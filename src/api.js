// Network calls to the two public APIs. Both allow requests straight from the browser.

const BINANCE = 'https://fapi.binance.com';
const HYPERLIQUID = 'https://api.hyperliquid.xyz/info';
const TIMEOUT_MS = 10_000;
const HOUR_MS = 3_600_000;
const HISTORY_DAYS = 7;

async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  return res.json();
}

const binance = (path) => getJson(BINANCE + path);

const hyperliquid = (body) =>
  getJson(HYPERLIQUID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// exchangeInfo is about 1 MB and rarely changes, so it is fetched once per page load.
let exchangeInfo = null;

export async function fetchBinance() {
  const [info, premiumIndex, fundingInfo, tickers, bookTickers] = await Promise.all([
    exchangeInfo ?? binance('/fapi/v1/exchangeInfo'),
    binance('/fapi/v1/premiumIndex'), // predicted funding, mark price, next payment time
    binance('/fapi/v1/fundingInfo'), // funding interval and cap per symbol
    binance('/fapi/v1/ticker/24hr'), // volume and 24h price change
    binance('/fapi/v1/ticker/bookTicker'), // best bid and ask
  ]);
  exchangeInfo = info;
  return { exchangeInfo, premiumIndex, fundingInfo, tickers, bookTickers };
}

export function fetchHyperliquid() {
  return hyperliquid({ type: 'metaAndAssetCtxs' });
}

// Binance history starts 8 hours earlier, the longest interval, so the first payment
// inside the window has an earlier one to measure its interval from.
export function fetchHistory(coin, symbol) {
  const startTime = Date.now() - HISTORY_DAYS * 24 * HOUR_MS;
  const bnStart = startTime - 8 * HOUR_MS;
  return Promise.all([
    hyperliquid({ type: 'fundingHistory', coin, startTime }),
    binance(`/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&startTime=${bnStart}&limit=1000`),
  ]);
}
