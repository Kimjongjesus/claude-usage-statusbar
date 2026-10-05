# Claude Usage Status Bar

Your **month-to-date Claude Code spend vs. your monthly budget**, in the VS Code status bar. It counts usage across every session and every VS Code window, and **starts again from $0 on the 1st of each month (local time)**. That core has not changed.

Version 0.3 adds four things that help you spend less: a **context meter**, a **Waste Report**, **per-session and per-feature cost**, and an opt-in **token-saver hooks pack**.

![Status bar with context hint, dark](docs/screenshots/statusbar-dark.png)
![Status bar with context hint, light](docs/screenshots/statusbar-light.png)

- **Status bar:** `$551 ●●●○○ 55% · ctx 142k`. The pulse icon becomes a warning (yellow) at 75% and an error (red) at 90%. The `ctx 142k` hint appears only when your current session's context gets large.
- **Hover:** spent / budget, remaining, projected month end, safe daily spend, top models, **this session's cost**, and the context size with a concrete saving tip.
- **Click:** a dashboard that follows your VS Code theme (light, dark, high contrast).

| Dark | Light |
|---|---|
| ![Hover, dark](docs/screenshots/hover-dark.png) | ![Hover, light](docs/screenshots/hover-light.png) |

## What is new in 0.3

### 1. Context meter
Every request Claude Code makes re-sends the whole conversation. The meter shows how big the current session's context is (`input + cache read + cache write` tokens of its last request) against your model's context window (`claudeUsage.contextWindow`, default 200,000), and says what that costs:

> Each request re-sends about 142k tokens: roughly $0.043 per request at Sonnet 4.5 while the cache is warm ($0.53 if it expired). /compact (summarize) or /clear (fresh start) would shrink that.

You get one notice per session when it passes `claudeUsage.contextNudgeAt` (default 150,000). It is remembered, so it never repeats for the same session, even after a restart. Set it to `0` to turn it off.

### 2. Waste Report
Command Palette: **Claude Usage: Waste Report** (also linked from the hover and the dashboard). A themed page with the same strict CSP as the dashboard:

- **Most expensive sessions** this month, with branch, share of spend, requests and peak context.
- **Cold start vs cache reads:** cost by token class, the cache-write cost of each session's first request, and cache rewrites after idle pauses.
- **Context-bloat sessions:** what re-sending tokens above your threshold cost.
- **Repeated reads** of the same file within a session, and **huge tool results** (over about 5k tokens).
- **Per-model cost share**, and the estimated saving if routine work moved to the next cheaper model.

![Waste report, dark](docs/screenshots/waste-dark.png)
![Waste report, light](docs/screenshots/waste-light.png)

Every number comes from the logs. Where a figure rests on a rule of thumb it carries a **heuristic** tag and says which rule:

| Heuristic | Rule used |
|---|---|
| Expired-cache rewrite | a pause longer than 5 minutes (60 for the 1-hour cache) followed by a cache write of at least 10k tokens; "extra" = that write minus what a warm read would have cost |
| Context bloat | tokens above `contextNudgeAt` in a request, priced at the cache-read rate |
| Repeated read | the same file read again in the same session (not checked for edits in between); tokens = result characters / 4; cost = those tokens at the cache-write rate, a minimum |
| Huge tool result | a single result over 20,000 characters (about 5k tokens by characters / 4) |
| Routine work | a request whose only tool calls were Read, Grep, Glob, LS, Bash or PowerShell and whose answer was at most 400 output tokens; saving = those exact tokens repriced on the next cheaper family (Opus to Sonnet, Sonnet to Haiku). A cheaper model may need more turns and a model switch restarts the cache, so treat it as an upper-bound style estimate |

### 3. Per-session and per-feature cost
The dashboard gets a **Current session** card, a **Recent sessions** list and a **By branch (feature)** breakdown, so you can see what each dashboard or feature cost to build. Work on one git branch is one feature. The month total is still the headline.

| Dark | Light |
|---|---|
| ![Dashboard, dark](docs/screenshots/dashboard-dark.png) | ![Dashboard, light](docs/screenshots/dashboard-light.png) |

### 4. Token-Saver hooks pack (opt-in)
Node-only [Claude Code hooks](hooks/README.md) plus templates, in `hooks/` and `templates/` (both ship in the .vsix):

| What | Where |
|---|---|
| **Read guard**: denies `node_modules`/`dist`/`build`, lockfiles, minified files, binaries and huge files before Claude spends tokens on them | `hooks/guard-reads.js` |
| **Budget guard**: warns you once per session at 75% and 90% of the monthly budget (optional hard stop) | `hooks/budget-guard.js` |
| **Output trimmer**: shortens huge Bash/PowerShell/MCP output before Claude reads it | `hooks/trim-output.js` |
| `settings.json` snippet and a ready-to-copy `permissions.deny` snippet | `hooks/settings.snippet.json`, `hooks/permissions-deny.snippet.json` |
| Starter `CLAUDE.md` for a dashboards hub (architecture, how a dashboard registers, conventions, commands, a "do not read" list) | `templates/CLAUDE.template.md` |
| `/new-dashboard` slash command that scaffolds a dashboard from your pattern | `templates/.claude/commands/new-dashboard.md` |

The templates are generic with `{{PLACEHOLDERS}}` for your own project.

**Install:** Command Palette, **Claude Usage: Install Token-Saver Hooks**. It opens a preview of what it would do, then asks. Nothing is written until you pick an install option and click **Write files** in a confirmation that lists every file. It copies the scripts to `~/.claude/token-saver-hooks`, saves a timestamped backup of your settings file, and merges the hooks in without touching your own hooks and permissions. A settings file that is not valid JSON is never touched. "Copy the snippet" options write nothing.

![Install confirmation](docs/screenshots/install-confirm-dark.png)

**What hooks can and cannot do** (checked against the [official hooks reference](https://code.claude.com/docs/en/hooks)): they can block or warn before a read, warn you about spend, and replace Bash/PowerShell/MCP output. They **cannot** trim Read/Grep/Glob output (the replacement must match an output shape that is not documented for those tools), cannot stop an `@file` mention from loading a file, cannot switch the model, and are not a hard fence (Claude can still `cat` a file via Bash; use `permissions.deny` for that). Details and the full table are in [hooks/README.md](hooks/README.md). The scripts were also run against a real Claude Code 2.1.289 session to confirm the deny, the context warning and the output trim are accepted.

## Why it is safe to run at work
- **No network access.** No code in the extension or the hook scripts makes a request. They use only `fs`, `os` and `path` (plus the `vscode` API in the extension). The webviews have a strict Content-Security-Policy (`default-src 'none'`): no scripts, no fonts, no remote resources. Charts are inline SVG. A test fails if any runtime file or hook script references a network or process API.
- **Zero runtime dependencies.** Plain JavaScript, no bundler, no `node_modules` in the package. Small enough to audit in a few minutes.
- **Read-only on your Claude logs.** It reads the `.jsonl` transcripts Claude Code already writes under `~/.claude/projects` and never modifies them. A test fails if any runtime file calls a file-writing API, except the two documented writers: the hooks installer (only after you confirm) and the budget guard's small state file.
- **Nothing is installed or edited silently.** The hooks installer is the only code that writes to disk, only after a modal confirmation, with a backup first.
- **No telemetry, no credentials, no API key needed.**

## How it works
Claude Code logs token usage for every message. The extension reads those logs, de-duplicates streamed and resumed messages, prices tokens per model (including 5-minute and 1-hour cache writes and cache reads), and sums the **current calendar month in local time**. Because the numbers come from the log files, they carry across sessions and windows. The 1st of the month needs no action: a timer fires just after local midnight and the periodic refresh re-checks the month, so the status bar rolls over without a restart.

> **Estimate from local logs.** Cost is computed from a built-in price table, not your Anthropic invoice. Check the Anthropic Console for billing-grade numbers. If a model has unknown pricing, Sonnet rates are assumed and a warning shows in the hover. Fix it with `claudeUsage.pricingOverrides`.

### What the logs contain, and how the current session is found
Checked against real Claude Code 2.1 transcripts:
- Every record carries `sessionId`, `cwd`, `gitBranch` and `isSidechain` (true for subagent turns, which share the main session's id). Per-session and per-branch cost use these.
- One assistant message is written as several lines (one per content block) sharing one message id; the last has the final usage. Tool calls are `tool_use` blocks and their results come back as `tool_result` blocks, joined by `tool_use_id`. The Waste Report uses those.
- A resumed or forked session copies earlier messages into a **new file under a new session id**. They are counted once in the totals and stay with the session that wrote them (the copy in the oldest file wins).
- `ai-title` records hold Claude's generated session title, used as the session name.
- `gitBranch` can be `HEAD` (detached or some worktrees); it is shown as "(detached HEAD)".

**Assumptions** for "current session": it is the session whose last main-conversation request is newest. With several VS Code windows open, a session whose working folder is one of this window's folders wins. A session counts as **active** if Claude wrote to it in the last hour; the status bar hint and the nudge only apply to an active session, and the hover says "Last session" otherwise. Subagent turns never count toward context size (they have their own), but their cost belongs to the session.

## Convenience
- **First run:** asks you to confirm the monthly budget (default $1,000).
- **Claude Usage: Set Monthly Budget** in the Command Palette (or the link in the hover).
- Updates within a few seconds after Claude Code writes a response (file watcher with throttle), plus a 30 s safety-net rescan, and immediately when you change a setting. Long logs are read incrementally, only the new part.
- One notification at the warning % and one at the critical %, **once per month each**.

## Install from VSIX (Windows, no marketplace needed)
1. Get `claude-usage-statusbar-0.3.0.vsix` (the repo's Releases page, or build it below).
2. In VS Code: Extensions panel, `...` menu, **Install from VSIX...**, pick the file.
   Or in a terminal: `code --install-extension claude-usage-statusbar-0.3.0.vsix`
3. The status bar item appears on the right. Click it for the dashboard.

If your IT policy blocks VSIX installs, copy this repo into `%USERPROFILE%\.vscode\extensions\kimjongjesus.claude-usage-statusbar-0.3.0` and restart VS Code. The hooks and templates are in the installed extension folder (`hooks\`, `templates\`) and in this repo.

## Settings
| Setting | Default | |
|---|---|---|
| `claudeUsage.monthlyBudgetUsd` | `1000` | Monthly budget in USD |
| `claudeUsage.warnAtPercent` / `criticalAtPercent` | `75` / `90` | Yellow / red thresholds (and one-time notices) |
| `claudeUsage.notifyOnThresholds` | `true` | Turn the notices off |
| `claudeUsage.contextWindow` | `200000` | Context window of your model, for the meter (use `1000000` for a 1M model) |
| `claudeUsage.contextNudgeAt` | `150000` | One notice per session at this many tokens of context; `0` = off |
| `claudeUsage.contextHintAtPercent` | `50` | Show `ctx 142k` in the status bar from this % of the window |
| `claudeUsage.dataDirs` | `[]` | Extra `projects` folders to scan (`~` and `%VAR%` are expanded) |
| `claudeUsage.pricingOverrides` | `{}` | e.g. `{"opus-5": {"input": 5, "output": 25}}` |
| `claudeUsage.refreshSeconds` | `30` | Safety-net rescan interval |

It scans `%USERPROFILE%\.claude\projects` and `%CLAUDE_CONFIG_DIR%\projects`. Path handling is unit-tested with `path.win32`.

**Remote / WSL / dev containers:** logs live on the machine where Claude Code runs, and the extension runs there too. Usage on other machines is not included.

## Build / test
```
npm test                       # unit tests, no dependencies
npx @vscode/vsce package       # builds the .vsix (hooks/ and templates/ are included)
```
Older Node versions may need a `globalThis.File` polyfill for `vsce`, via `NODE_OPTIONS="--require <file>"`.

`node scripts/make-fixture.js <dir>` writes a fake Claude history (several months, branches, a bloated session, repeated reads, huge tool results) under `<dir>/.claude/projects` for demos and screenshots. It is not shipped in the .vsix. _All screenshots use this fake data, not real usage._

## Limitations
- Only counts usage logged on this machine. If `~/.claude` is deleted, the current month's number is gone (past-month totals the extension already saw are kept in VS Code's global state for the small "Previous months" list, and are never added to this month).
- Prices are hard-coded estimates and may drift when Anthropic changes them.
- The branch breakdown can only be as good as `gitBranch` in the logs (`HEAD` when detached).
- Waste-report figures marked heuristic are estimates by design; they point at where to look, not at an exact saving.

MIT licensed.
