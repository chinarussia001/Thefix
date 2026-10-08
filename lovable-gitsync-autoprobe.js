(() => {
  if (window.__LOVABURST_GITSYNC_AUTOPROBE__) return;
  window.__LOVABURST_GITSYNC_AUTOPROBE__ = true;

  const downstreamFetch = window.fetch;
  const attempts = new Set();

  let observedWorkspaceId = "";
  let latestRequestContext = null;
  let lastProjectId = currentProjectId();

  function currentProjectId() {
    return location.pathname.match(/\/projects\/([A-Za-z0-9-]+)/i)?.[1] || "";
  }

  function parseUrl(value) {
    try {
      return new URL(String(value || ""), location.href);
    } catch {
      return null;
    }
  }

  function workspaceIdFromUrl(value) {
    const url = parseUrl(value);
    return url?.pathname.match(/\/workspaces\/(workspace_[A-Za-z0-9]+)/i)?.[1] || "";
  }

  function projectIdFromUrl(value) {
    const url = parseUrl(value);
    return url?.pathname.match(/\/projects\/([A-Za-z0-9-]+)/i)?.[1] || "";
  }

  function isLovableApi(value) {
    return parseUrl(value)?.hostname === "api.lovable.dev";
  }

  function isGitsync(value) {
    return /\/gitsync\/?$/i.test(parseUrl(value)?.pathname || "");
  }

  function normalizeRepository(value) {
    if (!value) return "";
    const match = String(value).match(
      /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#\]\)\s"'<>]|$)/i
    );
    return match ? `${match[1]}/${match[2].replace(/\.git$/i, "")}` : "";
  }

  function normalizeIdentity(value) {
    const text = String(value || "").trim();
    return /^[A-Za-z0-9_.-]{2,100}$/.test(text) ? text : "";
  }

  function repositoryFromConfig(payload) {
    const config = payload?.config;
    if (!config || typeof config !== "object") return "";

    const fromUrl = normalizeRepository(config.repo_url);
    if (fromUrl) return fromUrl;

    const owner = normalizeIdentity(config.owner_name);
    const repoName = normalizeIdentity(config.repo_name);
    return owner && repoName ? `${owner}/${repoName}` : "";
  }

  function clearPublishedRepository() {
    const root = document.documentElement;
    if (!root) return;

    delete root.dataset.lovaburstRepository;
    delete root.dataset.lovaburstRepositorySource;
    delete root.dataset.lovaburstRepositoryProject;
    delete root.dataset.lovaburstGitsyncRepository;
  }

  function publish(repository, projectId) {
    if (!repository || !projectId) return;
    const root = document.documentElement;
    if (!root) return;

    root.dataset.lovaburstRepository = repository;
    root.dataset.lovaburstRepositorySource = "lovable-gitsync";
    root.dataset.lovaburstRepositoryProject = projectId;
    root.dataset.lovaburstGitsyncRepository = repository;
  }

  async function inspectGitsyncResponse(response, projectId) {
    try {
      if (!response?.ok) return "";
      const contentType = response.headers?.get("content-type") || "";
      if (!/json/i.test(contentType)) return "";

      const payload = await response.clone().json();
      const repository = repositoryFromConfig(payload);

      if (repository) publish(repository, projectId);
      return repository;
    } catch {
      return "";
    }
  }

  function requestUrl(input, response) {
    if (typeof input === "string" || input instanceof URL) return String(input);
    return input?.url || response?.url || "";
  }

  function probeInit(input, init = {}) {
    const request = input instanceof Request ? input : null;
    const headers = init?.headers || request?.headers;
    const credentials = init?.credentials || request?.credentials || "include";

    return {
      method: "GET",
      ...(headers ? { headers } : {}),
      credentials,
      cache: "no-store",
      redirect: init?.redirect || request?.redirect || "follow",
      mode: init?.mode || request?.mode || "cors",
      ...(init?.referrer || request?.referrer
        ? { referrer: init?.referrer || request?.referrer }
        : {}),
      ...(init?.referrerPolicy || request?.referrerPolicy
        ? { referrerPolicy: init?.referrerPolicy || request?.referrerPolicy }
        : {}),
    };
  }

  async function tryProbe() {
    const projectId = currentProjectId();
    if (!projectId || !observedWorkspaceId || !latestRequestContext) return;

    const root = document.documentElement;
    if (
      root?.dataset?.lovaburstRepository &&
      root?.dataset?.lovaburstRepositoryProject === projectId
    ) {
      return;
    }

    const key = `${observedWorkspaceId}:${projectId}`;
    if (attempts.has(key)) return;
    attempts.add(key);

    const target =
      `https://api.lovable.dev/workspaces/${observedWorkspaceId}` +
      `/projects/${projectId}/gitsync`;

    try {
      const response = await downstreamFetch(
        target,
        probeInit(latestRequestContext.input, latestRequestContext.init),
      );
      await inspectGitsyncResponse(response, projectId);
    } catch {
      attempts.delete(key);
    }
  }

  function handleProjectChange() {
    const projectId = currentProjectId();
    if (projectId === lastProjectId) return;

    lastProjectId = projectId;
    clearPublishedRepository();

    if (projectId) {
      queueMicrotask(tryProbe);
      window.setTimeout(tryProbe, 250);
      window.setTimeout(tryProbe, 900);
    }
  }

  function observeRequest(input, init, url) {
    if (!isLovableApi(url) || isGitsync(url)) return;

    latestRequestContext = {
      input,
      init: init || {},
    };

    const workspace = workspaceIdFromUrl(url);
    if (workspace) observedWorkspaceId = workspace;

    handleProjectChange();
    tryProbe();
  }

  if (typeof downstreamFetch === "function") {
    window.fetch = async function (...args) {
      const response = await downstreamFetch.apply(this, args);
      const url = requestUrl(args[0], response);

      handleProjectChange();

      if (isGitsync(url)) {
        const projectId = projectIdFromUrl(url) || currentProjectId();
        inspectGitsyncResponse(response, projectId);
      } else {
        observeRequest(args[0], args[1] || {}, url);
      }

      return response;
    };
  }

  function onNavigation() {
    handleProjectChange();
  }

  const nativePushState = history.pushState;
  history.pushState = function (...args) {
    const result = nativePushState.apply(this, args);
    queueMicrotask(onNavigation);
    return result;
  };

  const nativeReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const result = nativeReplaceState.apply(this, args);
    queueMicrotask(onNavigation);
    return result;
  };

  addEventListener("popstate", onNavigation);

  document.addEventListener("lovaburst-force-repository-refresh", () => {
    const projectId = currentProjectId();
    if (!projectId || !observedWorkspaceId) return;

    attempts.delete(`${observedWorkspaceId}:${projectId}`);
    clearPublishedRepository();
    queueMicrotask(tryProbe);
    window.setTimeout(tryProbe, 180);
    window.setTimeout(tryProbe, 650);
  });

  // Fallback para mudanças de rota feitas pelo SPA que não disparem um evento
  // de navegação observável pela extensão.
  window.setInterval(handleProjectChange, 350);

  handleProjectChange();
})();
