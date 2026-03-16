/**
 * Background script — polls Readwise for thin/paywalled documents and
 * enriches them with full page content by loading them in background tabs.
 */

// ============================================================================
// Constants
// ============================================================================

/** Poll interval in minutes */
const POLL_INTERVAL_MINUTES = 2;

/**
 * Minimum word count to consider a document "complete".
 * Paywalled excerpts are typically 150-400 words.
 * Most full articles are 800+ words.
 */
const MIN_WORD_COUNT = 500;

/** How many recent documents to check per poll */
const DOCS_TO_CHECK = 20;

/** How long to wait for a page to load before extracting (ms) */
const PAGE_LOAD_TIMEOUT = 15000;

/** Cooldown: don't re-process the same URL within this window (ms) */
const PROCESS_COOLDOWN = 24 * 60 * 60 * 1000; // 24 hours

/** How far back to look for documents to enrich (ms) */
const LOOKBACK_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Minimum HTML size (bytes) to consider an extraction successful.
 * Cloudflare challenge pages are typically small (~5-15KB).
 * Real article pages are usually 50KB+.
 */
const MIN_HTML_SIZE = 30000;

// ============================================================================
// State — persisted to storage to survive event page unloads
// ============================================================================

/**
 * Get the set of recently processed URLs from storage.
 * @returns {Promise<Record<string, number>>} Map of URL → timestamp
 */
async function getProcessedUrls() {
  const { processedUrls } = await browser.storage.local.get("processedUrls");
  return processedUrls || {};
}

async function markProcessed(url) {
  const urls = await getProcessedUrls();
  urls[url] = Date.now();

  // Prune entries older than cooldown
  const cutoff = Date.now() - PROCESS_COOLDOWN;
  for (const [key, ts] of Object.entries(urls)) {
    if (ts < cutoff) delete urls[key];
  }

  await browser.storage.local.set({ processedUrls: urls });
}

async function isRecentlyProcessed(url) {
  const urls = await getProcessedUrls();
  const ts = urls[url];
  if (!ts) return false;
  return Date.now() - ts < PROCESS_COOLDOWN;
}

async function getEnrichCount() {
  const urls = await getProcessedUrls();
  return Object.keys(urls).length;
}

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

  console.log("[readwise-full-content] Polling for thin documents...");

  try {
    // Fetch documents updated recently
    const lookbackDate = new Date(Date.now() - LOOKBACK_WINDOW).toISOString();
    const docs = await listDocuments(token, {
      updatedAfter: lookbackDate,
      limit: DOCS_TO_CHECK,
    });

    console.log(
      `[readwise-full-content] Found ${docs.length} recent documents`,
    );

    let enriched = 0;
    let skipped = 0;

    for (const doc of docs) {
      // Skip if already processed recently
      if (await isRecentlyProcessed(doc.source_url)) {
        skipped++;
        continue;
      }

      // Skip if it already has decent content
      if (doc.word_count >= MIN_WORD_COUNT) continue;

      // Skip non-web content (PDFs, tweets, etc.)
      const validCategories = ["article", "rss", "email"];
      if (!validCategories.includes(doc.category)) continue;

      // Skip if no source URL
      if (!doc.source_url) continue;

      // Skip internal URLs
      try {
        const url = new URL(doc.source_url);
        if (url.hostname.includes("readwise.io")) continue;
        if (url.hostname.includes("read.readwise.io")) continue;
        // Skip non-http(s) URLs
        if (!url.protocol.startsWith("http")) continue;
      } catch {
        continue;
      }

      console.log(
        `[readwise-full-content] Enriching: "${doc.title}" (${doc.word_count} words) — ${doc.source_url}`,
      );

      try {
        const success = await enrichDocument(token, doc);
        await markProcessed(doc.source_url);
        if (success) enriched++;
      } catch (err) {
        if (err.message?.startsWith("RATE_LIMITED")) {
          console.warn("[readwise-full-content] Rate limited, will retry next poll");
          return;
        }
        console.error(
          `[readwise-full-content] Failed to enrich "${doc.title}":`,
          err.message,
        );
        // Mark as processed to avoid retrying immediately
        await markProcessed(doc.source_url);
      }
    }

    console.log(
      `[readwise-full-content] Poll complete: ${enriched} enriched, ${skipped} already processed`,
    );
  } catch (err) {
    if (err.message?.startsWith("RATE_LIMITED")) {
      console.warn("[readwise-full-content] Rate limited during list, will retry next poll");
      return;
    }
    console.error("[readwise-full-content] Poll error:", err);
  }
}

/**
 * Enrich a single document by loading it in a background tab,
 * extracting the full page HTML, and pushing it to Readwise.
 *
 * Returns true if enrichment succeeded, false if skipped.
 */
async function enrichDocument(token, doc) {
  const result = await extractPageHtml(doc.source_url);

  if (!result?.html) {
    console.warn(
      `[readwise-full-content] No HTML extracted from ${doc.source_url}`,
    );
    return false;
  }

  const { html, finalUrl } = result;

  // Check if we got a real page or a Cloudflare challenge / error page
  if (html.length < MIN_HTML_SIZE) {
    console.warn(
      `[readwise-full-content] HTML too small (${html.length} bytes), likely a challenge page — ${doc.source_url}`,
    );
    return false;
  }

  // Quick check: if the HTML contains Cloudflare challenge markers, skip
  if (
    html.includes("cf-challenge-running") ||
    html.includes("challenge-platform") ||
    html.includes("Just a moment...") ||
    html.includes("Checking your browser")
  ) {
    console.warn(
      `[readwise-full-content] Cloudflare challenge detected, skipping — ${doc.source_url}`,
    );
    return false;
  }

  // Use the final URL (after redirects) as the canonical URL.
  // This handles tracking redirects like click.e.economist.com → economist.com
  const canonicalUrl = finalUrl || doc.source_url;

  // Replace the thin document with the full-content version
  await replaceDocument(token, doc.id, {
    url: canonicalUrl,
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

  console.log(
    `[readwise-full-content] ✓ Enriched: "${doc.title}"` +
      (canonicalUrl !== doc.source_url
        ? ` (redirected to ${canonicalUrl})`
        : ""),
  );
  return true;
}

/**
 * Load a URL in a background tab, wait for it to finish loading,
 * extract the full page HTML, then close the tab.
 *
 * Returns { html, finalUrl } where finalUrl is the URL after any redirects.
 * This handles tracking redirects (e.g., click.e.economist.com → economist.com).
 */
async function extractPageHtml(url) {
  let tab;
  try {
    tab = await browser.tabs.create({ url, active: false });

    await waitForTabLoad(tab.id);

    // Give JS-rendered content a moment to hydrate
    await new Promise((r) => setTimeout(r, 3000));

    // Get the final URL (after redirects) and extract HTML
    const updatedTab = await browser.tabs.get(tab.id);
    const finalUrl = updatedTab.url;

    const results = await browser.tabs.executeScript(tab.id, {
      code: `document.documentElement.outerHTML`,
    });

    const html = results?.[0] || null;
    return html ? { html, finalUrl } : null;
  } catch (err) {
    console.error(
      `[readwise-full-content] Tab extraction error for ${url}:`,
      err.message,
    );
    return null;
  } finally {
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

    browser.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          clearTimeout(timeout);
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      })
      .catch(reject);
  });
}

// ============================================================================
// Alarm-based polling
// ============================================================================

// Handle alarm fires
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "readwise-poll") {
    pollAndEnrich();
  }
});

async function ensurePollerRunning() {
  const token = await getToken();
  if (!token) return;

  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
  if (pollingEnabled === false) return;

  // alarms.get returns the alarm if it exists, or undefined
  const existing = await browser.alarms.get("readwise-poll");
  if (!existing) {
    await browser.alarms.create("readwise-poll", {
      periodInMinutes: POLL_INTERVAL_MINUTES,
    });
    console.log("[readwise-full-content] Poller alarm created");
  }
}

async function stopPoller() {
  await browser.alarms.clear("readwise-poll");
  console.log("[readwise-full-content] Poller alarm cleared");
}

// ============================================================================
// Message handler (from popup)
// ============================================================================

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Save current page to Readwise (mobile/manual flow)
  if (message.type === "SAVE_PAGE") {
    (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("Readwise token not configured");

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
    return true;
  }

  // Get poller status
  if (message.type === "GET_STATUS") {
    (async () => {
      const token = await getToken();
      const { pollingEnabled } = await browser.storage.local.get(
        "pollingEnabled",
      );
      const alarm = await browser.alarms.get("readwise-poll");
      const enrichCount = await getEnrichCount();
      sendResponse({
        hasToken: !!token,
        pollerActive: pollingEnabled !== false && !!alarm,
        processedCount: enrichCount,
      });
    })();
    return true;
  }

  // Toggle polling
  if (message.type === "SET_POLLING") {
    (async () => {
      await browser.storage.local.set({ pollingEnabled: message.enabled });
      if (message.enabled) {
        await ensurePollerRunning();
        // Also run immediately
        pollAndEnrich();
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
// Init — runs every time the event page wakes up
// ============================================================================

(async () => {
  const token = await getToken();
  if (!token) return;

  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
  if (pollingEnabled !== false) {
    await browser.storage.local.set({ pollingEnabled: true });
    await ensurePollerRunning();
  }
})();
