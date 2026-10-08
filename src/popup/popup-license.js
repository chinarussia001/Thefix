(() => {
  const licenseMeta = document.querySelector(".license-meta");
  if (licenseMeta) licenseMeta.textContent = "LovaRPM securely verifies license status when protected work is requested.";
  const gate = document.getElementById("licenseGate");
  const shell = document.querySelector(".app-shell");
  const form = document.getElementById("licenseForm");
  const input = document.getElementById("licenseKeyInput");
  const button = document.getElementById("licenseActivateButton");
  const feedback = document.getElementById("licenseFeedback");
  const resetButton = document.getElementById("licenseResetButton");
  const summary = document.getElementById("licenseDetailsSummary");
  const expiryValue = document.getElementById("licenseDetailsExpiryValue");
  const statusValue = document.getElementById("licenseDetailsStatusValue");
  const customerNameInput = document.getElementById("licenseCustomerNameInput");
  let lastStatus = null;

  customerNameInput?.closest(".license-field")?.remove();
  const resetLabel = resetButton?.querySelector("span");
  if (resetLabel) resetLabel.textContent = "Deactivate this device";
  if (resetButton) resetButton.title = "Deactivate this device from LovaRPM.";
  resetButton?.nextElementSibling?.remove();
  const customerLabel = document.querySelector("#licenseDetailsSummary > div:first-child > span");
  if (customerLabel) customerLabel.textContent = "PRODUCT";
  const notice = document.querySelector(".license-notice span");
  if (notice) notice.textContent = "Enter your LovaRPM license key to activate the extension.";
  const keyLabel = document.querySelector("label[for='licenseKeyInput'] span") || input?.closest("label")?.querySelector("span");
  if (keyLabel) keyLabel.textContent = "LOVARPM LICENSE KEY";
  if (input) {
    input.placeholder = "LXC-XXXXX-XXXXX-XXXXX-XXXXX";
    input.maxLength = 100;
  }
  const cloudBadge = document.querySelector(".license-cloud-badge");
  if (cloudBadge) cloudBadge.textContent = "LOVARPM";

  if (summary && expiryValue && statusValue) {
    const clientBlock = summary.firstElementChild;
    const statusLabel = summary.querySelector(".license-summary-status-label");
    const clientLabel = clientBlock?.querySelector(":scope > span");
    const clientName = clientBlock?.querySelector(":scope > strong");
    if (clientLabel) clientLabel.textContent = "PRODUCT";
    const expiryRow = document.createElement("div"); expiryRow.className = "license-expiry-row";
    const expiryLabel = document.createElement("span"); expiryLabel.textContent = "Expires:"; expiryRow.append(expiryLabel, expiryValue);
    const statusRow = document.createElement("div"); statusRow.className = "license-status-row"; if (statusLabel) statusRow.append(statusLabel); statusRow.append(statusValue);
    const left = document.createElement("div"); left.className = "license-client-block"; if (clientLabel) left.append(clientLabel); if (clientName) left.append(clientName);
    const right = document.createElement("div"); right.className = "license-status-stack"; right.append(expiryRow, statusRow);
    summary.replaceChildren(left, right);
  }

  const setFeedback = (text, state = "error") => { if (feedback) { feedback.textContent = text || ""; feedback.dataset.state = state; } };

  const renderLicenseSummary = async (status) => {
    if (!summary) return;
    const valid = Boolean(status?.valid);
    summary.hidden = !valid;
    if (!valid) return;
    summary.style.display = "grid";
    const name = summary.querySelector("[data-license-name]");
    if (name) name.textContent = "LovaRPM";
    if (expiryValue) {
      const date = status.expiresAt ? new Date(status.expiresAt) : null;
      expiryValue.textContent = date && !Number.isNaN(date.getTime()) ? date.toLocaleString("en-US", { dateStyle:"short", timeStyle:"short" }) : "—";
    }
    if (statusValue) {
      statusValue.textContent = "ACTIVE";
      statusValue.dataset.state = "active";
    }
  };

  const setGate = (locked) => {
    if (gate) {
      gate.hidden = !locked;
      gate.style.removeProperty("display");
    }
    if (shell) {
      shell.dataset.licenseLocked = String(locked);
      shell.dataset.licenseReady = "true";
    }
    if (resetButton) resetButton.hidden = locked;
  };

  const showStatus = (status) => {
    lastStatus = status || null;
    const valid = status?.valid === true && status?.code === "active";
    setGate(!valid);
    if (valid) {
      renderLicenseSummary(status);
      setFeedback("");
    } else {
      renderLicenseSummary(null);
      if (status?.message) setFeedback(status.message, status.code === "unlicensed" ? "warning" : "error");
    }
  };

  async function loadStatus(force = false) {
    setGate(true);
    try {
      const response = await chrome.runtime.sendMessage({ type:"LOVARPM_LICENSE_STATUS", force });
      showStatus(response?.status || { valid:false, code:"provider_error", message:"Could not verify the license." });
    } catch {
      showStatus({ valid:false, code:"provider_error", message:"Could not verify the license. Protected features remain locked." });
    }
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = String(input?.value || "").trim().toUpperCase();
    if (key.length < 16 || key.length > 100) return setFeedback("Enter your LovaRPM license key.");
    button.disabled = true;
    setFeedback("Activating your LovaRPM license…", "warning");
    try {
      const response = await chrome.runtime.sendMessage({ type:"LOVARPM_LICENSE_ACTIVATE", key });
      const status = response?.status || { valid:false, code:"provider_error", message:"Could not activate the license." };
      showStatus(status);
      if (status.valid) setFeedback("License activated.", "success");
    } catch { showStatus({ valid:false, code:"provider_error", message:"Could not connect to the license service. Protected features remain locked." }); }
    finally { button.disabled = false; }
  });

  resetButton?.addEventListener("click", async () => {
    if (!lastStatus?.valid || !window.confirm("Deactivate this device? LovaRPM protected features will lock on this device.")) return;
    resetButton.disabled = true;
    setFeedback("Deactivating this device…", "warning");
    try {
      const response = await chrome.runtime.sendMessage({ type:"LOVARPM_LICENSE_DEACTIVATE" });
      showStatus(response?.status || { valid:false, code:"provider_error", message:"Could not deactivate this device." });
    } catch { showStatus({ valid:false, code:"provider_error", message:"Could not connect to the license service. The current license state could not be changed." }); }
    finally { resetButton.disabled = false; }
  });

  chrome.storage.local.get("happyLittleLicenseKey").then((stored) => {
    if (input && stored.happyLittleLicenseKey) input.value = stored.happyLittleLicenseKey;
  });

  loadStatus(true);
})();
