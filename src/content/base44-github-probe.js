(() => {
  if (window.__LOVARPM_BASE44_GITHUB_PROBE__) return;
  window.__LOVARPM_BASE44_GITHUB_PROBE__ = true;

  const PROJECT_RE = /\/apps\/([A-Za-z0-9-]+)/i;
  const REPOSITORY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
  let lastProjectId = "";
  let lastDirectProbeAt = 0;
  const sessionHeaders = {};

  function projectId() {
    return location.pathname.match(PROJECT_RE)?.[1] || "";
  }

  function normalize(value) {
    const text = String(value || "").trim();
    const url = text.match(/(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i);
    const candidate = url ? `${url[1]}/${url[2]}` : text.replace(/^github:/i, "").replace(/\.git$/i, "");
    return REPOSITORY_RE.test(candidate) ? candidate : "";
  }

  function publish(repository, source = "base44-api") {
    const repo = normalize(repository);
    const id = projectId();
    if (!repo || !id) return false;
    const root = document.documentElement;
    root.dataset.lovarpmBase44Repository = repo;
    root.dataset.lovarpmBase44RepositoryProject = id;
    root.dataset.lovarpmBase44RepositorySource = source;
    root.dispatchEvent(new CustomEvent("lovarpm-base44-repository", { detail: { projectId: id, repository: repo, source } }));
    return true;
  }

  function inspect(value, depth = 0, seen = new WeakSet()) {
    if (value == null || depth > 8) return "";
    if (typeof value === "string") return /github\.com|^[\w.-]+\/[\w.-]+(?:\.git)?$/i.test(value) ? normalize(value) : "";
    if (typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);

    const directKeys = ["repo_full_name", "repoFullName", "repository_full_name", "repositoryFullName", "github_repo", "githubRepo", "repo_url", "repoUrl", "repository_url", "repositoryUrl", "clone_url", "cloneUrl"];
    for (const key of directKeys) {
      const repo = normalize(value[key]);
      if (repo) return repo;
    }

    const owner = String(value.org_name || value.owner_name || value.owner?.login || value.organization?.login || "").trim();
    const name = String(value.repo_name || value.repository_name || value.repository?.name || "").trim();
    const paired = normalize(owner && name ? `${owner}/${name}` : "");
    if (paired) return paired;

    for (const [key, child] of Object.entries(value)) {
      if (depth < 3 || /github|repo|connection|integration|clone/i.test(key)) {
        const repo = inspect(child, depth + 1, seen);
        if (repo) return repo;
      }
    }
    return "";
  }

  async function inspectResponse(response, source) {
    try {
      const type = response.headers?.get?.("content-type") || "";
      if (!/json/i.test(type)) return;
      const data = await response.clone().json();
      const repo = inspect(data);
      if (repo) publish(repo, source);
    } catch {}
  }

  async function directProbe({ force = false } = {}) {
    const id = projectId();
    if (!id) return;
    const now = Date.now();
    if (!force && id === lastProjectId && now - lastDirectProbeAt < 15000) return;
    lastProjectId = id;
    lastDirectProbeAt = now;
    try {
      const response = await originalFetch(`/api/apps/${encodeURIComponent(id)}/github/connection`, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json", ...sessionHeaders },
      });
      if (!response.ok) return;
      const data = await response.json();
      if (data?.connected !== false) publish(data?.repo_full_name || data?.repo_url || inspect(data), "base44-github-connection");
    } catch {}
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    try {
      const requestUrl = new URL(String(args[0]?.url || args[0] || ""), location.href);
      if (requestUrl.origin === location.origin && /\/api\//i.test(requestUrl.pathname)) {
        const headers = new Headers(args[1]?.headers || args[0]?.headers || {});
        const authorization = headers.get("authorization");
        const apiKey = headers.get("api_key") || headers.get("x-api-key");
        if (authorization) sessionHeaders.Authorization = authorization;
        if (apiKey) sessionHeaders.api_key = apiKey;
      }
    } catch {}
    const response = await originalFetch(...args);
    const url = String(args[0]?.url || args[0] || "");
    if (/\/api\/apps\//i.test(url)) void inspectResponse(response, /github/i.test(url) ? "base44-github-api" : "base44-app-api");
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__lovarpmBase44Url = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    let sameOriginApi = false;
    try { const url = new URL(this.__lovarpmBase44Url || "", location.href); sameOriginApi = url.origin === location.origin && /\/api\//i.test(url.pathname); } catch {}
    if (sameOriginApi && /^authorization$/i.test(String(name || ""))) sessionHeaders.Authorization = String(value || "");
    if (sameOriginApi && /^(?:api_key|x-api-key)$/i.test(String(name || ""))) sessionHeaders.api_key = String(value || "");
    return originalSetRequestHeader.call(this, name, value);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    if (/\/api\/apps\//i.test(this.__lovarpmBase44Url || "")) {
      this.addEventListener("load", () => {
        try {
          const data = typeof this.response === "object" && this.response ? this.response : JSON.parse(this.responseText || "null");
          const repo = inspect(data);
          if (repo) publish(repo, /github/i.test(this.__lovarpmBase44Url) ? "base44-github-xhr" : "base44-app-xhr");
        } catch {}
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };

  document.documentElement.addEventListener("lovarpm-base44-force-repository-refresh", () => void directProbe({ force: true }));
  addEventListener("popstate", () => void directProbe({ force: true }));
  addEventListener("hashchange", () => void directProbe({ force: true }));
  setInterval(() => void directProbe(), 2500);
  void directProbe({ force: true });
})();
