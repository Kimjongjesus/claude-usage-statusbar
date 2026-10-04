# Claude Usage Status Bar

Shows your **month-to-date Claude Code spend vs. your monthly budget** in the VS Code status bar, e.g. `$412.30 / $1,000.00 (41%)`. It turns yellow at 75% and red at 90%.

## Why it is safe to run at work
- **No network access.** The code never makes a request. Read `lib/usage.js`; it only uses `fs`, `os` and `path`.
- **Zero dependencies.** Plain JavaScript with no bundler and no `node_modules`. The whole extension is about 250 lines you can audit in 5 minutes.
- **Read-only.** It reads the `.jsonl` transcripts Claude Code already writes to `~/.claude/projects` and never modifies them.
- **No telemetry, no credentials, no API key needed.**

## How it works
Claude Code logs token usage for every message. Totals persist across sessions and VS Code windows because they come from the log files. The extension de-duplicates streamed and resumed messages, prices tokens per model (including 5-minute/1-hour cache writes and cache reads), and sums the current calendar month (local time).

> **Estimate:** the cost is computed from a built-in price table, not your Anthropic invoice. Check the Anthropic Console for billing-grade numbers. If a model has unknown pricing, Sonnet rates are assumed and a warning appears in the tooltip. Fix it with `claudeUsage.pricingOverrides`.

## Install (Windows, no marketplace needed)
1. Download `claude-usage-statusbar-x.y.z.vsix` from the repo's **Releases** page, or build it (below).
2. VS Code: Extensions panel, then `...`, then **Install from VSIX...**
   Or in a terminal: `code --install-extension claude-usage-statusbar-0.1.0.vsix`
3. Done. The status bar item appears on the right. Click it for a breakdown by model, project and day, plus the monthly totals it has saved.

If your IT policy blocks VSIX installs, you can instead clone this repo into `%USERPROFILE%\.vscode\extensions\claude-usage-statusbar` and restart VS Code.

## Settings
| Setting | Default | |
|---|---|---|
| `claudeUsage.monthlyBudgetUsd` | `1000` | Monthly budget |
| `claudeUsage.warnAtPercent` / `criticalAtPercent` | `75` / `90` | Color thresholds |
| `claudeUsage.dataDirs` | `[]` | Extra `projects` dirs to scan |
| `claudeUsage.pricingOverrides` | `{}` | e.g. `{"opus-5": {"input": 5, "output": 25}}` |
| `claudeUsage.refreshSeconds` | `30` | Rescan interval |

It scans `%USERPROFILE%\.claude\projects` and `$CLAUDE_CONFIG_DIR\projects`.

**Remote/WSL/dev containers:** logs live on the machine where Claude Code runs. The extension runs in the same place as the Claude Code extension so it sees them. Usage on other machines is not included.

## Build / test
```
npm test                      # unit tests, no dependencies
npx @vscode/vsce package      # builds the .vsix
```

## Limitations
- Only counts usage logged on this machine. If `~/.claude` is wiped, history is lost (month totals the extension saw are kept in VS Code's global state and shown in the breakdown).
- Prices are hard-coded estimates and may drift when Anthropic changes them.

MIT licensed.
