// HTTP projection for the trade desk: GET /trades and GET /trades/<orderId> (plan §8).
// Dependency-free: the caller injects a `trades` facade — the trade engine, or null when the desk is off.
// A 5-second in-memory cache keeps GET /trades O(1) between ledger changes, mirroring /ledger's
// read-whole-file policy. Every number comes from the engine's publicStatus/orderInfo, which are
// secret-free by construction (no return address, auth6, clientRef, order key, deposit address or memo).

export function tradesHttp({ now = Date.now, ttlMs = 5_000 } = {}) {
  const cache = new Map();
  const hit = (key) => {
    const entry = cache.get(key);
    return entry && now() - entry.at < ttlMs ? entry.body : null;
  };
  const remember = (key, body) => cache.set(key, { at: now(), body });

  return {
    async serve(req, res, { trades }) {
      res.setHeader('access-control-allow-origin', '*');
      const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body, null, 1));
      };

      if (req.url === '/trades') {
        if (!trades) return json(200, { enabled: false, open: 0, closed: 0 });
        const cachedBody = hit('/trades');
        if (cachedBody) return json(200, cachedBody);
        const body = (await trades.publicStatus()) ?? { enabled: false, open: 0, closed: 0 };
        remember('/trades', body);
        return json(200, body);
      }

      if (req.url.startsWith('/trades/')) {
        const id = req.url.slice('/trades/'.length);
        if (!id) return json(404, { error: 'not_found' });
        const detail = trades ? await trades.orderInfo(id) : null;
        if (!detail) return json(404, { error: 'not_found' });
        return json(200, detail);
      }

      return json(404, { error: 'not_found' });
    },
  };
}
