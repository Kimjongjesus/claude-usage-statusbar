'use strict';
// Small pure helpers shared by the status bar, hover and dashboard.
// Status bar meter uses dots (uniform width in every UI font); the hover uses blocks in a monospace span.
const FILLED = '●';
const EMPTY = '○';
const BLOCKS = ['█', '░'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

function group(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

// $1,234.56
function usd(n) {
  const v = Number.isFinite(n) ? n : 0;
  const s = Math.abs(v).toFixed(2);
  const [i, f] = s.split('.');
  return (v < 0 ? '-$' : '$') + group(i) + '.' + f;
}
// $1,235 for big numbers, $41.20 below $100. Used where space matters.
function usdShort(n) {
  const v = Number.isFinite(n) ? n : 0;
  if (Math.abs(v) >= 100) return (v < 0 ? '-$' : '$') + group(String(Math.round(Math.abs(v))));
  return usd(v);
}
function usdWhole(n) { return (n < 0 ? '-$' : '$') + group(String(Math.round(Math.abs(Number.isFinite(n) ? n : 0)))); }

function bar(pct, segments, glyphs) {
  const [on, off] = glyphs || [FILLED, EMPTY];
  const n = segments || 5;
  const p = Number.isFinite(pct) ? Math.max(0, pct) : 0;
  const filled = Math.min(n, Math.round((p / 100) * n));
  return on.repeat(filled) + off.repeat(n - filled);
}

function count(n) { return group(String(Math.round(n || 0))); }
function compact(n) {
  const v = n || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}

// claude-sonnet-4-5-20250929 -> "Sonnet 4.5", claude-3-5-sonnet-20241022 -> "Sonnet 3.5"
function modelLabel(id) {
  const s = String(id || 'unknown');
  let m = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?=-\d{8}|$|-latest)/i.exec(s);
  if (m) return cap(m[1]) + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
  m = /claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)/i.exec(s);
  if (m) return cap(m[3]) + ' ' + m[1] + (m[2] ? '.' + m[2] : '');
  return s;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

function monthName(i) { return MONTHS[i]; }
function monthLabelFromKey(k) { // '2026-09' -> 'September 2026'
  const [y, m] = k.split('-');
  return MONTHS[Number(m) - 1] + ' ' + y;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function clock(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }

// Markdown / HTML escaping for strings that come out of log files.
function escMd(s) { return String(s).replace(/[\\`*_{}\[\]()#+!|<>~&]/g, '\\$&'); }
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { usd, usdShort, usdWhole, bar, count, compact, modelLabel, monthName, monthLabelFromKey, clock, escMd, escHtml, FILLED, EMPTY, BLOCKS };
