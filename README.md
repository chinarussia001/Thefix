# LovaRPM

LovaRPM routes Lovable project prompts to a persistent coding-agent backend. The backend uses Vyce AI's OpenAI-compatible chat-completions endpoint, runs repository commands in per-task Docker containers, validates real changes, and creates a GitHub branch, commit, and pull request after validation.

## Local backend

Requirements: Node.js 22+, Git, and a working Docker daemon. No npm packages are required.

1. Copy `.env.example` to `.env`. Keep `.env` out of Git.
2. Generate a unique `LOVARPM_API_TOKEN` (for example, with `openssl rand -hex 32`) and configure it only in the backend environment.
3. Configure `VYCE_API_KEY` and a GitHub Personal Access Token as backend secrets/environment variables. The PAT needs repository read/write and pull-request permissions for the repositories you intend to use. Neither credential belongs in the extension.
4. Start the service with `npm start`. It listens on `http://127.0.0.1:4173` by default. The first task pulls the configured execution image if it is not already present.
5. Load this directory as an unpacked Chrome extension. Activate a valid LovaRPM license in the panel, then save the backend URL and matching backend API token. Refresh the model catalogue to enable only models listed by Vyce AI.

Tasks and activity are stored in SQLite under `backend/data`; isolated workspaces and protected-file quarantine data are under `backend/workspaces` and `backend/data/quarantine`. The default worker handles one task at a time. It never places backend secrets inside the execution container. Set task time, model-token, and tool-call limits in the backend environment.

The local service is a single-operator deployment: its bearer token maps to one configured owner. It is not an account-registration or multi-tenant service. For a remote backend, use HTTPS, a private secret manager, and request the backend host permission in the extension. The Docker daemon is a required execution dependency; do not expose its socket to untrusted users. Token usage and estimated cost are recorded per model; cost figures use the supplied pricing snapshot and are not live-verified.

If Vyce AI, Docker, or GitHub is unavailable, task state and the actual failure are retained. Tasks interrupted by a backend restart are marked for attention rather than replayed automatically.

## Verification

- Run unit tests with `npm test`.
- Run the real isolated-container test with `RUN_DOCKER_TESTS=1 npm test`. This exercises actual Docker-backed file and command operations against a disposable local Git repository; it does not call Vyce AI or GitHub.
- The `/health` endpoint reports whether provider and GitHub secrets are configured. Authenticated `GET /api/models` performs a real `GET https://vyceai.com/v1/models`; task inference uses `POST /v1/chat/completions`.

The bundled extension can intercept Lovable's native composer and can submit work from its panel. Closing the popup or Lovable tab does not stop an accepted backend task. Lovable's Git synchronization back to its preview depends on Lovable's own repository synchronization and has not been independently verified by this project.
