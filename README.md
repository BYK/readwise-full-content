# Readwise Full Content

A Firefox extension that enriches your Readwise Reader library with full article content from paywalled sites. Works on **desktop and Android** Firefox.

## The Problem

When you save an article URL to Readwise Reader from a paywalled site (The Economist, Washington Post, Wired, etc.), you get a stub — just the title and maybe a sentence or two. You're a subscriber to these sites, but Readwise's servers can't access the content behind the paywall.

## The Solution

This extension works in two ways:

### Desktop: Automatic Background Enrichment

The extension polls your Readwise Reader library every 2 minutes, finds recently saved articles that have thin content (< 100 words), opens each one in a background tab (using your browser's logged-in sessions and cookies), grabs the full page HTML, and pushes it back to Readwise Reader.

```
Readwise Reader has a thin article (paywalled stub)
  → Extension opens the URL in a hidden background tab
  → Your browser loads it with your subscriber cookies
  → Extension extracts document.documentElement.outerHTML
  → Deletes the thin stub from Readwise
  → Re-creates the document with full HTML + should_clean_html=true
  → Readwise cleans it up (strips nav, ads, etc.)
  → Full article appears in your Reader
```

This means you can save articles from **any device** (phone, tablet, Readwise app, email) and as long as your desktop Firefox is running, they'll get enriched automatically.

### Mobile: Manual Save with Full Content

On Android Firefox, tap the extension icon on any page to save the current page's full content directly to Readwise Reader. Since you're viewing the page in your browser (already logged in), the extension grabs the complete HTML.

## Install

### From AMO (Recommended)

Install from [addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/readwise-full-content/) — works on both desktop and Android Firefox. Auto-updates included.

### From GitHub Releases

1. Download the latest `.xpi` from [Releases](https://github.com/BYK/readwise-full-content/releases)
2. **Desktop:** Open the `.xpi` file in Firefox, or drag it into a Firefox window
3. **Android (Beta/Nightly):** Transfer the `.xpi` to your device, then in Settings → "Install extensions from file"

### From Source

```bash
git clone https://github.com/BYK/readwise-full-content.git
cd readwise-full-content/extension
npx web-ext build
```

Then load `extension/manifest.json` via `about:debugging` → "Load Temporary Add-on", or install the `.xpi` from `web-ext-artifacts/`.

## Setup

1. Click the extension icon
2. Enter your **Readwise Access Token** from [readwise.io/access_token](https://readwise.io/access_token)
3. Click **Save Token**
4. The "Auto-enrich saved articles" toggle is on by default (desktop)

## How It Works

### Background Enrichment (Desktop)

Every 2 minutes, the extension:

1. Calls `GET /api/v3/list/` to fetch your 20 most recent Reader documents
2. Filters for articles with `word_count < 100` (thin/paywalled stubs)
3. Skips URLs it already processed in the last hour
4. For each thin article:
   - Opens the URL in a **hidden background tab** (not active — doesn't steal focus)
   - Waits for the page to load + 2 seconds for JS hydration
   - Executes `document.documentElement.outerHTML` to get full page HTML
   - Closes the background tab
   - Deletes the existing thin document from Readwise
   - Creates a new document with the full HTML and `should_clean_html: true`
   - Readwise's backend strips navigation, ads, and boilerplate

### Manual Save (Mobile / Desktop)

When you click "Save Full Page to Readwise":

1. Extension runs `document.documentElement.outerHTML` on the current tab
2. Sends the HTML to Readwise Reader API with `should_clean_html: true`
3. If the URL already exists in Reader, it deletes the old version and re-creates with full content

### Why `should_clean_html: true`?

Readwise has a robust HTML content extraction pipeline. When you send it a full page's `outerHTML`, it:
- Extracts the main article content
- Strips navigation, sidebars, ads, scripts, styles
- Preserves article formatting, images, and links
- Extracts title and author if not provided

This means the extension doesn't need site-specific parsing logic. It works on **any website** — The Economist, Washington Post, Wired, NYT, FT, or any other site you're subscribed to.

## Files

```
extension/
├── manifest.json     # MV2 manifest (compatible with Firefox Android)
├── background.js     # Poller + enrichment logic + message handling
├── readwise.js       # Readwise Reader API client (shared)
├── popup.html        # Extension popup UI
├── popup.js          # Popup logic
└── icons/            # Extension icons
```

## Privacy

- Your Readwise token is stored locally in `browser.storage.local`
- Page HTML goes directly from your browser to Readwise's API
- No intermediary servers, no data collection, no tracking
- Background tabs are opened and closed automatically — you may see brief tab flashes
- The extension requires `*://*/*` permission to open background tabs on any domain

## FAQ

**Will I see background tabs flashing?**
On desktop Firefox, background tabs are created with `active: false`, so they shouldn't steal focus. However, you may briefly see them in your tab bar before they're closed (~15-17 seconds per article).

**What if the site needs a Cloudflare challenge?**
If you've recently visited the site in your browser, the `cf_clearance` cookie will still be valid and the background tab will load normally. If the cookie has expired, the background tab may hit a Cloudflare challenge page and the enrichment will fail silently. Just visit the site once in a regular tab to refresh the cookie.

**Does it work with every paywalled site?**
It works with any site where your browser can load the full article (i.e., you have an active subscription and are logged in). The extension uses your browser's existing cookies and sessions.

**What about rate limits?**
The extension checks 20 documents every 2 minutes. Readwise's list API allows 20 requests/minute and save API allows 50 requests/minute. The extension handles rate limiting gracefully (backs off on 429 responses).

**Can I turn off background enrichment?**
Yes — toggle "Auto-enrich saved articles" in the popup. The manual "Save Full Page" button always works regardless.

## License

MIT
