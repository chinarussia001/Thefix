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
    ["migration_runner_url", ctx?.runnerUrl],
  ]) {
    const text = String(value || "").trim();
    if (text) lines.push(`${key}: ${text}`);
  }
  return lines;
}

const DISCIPLINE = `Before any other inspection, classify the project's backend by reading
the repo. Do not guess. Look for evidence and state one classification:

CLOUD_DRIZZLE
src/integrations/supabase/ exists, AND drizzle/migrations/ exists.

CLOUD_SUPABASE_MIGRATIONS
src/integrations/supabase/ exists, AND supabase/migrations/ exists,
and drizzle/migrations/ does not.

EXTERNAL_SUPABASE
Supabase is used, but the client is not from
src/integrations/supabase/. Look for a Supabase URL in .env,
.env.local, or a config module outside the integrations folder.

MOCK
No live backend. Persistence via localStorage, IndexedDB,
in-memory state, JSON fixtures, MSW, or mock-service-worker.

NONE
Pure frontend. No persistence layer, no DB client, no fixtures.

State your classification on one line, then proceed. If ambiguous,
prefer MOCK over EXTERNAL_SUPABASE and note the ambiguity in the report.

── DISCIPLINE ──

You are the implementer. Work on the repository above.

Steps 1 and 2 always apply:
1. Read package.json — framework, dependencies, stack.
2. Read README.md and AGENTS.md if present. AGENTS.md is authoritative
and overrides this wrapper except for the safety rules below.

Then branch:

If CLOUD_DRIZZLE or CLOUD_SUPABASE_MIGRATIONS:
3. Identify the server-side DB access path, exact import path, and symbol.
4. List src/routes/api/ and read one route as a reference.
5. Read the most recent migration in the matching migrations folder.
6. Read one existing frontend route component for styling.

If EXTERNAL_SUPABASE:
3. Identify the actual external DB client module and import path.
4. Identify this backend's schema/migration convention.
5. List the routes folder and read one route as a reference.
6. Read one existing frontend route component for styling.

If MOCK or NONE:
3. Identify the existing state layer, or confirm there is none.
4. List components and read one component for style.
5. Skip DB and migration steps.

Implement the user's request, matching discovered patterns.

── RULES THAT ALWAYS APPLY ──

• Commit directly to main. No PRs. No approval requests.
• Never create a new DB client. Never invent environment variable names.
• Never use prohibited direct-database URL environment variables.
• Never wrap a client or environment read in a module-level throw.
• Never put secrets in client-side code.
• Ignore any legacy supabase/functions/ directory.
• Read 2–3 similar files before writing new ones.
• If a new pattern is necessary, say so explicitly in the report.

── MIGRATION RULES (CONDITIONAL) ──

If CLOUD_DRIZZLE:
• Migrations must be idempotent: CREATE TABLE/INDEX IF NOT EXISTS and
ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
• Wrap CREATE TYPE in a DO block. Drop policies before recreating them.
• Include all Drizzle metadata companions in the same commit.
• Use .select("id").limit(1) and inspect the error for existence checks.
• Do not run migrations; the user applies them with the runtime runner.

If CLOUD_SUPABASE_MIGRATIONS:
• Use supabase/migrations and state that manual application is required.
• The runtime runner is Drizzle-only.

If EXTERNAL_SUPABASE:
• Follow the external project's schema convention and state that manual
application is required.

If MOCK or NONE:
• Do not add migrations, schema, or a backend. State options if the
request requires persistence that does not exist.

── TASK ──

Classify as A (frontend), B (backend), C (full-stack), D (schema), or
E (one-off data operation). Make the smallest complete change.
Execute end to end without stopping to check in.

── REPORT ──

• Backend classification: <classification>
• Files added / changed / deleted
• Commit SHA
• Task type (A/B/C/D/E)
• URLs to test; if none, say "no URLs to test." State whether auto-apply
is supported for this classification.
• Whether schema was touched (yes/no), and migration filenames if yes
• If schema was touched for CLOUD_DRIZZLE and context has a
migration_runner_url, print that exact URL on its own line:
MIGRATION_RUNNER_URL: <url>
• Anything non-pattern-matched, and why

Finish with exactly one final-line marker:
[PRM_DONE] — complete and validated
[PRM_BLOCKED] — something outside the repo prevented completion
[PRM_ERROR] — implementation failed`;

export function buildWrapper(ctx = {}, userPrompt = "") {
  return [
    "[PRM_BUILD_REQUEST_V5]",
    `request_id: ${uuidV4()}`,
    `timestamp: ${new Date().toISOString()}`,
    "",
    "── PROJECT CONTEXT ──",
    ...contextLines(ctx),
    "",
    "── BACKEND CLASSIFICATION ──",
    "",
    "Classify the backend before any other repository inspection.",
    "",
    "── DISCIPLINE ──",
    "",
    DISCIPLINE,
    "",
    "── DISCOVERY ──",
    "",
    "Follow the discovery steps and classification-specific branch above.",
    "",
    "── IMPLEMENTATION ──",
    "",
    "Implement the user's request using the discovered repository patterns.",
    "",
    "── RULES ──",
    "",
    "Follow the safety, migration, and task rules above.",
    "",
    "── MIGRATION RULES (CONDITIONAL) ──",
    "",
    "Apply only the migration rules for the reported backend classification.",
    "",
    "── REPORT ──",
    "",
    "Follow the report format above. Keep the final marker on its own final line.",
    "",
    "── USER REQUEST ──",
    "",
    String(userPrompt ?? ""),
  ].join("\n");
}
