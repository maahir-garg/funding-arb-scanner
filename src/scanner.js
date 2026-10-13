// Turns raw exchange responses into ranked funding spreads.
// Pure functions only, no network and no DOM, so every step can be tested.

export const HOURS_PER_YEAR = 24 * 365;
const HOUR_MS = 3_600_000;

// Two listings count as the same coin only if their prices agree within 5%.
const PRICE_TOLERANCE = 0.05;

// Flag thresholds.
const NEAR_CAP = 0.8; // Binance funding at 80% or more of its cap
const EXTREME = 0.0001; // either side paying 0.01% an hour or more, 8 times the normal rate
const BIG_MOVE = 0.15; // price moved 15% or more in 24 hours

export function parseBinance({ exchangeInfo, premiumIndex, fundingInfo, tickers, bookTickers }) {
  const perpetuals = new Set(
    exchangeInfo.symbols
      .filter((s) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
      .map((s) => s.symbol),
  );
  const info = indexBy(fundingInfo, 'symbol');
  const ticker = indexBy(tickers, 'symbol');
  const book = indexBy(bookTickers, 'symbol');

  const markets = new Map();
  for (const p of premiumIndex) {
    const t = ticker.get(p.symbol);
    const b = book.get(p.symbol);
    if (!perpetuals.has(p.symbol) || !t || !(Number(b?.bidPrice) > 0 && Number(b?.askPrice) > 0)) continue;

    const intervalHours = info.get(p.symbol)?.fundingIntervalHours ?? 8; // 8 hours is Binance's default
    const rate = Number(p.lastFundingRate); // despite the name, this is the predicted next payment
    markets.set(p.symbol, {
      symbol: p.symbol,
      price: Number(p.markPrice),
      rate,
      intervalHours,
      hourly: rate / intervalHours,
      cap: info.has(p.symbol) ? Number(info.get(p.symbol).adjustedFundingRateCap) : null,
      volume: Number(t.quoteVolume),
      change24h: Number(t.priceChangePercent) / 100,
      spread: relativeSpread(Number(b.bidPrice), Number(b.askPrice)),
    });
  }
  return markets;
}

// Input is the [meta, assetContexts] pair from Hyperliquid's metaAndAssetCtxs.
// The two arrays line up by index. Funding there is already an hourly rate.
// Bid and ask are Hyperliquid's impact prices: the average fill for a $20,000 order
// on BTC and ETH and $6,000 on everything else.
export function parseHyperliquid([meta, contexts]) {
  const markets = new Map();
  meta.universe.forEach((asset, i) => {
    const ctx = contexts[i];
    const [bid, ask] = (ctx?.impactPxs ?? []).map(Number);
    if (asset.isDelisted || !(bid > 0 && ask > 0)) return;
    markets.set(asset.name, {
      name: asset.name,
      price: Number(ctx.markPx),
      hourly: Number(ctx.funding),
      volume: Number(ctx.dayNtlVlm),
      spread: relativeSpread(bid, ask),
    });
  });
  return markets;
}

// Binance symbols that could be the same coin as a Hyperliquid name, with how many
// coins one unit of each contract represents. Hyperliquid's "kPEPE" is 1,000 PEPE,
// Binance's "1000PEPEUSDT" is also 1,000 PEPE.
export function binanceCandidates(hyperliquidName) {
  const thousands = /^k[A-Z0-9]/.test(hyperliquidName);
  const base = thousands ? hyperliquidName.slice(1) : hyperliquidName;
  const hlUnit = thousands ? 1000 : 1;
  return [
    { symbol: `${base}USDT`, bnUnit: 1, hlUnit },
    { symbol: `1000${base}USDT`, bnUnit: 1000, hlUnit },
    { symbol: `1000000${base}USDT`, bnUnit: 1_000_000, hlUnit },
    { symbol: `1M${base}USDT`, bnUnit: 1_000_000, hlUnit },
  ];
}

// Pairs each Hyperliquid coin with its Binance perpetual. A name match alone is not
// enough: the price per coin must also agree, which catches contracts of different sizes
// and unrelated tokens that share a ticker.
export function matchMarkets(binance, hyperliquid) {
  const pairs = [];
  const unmatched = [];
  for (const hl of hyperliquid.values()) {
    const match = binanceCandidates(hl.name).find(({ symbol, bnUnit, hlUnit }) => {
      const bn = binance.get(symbol);
      return bn && Math.abs(bn.price / bnUnit / (hl.price / hlUnit) - 1) <= PRICE_TOLERANCE;
    });
    if (match) pairs.push({ coin: hl.name, hl, bn: binance.get(match.symbol) });
    else unmatched.push(hl.name);
  }
  return { pairs, unmatched };
}

// Fees are fractions per trade, e.g. 0.0005 for 0.05%.
export function score({ coin, hl, bn }, { binanceFee, hyperliquidFee, holdHours }) {
  // Short the exchange with the higher rate: shorts receive positive funding
  // and longs receive negative funding, so the gap is earned either way.
  const shortHyperliquid = hl.hourly > bn.hourly;
  const spreadHourly = Math.abs(hl.hourly - bn.hourly);
  // Four trades (open and close on both exchanges), plus crossing the bid-ask
  // on each exchange: half the spread going in and half coming out.
  const cost = 2 * (binanceFee + hyperliquidFee) + bn.spread + hl.spread;
  return {
    coin,
    hl,
    bn,
    shortHyperliquid,
    spreadApr: spreadHourly * HOURS_PER_YEAR,
    cost,
    breakevenHours: spreadHourly > 0 ? cost / spreadHourly : Infinity,
    netApr: ((spreadHourly * holdHours - cost) / holdHours) * HOURS_PER_YEAR,
    flags: flags(hl, bn),
  };
}

export function flags(hl, bn) {
  const out = [];
  if (Math.max(Math.abs(hl.hourly), Math.abs(bn.hourly)) >= EXTREME) out.push('Extreme funding');
  if (bn.cap && Math.abs(bn.rate) >= NEAR_CAP * bn.cap) out.push('Near cap');
  if (bn.intervalHours === 1) out.push('1h funding');
  if (Math.abs(bn.change24h) >= BIG_MOVE) out.push(`Moved ${Math.round(bn.change24h * 100)}%`);
  return out;
}

export function rank(pairs, { minVolume = 0, query = '', ...settings }) {
  const q = query.trim().toUpperCase();
  return pairs
    .filter((p) => Math.min(p.hl.volume, p.bn.volume) >= minVolume)
    .filter((p) => !q || p.coin.toUpperCase().includes(q) || p.bn.symbol.includes(q))
    .map((p) => score(p, settings))
    .sort((a, b) => b.netApr - a.netApr);
}

// Puts both exchanges on one hourly grid. A Binance payment of r covering n hours
// counts as r / n for each of those hours. Each point is keyed by the hour it ends.
export function hourlySeries(hlHistory, bnHistory, bnIntervalHours) {
  const hl = new Map(hlHistory.map((h) => [Math.floor(h.time / HOUR_MS), Number(h.fundingRate)]));
  const bn = new Map();
  bnHistory.forEach((p, i) => {
    const end = Math.floor(p.fundingTime / HOUR_MS);
    const n = i > 0 ? Math.round((p.fundingTime - bnHistory[i - 1].fundingTime) / HOUR_MS) : bnIntervalHours;
    for (let h = end - n + 1; h <= end; h++) bn.set(h, Number(p.fundingRate) / n);
  });
  return [...hl.keys()]
    .filter((h) => bn.has(h))
    .sort((a, b) => a - b)
    .map((h) => ({ time: h * HOUR_MS, hl: hl.get(h), bn: bn.get(h) }));
}

// How the trade, held in today's direction, would have done over the series.
export function summarise(series, shortHyperliquid) {
  const sign = shortHyperliquid ? 1 : -1;
  const gaps = series.map((p) => sign * (p.hl - p.bn));
  const total = gaps.reduce((a, b) => a + b, 0);
  return {
    hours: gaps.length,
    earned: total, // fraction of position size
    averageApr: gaps.length ? (total / gaps.length) * HOURS_PER_YEAR : 0,
    sameDirection: gaps.length ? gaps.filter((g) => g > 0).length / gaps.length : 0,
  };
}

function relativeSpread(bid, ask) {
  return (ask - bid) / ((ask + bid) / 2);
}

function indexBy(rows, key) {
  return new Map(rows.map((r) => [r[key], r]));
}
