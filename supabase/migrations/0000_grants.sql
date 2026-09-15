-- 0000_grants.sql — "grants first, then policies" (architecture D-2, amendments #1, #2).
-- Runs before any object exists so every later public object carries no implicit
-- grant to anon/authenticated. service_role defaults are untouched (bypassrls).
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
create schema if not exists internal;   -- plpgsql helpers, never exposed
create schema if not exists staging;    -- raw seed rows, never exposed
revoke all on schema internal, staging from public, anon, authenticated;
