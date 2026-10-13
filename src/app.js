import { fetchBinance, fetchHyperliquid, fetchHistory } from './api.js';
import { parseBinance, parseHyperliquid, matchMarkets, rank, hourlySeries, summarise } from './scanner.js';

const REFRESH_MS = 30_000;
const $ = (id) => document.getElementById(id);

const state = {
  binance: null,
  hyperliquid: null,
  errors: {},
  updated: null,
  detail: null, // { coin, series?, error? } for the coin whose history is open
};

function settings() {
  return {
    binanceFee: Number($('binance-fee').value) / 100,
    hyperliquidFee: Number($('hyperliquid-fee').value) / 100,
    holdHours: Number($('hold').value),
    minVolume: Number($('min-volume').value) * 1e6,
    query: $('search').value,
  };
}

async function refresh() {
  try {
    const [bn, hl] = await Promise.allSettled([fetchBinance(), fetchHyperliquid()]);
    // On failure, keep showing the last good data for that exchange.
    if (bn.status === 'fulfilled') {
      state.binance = parseBinance(bn.value);
      delete state.errors.Binance;
    } else state.errors.Binance = bn.reason.message;
    if (hl.status === 'fulfilled') {
      state.hyperliquid = parseHyperliquid(hl.value);
      delete state.errors.Hyperliquid;
    } else state.errors.Hyperliquid = hl.reason.message;
    state.updated = new Date();
    render();
  } finally {
    setTimeout(refresh, REFRESH_MS);
  }
}

async function openDetail(coin, symbol, intervalHours) {
  if (state.detail?.coin === coin) {
    state.detail = null;
    return render();
  }
  state.detail = { coin };
  render();
  try {
    const [hl, bn] = await fetchHistory(coin, symbol);
    if (state.detail?.coin === coin) state.detail.series = hourlySeries(hl, bn, intervalHours);
  } catch (err) {
    if (state.detail?.coin === coin) state.detail.error = err.message;
  }
  render();
}

function render() {
  $('status').innerHTML = statusHtml();
  if (!state.binance || !state.hyperliquid) return;

  const { pairs } = matchMarkets(state.binance, state.hyperliquid);
  const rows = rank(pairs, settings());
  $('summary').textContent = `${pairs.length} coins trade on both exchanges. Showing ${rows.length}.`;
  $('rows').innerHTML =
    rows.map((r, i) => rowHtml(r, i) + (r.coin === state.detail?.coin ? detailHtml(r) : '')).join('') ||
    '<tr><td colspan="11" class="empty">No coins match these settings.</td></tr>';
}

function statusHtml() {
  const errors = Object.entries(state.errors).map(([venue, msg]) => {
    const hint = msg.includes('451') ? ' Binance blocks some countries, including the US.' : '';
    return `<span class="error">${venue}: ${esc(msg)}.${hint}</span>`;
  });
  const updated = state.updated ? `Updated ${state.updated.toLocaleTimeString()}.` : 'Loading…';
  return [updated, ...errors].join(' ');
}

function rowHtml(r, i) {
  const trade = r.shortHyperliquid ? 'Short Hyperliquid<br>Long Binance' : 'Long Hyperliquid<br>Short Binance';
  const alias = r.bn.symbol === `${r.coin}USDT` ? '' : `<small>${esc(r.bn.symbol)}</small>`;
  return `<tr data-coin="${esc(r.coin)}" data-symbol="${esc(r.bn.symbol)}" data-interval="${r.bn.intervalHours}"
      class="${r.coin === state.detail?.coin ? 'open' : ''}">
    <td class="num muted">${i + 1}</td>
    <td class="coin">${esc(r.coin)}${alias}</td>
    <td>${trade}</td>
    <td class="num">${pct(r.hl.hourly, 5)}<small>per 1h</small></td>
    <td class="num">${pct(r.bn.rate, 4)}<small>per ${r.bn.intervalHours}h</small></td>
    <td class="num">${pct(r.spreadApr, 1)}</td>
    <td class="num">${pct(r.cost, 2)}</td>
    <td class="num">${duration(r.breakevenHours)}</td>
    <td class="num strong ${r.netApr >= 0 ? 'pos' : 'neg'}">${pct(r.netApr, 1)}</td>
    <td class="num">${usd(Math.min(r.hl.volume, r.bn.volume))}</td>
    <td>${r.flags.map((f) => `<span class="flag">${f}</span>`).join(' ')}</td>
  </tr>`;
}

function detailHtml(r) {
  const d = state.detail;
  let body;
  if (d.error) body = `<p class="error">${esc(d.error)}</p>`;
  else if (!d.series) body = '<p class="muted">Loading the last 7 days…</p>';
  else {
    const s = summarise(d.series, r.shortHyperliquid);
    body = `
      <div class="stats">
        <div><b>${pct(r.spreadApr, 1)}</b>spread per year now</div>
        <div><b>${pct(s.averageApr, 1)}</b>average over the last 7 days</div>
        <div><b>${Math.round(s.sameDirection * 100)}%</b>of hours paid in today's direction</div>
        <div><b>${money(s.earned * 10_000)}</b>funding this trade earned over 7 days on $10,000 a side</div>
        <div><b>${money(r.cost * 10_000)}</b>cost to open and close $10,000 a side</div>
      </div>
      <p class="legend"><span class="key hl"></span>Hyperliquid <span class="key bn"></span>Binance, hourly funding over the last 7 days</p>
      ${chart(d.series)}`;
  }
  return `<tr class="detail"><td colspan="11">${body}</td></tr>`;
}

function chart(series) {
  if (series.length < 2) return '<p class="muted">Not enough history yet.</p>';
  const W = 1000, H = 240, LEFT = 90, RIGHT = 10, TOP = 12, BOTTOM = 30;
  const t0 = series[0].time, t1 = series.at(-1).time;
  const values = series.flatMap((p) => [p.hl, p.bn]).concat(0);
  const lo = Math.min(...values), hi = Math.max(...values);
  const x = (t) => LEFT + ((t - t0) / (t1 - t0)) * (W - LEFT - RIGHT);
  const y = (v) => TOP + ((hi - v) / (hi - lo || 1)) * (H - TOP - BOTTOM);
  const line = (key) => series.map((p) => `${x(p.time).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const yLabel = (v) => `<text x="${LEFT - 8}" y="${y(v) + 5}" text-anchor="end">${pct(v, 5)}</text>`;
  const zeroLabel = Math.min(y(0) - y(hi), y(lo) - y(0)) > 16 ? yLabel(0) : ''; // skip if it would overlap
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly funding on both exchanges">
    <line class="zero" x1="${LEFT}" x2="${W - RIGHT}" y1="${y(0)}" y2="${y(0)}"/>
    <polyline class="bn" points="${line('bn')}"/>
    <polyline class="hl" points="${line('hl')}"/>
    ${yLabel(hi)}${yLabel(lo)}${zeroLabel}
    <text x="${LEFT}" y="${H - 6}">7 days ago</text>
    <text x="${W - RIGHT}" y="${H - 6}" text-anchor="end">now</text>
  </svg>`;
}

function pct(x, digits) {
  const s = (x * 100).toFixed(digits);
  return `${Number(s) === 0 ? s.replace('-', '') : s}%`; // no "-0.00%"
}

const usd = (x) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(1)}M`);

const money = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;

function duration(hours) {
  if (!Number.isFinite(hours)) return 'never';
  return hours < 48 ? `${Math.round(hours)} h` : `${(hours / 24).toFixed(1)} days`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

$('settings').addEventListener('input', render);
$('settings').addEventListener('submit', (e) => e.preventDefault());
$('rows').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-coin]');
  if (row) openDetail(row.dataset.coin, row.dataset.symbol, Number(row.dataset.interval));
});

refresh();
