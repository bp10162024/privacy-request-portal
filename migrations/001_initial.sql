-- Privacy Request Portal — initial schema
-- Run this in Supabase SQL Editor for project tnzonruwauoijhqyfwxw
-- All rows must be retained 24 months minimum per CCPA §1798.130

-- =========================================================
-- privacy_requests: one row per incoming request
-- =========================================================
create table if not exists privacy_requests (
  id uuid primary key default gen_random_uuid(),
  requester_email text not null,
  requester_name text,
  source text not null check (source in ('intercom','do_not_sell_form','email','mail','phone','other')),
  source_url text,
  request_type text not null check (request_type in ('opt_out','delete','access','correct','limit')),
  status text not null default 'received' check (status in ('received','acknowledged','in_progress','completed','cancelled')),
  identity_verified boolean not null default false,
  date_received timestamptz not null default now(),
  acknowledged_at timestamptz,
  completed_at timestamptz,
  deadline_at timestamptz not null,
  notes text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_privacy_requests_status on privacy_requests(status);
create index if not exists idx_privacy_requests_deadline on privacy_requests(deadline_at);
create index if not exists idx_privacy_requests_email on privacy_requests(requester_email);

-- =========================================================
-- privacy_request_actions: one row per (request, destination)
-- =========================================================
create table if not exists privacy_request_actions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references privacy_requests(id) on delete cascade,
  destination text not null check (destination in (
    'hubspot','meta','ga4','google_ads','amplitude',
    'linkedin','bing','intercom','stripe','internal_db'
  )),
  action_type text not null check (action_type in (
    'automated_api','manual_form','manual_support_ticket','manual_internal','skipped'
  )),
  status text not null default 'pending' check (status in (
    'pending','in_progress','completed','failed','skipped','not_applicable'
  )),
  external_reference text,
  response_data jsonb,
  error_message text,
  executed_at timestamptz,
  executed_by text,
  created_at timestamptz not null default now(),
  unique (request_id, destination)
);

create index if not exists idx_privacy_request_actions_request_id on privacy_request_actions(request_id);
create index if not exists idx_privacy_request_actions_status on privacy_request_actions(status);

-- =========================================================
-- privacy_request_audit_log: every action taken, for legal defense
-- =========================================================
create table if not exists privacy_request_audit_log (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references privacy_requests(id) on delete cascade,
  action text not null,
  actor_email text,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_privacy_request_audit_log_request_id on privacy_request_audit_log(request_id);
create index if not exists idx_privacy_request_audit_log_created_at on privacy_request_audit_log(created_at);

-- =========================================================
-- privacy_request_users: allowlist of who can log in to the portal
-- =========================================================
create table if not exists privacy_request_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role text not null default 'admin' check (role in ('admin','viewer')),
  added_by text,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- seed the first allowed user
insert into privacy_request_users (email, role, added_by)
values ('eric@buddypunch.com', 'admin', 'system')
on conflict (email) do nothing;

-- =========================================================
-- privacy_request_oauth_tokens: stored refresh tokens for Google APIs
-- (one-time OAuth flow; refresh tokens last indefinitely)
-- =========================================================
create table if not exists privacy_request_oauth_tokens (
  provider text primary key check (provider in ('google_analytics','google_ads')),
  refresh_token text not null,
  scope text not null,
  authorized_by text not null,
  authorized_at timestamptz not null default now()
);

-- =========================================================
-- View: open requests with deadline urgency
-- =========================================================
create or replace view privacy_requests_open as
select
  r.*,
  case
    when r.deadline_at < now() then 'overdue'
    when r.deadline_at < now() + interval '1 day' then 'critical'
    when r.deadline_at < now() + interval '5 days' then 'warning'
    else 'normal'
  end as urgency,
  extract(epoch from (r.deadline_at - now())) / 86400 as days_remaining,
  (select count(*) from privacy_request_actions a where a.request_id = r.id) as total_actions,
  (select count(*) from privacy_request_actions a where a.request_id = r.id and a.status = 'completed') as completed_actions
from privacy_requests r
where r.status not in ('completed','cancelled');

-- =========================================================
-- Function: compute deadline based on request_type
-- =========================================================
create or replace function compute_privacy_deadline(req_type text, received timestamptz)
returns timestamptz as $$
begin
  -- opt_out and limit: 15 business days
  -- delete, access, correct: 45 calendar days
  if req_type in ('opt_out','limit') then
    return received + interval '21 days';  -- ~15 business days approximated as 21 calendar days
  else
    return received + interval '45 days';
  end if;
end;
$$ language plpgsql immutable;
