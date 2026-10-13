import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBinance,
  parseHyperliquid,
  binanceCandidates,
  matchMarkets,
  score,
  flags,
  rank,
  hourlySeries,
  summarise,
} from '../src/scanner.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);

// Minimal raw responses in the exact shape the exchanges return.
function binanceRaw(overrides = {}) {
  const symbols = [
    { symbol: 'WLDUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
    { symbol: '1000PEPEUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
    { symbol: 'OLDUSDT', status: 'SETTLING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
  ];
  return {
    exchangeInfo: { symbols },
    premiumIndex: [
      { symbol: 'WLDUSDT', markPrice: '1.000', lastFundingRate: '-0.00014' },
      { symbol: '1000PEPEUSDT', markPrice: '0.0100', lastFundingRate: '0.0001' },
      { symbol: 'OLDUSDT', markPrice: '5', lastFundingRate: '0' },
    ],
    fundingInfo: [{ symbol: 'WLDUSDT', fundingIntervalHours: 8, adjustedFundingRateCap: '0.02' }],
    tickers: symbols.map(({ symbol }) => ({ symbol, quoteVolume: '50000000', priceChangePercent: '2.0' })),
    bookTickers: symbols.map(({ symbol }) => ({ symbol, bidPrice: '1', askPrice: '1' })),
    ...overrides,
  };
}

function hyperliquidRaw() {
  const universe = [{ name: 'WLD' }, { name: 'kPEPE' }, { name: 'GONE', isDelisted: true }];
  const ctx = (markPx, funding) => ({ markPx, funding, dayNtlVlm: '20000000', impactPxs: [markPx, markPx] });
  return [{ universe }, [ctx('1.001', '0.0000125'), ctx('0.01002', '0.0000125'), ctx('3', '0')]];
}

const FEES = { binanceFee: 0.0005, hyperliquidFee: 0.00045, holdHours: 72 };

test('Binance rates are converted to hourly using each symbol interval', () => {
  const bn = parseBinance(binanceRaw());
  close(bn.get('WLDUSDT').hourly, -0.00014 / 8);
  assert.equal(bn.get('1000PEPEUSDT').intervalHours, 8, 'missing from fundingInfo means the 8 hour default');
  assert.ok(!bn.has('OLDUSDT'), 'symbols that are not trading are dropped');
});

test('Hyperliquid delisted coins are dropped', () => {
  const hl = parseHyperliquid(hyperliquidRaw());
  assert.deepEqual([...hl.keys()], ['WLD', 'kPEPE']);
  close(hl.get('WLD').hourly, 0.0000125);
});

test('k-prefixed Hyperliquid coins map to 1000-prefixed Binance symbols', () => {
  assert.deepEqual(binanceCandidates('kPEPE')[1], { symbol: '1000PEPEUSDT', bnUnit: 1000, hlUnit: 1000 });
  const { pairs } = matchMarkets(parseBinance(binanceRaw()), parseHyperliquid(hyperliquidRaw()));
  assert.deepEqual(pairs.map((p) => [p.coin, p.bn.symbol]), [['WLD', 'WLDUSDT'], ['kPEPE', '1000PEPEUSDT']]);
});

test('kX matches a plain X symbol when Binance has no 1000 contract, by price per coin', () => {
  // Hyperliquid kNEIRO is 1,000 NEIRO at 0.4; Binance NEIROUSDT is 1 NEIRO at 0.0004.
  const bn = new Map([['NEIROUSDT', { symbol: 'NEIROUSDT', price: 0.0004 }]]);
  const hl = new Map([['kNEIRO', { name: 'kNEIRO', price: 0.4 }]]);
  assert.equal(matchMarkets(bn, hl).pairs[0].bn.symbol, 'NEIROUSDT');
});

test('a ticker match with the wrong price is rejected', () => {
  const bn = new Map([['ABCUSDT', { symbol: 'ABCUSDT', price: 2 }]]);
  const hl = new Map([['ABC', { name: 'ABC', price: 1 }]]);
  const { pairs, unmatched } = matchMarkets(bn, hl);
  assert.equal(pairs.length, 0);
  assert.deepEqual(unmatched, ['ABC']);
});

test('the WLD example: 26.3% a year, $190 in taker fees on $100k, 63 hours to break even', () => {
  const pair = {
    coin: 'WLD',
    hl: { hourly: 0.0000125, spread: 0 },
    bn: { hourly: -0.00014 / 8, rate: -0.00014, intervalHours: 8, cap: 0.02, change24h: 0, spread: 0 },
  };
  const r = score(pair, FEES);
  assert.equal(r.shortHyperliquid, true, 'short where funding is higher');
  close(r.spreadApr, 0.00003 * 8760);
  close(r.cost, 0.0019);
  close(r.breakevenHours, 0.0019 / 0.00003, 1e-6);
  close(r.netApr, ((0.00003 * 72 - 0.0019) / 72) * 8760);
});

test('direction flips when Binance pays more', () => {
  const pair = { coin: 'X', hl: { hourly: 0, spread: 0 }, bn: { hourly: 0.0001, rate: 0.0008, intervalHours: 8, change24h: 0, spread: 0 } };
  assert.equal(score(pair, FEES).shortHyperliquid, false);
});

test('bid-ask spreads on both exchanges count as cost', () => {
  const pair = { coin: 'X', hl: { hourly: 0, spread: 0.001 }, bn: { hourly: 0, rate: 0, intervalHours: 8, change24h: 0, spread: 0.002 } };
  close(score(pair, FEES).cost, 0.0019 + 0.003);
});

test('flags: extreme funding, near cap, hourly funding, big move', () => {
  const calm = { hourly: 0.0000125 };
  // RSR on 12 October: Binance at -1.96% per 8h against a 2% floor, Hyperliquid at -0.43% per hour.
  const rsr = flags({ hourly: -0.0043 }, { hourly: -0.0196 / 8, rate: -0.0196, cap: 0.02, intervalHours: 8, change24h: 0.41 });
  assert.deepEqual(rsr, ['Extreme funding', 'Near cap', 'Moved 41%']);
  assert.deepEqual(flags(calm, { hourly: 0.0001, rate: 0.0001, cap: 0.02, intervalHours: 1, change24h: -0.02 }), ['Extreme funding', '1h funding']);
  assert.deepEqual(flags(calm, { hourly: 0.0000125, rate: 0.0001, cap: null, intervalHours: 8, change24h: 0 }), []);
});

test('rank filters thin coins and sorts by net per year', () => {
  const mk = (coin, hlHourly, volume) => ({
    coin,
    hl: { hourly: hlHourly, spread: 0, volume },
    bn: { symbol: `${coin}USDT`, hourly: 0, rate: 0, intervalHours: 8, change24h: 0, spread: 0, volume },
  });
  const rows = rank([mk('A', 0.00001, 1e7), mk('B', 0.00005, 1e7), mk('C', 0.001, 1e3)], { ...FEES, minVolume: 1e6 });
  assert.deepEqual(rows.map((r) => r.coin), ['B', 'A']);
  assert.deepEqual(rank([mk('A', 0, 1e7), mk('B', 0, 1e7)], { ...FEES, query: 'b' }).map((r) => r.coin), ['B']);
});

test('hourly series spreads each Binance payment over the hours it covers', () => {
  const H = 3_600_000;
  const t = 1_000 * H; // an exact hour
  const hl = [1, 2, 3, 4].map((i) => ({ time: t + i * H + 50, fundingRate: '0.00002' }));
  const bn = [
    { fundingTime: t, fundingRate: '0.0001' },
    { fundingTime: t + 4 * H + 3, fundingRate: '0.00008' }, // a 4 hour interval, settled 3 ms late
  ];
  const series = hourlySeries(hl, bn, 4);
  assert.equal(series.length, 4);
  series.forEach((p) => close(p.bn, 0.00002));

  const s = summarise(series, true);
  assert.equal(s.hours, 4);
  close(s.earned, 0);
  assert.equal(s.sameDirection, 0);
});
