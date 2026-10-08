// Runtime integrity disabled for unlocked build
globalThis.LovaRPMRuntimeIntegrity = {
  async requireUntamperedRuntime() { return true; },
  async verify() { return { ok: true }; },
  isTrusted() { return true; },
};
async function requireUntamperedRuntime() { return true; }
globalThis.requireUntamperedRuntime = requireUntamperedRuntime;
