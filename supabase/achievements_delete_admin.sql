-- Run in Supabase SQL Editor so admins can delete match-linked achievements when a match is removed or cleared.
-- Without this policy, client deletes from `achievements` will fail under RLS.

drop policy if exists "achievements_delete_admin" on public.achievements;
create policy "achievements_delete_admin"
  on public.achievements for delete
  to authenticated
  using (
    exists (
      select 1 from public.players pa
      where pa.claimed_by = (select auth.uid()) and pa.is_admin = true
    )
  );
