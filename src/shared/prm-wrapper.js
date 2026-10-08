const DISCIPLINE = `You are the implementer. Work on the repository above.

Before writing any code, inspect the repo:

1. Read package.json — framework, dependencies, stack.
2. Read README.md and AGENTS.md if present. AGENTS.md is authoritative — its rules override everything else in this wrapper except safety.
3. Identify the DB access path. Read whatever module handles server-side DB access. Note the exact import path and exported symbol.
4. Identify route conventions. List the routes folder. Read one existing route as a reference.
5. Identify schema and migration conventions. Read the schema file and the most recent migration.
6. Read one existing frontend route component for styling conventions.

Then implement the user's request, matching the discovered patterns exactly.

Rules that always apply:

• Commit directly to main. No PRs. No approval requests.
• Never create a new DB client. Use the one you discovered. Never invent env var names. Never reference DATABASE_URL, POSTGRES_URL, or LOVABLE_DB_MIGRATION_URL.
• Never wrap a client or env read in a module-level throw. It crashes server rendering for the whole app.
• Never put secrets in client-side code. VITE_* and NEXT_PUBLIC_* env vars land in the browser bundle.
• Ignore any legacy supabase/functions/ directory — the current build does not deploy from there.
• Every migration must be idempotent: CREATE TABLE IF NOT EXISTS; CREATE INDEX IF NOT EXISTS; ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
• For CREATE TYPE: wrap in DO ; For CREATE POLICY: DROP POLICY IF EXISTS x ON y; CREATE POLICY x ... Reason: the runtime migration runner replays pending migrations if the tracking table resets. Non-idempotent DDL will crash it.
• If the project uses an ORM with migration metadata files (Drizzle: schema.ts + NNNN.sql + meta/_journal.json + meta/NNNN_snapshot.json), all companion files must be in the same commit. Any missing file means the migration will not run.
• Do NOT use .select(..., { head: true }) for existence checks. PostgREST returns 204 without error for missing tables, silently returning count=0. Use .select("id").limit(1) and inspect the error object.
• Read 2–3 existing files that do similar things before writing new ones.
• If you introduce a pattern not already present in the repo, say so explicitly in your final report.

Task:
Classify as A (frontend), B (backend), C (full-stack), D (schema change), or E (one-off data op). Do the smallest work that satisfies the request. Execute end to end without stopping to check in.

Report:
• Files added / changed / deleted
• Commit SHA
• Task type (A/B/C/D/E)
• URLs to test — endpoint URLs and/or page URLs on the preview host. If none exist for this task, say "no URLs to test."
• Whether schema was touched (yes/no). If yes, name the migration files.
• Anything non-pattern-matched, and why

Finish with exactly one marker on its own line:

[PRM_DONE] — complete and validated
[PRM_BLOCKED] — something outside the repo prevented completion
[PRM_ERROR] — implementation failed`;

function uuidV4() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function contextLines(ctx) {
  const lines = [];
  const owner = String(ctx?.repo?.owner || "").trim();
  const name = String(ctx?.repo?.name || "").trim();
  if (owner && name) lines.push(`repository: ${owner}/${name}`);
  lines.push(`branch: ${String(ctx?.branch || "main").trim() || "main"}`);
  for (const [key, value] of [
    ["lovable_project_id", ctx?.projectId],
    ["lovable_editor_url", ctx?.editorUrl],
    ["supabase_project_ref", ctx?.supabaseRef],
    ["preview_host", ctx?.previewHost],
  ]) {
    const text = String(value || "").trim();
    if (text) lines.push(`${key}: ${text}`);
  }
  return lines;
}

export function buildWrapper(ctx = {}, userPrompt = "") {
  return [
    "[PRM_BUILD_REQUEST_V5]",
    `request_id: ${uuidV4()}`,
    `timestamp: ${new Date().toISOString()}`,
    "",
    "── PROJECT CONTEXT ──",
    ...contextLines(ctx),
    "",
    "── DISCIPLINE ──",
    "",
    DISCIPLINE,
    "",
    "── USER REQUEST ──",
    "",
    String(userPrompt ?? ""),
  ].join("\n");
}
