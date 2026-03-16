/**
 * Readwise Reader API client.
 *
 * Shared between background.js and popup.js.
 */

const READWISE_BASE = "https://readwise.io/api";

/**
 * Get the stored Readwise token.
 */
async function getToken() {
  const { readwiseToken } = await browser.storage.local.get("readwiseToken");
  return readwiseToken || null;
}

/**
 * Validate a Readwise token.
 * Returns true if valid (204), false otherwise.
 */
async function validateToken(token) {
  try {
    const res = await fetch(`${READWISE_BASE}/v2/auth/`, {
      headers: { Authorization: `Token ${token}` },
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/**
 * Fetch recent documents from Readwise Reader.
 *
 * @param {string} token
 * @param {object} opts
 * @param {string} [opts.updatedAfter] - ISO 8601 timestamp
 * @param {string} [opts.location] - new, later, shortlist, archive, feed
 * @param {number} [opts.limit] - 1-100
 * @returns {Promise<Array>} List of documents
 */
async function listDocuments(token, opts = {}) {
  const params = new URLSearchParams();
  if (opts.updatedAfter) params.set("updatedAfter", opts.updatedAfter);
  if (opts.location) params.set("location", opts.location);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.withHtmlContent) params.set("withHtmlContent", "true");

  const url = `${READWISE_BASE}/v3/list/?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Token ${token}` },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") || "60";
    throw new Error(`RATE_LIMITED:${retryAfter}`);
  }

  if (!res.ok) {
    throw new Error(`Readwise list failed: ${res.status}`);
  }

  const data = await res.json();
  return data.results || [];
}

/**
 * Delete a document from Readwise Reader.
 */
async function deleteDocument(token, documentId) {
  const res = await fetch(`${READWISE_BASE}/v3/delete/${documentId}/`, {
    method: "DELETE",
    headers: { Authorization: `Token ${token}` },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") || "60";
    throw new Error(`RATE_LIMITED:${retryAfter}`);
  }

  return res.status === 204 || res.status === 404;
}

/**
 * Create a document in Readwise Reader with full HTML content.
 */
async function createDocument(token, doc) {
  const res = await fetch(`${READWISE_BASE}/v3/save/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(doc),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") || "60";
    throw new Error(`RATE_LIMITED:${retryAfter}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Readwise save failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return {
    id: data.id,
    url: data.url,
    alreadyExisted: res.status === 200,
  };
}

/**
 * Replace a document's content by deleting and re-creating it.
 *
 * Readwise has no content-update endpoint. URL is the dedup key —
 * POSTing the same URL returns the existing doc (200) without updating.
 * So we must delete first, then create with new HTML.
 *
 * @param {string} token
 * @param {string} existingId - ID of the document to replace
 * @param {object} doc - Document creation payload (url, html, title, etc.)
 */
async function replaceDocument(token, existingId, doc) {
  await deleteDocument(token, existingId);

  // Brief pause for deletion to propagate
  await new Promise((r) => setTimeout(r, 1500));

  return createDocument(token, doc);
}
