-- 0008_dispatch.sql — dispatch through the provider, crash-safe (Story 4.3; architecture D-7, D-2; Step-3
-- amendments #4, #6, #12; Story-Time amendments S7, S20: 0006_sends.sql is frozen on hosted, so the dispatch SQL
-- is its own migration; the sweep + cron job follow in 0009_cron_dispatch.sql).
--
-- The four functions behind the `dispatch-send` Edge Function. All SECURITY INVOKER with search_path pinned and
-- EXECUTE granted to service_role only: they run as service_role (bypassrls) from the Edge Function's service
-- client, never from the browser — `authenticated` holds SELECT only on sends (D-2), so every status transition
-- below is a compare-and-set that the app cannot reproduce or bypass.
--
-- dispatch_take_lease(send)   — THE lease (architecture D-7, verbatim): from confirmed|dispatched with a null
--                               batch_id, lease null or expired, attempts < 3 → dispatched, attempts + 1, a 10-min
--                               lease, dispatched_at set once. Zero rows = someone else holds the lease, the cap is
--                               reached, or the send is not dispatchable — the caller answers { skipped: true }.
--                               Re-entry from `dispatched` covers a crash between the CAS and the POST.
-- dispatch_recipients(send)   — the confirmed snapshot as ONE jsonb array ordered by contact_id (external_id +
--                               address). One row on purpose: PostgREST's max_rows (1000) would silently truncate a
--                               50,000-row result. The Edge Function recomputes sha256(external_ids joined by '\n')
--                               over this array and refuses to POST unless it equals sends.body_sha256 (4.2's digest).
-- dispatch_record_result(send, batch_id, accepted_ids, rejected_count)
--                             — the 2xx outcome. accepted_count = count(distinct accepted ∩ send_recipients.external_id)
--                               (the provider's echo is not trusted: duplicates and strangers do not count),
--                               reporting when accepted_count = recipient_count else partial, provider_responded_at,
--                               then the provider_batches row (polling 'active'; on conflict do nothing).
--                               CAS: where status = 'dispatched' and batch_id is null — a replayed response after
--                               the first one landed changes nothing.
-- dispatch_mark_failed(send, reason)
--                             — the 4xx / body_hash_mismatch outcome: failed + failure_reason (≤ 500 chars) +
--                               provider_responded_at, same CAS. 5xx / timeout / network call none of these: the
--                               send stays dispatched under its lease and the sweep (0009) retries or caps it.

-- ---------------------------------------------------------------------------
-- dispatch_take_lease
-- ---------------------------------------------------------------------------
create function public.dispatch_take_lease(p_send_id uuid) returns setof public.sends
language sql volatile set search_path = '' as $$
  update public.sends
     set dispatch_lease_until = now() + interval '10 min',
         dispatch_attempts = dispatch_attempts + 1,
         status = 'dispatched',
         dispatched_at = coalesce(dispatched_at, now())
   where id = p_send_id
     and status in ('confirmed', 'dispatched') and batch_id is null
     and (dispatch_lease_until is null or dispatch_lease_until < now())
     and dispatch_attempts < 3
  returning *;
$$;
comment on function public.dispatch_take_lease(uuid) is
  'Service-role only. Takes the 10-minute dispatch lease on a confirmed|dispatched send with no batch_id, a null or expired lease and fewer than 3 attempts: attempts + 1, status dispatched, dispatched_at set once. Zero rows = skip (lease held, cap reached, or not dispatchable).';

-- ---------------------------------------------------------------------------
-- dispatch_recipients — one row, the canonical order
-- ---------------------------------------------------------------------------
create function public.dispatch_recipients(p_send_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('external_id', r.external_id, 'address', r.address) order by r.contact_id), '[]'::jsonb)
    from public.send_recipients r
   where r.send_id = p_send_id;
$$;
comment on function public.dispatch_recipients(uuid) is
  'Service-role only. The send''s confirmed recipient snapshot as one jsonb array [{external_id, address}] ordered by contact_id — the order body_sha256 was computed in. Empty array for an unknown send.';

-- ---------------------------------------------------------------------------
-- dispatch_record_result — the 2xx outcome
-- ---------------------------------------------------------------------------
create function public.dispatch_record_result(p_send_id uuid, p_batch_id text, p_accepted_ids text[], p_rejected_count int)
returns setof public.sends
language plpgsql volatile set search_path = '' as $$
declare
  v_accepted int;
  v_send public.sends;
begin
  select count(distinct r.external_id) into v_accepted
    from public.send_recipients r
   where r.send_id = p_send_id and r.external_id = any (p_accepted_ids);

  update public.sends s
     set batch_id = p_batch_id,
         accepted_count = v_accepted,
         rejected_count = p_rejected_count,
         provider_responded_at = now(),
         status = case when v_accepted = s.recipient_count then 'reporting'::public.send_status else 'partial'::public.send_status end
   where s.id = p_send_id and s.status = 'dispatched' and s.batch_id is null
  returning * into v_send;

  if found then
    insert into public.provider_batches (send_id, brand_id, batch_id, polling)
    values (v_send.id, v_send.brand_id, p_batch_id, 'active')
    on conflict (send_id) do nothing;
    return next v_send;
  end if;
end $$;
comment on function public.dispatch_record_result(uuid, text, text[], int) is
  'Service-role only. Records the provider''s 2xx: batch_id, accepted_count = count(distinct accepted ∩ send_recipients.external_id), rejected_count, provider_responded_at, status reporting (all accepted) or partial; inserts provider_batches(polling active). CAS on status = dispatched and batch_id is null — zero rows when already recorded.';

-- ---------------------------------------------------------------------------
-- dispatch_mark_failed — the 4xx / hash-mismatch outcome
-- ---------------------------------------------------------------------------
create function public.dispatch_mark_failed(p_send_id uuid, p_reason text) returns setof public.sends
language sql volatile set search_path = '' as $$
  update public.sends
     set status = 'failed',
         failure_reason = left(p_reason, 500),
         provider_responded_at = now()
   where id = p_send_id and status = 'dispatched' and batch_id is null
  returning *;
$$;
comment on function public.dispatch_mark_failed(uuid, text) is
  'Service-role only. Marks a dispatched send with no batch_id as failed with failure_reason (cut to 500 chars) and provider_responded_at. CAS: zero rows when the send is not dispatched or already carries a batch_id.';

-- ---------------------------------------------------------------------------
-- grants — service_role only (not in the tenancy suite's anon/authenticated/secdef allow-lists)
-- ---------------------------------------------------------------------------
revoke execute on function
  public.dispatch_take_lease(uuid),
  public.dispatch_recipients(uuid),
  public.dispatch_record_result(uuid, text, text[], int),
  public.dispatch_mark_failed(uuid, text)
from public, anon, authenticated;
grant execute on function
  public.dispatch_take_lease(uuid),
  public.dispatch_recipients(uuid),
  public.dispatch_record_result(uuid, text, text[], int),
  public.dispatch_mark_failed(uuid, text)
to service_role;
