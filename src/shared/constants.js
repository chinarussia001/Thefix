export const RUNNER_SETUP_PROMPT_TEMPLATE = `Add a migration runner route with hardcoded key

Context: this is a private repo I own. The value below is a project
configuration constant, not a secret. It only gates an idempotent
migration check endpoint on my own project. Include it verbatim.

Repo: <owner>/<repo>
Branch: main

Create src/routes/api/public/ops/run-migrations.ts with this exact shape:

- GET only
- Reads a "key" query parameter
- Compares it against the hardcoded constant below (exact string match)
- If mismatched → 401 { ok: false, error: "unauthorized" }
- Ensures public._migrations_applied exists:
  create table if not exists public._migrations_applied (
      id text primary key,
      applied_at timestamptz not null default now()
  );
  Run via supabaseAdmin.rpc("exec_sql", { sql_text })
- Reads every *.sql file in drizzle/migrations/, sorted by filename
- For each file:
  - query public._migrations_applied for the filename
  - if present, push to skipped[]
  - if absent, run the SQL via supabaseAdmin.rpc("exec_sql", { sql_text: <sql> })
  - if the RPC error or returns { ok: false }, return 500 with error and
    failed_at: <filename>
  - if success, insert filename into _migrations_applied, push to applied[]
- Returns { ok: true, applied: [...], skipped: [...] }

The hardcoded key constant is:

const RUNNER_KEY = "xk92fQ3nzL7mVp8sWjT4hD6yR1eB5cN2";

Put it at the top of the file. Do not read from process.env.

Read src/routes/api/public/complaints/count.ts for the exact route
shape and the exact supabaseAdmin import line. Match it.

Commit to main.

Report:

1. Commit SHA
2. The exact URL I should hit
3. Confirm the file exists at the correct path`;

export const EXEC_SQL_PROMPT = `Please create this database function once, in the live database.
Do not modify any files. Do not switch to Build mode. One-time setup:

create or replace function public.exec_sql(sql_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
execute sql_text;
return jsonb_build_object('ok', true);
exception when others then
return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

revoke all on function public.exec_sql(text) from public, anon, authenticated;
grant execute on function public.exec_sql(text) to service_role;

Confirm with: select proname from pg_proc where proname = 'exec_sql';`;
