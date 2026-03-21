<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/opencode-lore) -->
## Long-term Knowledge

### Architecture

<!-- lore:019d0f47-5491-733a-b4cb-f997b0833180 -->
* **Readwise Full Content extension structure**: Firefox MV2 extension (desktop + Android) that enriches Readwise Reader articles with full content from paywalled sites. Key files in \`extension/\`: \`background.js\` (poller + enrichment), \`readwise.js\` (API client, shared), \`popup.js\`/\`popup.html\` (UI). Background uses alarm-based polling every 2 min, checks recent docs for low word count or paywall markers, then extracts HTML via \`fetch()\` first (invisible) with \`extractViaTab()\` fallback (visible tab). Readwise has no content-update endpoint — URL is the dedup key, so replacement requires delete-then-create with a 2s propagation delay. \`should\_clean\_html: true\` offloads content extraction to Readwise's backend.

### Gotcha

<!-- lore:019d0f47-54ba-77bf-bff5-ff5b86f9c48b -->
* **Readwise URL dedup prevents content updates**: Readwise Reader's save API uses URL as a dedup key — POSTing the same URL returns the existing doc (HTTP 200) without updating content. To replace a document's content, you must DELETE the old doc, wait ~2 seconds for deletion to propagate, then POST the new version. If the URL is still occupied after first delete (race condition or slow propagation), the code retries: delete the returned doc ID and create again. This delete-wait-create pattern is in \`replaceDocument()\` in \`readwise.js\`.

### Pattern

<!-- lore:019d0f47-54ab-7fb7-be6a-79c555181db8 -->
* **Fetch-first with tab fallback for HTML extraction**: The extension uses a two-tier extraction strategy: (1) \`fetch()\` with \`credentials: 'include'\` — invisible, fast, carries cookies, works for most sites; (2) \`browser.tabs.create()\` fallback for JS-heavy sites needing full browser rendering. Usability is checked via \`isUsableHtml()\`: minimum 30KB size and no Cloudflare challenge markers. On Android, tier 2 is disabled because tabs aren't truly backgrounded. The platform is detected once at startup via \`browser.runtime.getPlatformInfo()\` and cached in a module-level \`isAndroid\` boolean.
<!-- End lore-managed section -->
