// HTTP projection for pages. Kept out of index.mjs so the exact headers and bodies can be tested without
// booting the enclave, and so the route table stays a couple of lines of wiring.
import { PAGE_HTML_HEADERS } from './store.mjs';

/** `GET /pages`: the public inventory, derived from the ledger on every call. */
export function pagesView(pages) {
  const stats = pages.stats();
  return {
    count: stats.count,
    limit: stats.limit,
    editsToday: stats.editsToday,
    editsPerDay: stats.editsPerDay,
    pages: pages.list(),
  };
}

/**
 * `GET /pages/<slug>`: the exact bytes whose hash is in the ledger, under a CSP that forbids every fetch.
 * Returns { status, headers, body }; never throws for an unknown or invalid slug.
 */
export async function pageResponse(pages, rawSlug) {
  let slug;
  try {
    slug = decodeURIComponent(String(rawSlug ?? ''));
  } catch {
    return jsonError(404, 'not_found');
  }
  try {
    const page = await pages.get(slug);
    return {
      status: 200,
      headers: { ...PAGE_HTML_HEADERS, etag: `"${page.hash}"` },
      body: page.html,
    };
  } catch (e) {
    if (e?.code === 'not_found' || e?.code === 'bad_slug' || e?.code === 'reserved_slug') return jsonError(404, 'not_found');
    // A file that no longer matches its ledger hash must never be served: the commitment is the truth.
    if (e?.code === 'page_tampered') return jsonError(500, 'page_tampered');
    throw e;
  }
}

function jsonError(status, error) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error }),
  };
}
