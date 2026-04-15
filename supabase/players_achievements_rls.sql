-- Run in Supabase SQL Editor after enabling Email auth (Authentication → Providers → Email).
-- App uses magic-link sign-in; no phone/SMS provider required.

-- ── players ─────────────────────────────────────────────────────────────
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  claimed_by uuid references auth.users (id) on delete set null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists players_claimed_by_idx on public.players (claimed_by);
create index if not exists players_name_idx on public.players (name);

-- ── achievements ─────────────────────────────────────────────────────────
create table if not exists public.achievements (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players (id) on delete cascade,
  type text not null,
  earned_at timestamptz not null default now(),
  match_id uuid
);

create index if not exists achievements_player_idx on public.achievements (player_id);
create index if not exists achievements_earned_idx on public.achievements (earned_at desc);

-- One per player/type for match-scoped rows
create unique index if not exists achievements_unique_match
  on public.achievements (player_id, type, match_id)
  where match_id is not null;

-- One per player/type for season-scoped rows (match_id null)
create unique index if not exists achievements_unique_seasonal
  on public.achievements (player_id, type)
  where match_id is null;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.players enable row level security;
alter table public.achievements enable row level security;

-- players: read for any signed-in user
drop policy if exists "players_select_authenticated" on public.players;
create policy "players_select_authenticated"
  on public.players for select
  to authenticated
  using (true);

-- Insert new player (squad sync, add guest) — signed-in only
drop policy if exists "players_insert_authenticated" on public.players;
create policy "players_insert_authenticated"
  on public.players for insert
  to authenticated
  with check (
    claimed_by is null
    or claimed_by = (select auth.uid())
  );

-- Claim: only when unclaimed, set claimed_by to self; admins can update any row
drop policy if exists "players_update_authenticated" on public.players;
create policy "players_update_authenticated"
  on public.players for update
  to authenticated
  using (
    claimed_by is null
    or claimed_by = (select auth.uid())
    or exists (
      select 1 from public.players pa
      where pa.claimed_by = (select auth.uid()) and pa.is_admin = true
    )
  )
  with check (
    claimed_by is null
    or claimed_by = (select auth.uid())
    or exists (
      select 1 from public.players pa
      where pa.claimed_by = (select auth.uid()) and pa.is_admin = true
    )
  );

-- achievements: read for signed-in users
drop policy if exists "achievements_select_authenticated" on public.achievements;
create policy "achievements_select_authenticated"
  on public.achievements for select
  to authenticated
  using (true);

-- Only admins insert achievements (computed on match save in app)
drop policy if exists "achievements_insert_admin" on public.achievements;
create policy "achievements_insert_admin"
  on public.achievements for insert
  to authenticated
  with check (
    exists (
      select 1 from public.players pa
      where pa.claimed_by = (select auth.uid()) and pa.is_admin = true
    )
  );

-- Optional: allow users to delete own mistaken rows — skip for now

-- ── seasons (optional): if you enable RLS on `seasons`, allow authenticated read/write for the app JSON blob ──
-- alter table public.seasons enable row level security;
-- drop policy if exists "seasons_authenticated_all" on public.seasons;
-- create policy "seasons_authenticated_all"
--   on public.seasons for all
--   to authenticated
--   using (true)
--   with check (true);

-- ── Guest (anon) read — required for browsing without signing in (anon Supabase client) ──
drop policy if exists "players_select_anon" on public.players;
create policy "players_select_anon"
  on public.players for select
  to anon
  using (true);

drop policy if exists "achievements_select_anon" on public.achievements;
create policy "achievements_select_anon"
  on public.achievements for select
  to anon
  using (true);

-- If `seasons` has RLS enabled, also allow anon SELECT so guests load the shared JSON season:
-- alter table public.seasons enable row level security;
-- drop policy if exists "seasons_select_anon" on public.seasons;
-- create policy "seasons_select_anon"
--   on public.seasons for select
--   to anon
--   using (true);

-- Set yourself admin in Table Editor: players → is_admin = true for your row after claiming.

-- ── Idempotent squad seed (run once; app also calls RPC on load) ──
-- See `seed_wnf_players_rpc.sql` for `seed_wnf_players_if_empty()`.
