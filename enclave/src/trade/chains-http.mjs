// Shared plumbing for the chain clients (Jupiter, 1Click, Solana RPC): one fetch wrapper with a per-call
// abortable timeout, and a retry loop whose policy any client can tune (network errors, 429 and 5xx are
// retryable; other 4xx are not). No secrets are logged: error bodies are echoed to the console — which
// lives in the enclave — and the ledger receives only hash digests via src/log.mjs digestError.

/** Minimal fetch wrapper: returns {status, ok, json|text, headers} and never throws for HTTP errors (only transport). */
export async function fetchJson({ fetchImpl, url, method = 'GET', headers = {}, body, timeoutMs = 10_000 }) {
  const init = { method, headers: { accept: 'application/json', ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetchImpl(url, { ...init, signal });
  const text = await res.text();
  let json = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON body (proxy error page, HTML, …) */ }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

/**
 * Retry loop for {@link fetchJson} calls.
 * @param {{
 *   fetchImpl: Function, url: string, method?: string, headers?: Object, body?: any, timeoutMs?: number,
 *   retries?: number,          // additional attempts after the first
 *   backoffMs?: number,        // base delay, doubles per retry, capped at 5 s
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   retryOn?: (r: { status: number }) => boolean,   // default: status 429 or ≥ 500, or network throw
 *   label?: string,            // for console errors only
 * }} p
 * @returns {Awaited<ReturnType<typeof fetchJson>>}
 */
export async function fetchJsonRetries(p) {
  const { retries = 0, backoffMs = 250, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = p;
  const retryOn = p.retryOn ?? ((r) => r?.status === 429 || r?.status >= 500);
  let attempt = 0;
  for (;;) {
    let res = null, err = null;
    try { res = await fetchJson(p); }
    catch (e) { err = e; }
    const retryable = err ? true : retryOn?.(res) ?? false;
    if (!retryable) return res ?? null;
    if (attempt >= retries) {
      if (err) { err.label = p.label ?? p.url; throw err; }
      return res;
    }
    const retryAfter = Number(res?.headers?.get?.('retry-after') ?? 0);
    const delay = Math.max(isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 0, Math.min(backoffMs * 2 ** attempt, 5000));
    console.error(`[chains] ${p.label ?? p.url} attempt ${attempt + 1} failed (status=${err ? 'network' : res.status}), retry in ${delay}ms`);
    await sleep(delay);
    attempt++;
    void now;
  }
}
