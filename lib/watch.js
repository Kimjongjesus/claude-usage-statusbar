'use strict';
// Read-only change watcher for the Claude projects folders, so the number updates soon
// after a Claude Code response. Uses fs.watch only (no polling of file contents here);
// the extension's interval timer remains the safety net.
const fs = require('fs');
const path = require('path');

// Calls onChange at most once per `throttleMs` while files are changing.
function throttle(fn, ms) {
  let t = null;
  const run = () => { if (t) return; t = setTimeout(() => { t = null; fn(); }, ms); };
  run.cancel = () => { if (t) { clearTimeout(t); t = null; } };
  return run;
}

function watchDirs(dirs, onChange, throttleMs) {
  const trigger = throttle(onChange, throttleMs === undefined ? 3000 : throttleMs);
  const watchers = [];
  const safe = (dir, opts) => {
    try {
      const w = fs.watch(dir, opts, trigger);
      w.on('error', () => {});
      watchers.push(w);
      return true;
    } catch { return false; }
  };
  for (const dir of dirs) {
    // Recursive watching: Windows, macOS and newer Node. Falls back to the dir plus
    // its immediate project folders (where the .jsonl files live).
    if (safe(dir, { recursive: true, persistent: false })) continue;
    safe(dir, { persistent: false });
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of ents) if (e.isDirectory()) safe(path.join(dir, e.name), { persistent: false });
  }
  return {
    count: watchers.length,
    dispose() { trigger.cancel(); for (const w of watchers) { try { w.close(); } catch { /* ignore */ } } watchers.length = 0; },
  };
}

module.exports = { watchDirs, throttle };
