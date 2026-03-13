/**
 * Popup script — handles manual "save this page" and settings UI.
 */

// ============================================================================
// DOM refs
// ============================================================================

const views = {
  save: document.getElementById("view-save"),
  saving: document.getElementById("view-saving"),
  saved: document.getElementById("view-saved"),
  error: document.getElementById("view-error"),
  noPage: document.getElementById("view-no-page"),
};

const els = {
  pageTitle: document.getElementById("page-title"),
  pageUrl: document.getElementById("page-url"),
  saveBtn: document.getElementById("save-btn"),
  retryBtn: document.getElementById("retry-btn"),
  readerLink: document.getElementById("reader-link"),
  errorMessage: document.getElementById("error-message"),
  pollingToggle: document.getElementById("polling-toggle"),
  pollerStatus: document.getElementById("poller-status"),
  tokenInput: document.getElementById("token-input"),
  saveTokenBtn: document.getElementById("save-token-btn"),
  tokenMissing: document.getElementById("token-missing"),
};

// Current page state
let currentTab = null;

// ============================================================================
// View management
// ============================================================================

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle("hidden", key !== name);
  }
}

// ============================================================================
// Init
// ============================================================================

async function init() {
  // Load token
  const token = await getToken();
  if (token) {
    els.tokenInput.value = "••••••••••••••••";
    els.tokenMissing.classList.add("hidden");
  } else {
    els.tokenMissing.classList.remove("hidden");
  }

  // Load polling state
  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
  els.pollingToggle.checked = pollingEnabled !== false;

  // Get background status
  try {
    const status = await browser.runtime.sendMessage({ type: "GET_STATUS" });
    updatePollerStatus(status);
  } catch {
    els.pollerStatus.textContent = "Background script not running";
  }

  // Get current tab
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0];

  if (
    !currentTab?.url ||
    currentTab.url.startsWith("about:") ||
    currentTab.url.startsWith("moz-extension:") ||
    currentTab.url.startsWith("chrome:")
  ) {
    showView("noPage");
    return;
  }

  // Show page info
  els.pageTitle.textContent = currentTab.title || "Untitled";
  els.pageUrl.textContent = new URL(currentTab.url).hostname;
  showView("save");
}

function updatePollerStatus(status) {
  if (!status.hasToken) {
    els.pollerStatus.textContent = "Set your Readwise token to enable.";
    return;
  }
  if (status.pollerActive) {
    els.pollerStatus.textContent = `Active — ${status.processedCount} articles enriched this session.`;
  } else {
    els.pollerStatus.textContent = "Paused.";
  }
}

// ============================================================================
// Save current page
// ============================================================================

async function savePage() {
  if (!currentTab?.url) return;

  const token = await getToken();
  if (!token) {
    els.tokenMissing.classList.remove("hidden");
    return;
  }

  showView("saving");

  try {
    // Extract the full page HTML from the current tab
    const results = await browser.tabs.executeScript(currentTab.id, {
      code: `document.documentElement.outerHTML`,
    });

    const html = results?.[0];
    if (!html) throw new Error("Could not extract page content");

    // Clean the URL
    const articleUrl = stripTracking(currentTab.url);

    // Send to background for API call
    const result = await browser.runtime.sendMessage({
      type: "SAVE_PAGE",
      url: articleUrl,
      html,
      title: currentTab.title,
    });

    if (result.success) {
      showView("saved");
      if (result.url) {
        els.readerLink.href = result.url;
      }
    } else {
      throw new Error(result.error || "Unknown error");
    }
  } catch (err) {
    showView("error");
    els.errorMessage.textContent = `Error: ${err.message}`;
  }
}

/**
 * Clean tracking parameters from URLs.
 */
function stripTracking(url) {
  try {
    const parsed = new URL(url);
    // Remove common tracking params
    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
      "ref",
    ];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }
    // If no params left, clear the search string entirely
    if ([...parsed.searchParams].length === 0) {
      parsed.search = "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

// ============================================================================
// Token management
// ============================================================================

async function saveTokenAction() {
  const token = els.tokenInput.value.trim();
  if (!token || token === "••••••••••••••••") return;

  const valid = await validateToken(token);
  if (!valid) {
    alert("Invalid token. Please check and try again.");
    return;
  }

  await browser.storage.local.set({ readwiseToken: token });
  els.tokenInput.value = "••••••••••••••••";
  els.tokenInput.type = "password";
  els.tokenMissing.classList.add("hidden");

  // Start poller now that we have a token
  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
  if (pollingEnabled !== false) {
    browser.runtime.sendMessage({ type: "SET_POLLING", enabled: true });
  }
}

// ============================================================================
// Events
// ============================================================================

els.saveBtn.addEventListener("click", savePage);
els.retryBtn.addEventListener("click", savePage);
els.saveTokenBtn.addEventListener("click", saveTokenAction);

els.pollingToggle.addEventListener("change", async () => {
  const enabled = els.pollingToggle.checked;
  const result = await browser.runtime.sendMessage({
    type: "SET_POLLING",
    enabled,
  });
  if (result.success) {
    const status = await browser.runtime.sendMessage({ type: "GET_STATUS" });
    updatePollerStatus(status);
  }
});

els.tokenInput.addEventListener("focus", () => {
  if (els.tokenInput.value === "••••••••••••••••") {
    els.tokenInput.value = "";
    els.tokenInput.type = "text";
  }
});

els.tokenInput.addEventListener("blur", async () => {
  const token = await getToken();
  if (token && !els.tokenInput.value.trim()) {
    els.tokenInput.value = "••••••••••••••••";
    els.tokenInput.type = "password";
  }
});

// ============================================================================
// Start
// ============================================================================

init();
