# Claude Usage Status Bar

Your **month-to-date Claude Code spend vs. your monthly budget**, in the VS Code status bar. It counts usage across every session and every VS Code window, and **starts again from $0 on the 1st of each month (local time)**. Nothing else.

![Status bar, dark](docs/screenshots/statusbar-dark.png)
![Status bar, light](docs/screenshots/statusbar-light.png)

- **Status bar:** `$109 ●○○○○ 10%`. The pulse icon becomes a warning (yellow) at 75% and an error (red) at 90%.
- **Hover:** spent / budget, progress bar, remaining, projected month end, safe daily spend, days left, top 3 models.
- **Click:** a dashboard that follows your VS Code theme (light, dark, high contrast).

| Dark | Light |
|---|---|
| ![Hover, dark](docs/screenshots/hover-dark.png) | ![Hover, light](docs/screenshots/hover-light.png) |

The dashboard has a progress ring, a daily spend chart for this month, a pace-vs-budget chart with the projected month end, breakdowns by model and project, token totals and the last-updated time. Past months appear only as a small collapsed list at the bottom.

| Dark | Light |
|---|---|
| ![Dashboard, dark](docs/screenshots/dashboard-dark.png) | ![Dashboard, light](docs/screenshots/dashboard-light.png) |

_Screenshots use fake sample data, not real usage._

## Why it is safe to run at work
- **No network access.** The code never makes a request. It only uses `fs`, `os` and `path` (plus the `vscode` API). The dashboard is a Webview with a strict Content-Security-Policy (`default-src 'none'`): no scripts, no fonts, no remote resources. Charts are inline SVG.
- **Zero runtime dependencies.** Plain JavaScript, no bundler, no `node_modules` in the package. Small enough to audit in a few minutes.
- **Read-only.** It reads the `.jsonl` transcripts Claude Code already writes under `~/.claude/projects` and never modifies them. A unit test fails if runtime code calls any file-writing API.
- **No telemetry, no credentials, no API key needed.**

## How it works
Claude Code logs token usage for every message. The extension reads those logs, de-duplicates streamed and resumed messages, prices tokens per model (including 5-minute and 1-hour cache writes and cache reads), and sums the **current calendar month in local time**. Because the numbers come from the log files, they carry across sessions and windows. The 1st of the month needs no action: a timer fires just after local midnight and the periodic refresh re-checks the month, so the status bar rolls over without a restart.

> **Estimate from local logs.** Cost is computed from a built-in price table, not your Anthropic invoice. Check the Anthropic Console for billing-grade numbers. If a model has unknown pricing, Sonnet rates are assumed and a warning shows in the hover. Fix it with `claudeUsage.pricingOverrides`.

## Convenience
- **First run:** asks you to confirm the monthly budget (default $1,000).
- **Claude Usage: Set Monthly Budget** in the Command Palette (or the link in the hover).
- Updates within a few seconds after Claude Code writes a response (file watcher with throttle), plus a 30 s safety-net rescan, and immediately when you change a setting.
- One notification at the warning % and one at the critical %, **once per month each**.

## Install from VSIX (Windows, no marketplace needed)
1. Get `claude-usage-statusbar-0.2.0.vsix` (the repo's Releases page, or build it below).
2. In VS Code: Extensions panel, `...` menu, **Install from VSIX...**, pick the file.
   Or in a terminal: `code --install-extension claude-usage-statusbar-0.2.0.vsix`
3. The status bar item appears on the right. Click it for the dashboard.

If your IT policy blocks VSIX installs, copy this repo into `%USERPROFILE%\.vscode\extensions\kimjongjesus.claude-usage-statusbar-0.2.0` and restart VS Code.

## Settings
| Setting | Default | |
|---|---|---|
| `claudeUsage.monthlyBudgetUsd` | `1000` | Monthly budget in USD |
| `claudeUsage.warnAtPercent` / `criticalAtPercent` | `75` / `90` | Yellow / red thresholds (and one-time notices) |
| `claudeUsage.notifyOnThresholds` | `true` | Turn the notices off |
| `claudeUsage.dataDirs` | `[]` | Extra `projects` folders to scan (`~` and `%VAR%` are expanded) |
| `claudeUsage.pricingOverrides` | `{}` | e.g. `{"opus-5": {"input": 5, "output": 25}}` |
| `claudeUsage.refreshSeconds` | `30` | Safety-net rescan interval |

It scans `%USERPROFILE%\.claude\projects` and `%CLAUDE_CONFIG_DIR%\projects`. Path handling is unit-tested with `path.win32`.

**Remote / WSL / dev containers:** logs live on the machine where Claude Code runs, and the extension runs there too. Usage on other machines is not included.

## Build / test
```
npm test                       # unit tests, no dependencies
npx @vscode/vsce package       # builds the .vsix
```
Older Node versions may need a `globalThis.File` polyfill for `vsce`, via `NODE_OPTIONS="--require <file>"`.

`node scripts/make-fixture.js <dir>` writes fake two-month Claude history under `<dir>/.claude/projects` for demos and screenshots. It is not shipped in the .vsix.

## Limitations
- Only counts usage logged on this machine. If `~/.claude` is deleted, the current month's number is gone (past-month totals the extension already saw are kept in VS Code's global state for the small "Previous months" list, and are never added to this month).
- Prices are hard-coded estimates and may drift when Anthropic changes them.

MIT licensed.
