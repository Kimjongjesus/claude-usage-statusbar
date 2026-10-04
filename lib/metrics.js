'use strict';
// Derived numbers (pace, projection, thresholds) plus one-time threshold notifications.

// level: 'ok' | 'warn' | 'crit'
function derive(s, c) {
  const budget = c.budget > 0 ? c.budget : 1000;
  const pct = (s.totalUsd / budget) * 100;
  const level = pct >= c.crit ? 'crit' : pct >= c.warn ? 'warn' : 'ok';
  const remaining = Math.max(0, budget - s.totalUsd);
  const daysLeft = s.daysInMonth - s.dayOfMonth + 1; // includes today
  // A projection from less than a day of data is noise, so show "not enough data" instead.
  const projected = s.elapsedDays >= 1 ? (s.totalUsd / s.elapsedDays) * s.daysInMonth : null;
  return {
    budget, pct, level, remaining, daysLeft,
    safeDaily: remaining / Math.max(1, daysLeft),
    evenPaceDaily: budget / s.daysInMonth,
    projected, projectedPct: projected === null ? null : (projected / budget) * 100,
    overBudget: s.totalUsd > budget,
    resetsOn: new Date(s.year, s.monthIndex + 1, 1),
  };
}

// Several dated ids of one model family (e.g. sonnet-4-5-2025...) share one line.
function mergeModels(byModel) {
  const { modelLabel } = require('./format');
  const out = {};
  for (const [id, v] of Object.entries(byModel)) { const l = modelLabel(id); out[l] = (out[l] || 0) + v; }
  return out;
}

function topN(obj, n) {
  const total = Object.values(obj).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name, usd]) => ({ name, usd, share: (usd / total) * 100 }));
}

// Milliseconds until one second past the next local midnight. Used to roll the display over
// on the 1st without waiting for the next poll.
function msToNextMidnight(now) {
  const n = new Date(now);
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 1).getTime() - n.getTime();
}

// state: { month, warn, crit } persisted in globalState. Returns { level, state }.
// Each threshold fires at most once per calendar month. Jumping straight past both
// thresholds fires only the critical notice.
function decideNotification(pct, warn, crit, month, prev) {
  const st = prev && prev.month === month ? { month, warn: !!prev.warn, crit: !!prev.crit } : { month, warn: false, crit: false };
  let level = null;
  if (pct >= crit && !st.crit) { level = 'crit'; st.crit = true; st.warn = true; }
  else if (pct >= warn && !st.warn) { level = 'warn'; st.warn = true; }
  return { level, state: st };
}

module.exports = { derive, topN, mergeModels, msToNextMidnight, decideNotification };
