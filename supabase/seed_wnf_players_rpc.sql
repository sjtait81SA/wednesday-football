-- Idempotent seed: run after `players` table exists. Inserts squad rows only when `players` is empty.
-- Grant lets anon + authenticated clients call from the app on first load.

create or replace function public.seed_wnf_players_if_empty()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.players limit 1) then
    return;
  end if;

  insert into public.players (name, is_admin, claimed_by) values
    ('Steven', false, null),
    ('Dan', false, null),
    ('Chris', false, null),
    ('Tom', false, null),
    ('Matt', false, null),
    ('Owen', false, null),
    ('Cam', false, null),
    ('Francis', false, null),
    ('Ho Yin', false, null),
    ('Brandon', false, null),
    ('Parthi', false, null),
    ('Alan', false, null),
    ('Dimple', false, null);
end;
$$;

grant execute on function public.seed_wnf_players_if_empty() to anon, authenticated;
