const DEFAULTS = { ssoPortal: "" };

function load() {
  if (!chrome?.storage?.sync) {
    console.warn("chrome.storage.sync unavailable — reload the extension.");
    return;
  }
  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    document.getElementById("ssoPortal").value = cfg.ssoPortal || "";
  });
}

function save() {
  const raw = document.getElementById("ssoPortal").value.trim();
  // Accept "org-sso", "org-sso.awsapps.com", or full URL — keep just the subdomain.
  const ssoPortal = raw
    .replace(/^https?:\/\//i, "")
    .replace(/\.awsapps\.com.*$/i, "")
    .replace(/\/.*$/, "");

  if (!chrome?.storage?.sync) {
    console.warn("chrome.storage.sync unavailable — reload the extension.");
    return;
  }
  chrome.storage.sync.set({ ssoPortal }, () => {
    const status = document.getElementById("status");
    status.textContent = ssoPortal ? `Saved: ${ssoPortal}.awsapps.com` : "Cleared.";
    setTimeout(() => (status.textContent = ""), 2000);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  document.getElementById("saveBtn").addEventListener("click", save);
});
