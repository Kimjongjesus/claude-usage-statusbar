'use strict';
// Loads extension.js against a fake `vscode` module and prints the status bar text.
const Module = require('module');
const items = [];
const fake = {
  StatusBarAlignment: { Right: 2 }, ThemeColor: class { constructor(i) { this.id = i; } },
  MarkdownString: class { constructor() { this.v = ''; } appendMarkdown(s) { this.v += s; } },
  window: { createStatusBarItem: () => { const i = { show() {}, dispose() {} }; items.push(i); return i; }, createOutputChannel: () => ({ clear() {}, appendLine(l) { console.log(l); }, show() {}, dispose() {} }) },
  commands: { registerCommand: (n, f) => { fake._cmds[n] = f; return { dispose() {} }; } }, _cmds: {},
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: () => ({ dispose() {} }) },
};
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? fake : orig.call(this, r, ...a); };
const ext = require('../extension');
const store = {}; const ctx = { subscriptions: [], globalState: { get: (k, d) => store[k] || d, update: (k, v) => { store[k] = v; } } };
ext.activate(ctx);
console.log('STATUS:', items[0].text); console.log('TOOLTIP:', items[0].tooltip.v);
fake._cmds['claudeUsage.showDetails'](); ext.deactivate();
