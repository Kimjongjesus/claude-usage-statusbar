#!/usr/bin/env node
'use strict';
// Dev-only (not shipped; scripts/** is in .vscodeignore): renders the dashboard, hub and waste report from the
// synthetic fixture into plain HTML files, one per page and theme, plus the status bar hover markdown, so a
// headless browser can sweep window sizes (see scripts/resize-sweep.py).
//   node scripts/make-fixture.js <home> --now 2026-10-04T10:30:00 --handoff <home>/proj
//   node scripts/render-pages.js <home> <out-dir> [--stress] [--budget N]
// --stress rewrites project, branch and session names (and file paths) to very long ones so the sweep also
// covers the worst case a real history can produce.
// Webviews in VS Code get the active theme's --vscode-* CSS variables injected; the THEMES table below is a
// close copy of Dark+, Light+ and High Contrast so the pages look as they do in the editor.
// Zero network, zero dependencies.
const fs = require('fs');
const path = require('path');
const { summarize } = require('../lib/usage');
const { derive } = require('../lib/metrics');
const { analyze } = require('../lib/waste');
const { pickActive, ctxInfo, adviceText } = require('../lib/sessions');
const hubModel = require('../lib/hub');
const handoffs = require('../lib/handoffs');
const advice = require('../lib/plan-advice');
const { render } = require('../lib/dashboard');
const { render: renderHub } = require('../lib/hub-view');
const { render: renderWaste } = require('../lib/waste-view');
const { tooltipMarkdown, statusText } = require('../lib/tooltip');

const THEMES = {
  dark: {
    '--vscode-editor-background': '#1e1e1e', '--vscode-foreground': '#cccccc', '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-editorWidget-background': '#252526', '--vscode-sideBar-background': '#252526', '--vscode-panel-border': '#80808059',
    '--vscode-input-background': '#3c3c3c', '--vscode-button-background': '#0e639c', '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#1177bb', '--vscode-button-secondaryBackground': '#3a3d41', '--vscode-button-secondaryForeground': '#ffffff',
    '--vscode-button-secondaryHoverBackground': '#45494e', '--vscode-focusBorder': '#007fd4', '--vscode-textLink-foreground': '#3794ff',
    '--vscode-textLink-activeForeground': '#3794ff', '--vscode-textBlockQuote-background': '#222222', '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-charts-blue': '#3794ff', '--vscode-charts-green': '#89d185', '--vscode-charts-yellow': '#cca700', '--vscode-charts-red': '#f14c4c',
    '--vscode-charts-purple': '#b180d7', '--vscode-charts-orange': '#d18616',
    '--vscode-statusBarItem-warningBackground': '#7a5c00', '--vscode-statusBarItem-warningForeground': '#ffffff',
    '--vscode-statusBarItem-errorBackground': '#c72e0f', '--vscode-statusBarItem-errorForeground': '#ffffff',
  },
  light: {
    '--vscode-editor-background': '#ffffff', '--vscode-foreground': '#3b3b3b', '--vscode-descriptionForeground': '#717171',
    '--vscode-editorWidget-background': '#f3f3f3', '--vscode-sideBar-background': '#f3f3f3', '--vscode-panel-border': '#80808059',
    '--vscode-input-background': '#ffffff', '--vscode-button-background': '#007acc', '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#0062a3', '--vscode-button-secondaryBackground': '#5f6a79', '--vscode-button-secondaryForeground': '#ffffff',
    '--vscode-button-secondaryHoverBackground': '#4c5561', '--vscode-focusBorder': '#0090f1', '--vscode-textLink-foreground': '#006ab1',
    '--vscode-textLink-activeForeground': '#006ab1', '--vscode-textBlockQuote-background': '#f2f2f2', '--vscode-list-hoverBackground': '#e8e8e8',
    '--vscode-charts-blue': '#1a85ff', '--vscode-charts-green': '#388a34', '--vscode-charts-yellow': '#bf8803', '--vscode-charts-red': '#e51400',
    '--vscode-charts-purple': '#652d90', '--vscode-charts-orange': '#d18616',
    '--vscode-statusBarItem-warningBackground': '#bf8803', '--vscode-statusBarItem-warningForeground': '#ffffff',
    '--vscode-statusBarItem-errorBackground': '#c72e0f', '--vscode-statusBarItem-errorForeground': '#ffffff',
  },
  hc: {
    '--vscode-editor-background': '#000000', '--vscode-foreground': '#ffffff', '--vscode-descriptionForeground': '#ffffffb3',
    '--vscode-editorWidget-background': '#0c141f', '--vscode-sideBar-background': '#000000', '--vscode-panel-border': '#6fc3df',
    '--vscode-contrastBorder': '#6fc3df', '--vscode-input-background': '#000000', '--vscode-button-background': '#000000',
    '--vscode-button-foreground': '#ffffff', '--vscode-button-hoverBackground': '#000000', '--vscode-button-secondaryBackground': '#000000',
    '--vscode-button-secondaryForeground': '#ffffff', '--vscode-focusBorder': '#f38518', '--vscode-textLink-foreground': '#21a6ff',
    '--vscode-textLink-activeForeground': '#21a6ff', '--vscode-textBlockQuote-background': '#00000000', '--vscode-list-hoverBackground': '#00000000',
    '--vscode-charts-blue': '#3794ff', '--vscode-charts-green': '#89d185', '--vscode-charts-yellow': '#cca700', '--vscode-charts-red': '#f14c4c',
    '--vscode-charts-purple': '#b180d7', '--vscode-charts-orange': '#d18616',
    '--vscode-statusBarItem-warningBackground': '#000000', '--vscode-statusBarItem-warningForeground': '#ffffff',
    '--vscode-statusBarItem-errorBackground': '#000000', '--vscode-statusBarItem-errorForeground': '#ffffff',
  },
};

const args = process.argv.slice(2);
const home = args[0], out = args[1];
const stress = args.includes('--stress');
const bi = args.indexOf('--budget'); // e.g. --budget 200 puts the dashboard in its warning / critical state
const budget = bi >= 0 ? Number(args[bi + 1]) : 1000;
if (!home || !out) { console.error('usage: render-pages.js <fixture-home> <out-dir> [--stress]'); process.exit(2); }

const NOW = new Date(2026, 9, 4, 10, 30, 0);
const CFG = { budget, warn: 75, crit: 90, ctxWindow: 200000, ctxNudge: 150000, ctxHintPct: 50 };
const s = summarize({ dirs: [path.join(home, '.claude', 'projects')], now: NOW });

const LONG_PROJECT = 'customer-success-orchestration-platform-monorepo';
const LONG_BRANCH = 'feature/JIRA-48213-refactor-the-entire-notification-preferences-and-delivery-scheduling-subsystem';
const LONG_TITLE = 'Investigate intermittent failures in the nightly reconciliation-job-with-an-extremely-long-hyphenated-identifier-name';
if (stress) {
  let i = 0;
  const pmap = {};
  const rp = (p) => (pmap[p] = pmap[p] || (i++ === 0 ? LONG_PROJECT : p + '-' + LONG_PROJECT.slice(0, 18)));
  for (const x of s.sessions) {
    x.project = rp(x.project);
    if (x.branch && x.branch !== 'main') x.branch = LONG_BRANCH;
    if (x.title && (x.monthUsd | 0) % 2 === 0) x.title = LONG_TITLE;
  }
  for (const b of s.byBranch || []) { b.project = rp(b.project); if (b.branch && b.branch !== 'main') b.branch = LONG_BRANCH; }
  s.byProject = Object.fromEntries(Object.entries(s.byProject).map(([k, v]) => [rp(k), v]));
  s.dirs = s.dirs.map((d) => d + path.sep + 'a-very-long-directory-name-' + 'x'.repeat(60));
}

const d = derive(s, CFG);
const pick = pickActive(s.sessions, { workspaceDirs: [], now: NOW });
const info = pick && ctxInfo(pick.session, { window: CFG.ctxWindow });
const cx = pick && { session: pick.session, info, active: pick.active, inWorkspace: pick.inWorkspace, nudgeAt: CFG.ctxNudge, advice: adviceText(info), show: true };
const rep = analyze(s, { ctxThreshold: CFG.ctxNudge });
const hub = hubModel.buildHub(s, rep, { now: NOW, ctxThreshold: CFG.ctxNudge, contextWindow: CFG.ctxWindow, workspaceDirs: [path.join(home, 'proj')] });
const hoRows = handoffs.list([path.join(home, 'proj')]).slice(0, 8).map((e) => {
  const h = handoffs.read(e);
  return { name: e.name, rootIndex: 0, relPath: e.relPath, mtimeMs: NOW - 120000, title: stress ? LONG_TITLE : h.title, project: stress ? LONG_PROJECT : 'proj', suggestion: advice.suggest(h.plan), status: 'new' };
});
const history = { '2026-09': 640.5, '2026-08': 300 };

const pages = {
  dashboard: (nonce) => render(s, d, { nonce, updatedAt: NOW, history, context: cx, home }),
  hub: (nonce) => renderHub(hub, s, d, { nonce, updatedAt: NOW, handoffs: hoRows, handoffHook: true }),
  waste: (nonce) => renderWaste(s, d, rep, { nonce, updatedAt: NOW }),
};

// Approximation of the stylesheet VS Code adds to every webview, so default link/body behaviour matches.
const HOST_CSS = `html { scrollbar-color: rgba(121,121,121,.4) transparent; } body { background-color: var(--vscode-editor-background); color: var(--vscode-foreground);
 font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); margin: 0; padding: 0 20px; }
a, a code { color: var(--vscode-textLink-foreground); } a:hover { color: var(--vscode-textLink-activeForeground); }
code { font-family: var(--vscode-editor-font-family, monospace); }`;

function themed(html, theme, fontFamily) {
  const vars = Object.assign({ '--vscode-font-family': fontFamily, '--vscode-font-size': '13px' }, THEMES[theme]);
  const decl = Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ');
  // Same nonce as the page's own <style>, so its CSP still allows it.
  return html.replace(/<style nonce="([^"]+)">/, (m, n) => `<style nonce="${n}">:root { ${decl} } ${HOST_CSS}</style>${m}`)
    .replace('<body>', `<body class="vscode-${theme === 'hc' ? 'high-contrast' : theme}">`);
}

// Minimal markdown for the hover: headings, tables, **bold**, `code`, _em_, [links](cmd). Enough for tooltipMarkdown().
function md(src) {
  const inline = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\\([\\`*_{}[\]()#+.!|<>~$-])/g, '$1'); // markdown backslash escapes (escMd output)
  const lines = src.split('\n'), o = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^## /.test(l)) { o.push(`<h2>${inline(l.slice(3))}</h2>`); continue; }
    if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const align = cells(rows[1] || '').map((a) => (/:$/.test(a) ? 'right' : 'left'));
      o.push('<table>' + `<thead><tr>${cells(rows[0]).map((c, k) => `<th class="${align[k]}">${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
        rows.slice(2).map((r) => `<tr>${cells(r).map((c, k) => `<td class="${align[k]}">${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>');
      continue;
    }
    if (l.trim()) o.push(`<p>${inline(l)}</p>`);
  }
  return o.join('\n');
}

function hoverPage(theme, fontFamily, mdText) {
  const vars = Object.assign({ '--vscode-font-family': fontFamily, '--vscode-font-size': '13px' }, THEMES[theme]);
  const decl = Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ');
  // The hover widget: max-width 500px (VS Code's default hover limit), wraps long words, padding 4px 8px,
  // markdown tables with 0 4px cell padding. Never wider than the window.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>:root{${decl}}
body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px;line-height:1.4;}
.hover{box-sizing:border-box;max-width:min(500px,100vw);margin:8px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background);padding:4px 8px;
 overflow-wrap:anywhere;} .hover p{margin:6px 0;} .hover h2{font-size:1.3em;margin:6px 0;} .hover table{border-collapse:collapse;margin:6px 0;width:100%;}
.hover td,.hover th{padding:0 4px;} .hover .right{text-align:right;} .hover code{font-family:monospace;}</style></head>
<body><div class="hover">${md(mdText)}</div></body></html>`;
}

fs.mkdirSync(out, { recursive: true });
const fonts = { lato: '"Lato", "Segoe UI", sans-serif', dejavu: '"DejaVu Sans", sans-serif' };
const manifest = [];
for (const [fontKey, fam] of Object.entries(fonts)) {
  for (const theme of Object.keys(THEMES)) {
    for (const [name, make] of Object.entries(pages)) {
      const file = `${name}-${theme}-${fontKey}${stress ? '-stress' : ''}.html`;
      fs.writeFileSync(path.join(out, file), themed(make('sweepnonce'), theme, fam));
      manifest.push({ page: name, theme, font: fontKey, stress, file });
    }
    const tip = tooltipMarkdown(s, d, { links: true, context: cx });
    const file = `hover-${theme}-${fontKey}${stress ? '-stress' : ''}.html`;
    fs.writeFileSync(path.join(out, file), hoverPage(theme, fam, tip));
    manifest.push({ page: 'hover', theme, font: fontKey, stress, file });
  }
}
fs.writeFileSync(path.join(out, 'manifest' + (stress ? '-stress' : '') + '.json'), JSON.stringify(manifest, null, 1));
console.log('status bar text:', statusText(s, d, { show: true, tokens: info ? info.tokens : 0 }));
console.log(`wrote ${manifest.length} pages to ${out}`);
