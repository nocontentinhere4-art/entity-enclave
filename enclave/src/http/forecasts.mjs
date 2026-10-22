// HTTP projection for forecasts: GET /forecasts (and the forecasts summary on GET /).
// The route is registered in src/index.mjs; this module is dependency-free so the view can be tested
// over a real ephemeral HTTP server without booting dstack, the wallet or the life loop.
export function forecastsView(forecasts, now = Date.now()) {
  const { open, settled, void: voided } = forecasts.list();
  return {
    open: open.map((e) => forecastRow(e, now)),
    settled: settled.map((e) => ({ ...e })),
    void: voided.map((e) => ({ ...e })),
    score: forecasts.score(),
  };
}

function forecastRow(e, now) {
  const hoursLeft = Math.max(0, Math.round(((Date.parse(e.expiresAt) - now) / 3_600_000) * 10) / 10);
  return {
    id: e.id,
    asset: e.asset,
    horizonHours: e.horizonHours,
    direction: e.direction,
    targetPriceUsd: e.targetPriceUsd,
    confidence: e.confidence,
    rationale: e.rationale,
    priceOpenUsd: e.priceOpenUsd,
    openedAt: e.openedAt,
    expiresAt: e.expiresAt,
    hoursLeft,
  };
}

export function serveForecasts(req, res, { forecasts }) {
  const now = Date.now();
  const body = JSON.stringify(forecastsView(forecasts, now), null, 1);
  res.setHeader('access-control-allow-origin', '*');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}
