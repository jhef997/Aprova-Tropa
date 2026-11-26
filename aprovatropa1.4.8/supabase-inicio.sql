-- Rumo à Posse · início da nuvem (ETAPA A: cópia de segurança por usuário)
-- ATENÇÃO: NÃO foi testado em banco real. Rode primeiro em um projeto Supabase de TESTE.
-- Como usar: Supabase > SQL Editor > New query > cole tudo > Run.

create table if not exists public.user_backups (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  rev           bigint      not null default 0,        -- revisão do app (_rev), para saber qual cópia é mais nova
  atualizado_em timestamptz not null default now(),
  esquema       int         not null default 3,
  payload       jsonb       not null                    -- o backup completo do app
);

-- Segurança: cada pessoa só enxerga e altera a PRÓPRIA linha
alter table public.user_backups enable row level security;
drop policy if exists "ler o proprio backup"       on public.user_backups;
drop policy if exists "criar o proprio backup"     on public.user_backups;
drop policy if exists "atualizar o proprio backup" on public.user_backups;
drop policy if exists "apagar o proprio backup"    on public.user_backups;
create policy "ler o proprio backup"       on public.user_backups for select using (auth.uid() = user_id);
create policy "criar o proprio backup"     on public.user_backups for insert with check (auth.uid() = user_id);
create policy "atualizar o proprio backup" on public.user_backups for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "apagar o proprio backup"    on public.user_backups for delete using (auth.uid() = user_id);

-- Excluir a própria conta (as lojas exigem esse caminho para apps com cadastro)
create or replace function public.excluir_minha_conta() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from auth.users where id = auth.uid();       -- apaga também o backup (on delete cascade)
end; $$;
revoke all on function public.excluir_minha_conta() from public, anon;
grant execute on function public.excluir_minha_conta() to authenticated;
