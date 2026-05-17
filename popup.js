// ─── URL cleaning ─────────────────────────────────────────────────────────────

function cleanAWSUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const hostnameParts = parsedUrl.hostname.split(".");
    // Multi-session adds a leading dynamic subdomain:
    //   <dynamic>.region.console.aws.amazon.com  (6 parts)  →  region.console.aws.amazon.com
    if (hostnameParts.length === 6) {
      hostnameParts.shift();
      parsedUrl.hostname = hostnameParts.join(".");
    }
    return parsedUrl.toString();
  } catch (err) {
    console.error("Invalid URL provided", err);
    return url;
  }
}

// ─── In-page extractor (runs in the AWS console tab) ──────────────────────────
// Tries multiple strategies to find {accountId, roleName}.
// Must be a self-contained function — chrome.scripting.executeScript serializes it.

function extractAwsContextInPage() {
  function stripSsoPrefix(role) {
    if (!role) return role;
    // SSO permission set roles look like "AWSReservedSSO_<RoleName>_<hex>"
    const m = role.match(/^AWSReservedSSO_(.+?)_[a-f0-9]+$/i);
    return m ? m[1] : role;
  }

  function fromArn(arn) {
    if (!arn) return null;
    // arn:aws:sts::123456789012:assumed-role/RoleName/session
    // arn:aws:iam::123456789012:role/RoleName
    // arn:aws:iam::123456789012:user/UserName
    const m = arn.match(/arn:aws:(?:sts|iam)::(\d{12}):(?:assumed-role|role|user)\/([^/]+)/);
    if (!m) return null;
    return { accountId: m[1], roleName: stripSsoPrefix(m[2]) };
  }

  // Strategy 1 (authoritative): <meta name="awsc-session-data"> contains the
  // current session's ARN under `sessionARN`. This is the only strategy that
  // distinguishes the active session from other multi-session tabs whose role
  // names also appear in the account menu.
  try {
    const meta = document.querySelector('meta[name="awsc-session-data"]');
    if (meta) {
      const data = JSON.parse(meta.getAttribute("content") || "{}");
      const arnInfo = fromArn(data.sessionARN || data.displayName);
      const accountId = data.accountId || arnInfo?.accountId || null;
      const roleName = arnInfo?.roleName || null;
      if (accountId && roleName) {
        return { accountId, roleName, source: "meta:awsc-session-data" };
      }
    }
  } catch (_) {}

  // Strategy 2: aws-userInfo cookie (rarely JS-readable — usually httpOnly —
  // but cheap to try and authoritative when present).
  try {
    const cookieMatch = document.cookie.match(/(?:^|;\s*)aws-userInfo=([^;]+)/);
    if (cookieMatch) {
      const info = JSON.parse(decodeURIComponent(cookieMatch[1]));
      const arnInfo = fromArn(info.arn);
      if (arnInfo) return { ...arnInfo, source: "cookie" };
    }
  } catch (_) {}

  // Strategy 3: alternate meta tags AWS sometimes injects.
  try {
    const meta = document.querySelector('meta[name="awsc-mezz-data"]');
    if (meta) {
      const data = JSON.parse(meta.getAttribute("content") || "{}");
      const arnInfo = fromArn(data?.arn || data?.userArn || data?.sessionARN);
      if (arnInfo) return { ...arnInfo, source: "meta:awsc-mezz-data" };
    }
  } catch (_) {}

  // No reliable source found — bail rather than guess from the multi-session
  // menu, which lists OTHER open sessions and would return the wrong role.
  return { accountId: null, roleName: null, source: null };
}

// ─── SSO URL builder ──────────────────────────────────────────────────────────

function buildSsoUrl({ ssoPortal, accountId, roleName, destination }) {
  if (!ssoPortal || !accountId || !roleName) return null;
  // SSO start URL keeps params in the hash fragment.
  return (
    `https://${ssoPortal}.awsapps.com/start/#/console` +
    `?account_id=${encodeURIComponent(accountId)}` +
    `&role_name=${encodeURIComponent(roleName)}` +
    `&destination=${encodeURIComponent(destination)}`
  );
}

// ─── Popup wiring ─────────────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function detectAwsContext(tab) {
  if (!tab?.id || !tab.url || !/aws\.amazon\.com/.test(tab.url)) {
    return { accountId: null, roleName: null, source: null };
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractAwsContextInPage,
    });
    return result || { accountId: null, roleName: null, source: null };
  } catch (err) {
    console.warn("Failed to extract AWS context", err);
    return { accountId: null, roleName: null, source: null };
  }
}

function showWarning(html) {
  const box = document.getElementById("warningBox");
  box.innerHTML = html;
  box.style.display = "block";
  const link = box.querySelector("a[data-action=settings]");
  if (link) link.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
}

async function init() {
  const urlDisplay = document.getElementById("urlDisplay");
  const copyBtn = document.getElementById("copyBtn");
  const showFullBtn = document.getElementById("showFullBtn");
  const modeToggle = document.getElementById("modeToggle");
  const ssoBtn = document.getElementById("ssoModeBtn");
  const cleanBtn = document.getElementById("cleanModeBtn");
  const detectedInfo = document.getElementById("detectedInfo");
  const settingsLink = document.getElementById("settingsLink");

  settingsLink.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  const tab = await getActiveTab();
  if (!tab?.url) { urlDisplay.textContent = "No active tab."; return; }

  const cleanUrl = cleanAWSUrl(tab.url);
  const [{ ssoPortal }, ctx] = await Promise.all([
    new Promise((res) => {
      if (chrome?.storage?.sync) {
        chrome.storage.sync.get({ ssoPortal: "" }, res);
      } else {
        console.warn("chrome.storage.sync unavailable — reload the extension.");
        res({ ssoPortal: "" });
      }
    }),
    detectAwsContext(tab),
  ]);

  const ssoUrl = buildSsoUrl({
    ssoPortal,
    accountId: ctx.accountId,
    roleName: ctx.roleName,
    destination: cleanUrl,
  });

  let mode = ssoUrl ? "sso" : "clean";

  if (!ssoPortal) {
    showWarning('No SSO portal configured. <a href="#" data-action="settings">Open settings</a> to enable SSO wrapping.');
  } else if (!ctx.accountId || !ctx.roleName) {
    const missing = [!ctx.accountId && "account ID", !ctx.roleName && "role name"].filter(Boolean).join(" and ");
    showWarning(`Couldn't detect ${missing} from this page. Open the AWS console while signed in, then reopen this popup.`);
  }

  if (ctx.accountId || ctx.roleName) {
    detectedInfo.replaceChildren();

    const acctLabel = document.createElement(ctx.accountId ? "strong" : "em");
    acctLabel.textContent = ctx.accountId || "unknown";

    const roleLabel = document.createElement(ctx.roleName ? "strong" : "em");
    roleLabel.textContent = ctx.roleName || "unknown";

    detectedInfo.append("Detected: account ", acctLabel, " · role ", roleLabel);

    if (ctx.source) {
      const sourceLabel = document.createElement("span");
      sourceLabel.style.opacity = "0.5";
      sourceLabel.textContent = `(${ctx.source})`;
      detectedInfo.append(" ", sourceLabel);
    }

    detectedInfo.style.display = "block";
  }

  if (ssoUrl) modeToggle.style.display = "flex";

  function currentUrl() { return mode === "sso" && ssoUrl ? ssoUrl : cleanUrl; }

  function render() {
    const url = currentUrl();
    const maxLen = 160;
    if (url.length > maxLen) {
      const truncated = url.slice(0, 80) + "…" + url.slice(-50);
      urlDisplay.dataset.full = url;
      urlDisplay.dataset.truncated = truncated;
      urlDisplay.textContent = truncated;
      showFullBtn.style.display = "inline-block";
      showFullBtn.textContent = "Show Full";
    } else {
      urlDisplay.dataset.full = url;
      urlDisplay.dataset.truncated = url;
      urlDisplay.textContent = url;
      showFullBtn.style.display = "none";
    }
  }

  render();

  showFullBtn.addEventListener("click", () => {
    if (urlDisplay.textContent === urlDisplay.dataset.truncated) {
      urlDisplay.textContent = urlDisplay.dataset.full;
      showFullBtn.textContent = "Show Less";
    } else {
      urlDisplay.textContent = urlDisplay.dataset.truncated;
      showFullBtn.textContent = "Show Full";
    }
  });

  function setMode(next) {
    mode = next;
    ssoBtn.classList.toggle("active", mode === "sso");
    cleanBtn.classList.toggle("active", mode === "clean");
    render();
  }
  ssoBtn.addEventListener("click", () => { if (ssoUrl) setMode("sso"); });
  cleanBtn.addEventListener("click", () => setMode("clean"));
  setMode(mode);

  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(currentUrl()).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy URL"; }, 1500);
    }).catch((err) => console.error("Failed to copy:", err));
  });
}

document.addEventListener("DOMContentLoaded", init);
