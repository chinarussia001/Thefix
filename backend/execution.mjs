import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_OUTPUT_BYTES = 20_000;
const MAX_FILE_BYTES = 80_000;
const SECRET_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
const SAFE_ENV = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  HOME: process.env.HOME || "/tmp",
  LANG: "C.UTF-8",
};

function isSensitivePath(path) {
  const parts = path.split(/[\\/]/);
  return parts.some((part) => SECRET_FILE.test(part) && !/^\.(?:env|npmrc)\.(?:example|sample|template)$/i.test(part));
}

function redactSecrets(value) {
  return String(value)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1[redacted]$2");
}

function runProcess(command, args, { cwd, env = SAFE_ENV, timeoutMs = 60_000, maxBytes = MAX_OUTPUT_BYTES, signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      const remaining = Math.max(0, maxBytes - target.length);
      if (remaining) return chunk.subarray(0, remaining).toString("utf8");
      return "";
    };
    child.stdout.on("data", (chunk) => { stdout += collect(stdout)(chunk); });
    child.stderr.on("data", (chunk) => { stderr += collect(stderr)(chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, terminationSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 128,
        signal: terminationSignal,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        truncated: bytes > maxBytes,
      });
    });
  });
}

function assertRepository(repository) {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
    throw new Error("Repository must use the owner/name format.");
  }
}

export class DockerWorkspace {
  constructor({ root, secretRoot = resolve(root, ".private-task-files"), taskId, repository, branch, githubToken = process.env.GITHUB_TOKEN, sourceRepositoryPath = "" }) {
    assertRepository(repository);
    this.root = resolve(root);
    this.secretRoot = resolve(secretRoot);
    this.taskId = taskId;
    this.repository = repository;
    this.branch = branch;
    this.githubToken = String(githubToken || "").trim();
    this.sourceRepositoryPath = sourceRepositoryPath ? resolve(sourceRepositoryPath) : "";
    this.image = process.env.LOVARPM_EXECUTION_IMAGE || "node:22-bookworm";
    this.network = process.env.LOVARPM_DOCKER_NETWORK || "bridge";
    this.directory = resolve(this.root, taskId);
    this.containerName = `lovarpm-${taskId.replaceAll("-", "").slice(0, 20)}`;
    this.hiddenSecrets = [];
    this.abortController = new AbortController();
  }

  async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.directory, { recursive: false, mode: 0o700 });
    const cloneUrl = this.sourceRepositoryPath || `https://github.com/${this.repository}.git`;
    const cloneArgs = ["clone", "--single-branch", "--branch", this.branch, cloneUrl, this.directory];
    const env = { ...SAFE_ENV };
    if (this.githubToken && !this.sourceRepositoryPath) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.githubToken}`).toString("base64")}`;
    }
    const clone = await runProcess("git", cloneArgs, { cwd: this.root, env, timeoutMs: 120_000, signal: this.abortController.signal });
    if (clone.exitCode !== 0) {
      await rm(this.directory, { recursive: true, force: true });
      const authHint = this.githubToken ? "" : " Configure GITHUB_TOKEN on the backend for private repositories and GitHub delivery.";
      throw new Error(`Could not clone ${this.repository} at ${this.branch}: ${clone.stderr.trim() || clone.stdout.trim() || `git exited ${clone.exitCode}`}.${authHint}`);
    }
    await this.hideSecrets();
    await this.createContainer();
  }

  async hideSecrets() {
    const quarantine = resolve(this.secretRoot, this.taskId);
    const manifest = [];
    const walk = async (directory, prefix = "") => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = resolve(directory, entry.name);
        if (isSensitivePath(path)) {
          const info = await lstat(absolute);
          if (!info.isFile()) continue;
          const backupPath = resolve(quarantine, path);
          await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
          await writeFile(backupPath, await readFile(absolute), { mode: 0o600 });
          manifest.push({ path, mode: info.mode & 0o777 });
          await writeFile(resolve(quarantine, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
          await rm(absolute, { recursive: true, force: true });
        } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
          await walk(absolute, path);
        }
      }
    };
    await walk(this.directory);
    if (manifest.length) this.hiddenSecrets = manifest;
  }

  async restoreSecrets() {
    const quarantine = resolve(this.secretRoot, this.taskId);
    let manifest = this.hiddenSecrets;
    if (!manifest.length) {
      try {
        manifest = JSON.parse(await readFile(resolve(quarantine, "manifest.json"), "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw new Error(`Could not read protected-file recovery metadata: ${error.message}`);
      }
    }
    for (const entry of manifest) {
      const original = resolve(this.directory, entry.path);
      const parent = dirname(original);
      const relativePath = relative(this.directory, original);
      if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
        throw new Error("Protected-file recovery path escapes the repository.");
      }
      let current = this.directory;
      for (const segment of relativePath.split(sep).slice(0, -1)) {
        current = resolve(current, segment);
        try {
          if ((await lstat(current)).isSymbolicLink()) {
            throw new Error(`Refusing to restore protected file through a symbolic link: ${entry.path}`);
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      await mkdir(parent, { recursive: true });
      await rm(original, { recursive: true, force: true });
      const backupPath = resolve(quarantine, entry.path);
      const backupRelative = relative(quarantine, backupPath);
      if (!backupRelative || backupRelative.startsWith(`..${sep}`) || backupRelative === "..") {
        throw new Error("Protected-file backup path escapes quarantine.");
      }
      await writeFile(original, await readFile(backupPath), { mode: entry.mode });
    }
    await rm(quarantine, { recursive: true, force: true });
    this.hiddenSecrets.length = 0;
  }

  async createContainer() {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    const args = [
      "run", "-d", "--name", this.containerName, "--network", this.network,
      "--memory", "4g", "--cpus", "2", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=512m",
      "--tmpfs", "/home:rw,nosuid,size=512m", "--env", "HOME=/tmp",
      "--env", "npm_config_cache=/tmp/.npm",
      "--user", `${uid}:${gid}`,
      "--volume", `${this.directory}:/workspace:rw`,
      "--workdir", "/workspace",
      this.image, "sleep", "infinity",
    ];
    const created = await runProcess("docker", args, { timeoutMs: 120_000 });
    if (created.exitCode !== 0) {
      throw new Error(`Could not start the isolated Docker workspace: ${created.stderr.trim() || created.stdout.trim()}`);
    }
  }

  async safePath(filePath) {
    const normalized = String(filePath || "").replaceAll("\\", "/");
    if (!normalized || normalized.includes("\0") || isAbsolute(normalized) || normalized.split("/").some((part) => part === ".." || !part)) {
      throw new Error("File path must be a non-empty relative path inside the repository.");
    }
    if (isSensitivePath(normalized) || normalized.split("/").includes(".git")) {
      throw new Error("Access to credentials and Git internals is not allowed.");
    }
    const absolute = resolve(this.directory, normalized);
    const relativePath = relative(this.directory, absolute);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
      throw new Error("File path escapes the repository workspace.");
    }
    let current = this.directory;
    for (const segment of relativePath.split(sep)) {
      current = resolve(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error("Symbolic links cannot be traversed by file tools.");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const rootPath = await realpath(this.directory);
    const parentPath = await realpath(dirname(absolute)).catch(() => rootPath);
    if (parentPath !== rootPath && !parentPath.startsWith(`${rootPath}${sep}`)) {
      throw new Error("File path escapes the repository workspace.");
    }
    return absolute;
  }

  async listFiles(directory = ".", limit = 300) {
    const base = directory === "." ? this.directory : await this.safePath(directory);
    const files = [];
    const walk = async (folder, prefix = "") => {
      const entries = await readdir(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= limit) return;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (isSensitivePath(path)) continue;
        if (entry.isDirectory()) await walk(resolve(folder, entry.name), path);
        else if (entry.isFile()) files.push(path);
      }
    };
    await walk(base, directory === "." ? "" : directory);
    return { files, truncated: files.length >= limit };
  }

  async readFile(filePath) {
    const path = await this.safePath(filePath);
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("Requested path is not a regular file.");
    if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit.`);
    return redactSecrets(await readFile(path, "utf8"));
  }

  async writeFile(filePath, content) {
    const path = await this.safePath(filePath);
    const value = String(content);
    if (Buffer.byteLength(value) > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte write limit.`);
    await mkdir(dirname(path), { recursive: true });
    const checkedPath = await this.safePath(filePath);
    await writeFile(checkedPath, value, { encoding: "utf8", mode: 0o600 });
    return { path: filePath, bytesWritten: Buffer.byteLength(value) };
  }

  async runCommand(command, timeoutMs = 120_000) {
    const value = String(command || "").trim();
    if (!value || value.length > 4000) throw new Error("Command must contain between 1 and 4000 characters.");
    const result = await runProcess("docker", [
      "exec", "--workdir", "/workspace", this.containerName, "sh", "-lc", value,
    ], { timeoutMs, maxBytes: MAX_OUTPUT_BYTES, signal: this.abortController.signal });
    return result;
  }

  async git(args, options = {}) {
    return runProcess("git", ["-C", this.directory, ...args], { timeoutMs: 60_000, ...options });
  }

  async status() {
    return this.git(["status", "--short"]);
  }

  async repositoryMetadata() {
    const [owner, name] = this.repository.split("/");
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.githubToken) headers.Authorization = `Bearer ${this.githubToken}`;
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub repository metadata request failed (HTTP ${response.status}).`);
    const metadata = await response.json();
    return {
      repository: metadata.full_name,
      defaultBranch: metadata.default_branch,
      private: Boolean(metadata.private),
      url: metadata.html_url,
    };
  }

  async diff() {
    return this.git(["diff", "--", "."]);
  }

  async changedPaths() {
    const result = await this.git(["diff", "--name-only", "-z", "HEAD"]);
    if (result.exitCode !== 0) throw new Error(`Could not inspect the Git diff: ${result.stderr}`);
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked.exitCode !== 0) throw new Error(`Could not inspect untracked files: ${untracked.stderr}`);
    return [...new Set([...result.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean))];
  }

  async deliver({ taskId, baseBranch, prompt, signal, checkActive = () => {} }) {
    if (!this.githubToken) throw new Error("GitHub delivery is unavailable: set GITHUB_TOKEN on the backend.");
    checkActive();
    await this.close();
    await this.restoreSecrets();
    const branchName = `lovarpm/task-${taskId.slice(0, 8)}`;
    const existing = await this.git(["branch", "--list", branchName]);
    if (existing.exitCode !== 0) throw new Error(`Could not inspect the task branch: ${existing.stderr}`);
    if (!existing.stdout.trim()) {
      checkActive();
      const checkout = await this.git(["checkout", "-b", branchName]);
      if (checkout.exitCode !== 0) throw new Error(`Could not create task branch: ${checkout.stderr}`);
    } else {
      checkActive();
      const checkout = await this.git(["checkout", branchName]);
      if (checkout.exitCode !== 0) throw new Error(`Could not switch to task branch: ${checkout.stderr}`);
    }

    const changed = await this.changedPaths();
    const safePaths = changed.filter((path) => !isSensitivePath(path) && !path.split("/").includes(".git"));
    if (!safePaths.length) throw new Error("No non-sensitive file changes are available to commit.");
    const add = await this.git(["add", "--", ...safePaths]);
    if (add.exitCode !== 0) throw new Error(`Could not stage task changes: ${add.stderr}`);
    const diffCheck = await this.git(["diff", "--cached", "--check"]);
    if (diffCheck.exitCode !== 0) throw new Error(`Git diff check failed: ${diffCheck.stderr}`);
    const staged = await this.git(["diff", "--cached", "--quiet"]);
    if (staged.exitCode === 0) throw new Error("There are no new staged changes to commit.");

    checkActive();
    const commit = await this.git([
      "-c", "user.name=LovaRPM Agent",
      "-c", "user.email=lovarpm-agent@users.noreply.github.com",
      "commit", "-m", `LovaRPM: ${String(prompt).replace(/\s+/g, " ").slice(0, 60)}`,
    ]);
    if (commit.exitCode !== 0) throw new Error(`Git commit failed: ${commit.stderr}`);
    const shaResult = await this.git(["rev-parse", "HEAD"]);
    if (shaResult.exitCode !== 0) throw new Error(`Could not resolve created commit: ${shaResult.stderr}`);
    const sha = shaResult.stdout.trim();

    const env = { ...SAFE_ENV,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.githubToken}`).toString("base64")}`,
    };
    checkActive();
    const push = await runProcess("git", ["-C", this.directory, "push", "--set-upstream", "origin", branchName], { env, timeoutMs: 120_000, signal });
    if (push.exitCode !== 0) throw new Error(`GitHub push failed: ${push.stderr.trim() || push.stdout.trim()}`);
    checkActive();
    const pullRequest = await this.createPullRequest({ branchName, baseBranch, taskId, prompt, signal });
    return {
      branch: branchName,
      commit: sha,
      commitUrl: `https://github.com/${this.repository}/commit/${sha}`,
      pullRequest,
    };
  }

  async createPullRequest({ branchName, baseBranch, taskId, prompt, signal }) {
    const [owner, repo] = this.repository.split("/");
    const endpoint = `https://api.github.com/repos/${owner}/${repo}/pulls`;
    const headers = {
      Authorization: `Bearer ${this.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
    const existingResponse = await fetch(`${endpoint}?state=open&head=${encodeURIComponent(`${owner}:${branchName}`)}&base=${encodeURIComponent(baseBranch)}`, {
      headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (!existingResponse.ok) throw new Error(`Could not check existing GitHub pull requests (HTTP ${existingResponse.status}).`);
    const existing = await existingResponse.json();
    if (Array.isArray(existing) && existing[0]) {
      return { number: existing[0].number, url: existing[0].html_url, reused: true };
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `LovaRPM: ${String(prompt).replace(/\s+/g, " ").slice(0, 60)}`,
        body: `Automated coding task ${taskId}.\n\nChanges were executed and validated in an isolated workspace.`,
        head: branchName,
        base: baseBranch,
        draft: false,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(`Could not create GitHub pull request (HTTP ${response.status}): ${String(payload?.message || "GitHub rejected the request.")}`);
    }
    const pullRequest = await response.json();
    return { number: pullRequest.number, url: pullRequest.html_url, reused: false };
  }

  async close() {
    const result = await runProcess("docker", ["rm", "-f", this.containerName], { timeoutMs: 30_000 });
    if (result.exitCode !== 0 && !/no such container|no such object/i.test(`${result.stderr} ${result.stdout}`)) {
      throw new Error(`Could not stop the isolated task container: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  async cancel() {
    this.abortController.abort();
    await this.close();
  }
}

export async function recoverInterruptedWorkspace({ workspaceRoot, secretRoot, taskId }) {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error("Invalid interrupted task ID.");
  const containerName = `lovarpm-${taskId.replaceAll("-", "").slice(0, 20)}`;
  const removed = await runProcess("docker", ["rm", "-f", containerName], { timeoutMs: 30_000 });
  if (removed.exitCode !== 0 && !/no such container/i.test(`${removed.stderr} ${removed.stdout}`)) {
    throw new Error(`Could not stop orphaned task container: ${removed.stderr.trim() || removed.stdout.trim()}`);
  }
  const workspace = new DockerWorkspace({
    root: workspaceRoot,
    secretRoot,
    taskId,
    repository: "recovery/workspace",
    branch: "main",
  });
  await workspace.restoreSecrets();
}
