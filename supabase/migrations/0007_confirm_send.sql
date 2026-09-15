-- 0007_confirm_send.sql — confirm exactly once (Story 4.2; architecture D-2, D-6; Step-3 amendments #4, #9, #11;
-- Story-Time amendment S20: 0006_sends.sql is applied on hosted and frozen, so this story is its own migration).
--
-- public.confirm_send(campaign, expected_count) — THE only way a portal send comes into existence. Security
--                               definer (runs as postgres, which bypasses the forced RLS on sends /
--                               send_recipients — authenticated holds SELECT only, D-2), so the checks inside are
--                               the whole guard and run in this order:
--                                 1. current_app_role() is distinct from 'owner' → not_owner  (null-safe: a user
--                                    with no app_users row is refused, not passed; and before the brand lookup, so
--                                    an analyst learns nothing about other brands' campaign ids)
--                                 2. campaign not in the caller's brand, unknown, or null → not_in_brand
--                                 3. channel not email/sms → invalid_input
--                                 4. recount with internal.recipient_classification (the predicate the preview
--                                    used — D-6: the number previewed is the number confirmed); 0 → invalid_input
--                                 5. count ≠ p_expected_count (or null) → count_mismatch, hint = the new count
--                                    so the dialog can re-render with it
--                                 6. insert sends(status 'confirmed', source 'portal') — guarded by the partial
--                                    unique index uq_sends_one_active_per_campaign; a concurrent second confirm
--                                    blocks on that index until the first commits, then raises unique_violation,
--                                    which is caught (a subtransaction: the failed insert is rolled back) and
--                                    answered with the existing non-terminal send — same id, no error
--                                 7. snapshot send_recipients for exactly the ids frozen in step 4 (external_id +
--                                    the address for the channel), then body_sha256 over that snapshot
--                               Canonical recipient list = external_id values ordered by contact_id, joined by
--                               '\n', UTF-8, SHA-256 hex. Story 4.3's Edge Function recomputes exactly this and
--                               refuses to POST on a mismatch — the separator and the ordering are a contract.
--                               Why the array: the recount and the snapshot are separate statements under READ
--                               COMMITTED; freezing the ids guarantees recipient_count = count(send_recipients)
--                               even if the poller suppresses a contact between them.
--                               Error contract: raise exception '<code>' (SQLSTATE P0001, the stable message);
--                               only count_mismatch carries a hint. Never `update sends set status` here —
--                               CAS-style writes only, the insert guarded by the index.

create function public.confirm_send(p_campaign_id uuid, p_expected_count int)
returns public.sends
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_brand_id uuid := (select public.current_brand_id());
  v_campaign public.campaigns;
  v_ids uuid[];
  v_count int;
  v_send public.sends;
begin
  if public.current_app_role() is distinct from 'owner' then raise exception 'not_owner'; end if;

  select * into v_campaign from public.campaigns k
   where k.id = p_campaign_id and k.brand_id = v_brand_id;
  if not found then raise exception 'not_in_brand'; end if;
  if v_campaign.channel is null or v_campaign.channel not in ('email', 'sms') then
    raise exception 'invalid_input'; end if;

  -- recount: one scan, ids frozen in an array so count == snapshot rows
  select coalesce(array_agg(r.contact_id order by r.contact_id), '{}') into v_ids
    from internal.recipient_classification(p_campaign_id) r where r.reason is null;
  v_count := cardinality(v_ids);
  if v_count = 0 then raise exception 'invalid_input'; end if;
  if p_expected_count is null or v_count <> p_expected_count then
    raise exception 'count_mismatch' using hint = v_count::text; end if;

  begin
    insert into public.sends (brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at)
    values (v_brand_id, p_campaign_id, 'confirmed', 'portal', v_count,
            (select u.email::text from public.app_users u where u.auth_user_id = auth.uid()), now())
    returning * into v_send;
  exception when unique_violation then
    select * into v_send from public.sends s
     where s.campaign_id = p_campaign_id and s.brand_id = v_brand_id
       and s.status not in ('complete', 'partial', 'failed')
     order by s.created_at desc limit 1;
    if not found then raise exception 'send_in_progress'; end if;
    return v_send;                         -- the losing session sees the existing send
  end;

  insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address)
  select v_send.id, v_brand_id, c.id, c.external_id,
         case v_campaign.channel when 'email' then c.email else c.phone end
    from public.contacts c where c.id = any (v_ids);

  update public.sends s set body_sha256 = (
      select encode(sha256(convert_to(string_agg(r.external_id, E'\n' order by r.contact_id), 'UTF8')), 'hex')
        from public.send_recipients r where r.send_id = v_send.id)
   where s.id = v_send.id returning * into v_send;
  return v_send;
end $$;
comment on function public.confirm_send(uuid, int) is
  'Confirm a send for one campaign of the caller''s brand, exactly once: not_owner (role is distinct from owner), not_in_brand (foreign / unknown / null campaign), invalid_input (channel not email/sms, or zero recipients), count_mismatch with hint = the recount; otherwise inserts sends(confirmed, portal) + the send_recipients snapshot (external_id, address; ordered by contact_id) and body_sha256 = sha256 of the external_ids joined by \n. A concurrent second confirm (unique_violation on uq_sends_one_active_per_campaign) returns the existing non-terminal send.';
revoke execute on function public.confirm_send(uuid, int) from public, anon;
grant execute on function public.confirm_send(uuid, int) to authenticated;
