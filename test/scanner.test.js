import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
function binanceRaw() {
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
  const pairs = matchMarkets(parseBinance(binanceRaw()), parseHyperliquid(hyperliquidRaw()));
  assert.deepEqual(pairs.map((p) => [p.coin, p.bn.symbol]), [['WLD', 'WLDUSDT'], ['kPEPE', '1000PEPEUSDT']]);
});

test('kX matches a plain X symbol when Binance has no 1000 contract, by price per coin', () => {
  // Hyperliquid kNEIRO is 1,000 NEIRO at 0.4; Binance NEIROUSDT is 1 NEIRO at 0.0004.
  const bn = new Map([['NEIROUSDT', { symbol: 'NEIROUSDT', price: 0.0004 }]]);
  const hl = new Map([['kNEIRO', { name: 'kNEIRO', price: 0.4 }]]);
  assert.equal(matchMarkets(bn, hl)[0].bn.symbol, 'NEIROUSDT');
});

test('a ticker match with the wrong price is rejected', () => {
  const bn = new Map([['ABCUSDT', { symbol: 'ABCUSDT', price: 2 }]]);
  const hl = new Map([['ABC', { name: 'ABC', price: 1 }]]);
  assert.equal(matchMarkets(bn, hl).length, 0);
});

test('WLD earns 26.3% a year, costs $190 on $100k a side and breaks even in 63 hours', () => {
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

test('flags extreme funding, near cap, hourly funding and big moves', () => {
  const calm = { hourly: 0.0000125 };
  // RSR on 12 October. Binance paid -1.96% per 8h against a 2% floor, Hyperliquid -0.43% per hour.
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
  // A search finds a coin even when it is below the volume filter.
  assert.deepEqual(rank([mk('C', 0.001, 1e3)], { ...FEES, minVolume: 1e6, query: 'c' }).map((r) => r.coin), ['C']);
});

test('the full pipeline runs on real responses recorded on 13 October', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/recorded-2026-10-13.json', import.meta.url)));
  const pairs = matchMarkets(parseBinance(raw.binance), parseHyperliquid(raw.hyperliquid));
  assert.deepEqual(pairs.map((p) => p.coin).sort(), ['BTC', 'RSR', 'WLD', 'kPEPE'], 'the delisted coin is dropped');

  const rows = rank(pairs, { ...FEES, minVolume: 0 });
  rows.forEach((r) => assert.ok(Number.isFinite(r.netApr) && Number.isFinite(r.cost), `${r.coin} has finite numbers`));

  const wld = rows.find((r) => r.coin === 'WLD');
  assert.equal(wld.shortHyperliquid, true);
  close(wld.spreadApr, (0.0000125 + 0.00014033 / 8) * 8760, 1e-6); // about 26.3% a year
  assert.ok(rows.find((r) => r.coin === 'RSR').flags.includes('Extreme funding'));
});

test('hourly series spreads each Binance payment over the hours since the one before', () => {
  const H = 3_600_000;
  const t = 1_000 * H; // an exact hour
  const hl = [1, 2, 3, 4, 5, 6].map((i) => ({ time: t + i * H + 50, fundingRate: '0.00002' }));
  const bn = [
    { fundingTime: t - 4 * H, fundingRate: '0.5' }, // before the window, only marks where the next one starts
    { fundingTime: t, fundingRate: '0.00016' }, // covers 4 hours
    { fundingTime: t + 4 * H + 3, fundingRate: '0.00008' }, // 4 hours, settled 3 ms late
    { fundingTime: t + 5 * H, fundingRate: '0.00003' }, // switched to hourly
  ];
  const series = hourlySeries(hl, bn);
  assert.deepEqual(series.map((p) => (p.time - t) / H), [1, 2, 3, 4, 5], 'hour 6 has no Binance payment yet');
  series.slice(0, 4).forEach((p) => close(p.bn, 0.00002));
  close(series[4].bn, 0.00003);
});

test('summarise counts the gap in the direction of the trade', () => {
  const series = [
    { hl: 0.00003, bn: 0.00001 }, // short Hyperliquid earns 0.00002
    { hl: 0.00001, bn: 0.00001 }, // flat
    { hl: 0.00001, bn: 0.00002 }, // short Hyperliquid loses 0.00001
  ];
  const short = summarise(series, true);
  assert.equal(short.hours, 3);
  close(short.earned, 0.00001);
  close(short.averageApr, (0.00001 / 3) * 8760);
  close(short.paid, 1 / 3);
  close(short.against, 1 / 3);

  const long = summarise(series, false);
  close(long.earned, -0.00001);
  close(long.paid, 1 / 3);
});
