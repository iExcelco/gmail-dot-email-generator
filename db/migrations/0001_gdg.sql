-- Gmail Dot Trick (gdg): own schema. Never touches the Drizzle-managed public tables
-- (Free Digital Marketing Audit) or asg.* (AI Search Grader), except one INSERT per
-- lead into public.leads so every agent's leads live in one place.
create schema if not exists gdg;

create table if not exists gdg.leads (
  lead_id            text primary key,                   -- IXL-GDG-...
  public_lead_id     uuid,                               -- row in public.leads (shared across agents)
  email              text not null,
  domain             text not null,                      -- gmail.com / googlemail.com / workspace domain
  base_local         text,
  plus_tag           text,
  source             text not null default 'gmail-dot-trick',
  site               text,                               -- host the lead came in on (agents.iexcel.co / gmaildottrick.co)
  lead_status        text not null default 'started',    -- started | completed | failed
  consent            boolean not null default false,
  consent_granted_at timestamptz,
  consent_text       text,
  is_workspace       boolean not null default false,
  workspace_domain   text,
  user_agent         text,
  ip                 text,
  sheet_row_number   integer,
  run_id             text,                               -- gdg.runs.id once the run is saved
  variant_count      integer,
  dot_variant_count  integer,
  plus_variant_count integer,
  results_emailed_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists gdg_leads_email_idx on gdg.leads (lower(email));
create index if not exists gdg_leads_created_idx on gdg.leads (created_at desc);

create table if not exists gdg.runs (
  id                 text primary key,                   -- 16-hex run id
  lead_id            text references gdg.leads(lead_id) on delete set null,
  email              text not null,
  domain             text not null,
  base_local         text,
  mode               text not null,                      -- wordSplit | all
  is_workspace       boolean not null default false,
  workspace_domain   text,
  plus_tags          jsonb,                              -- tags actually used (user's or the defaults)
  primary_variant    text,                               -- recommended word-split variant
  no_dot_variant     text,
  variant_count      integer not null,                   -- primary + extras (what the page counts)
  dot_variant_count  integer not null,
  plus_variant_count integer not null,
  mode_warning       text,
  status             text not null default 'completed',
  duration_ms        integer,
  report             jsonb not null,                     -- the full run output
  app_version        text,
  created_at         timestamptz not null default now()
);
create index if not exists gdg_runs_lead_idx on gdg.runs (lead_id);
create index if not exists gdg_runs_email_idx on gdg.runs (lower(email));
create index if not exists gdg_runs_created_idx on gdg.runs (created_at desc);

create table if not exists gdg.variants (
  id         bigserial primary key,
  run_id     text not null references gdg.runs(id) on delete cascade,
  position   integer not null,                         -- 0 = primary, then the order the page shows
  address    text not null,
  kind       text not null                             -- primary | dot | plus
);
create index if not exists gdg_variants_run_idx on gdg.variants (run_id, position);

create table if not exists gdg.exports (
  id         bigserial primary key,
  run_id     text,
  lead_id    text,
  kind       text not null,                            -- auto_email
  recipient  text,
  ok         boolean not null,
  error      text,
  created_at timestamptz not null default now()
);
create index if not exists gdg_exports_run_idx on gdg.exports (run_id);

create table if not exists gdg.events (
  id         bigserial primary key,
  run_id     text,
  stage      text not null,                            -- capture | sheet_append | generate | saved | sheet_update | done | error
  payload    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists gdg_events_run_idx on gdg.events (run_id);
