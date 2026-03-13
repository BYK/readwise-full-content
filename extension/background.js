/**
 * Background script — polls Readwise for thin/paywalled documents and
 * enriches them with full page content by loading them in background tabs.
 *
 * Only runs on desktop (Firefox Android doesn't support persistent background
 * scripts or programmatic tab management in the same way).
 */

// ============================================================================
// Constants
// ============================================================================

/** Poll interval in minutes */
const POLL_INTERVAL_MINUTES = 2;

/** Minimum word count to consider a document "complete" */
const MIN_WORD_COUNT = 100;

/** How many recent documents to check per poll */
const DOCS_TO_CHECK = 20;

/** How long to wait for a page to load before extracting (ms) */
const PAGE_LOAD_TIMEOUT = 15000;

/** Cooldown: don't re-process the same URL within this window (ms) */
const PROCESS_COOLDOWN = 60 * 60 * 1000; // 1 hour

// ============================================================================
// State
// ============================================================================

/**
 * Track recently processed URLs to avoid re-processing.
 * Map<url, timestamp>
 */
const processedUrls = new Map();

/** Whether the background poller is active */
let pollerActive = false;

// ============================================================================
// Polling logic
// ============================================================================

/**
 * Check recent Readwise documents and enrich any that look thin.
 */
async function pollAndEnrich() {
  const token = await getToken();
  if (!token) return;

  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
  if (pollingEnabled === false) return;

  try {
    // Fetch recent documents
    const docs = await listDocuments(token, {
      limit: DOCS_TO_CHECK,
    });

    for (const doc of docs) {
      // Skip if already processed recently
      if (isRecentlyProcessed(doc.source_url)) continue;

      // Skip if it already has decent content
      if (doc.word_count >= MIN_WORD_COUNT) continue;

      // Skip non-web content (PDFs, tweets, etc.)
      if (doc.category !== "article" && doc.category !== "rss") continue;

      // Skip if no source URL
      if (!doc.source_url) continue;

      // Skip readwise.io URLs and other internal URLs
      try {
        const url = new URL(doc.source_url);
        if (url.hostname.includes("readwise.io")) continue;
        if (url.hostname.includes("read.readwise.io")) continue;
      } catch {
        continue;
      }

      console.log(
        `[readwise-full-content] Enriching: ${doc.title} (${doc.word_count} words) — ${doc.source_url}`,
      );

      try {
        await enrichDocument(token, doc);
        markProcessed(doc.source_url);
      } catch (err) {
        if (err.message?.startsWith("RATE_LIMITED")) {
          console.warn("[readwise-full-content] Rate limited, backing off");
          return; // Stop processing, wait for next poll
        }
        console.error(
          `[readwise-full-content] Failed to enrich ${doc.source_url}:`,
          err.message,
        );
        // Mark as processed to avoid retrying immediately
        markProcessed(doc.source_url);
      }
    }
  } catch (err) {
    if (err.message?.startsWith("RATE_LIMITED")) {
      console.warn("[readwise-full-content] Rate limited during list, backing off");
      return;
    }
    console.error("[readwise-full-content] Poll error:", err);
  }
}

/**
 * Enrich a single document by loading it in a background tab,
 * extracting the full page HTML, and pushing it to Readwise.
 */
async function enrichDocument(token, doc) {
  const html = await extractPageHtml(doc.source_url);
  if (!html) {
    console.warn(`[readwise-full-content] No HTML extracted from ${doc.source_url}`);
    return;
  }

  // Replace the thin document with the full-content version.
  // Let Readwise clean the HTML (it's good at extracting article content
  // from full page HTML, stripping nav/ads/etc.).
  await replaceDocument(token, doc.id, {
    url: doc.source_url,
    html,
    should_clean_html: true,
    title: doc.title,
    author: doc.author,
    summary: doc.summary,
    published_date: doc.published_date,
    image_url: doc.image_url,
    location: doc.location,
    category: "article",
    saved_using: "readwise-full-content",
  });

  console.log(`[readwise-full-content] Enriched: ${doc.title}`);
}

/**
 * Load a URL in a background tab, wait for it to finish loading,
 * extract the full page HTML, then close the tab.
 *
 * This works because the tab runs in the user's browser session,
 * inheriting all cookies (subscriber sessions, Cloudflare clearance, etc.).
 */
async function extractPageHtml(url) {
  let tab;
  try {
    // Create a background tab (not active — doesn't steal focus)
    tab = await browser.tabs.create({ url, active: false });

    // Wait for the tab to finish loading
    await waitForTabLoad(tab.id);

    // Give JS-rendered content a moment to hydrate
    await new Promise((r) => setTimeout(r, 2000));

    // Execute content script to extract HTML
    const results = await browser.tabs.executeScript(tab.id, {
      code: `document.documentElement.outerHTML`,
    });

    return results?.[0] || null;
  } finally {
    // Always close the background tab
    if (tab?.id) {
      try {
        await browser.tabs.remove(tab.id);
      } catch {
        // Tab may already be closed
      }
    }
  }
}

/**
 * Wait for a tab to reach "complete" loading state, with timeout.
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      // Resolve anyway — partial content is better than nothing
      resolve();
    }, PAGE_LOAD_TIMEOUT);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    browser.tabs.onUpdated.addListener(listener);

    // Check if already complete
    browser.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timeout);
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(reject);
  });
}

// ============================================================================
// Cooldown tracking
// ============================================================================

function isRecentlyProcessed(url) {
  const ts = processedUrls.get(url);
  if (!ts) return false;
  if (Date.now() - ts > PROCESS_COOLDOWN) {
    processedUrls.delete(url);
    return false;
  }
  return true;
}

function markProcessed(url) {
  processedUrls.set(url, Date.now());
  // Prune old entries
  if (processedUrls.size > 200) {
    const cutoff = Date.now() - PROCESS_COOLDOWN;
    for (const [key, ts] of processedUrls) {
      if (ts < cutoff) processedUrls.delete(key);
    }
  }
}

// ============================================================================
// Alarm-based polling (desktop only)
// ============================================================================

async function startPoller() {
  if (pollerActive) return;
  pollerActive = true;

  // Create an alarm that fires every POLL_INTERVAL_MINUTES
  await browser.alarms.create("readwise-poll", {
    periodInMinutes: POLL_INTERVAL_MINUTES,
  });

  // Also run immediately on start
  pollAndEnrich();
}

async function stopPoller() {
  pollerActive = false;
  await browser.alarms.clear("readwise-poll");
}

// Handle alarm fires
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "readwise-poll") {
    pollAndEnrich();
  }
});

// ============================================================================
// Message handler (from popup)
// ============================================================================

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Save current page to Readwise (mobile flow)
  if (message.type === "SAVE_PAGE") {
    (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("Readwise token not configured");

        // First try creating — if it already exists, replace it
        const result = await createDocument(token, {
          url: message.url,
          html: message.html,
          should_clean_html: true,
          title: message.title,
          author: message.author,
          location: "new",
          category: "article",
          saved_using: "readwise-full-content",
        });

        if (result.alreadyExisted) {
          // Document exists — delete and re-create with full content
          const replaced = await replaceDocument(token, result.id, {
            url: message.url,
            html: message.html,
            should_clean_html: true,
            title: message.title,
            author: message.author,
            location: "new",
            category: "article",
            saved_using: "readwise-full-content",
          });
          sendResponse({ success: true, ...replaced });
        } else {
          sendResponse({ success: true, ...result });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // async response
  }

  // Get poller status
  if (message.type === "GET_STATUS") {
    (async () => {
      const token = await getToken();
      sendResponse({
        hasToken: !!token,
        pollerActive,
        processedCount: processedUrls.size,
      });
    })();
    return true;
  }

  // Toggle polling
  if (message.type === "SET_POLLING") {
    (async () => {
      await browser.storage.local.set({ pollingEnabled: message.enabled });
      if (message.enabled) {
        await startPoller();
      } else {
        await stopPoller();
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  return false;
});

// ============================================================================
// Init
// ============================================================================

(async () => {
  const token = await getToken();
  if (!token) return;

  // Check if polling is enabled (default: true on desktop)
  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");

  // Default to enabled if not explicitly set
  if (pollingEnabled !== false) {
    await browser.storage.local.set({ pollingEnabled: true });
    startPoller();
  }
})();
