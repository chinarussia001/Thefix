(() => {
  if (window.__LOVABURST_LOVABLE_PAGE_PROBE__) return;
  window.__LOVABURST_LOVABLE_PAGE_PROBE__ = true;

  const BLOCKED = new Set([
    "settings", "marketplace", "features", "topics", "collections", "login", "signup",
    "projects", "project", "lovable", "api", "assets", "src", "public", "blob", "tree",
  ]);
  const diagnostics = new Map();
  const MAX_DIAGNOSTICS = 24;

  function sanitizeEndpoint(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      if (!/^https?:$/i.test(url.protocol)) return "";
      return `${url.hostname}${url.pathname}`.slice(0, 220);
    } catch {
      return "";
    }
  }

  function isGitsyncEndpoint(value) {
    try {
      return /\/gitsync\/?$/i.test(new URL(String(value || ""), location.href).pathname);
    } catch {
      return false;
    }
  }

  function publishDiagnostics() {
    const root = document.documentElement;
    if (!root) return;
    root.dataset.lovaburstApiDiagnostics = JSON.stringify([...diagnostics.values()].slice(-MAX_DIAGNOSTICS));
  }

  function recordDiagnostic({ url, transport, status, contentType, hints = [], gitsyncFields = [] }) {
    const endpoint = sanitizeEndpoint(url);
    if (!endpoint) return;
    const normalizedHints = [...new Set(hints)].slice(0, 8);
    const key = `${transport}:${endpoint}`;
    diagnostics.set(key, {
      endpoint,
      transport: String(transport || "unknown").slice(0, 12),
      status: Number(status) || 0,
      contentType: String(contentType || "").split(";")[0].slice(0, 60),
      hints: normalizedHints,
      ...(gitsyncFields.length ? { gitsyncFields: gitsyncFields.slice(0, 40) } : {}),
    });
    while (diagnostics.size > MAX_DIAGNOSTICS) diagnostics.delete(diagnostics.keys().next().value);
    publishDiagnostics();
  }

  function normalizeRepository(value, allowPlain = false) {
    if (!value) return "";
    const raw = String(value).trim();
    const github = raw.match(/(?:https?:\/\/)?(?:www\.)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#\s"'<>]|$)/i);
    const plain = allowPlain
      ? raw.match(/(?:^|[\s"'=:,(\[{])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:[\s"',)\]}?#]|$)/i)
      : null;
    const match = github || plain;
    if (!match) return "";

    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, "");
    if (owner.length < 2 || repo.length < 2) return "";
    if (BLOCKED.has(owner.toLowerCase()) || BLOCKED.has(repo.toLowerCase())) return "";
    return `${owner}/${repo}`;
  }

  function normalizeIdentity(value) {
    const raw = String(value || "").trim().replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9_.-]{2,100}$/.test(raw)) return "";
    if (BLOCKED.has(raw.toLowerCase())) return "";
    return raw;
  }

  function identityFromValue(value) {
    if (typeof value === "string") return normalizeIdentity(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    for (const key of ["login", "username", "slug", "name", "handle"]) {
      const identity = normalizeIdentity(value[key]);
      if (identity) return identity;
    }
    return "";
  }

  function keyId(key) {
    return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  }

  function safeDiagnosticValue(key, value) {
    const id = keyId(key);
    if (/token|secret|auth|credential|password|cookie|session|apikey|accesskey|privatekey/.test(id)) return "";
    if (!["string", "number", "boolean"].includes(typeof value)) return "";
    const raw = String(value ?? "").trim();
    if (!raw || raw.length > 140) return "";
    if (/^bearer\s/i.test(raw) || /^eyJ[A-Za-z0-9_-]+\./.test(raw) || /^(?:gh[pousr]_|github_pat_|sk-)/i.test(raw)) return "";
    return raw.replace(/[?#].*$/, "");
  }

  function collectGitsyncSchema(value) {
    const fields = [];
    const owners = new Set();
    const repoNames = new Set();
    const directRepos = new Set();

    const ownerIds = new Set([
      "owner", "ownerlogin", "repositoryowner", "repoowner", "githubowner",
      "githuborganization", "githuborg", "organization", "org", "account",
      "accountname", "githubuser", "githubusername", "repositoryownerlogin", "repoownerlogin",
    ]);
    const repoIds = new Set([
      "reponame", "repositoryname", "githubreponame", "githubrepositoryname",
      "repo", "repository", "githubrepo", "githubrepository",
    ]);

    function walk(node, path = [], depth = 0) {
      if (depth > 8 || node == null || fields.length >= 60) return;
      if (Array.isArray(node)) {
        for (let index = 0; index < Math.min(node.length, 80); index += 1) {
          walk(node[index], [...path, String(index)], depth + 1);
        }
        return;
      }
      if (typeof node !== "object") return;

      for (const [key, child] of Object.entries(node).slice(0, 220)) {
        const id = keyId(key);
        const nextPath = [...path, key];
        const pathText = nextPath.join(".").slice(0, 180);
        const parentContext = path.map(keyId).join(".");
        const relevant = /github|repo|repository|owner|account|organization|provider|gitsync|connection|installation|login|name/.test(id);
        const type = Array.isArray(child) ? "array" : child === null ? "null" : typeof child;

        if (relevant && fields.length < 60) {
          const safeValue = safeDiagnosticValue(key, child);
          fields.push({
            path: pathText,
            type,
            ...(safeValue ? { value: safeValue } : {}),
          });
        }

        if (typeof child === "string") {
          const full = normalizeRepository(child, ownerIds.has(id) || repoIds.has(id) || /github|repo|repository/.test(parentContext));
          if (full) directRepos.add(full);

          if (ownerIds.has(id)) {
            const owner = normalizeIdentity(child);
            if (owner) owners.add(owner);
          }

          if (repoIds.has(id) || (id === "name" && /github|repo|repository/.test(parentContext))) {
            const repo = normalizeIdentity(child);
            if (repo) repoNames.add(repo);
          }
        } else if (child && typeof child === "object") {
          if (ownerIds.has(id)) {
            const owner = identityFromValue(child);
            if (owner) owners.add(owner);
          }
          if (repoIds.has(id)) {
            const repo = identityFromValue(child);
            if (repo) repoNames.add(repo);
          }
          walk(child, nextPath, depth + 1);
        }
      }
    }

    walk(value);
    return {
      fields: fields.slice(0, 40),
      owners: [...owners].slice(0, 8),
      repoNames: [...repoNames].slice(0, 8),
      directRepos: [...directRepos].slice(0, 8),
    };
  }

  function uniqueGitsyncRepository(value) {
    const schema = collectGitsyncSchema(value);
    if (schema.directRepos.length === 1) return { repository: schema.directRepos[0], schema };
    if (schema.owners.length === 1 && schema.repoNames.length === 1) {
      const repository = normalizeRepository(`${schema.owners[0]}/${schema.repoNames[0]}`, true);
      if (repository) return { repository, schema };
    }
    return { repository: "", schema };
  }

  function gitsyncRepository(value, contextual = true, depth = 0) {
    if (depth > 8 || value == null) return "";
    if (typeof value === "string") return normalizeRepository(value, contextual);

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 100)) {
        const repository = gitsyncRepository(item, contextual, depth + 1);
        if (repository) return repository;
      }
      return "";
    }

    if (typeof value !== "object") return "";

    const entries = Object.entries(value).slice(0, 220);
    const fullNameKeys = new Set([
      "repositoryfullname", "repofullname", "namewithowner", "githubrepositoryfullname",
      "githubrepofullname", "repositoryurl", "repourl", "githuburl", "cloneurl", "giturl",
    ]);
    const ownerKeys = new Set([
      "owner", "repositoryowner", "repoowner", "githubowner", "githuborganization",
      "githuborg", "organization", "org", "account", "githubuser", "githubusername",
      "repositoryownerlogin", "repoownerlogin",
    ]);
    const repoKeys = new Set([
      "reponame", "repositoryname", "githubreponame", "githubrepositoryname",
      "repo", "repository", "githubrepo", "githubrepository",
    ]);

    for (const [key, child] of entries) {
      if (!fullNameKeys.has(keyId(key))) continue;
      const repository = normalizeRepository(typeof child === "string" ? child : JSON.stringify(child), true);
      if (repository) return repository;
    }

    const objectContext = contextual || entries.some(([key, child]) => {
      const id = keyId(key);
      return /github|repository|repo|gitsync|sourcecontrol|gitremote/.test(id) || String(child || "").toLowerCase() === "github";
    });

    let owner = "";
    let repoName = "";

    for (const [key, child] of entries) {
      const id = keyId(key);
      if (!owner && ownerKeys.has(id)) owner = identityFromValue(child);
      if (!repoName && repoKeys.has(id)) {
        if (typeof child === "string") {
          const full = normalizeRepository(child, true);
          if (full) return full;
          repoName = normalizeIdentity(child);
        } else if (child && typeof child === "object") {
          const full = gitsyncRepository(child, true, depth + 1);
          if (full) return full;
          repoName = identityFromValue(child);
        }
      }
    }

    if (!repoName && objectContext) repoName = normalizeIdentity(value.name);
    if (!owner && objectContext) {
      owner = identityFromValue(value.account) || identityFromValue(value.organization) || identityFromValue(value.user);
    }

    if (owner && repoName) {
      const repository = normalizeRepository(`${owner}/${repoName}`, true);
      if (repository) return repository;
    }

    for (const [key, child] of entries) {
      if (!child || typeof child !== "object") continue;
      const childContext = objectContext || /github|repository|repo|gitsync|sourcecontrol|gitremote/.test(keyId(key));
      const repository = gitsyncRepository(child, childContext, depth + 1);
      if (repository) return repository;
    }

    return "";
  }

  function repoFromObject(value, contextual = false, depth = 0) {
    if (depth > 7 || value == null) return "";
    if (typeof value === "string") return normalizeRepository(value, contextual);

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 80)) {
        const repo = repoFromObject(item, contextual, depth + 1);
        if (repo) return repo;
      }
      return "";
    }

    if (typeof value !== "object") return "";

    if (contextual) {
      const direct = [
        value.full_name, value.fullName, value.nameWithOwner, value.repositoryFullName,
        value.repoFullName, value.html_url, value.htmlUrl, value.url,
        value.clone_url, value.cloneUrl, value.git_url, value.gitUrl,
      ];
      for (const candidate of direct) {
        const repo = normalizeRepository(candidate, true);
        if (repo) return repo;
      }

      const owner =
        value.owner?.login || value.owner?.name || value.owner ||
        value.organization?.login || value.organization?.name || value.organization ||
        value.repositoryOwner || value.repoOwner;
      const name = value.name || value.repositoryName || value.repoName;
      if (typeof owner === "string" && typeof name === "string") {
        const repo = normalizeRepository(`${owner}/${name}`, true);
        if (repo) return repo;
      }
    }

    for (const [key, child] of Object.entries(value).slice(0, 180)) {
      const repoContext = contextual || /github|repository|repo|source.?control|git.?remote|git.?url/i.test(key);
      if (typeof child === "string") {
        const repo = normalizeRepository(child, repoContext);
        if (repo) return repo;
      } else if (child && typeof child === "object") {
        const repo = repoFromObject(child, repoContext, depth + 1);
        if (repo) return repo;
      }
    }
    return "";
  }

  function detectHints(text) {
    const input = String(text || "").slice(0, 500000).toLowerCase();
    const hints = [];
    if (input.includes("github")) hints.push("github");
    if (input.includes("repository")) hints.push("repository");
    if (/\brepo(?:sitory)?[_-]?(?:full[_-]?name|name|owner)?\b/.test(input)) hints.push("repo-key");
    if (/source[_-]?control|git[_-]?(?:url|remote|provider)/.test(input)) hints.push("git-metadata");
    if (/project[_-]?(?:id|uuid|slug)/.test(input)) hints.push("project-key");
    return hints;
  }

  function publish(repository, source) {
    if (!repository) return;
    const root = document.documentElement;
    if (root) {
      root.dataset.lovaburstRepository = repository;
      root.dataset.lovaburstRepositorySource = source;
    }
    window.postMessage({
      source: "LOVABURST_PAGE_PROBE",
      type: "LOVABURST_REPOSITORY_DETECTED",
      repository,
      detectionSource: source,
    }, window.location.origin);
  }

  async function inspectTextResponse(text, meta) {
    if (!text || text.length > 3000000) {
      recordDiagnostic(meta);
      return;
    }

    const hints = detectHints(text);
    let parsed = null;
    let gitsyncSchema = null;
    if (/json/i.test(meta.contentType || "")) {
      try {
        parsed = JSON.parse(text);
        if (isGitsyncEndpoint(meta.url)) gitsyncSchema = uniqueGitsyncRepository(parsed);
      } catch {}
    }

    recordDiagnostic({
      ...meta,
      hints,
      gitsyncFields: gitsyncSchema?.schema?.fields || [],
    });

    let repository = normalizeRepository(text, false);
    if (!repository && parsed) {
      if (isGitsyncEndpoint(meta.url)) {
        repository = gitsyncSchema?.repository || gitsyncRepository(parsed, true);
      }
      if (!repository) repository = repoFromObject(parsed, false);
    }
    if (!repository) {
      const contextual = text.match(/["'](?:githubRepository|repository|repo|repositoryFullName|repoFullName|nameWithOwner|gitUrl|git_url)["']\s*:\s*["']([^"']+)["']/i);
      repository = normalizeRepository(contextual?.[1], true);
    }
    if (repository) {
      publish(repository, isGitsyncEndpoint(meta.url) ? "lovable-gitsync" : meta.transport === "xhr" ? "lovable-api-xhr" : "lovable-api");
    }
  }

  async function inspectFetchResponse(response, url) {
    try {
      const contentType = response.headers.get("content-type") || "";
      const meta = { url, transport: "fetch", status: response.status, contentType };
      if (!/json|text|javascript/i.test(contentType)) {
        recordDiagnostic(meta);
        return;
      }
      const text = await response.clone().text();
      await inspectTextResponse(text, meta);
    } catch {}
  }

  if (typeof window.fetch === "function") {
    const nativeFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await nativeFetch.apply(this, args);
      const requestUrl =
        typeof args[0] === "string" || args[0] instanceof URL
          ? String(args[0])
          : args[0]?.url || response.url || "";
      inspectFetchResponse(response, requestUrl);
      return response;
    };
  }

  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;

    NativeXHR.prototype.open = function (method, url, ...rest) {
      this.__lovaburstUrl = String(url || "");
      return nativeOpen.call(this, method, url, ...rest);
    };

    NativeXHR.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        try {
          const url = this.__lovaburstUrl || this.responseURL || "";
          const contentType = this.getResponseHeader("content-type") || "";
          const meta = { url, transport: "xhr", status: this.status, contentType };
          if (this.responseType && !["", "text", "json"].includes(this.responseType)) {
            recordDiagnostic(meta);
            return;
          }

          if (this.responseType === "json" && this.response) inspectTextResponse(JSON.stringify(this.response), meta);
          else inspectTextResponse(String(this.responseText || ""), meta);
        } catch {}
      }, { once: true });
      return nativeSend.apply(this, args);
    };
  }

  publishDiagnostics();
})();
