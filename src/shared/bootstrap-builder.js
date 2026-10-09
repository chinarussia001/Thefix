import { buildMigrationRunnerSource } from "./migration-runner-template.js";
import { buildSeedRouteSource } from "./seed-route-template.js";

const EXEC_SQL_BOOTSTRAP_SQL = `create or replace function public.exec_sql(sql_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $ begin execute sql_text; return jsonb_build_object('ok', true); exception when others then return jsonb_build_object('ok', false, 'error', sqlerrm); end; $;

revoke all on function public.exec_sql(text) from public, anon, authenticated;
grant execute on function public.exec_sql(text) to service_role;`;

export function buildBootstrapPrompt({ key, previewHost }) {
  if (typeof key !== "string" || key.length === 0) throw new Error("Migration key cannot be empty.");
  const runnerSource = buildMigrationRunnerSource(key);
  const seedSource = buildSeedRouteSource(key);
  void previewHost;
  return [
    "One-time setup task. Do this exactly as written. Do not modify any character of the files below. Do not reformat. Do not rename symbols. Do not add comments. The files contain a string constant that must remain exactly as written — treat it as opaque.",
    "",
    "First, write the following two files.",
    "",
    "=== BEGIN FILE 1: src/routes/api/public/ops/run-migrations.ts ===",
    runnerSource,
    "=== END FILE 1 ===",
    "",
    "=== BEGIN FILE 2: src/routes/api/public/ops/seed-migrations.ts ===",
    seedSource,
    "=== END FILE 2 ===",
    "",
    "Second, run the following SQL in the SQL console:",
    "",
    EXEC_SQL_BOOTSTRAP_SQL,
    "",
    "Do not do anything else. Do not create any other file. Do not modify any existing file. When done, reply with the commit SHA.",
  ].join("\n");
}
