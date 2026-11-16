create table if not exists public.gex_latest_snapshots (
  symbol text primary key,
  captured_at timestamptz not null,
  payload jsonb not null
);
alter table public.gex_latest_snapshots enable row level security;
revoke all on public.gex_latest_snapshots from anon, authenticated;
grant select, insert, update on public.gex_latest_snapshots to service_role;
-- Only server-side publishing. Do not place the service-role/secret key in JS.
