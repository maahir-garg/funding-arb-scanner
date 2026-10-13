// Network calls to the two public APIs. Both allow requests straight from the browser.

const BINANCE = 'https://fapi.binance.com';
const HYPERLIQUID = 'https://api.hyperliquid.xyz/info';
const DAY_MS = 86_400_000;

async function getJson(url, options) {
  const res = await fetch(url, options);
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

export function fetchHistory(coin, symbol, days = 7) {
  const startTime = Date.now() - days * DAY_MS;
  return Promise.all([
    hyperliquid({ type: 'fundingHistory', coin, startTime }),
    binance(`/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&startTime=${startTime}&limit=1000`),
  ]);
}
