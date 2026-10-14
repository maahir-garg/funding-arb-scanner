import { fetchBinance, fetchHyperliquid, fetchHistory } from './api.js';
import { parseBinance, parseHyperliquid, matchMarkets, rank, hourlySeries, summarise } from './scanner.js';

const REFRESH_MS = 30_000;
const $ = (id) => document.getElementById(id);
const COLUMNS = document.querySelectorAll('thead th').length;

const state = {
  binance: null,
  hyperliquid: null,
  loadedAt: {}, // last successful load per exchange
  errors: {},
  detail: null, // { coin, series?, error? } for the coin whose history is open
  stale: false, // new data arrived while the pointer was over the table
};

// Reads a number input, falling back to its default while it is empty or invalid,
// so clearing a fee box to retype it doesn't briefly rank everything with zero fees.
function num(id) {
  const input = $(id);
  const value = input.valueAsNumber;
  return Number.isFinite(value) && value >= 0 ? value : Number(input.defaultValue);
}

function settings() {
  return {
    binanceFee: num('binance-fee') / 100,
    hyperliquidFee: num('hyperliquid-fee') / 100,
    holdHours: Number($('hold').value),
    minVolume: num('min-volume') * 1e6,
    query: $('search').value,
  };
}

// Polls every 30 seconds while the tab is visible. A hidden tab still loads once.
async function refresh() {
  try {
    if (!document.hidden || !state.binance || !state.hyperliquid) await load();
  } finally {
    setTimeout(refresh, REFRESH_MS);
  }
}

// One load at a time, so a tab coming back into view can't overlap the timer's load.
let loading = null;
function load() {
  loading ??= fetchBoth().finally(() => (loading = null));
  return loading;
}

async function fetchBoth() {
  const [bn, hl] = await Promise.allSettled([fetchBinance(), fetchHyperliquid()]);
  // On failure, keep showing the last good data for that exchange.
  if (bn.status === 'fulfilled') {
    state.binance = parseBinance(bn.value);
    state.loadedAt.Binance = new Date();
    delete state.errors.Binance;
  } else state.errors.Binance = bn.reason.message;
  if (hl.status === 'fulfilled') {
    state.hyperliquid = parseHyperliquid(hl.value);
    state.loadedAt.Hyperliquid = new Date();
    delete state.errors.Hyperliquid;
  } else state.errors.Hyperliquid = hl.reason.message;

  // Re-sorting under the pointer would move the row someone is about to click,
  // so only the status line updates until the pointer leaves the table.
  if ($('rows').matches(':hover')) {
    state.stale = true;
    $('status').innerHTML = statusHtml();
  } else render();
}

async function toggleDetail(coin, symbol) {
  if (state.detail?.coin === coin) {
    state.detail = null;
    return render();
  }
  const detail = (state.detail = { coin });
  render();
  try {
    const [hl, bn] = await fetchHistory(coin, symbol);
    detail.series = hourlySeries(hl, bn);
  } catch (err) {
    detail.error = err.message;
  }
  if (state.detail === detail) render(); // skip if another coin was opened meanwhile
}

function render() {
  state.stale = false;
  $('status').innerHTML = statusHtml();
  if (!state.binance || !state.hyperliquid) return;

  const pairs = matchMarkets(state.binance, state.hyperliquid);
  const rows = rank(pairs, settings());
  $('summary').textContent = `${pairs.length} coins trade on both exchanges. Showing ${rows.length}.`;
  $('rows').innerHTML =
    rows.map((r, i) => rowHtml(r, i) + (r.coin === state.detail?.coin ? detailHtml(r) : '')).join('') ||
    `<tr><td colspan="${COLUMNS}" class="empty">No coins match these settings.</td></tr>`;
}

function statusHtml() {
  const times = Object.values(state.loadedAt);
  if (!times.length && !Object.keys(state.errors).length) return 'Loading…';
  const latest = times.length ? `Updated ${clock(new Date(Math.max(...times)))}.` : '';
  const errors = Object.entries(state.errors).map(([venue, msg]) => {
    const hint = msg.includes('451') ? ' Binance blocks some countries, including the US.' : '';
    const since = state.loadedAt[venue] ? ` Showing ${venue} data from ${clock(state.loadedAt[venue])}.` : '';
    return `<span class="error">${venue}: ${esc(msg)}.${hint}${since}</span>`;
  });
  return [latest, ...errors].join(' ');
}

function rowHtml(r, i) {
  const open = r.coin === state.detail?.coin;
  const trade =
    r.spreadApr === 0 ? 'Same rate' : r.shortHyperliquid ? 'Short Hyperliquid<br>Long Binance' : 'Long Hyperliquid<br>Short Binance';
  const alias = r.bn.symbol === `${r.coin}USDT` ? '' : `<small>${esc(r.bn.symbol)}</small>`;
  return `<tr data-coin="${esc(r.coin)}" data-symbol="${esc(r.bn.symbol)}" class="${open ? 'open' : ''}">
    <td class="num muted secondary">${i + 1}</td>
    <td><button class="coin" aria-expanded="${open}">${esc(r.coin)}</button>${alias}</td>
    <td>${trade}</td>
    <td class="num secondary">${pct(r.hl.hourly, 5)}<small>per 1h</small></td>
    <td class="num secondary">${pct(r.bn.rate, 4)}<small>per ${r.bn.intervalHours}h</small></td>
    <td class="num">${pct(r.spreadApr, 1)}</td>
    <td class="num secondary">${pct(r.cost, 2)}</td>
    <td class="num">${duration(r.breakevenHours)}</td>
    <td class="num strong ${r.netApr >= 0 ? 'pos' : 'neg'}">${pct(r.netApr, 1)}</td>
    <td class="num secondary">${volume(Math.min(r.hl.volume, r.bn.volume))}</td>
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
    const days = `${+(s.hours / 24).toFixed(1)} days`;
    body = `
      <div class="stats">
        <div><b>${pct(r.spreadApr, 1)}</b>spread per year now</div>
        <div><b>${pct(s.averageApr, 1)}</b>average over the last ${days}</div>
        <div><b>${Math.round(s.against * 100)}%</b>of hours went against the trade</div>
        <div><b>${dollars(s.earned * 10_000)}</b>funding this trade earned over ${days} on $10,000 a side</div>
        <div><b>${dollars(r.cost * 10_000)}</b>cost to open and close $10,000 a side</div>
      </div>
      <p class="legend"><span class="key hl"></span>Hyperliquid <span class="key bn"></span>Binance, funding per hour up to the last Binance payment</p>
      ${chart(d.series)}`;
  }
  return `<tr class="detail"><td colspan="${COLUMNS}"><div class="detail-body">${body}</div></td></tr>`;
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
  const when = (t) =>
    new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly funding on both exchanges">
    <line class="zero" x1="${LEFT}" x2="${W - RIGHT}" y1="${y(0)}" y2="${y(0)}"/>
    <polyline class="bn" points="${line('bn')}"/>
    <polyline class="hl" points="${line('hl')}"/>
    ${yLabel(hi)}${yLabel(lo)}${zeroLabel}
    <text x="${LEFT}" y="${H - 6}">${when(t0)}</text>
    <text x="${W - RIGHT}" y="${H - 6}" text-anchor="end">${when(t1)}</text>
  </svg>`;
}

// Formatting. Values that round to zero drop their minus sign.

function pct(x, digits) {
  const s = (x * 100).toFixed(digits);
  return `${Number(s) === 0 ? s.replace('-', '') : s}%`;
}

function dollars(x) {
  const s = Math.abs(x).toFixed(2);
  return `${x < 0 && Number(s) !== 0 ? '-' : ''}$${s}`;
}

function volume(x) {
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  return `$${Math.round(x / 1e3)}K`;
}

function duration(hours) {
  if (!Number.isFinite(hours)) return 'never';
  return hours < 48 ? `${Math.round(hours)} h` : `${(hours / 24).toFixed(1)} days`;
}

const clock = (date) => date.toLocaleTimeString();

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

$('settings').addEventListener('input', render);
$('settings').addEventListener('submit', (e) => e.preventDefault());
$('rows').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-coin]');
  // e.detail counts clicks, so the second click of a double-click doesn't close the panel again.
  if (row && e.detail <= 1) toggleDetail(row.dataset.coin, row.dataset.symbol);
});
$('rows').addEventListener('mouseleave', () => state.stale && render());
document.addEventListener('visibilitychange', () => !document.hidden && load());

refresh();
