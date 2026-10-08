(() => {
  if (window.__LOVABURST_GITSYNC_STICKY__) return;
  window.__LOVABURST_GITSYNC_STICKY__ = true;

  const ROOT = document.documentElement;
  const DIAGNOSTICS_ATTRIBUTE = "data-lovaburst-api-diagnostics";

  function normalizeRepository(value) {
    if (!value) return "";
    const match = String(value).match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:[/?#\]\)\s"'<>]|$)/i);
    if (!match) return "";
    return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
  }

  function normalizeIdentity(value) {
    const text = String(value || "").trim();
    return /^[A-Za-z0-9_.-]{2,100}$/.test(text) ? text : "";
  }

  function readRepository() {
    if (!ROOT) return "";

    let diagnostics;
    try {
      diagnostics = JSON.parse(ROOT.dataset.lovaburstApiDiagnostics || "[]");
    } catch {
      return "";
    }

    if (!Array.isArray(diagnostics)) return "";

    const gitsync = diagnostics
      .slice()
      .reverse()
      .find((entry) => /\/gitsync\/?$/i.test(String(entry?.endpoint || "")) && Array.isArray(entry?.gitsyncFields));

    if (!gitsync) return "";

    const fields = new Map(
      gitsync.gitsyncFields
        .filter((field) => typeof field?.path === "string" && typeof field?.value === "string")
        .map((field) => [field.path, field.value]),
    );

    const fromUrl = normalizeRepository(fields.get("config.repo_url"));
    if (fromUrl) return fromUrl;

    const owner = normalizeIdentity(fields.get("config.owner_name"));
    const repoName = normalizeIdentity(fields.get("config.repo_name"));
    return owner && repoName ? `${owner}/${repoName}` : "";
  }

  function persistRepository() {
    if (!ROOT || ROOT.dataset.lovaburstRepository) return;
    const repository = readRepository();
    if (!repository) return;

    ROOT.dataset.lovaburstRepository = repository;
    ROOT.dataset.lovaburstRepositorySource = "lovable-gitsync";
    ROOT.dataset.lovaburstGitsyncRepository = repository;
  }

  persistRepository();

  if (ROOT) {
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.attributeName === DIAGNOSTICS_ATTRIBUTE)) {
        persistRepository();
      }
    });

    observer.observe(ROOT, {
      attributes: true,
      attributeFilter: [DIAGNOSTICS_ATTRIBUTE],
    });
  }
})();
