# Token-Saver hooks for Claude Code

Opt-in, Node-only hook scripts that cut token spend. They need nothing but Node, make **no network calls**, and are plain readable JavaScript.

Nothing here is active until you install it. Easiest path: Command Palette, **Claude Usage: Install Token-Saver Hooks**. It shows exactly what it will do, asks first, backs your settings file up, and never edits it silently.

## What Claude Code's hooks API can and cannot do

Checked against the official reference, https://code.claude.com/docs/en/hooks (October 2026). Hook events fire in the VS Code extension, the terminal and the desktop app alike.

| Goal | Possible? | How |
|---|---|---|
| Block or warn before a file read | **Yes** | `PreToolUse` on `Read`, `Grep`, `Glob`; return `permissionDecision: deny` / `ask`, or just `additionalContext` to warn. `tool_input.file_path` is always absolute (backslashes on Windows) |
| Warn about month spend | **Yes** | `UserPromptSubmit`: `systemMessage` shows you a warning, `additionalContext` tells Claude, `decision: block` can refuse a prompt |
| Trim huge **Bash / PowerShell / MCP** output | **Yes** | `PostToolUse` + `updatedToolOutput`. The Bash shape is `stdout`, `stderr`, `interrupted`, `isImage`; MCP output is not schema-checked |
| Trim huge **Read / Grep / Glob** output | **No** | `updatedToolOutput` must match the tool's own output shape, and a mismatch is silently ignored. That shape is not documented for these tools, so the trimmer leaves them alone. Use the read guard to stop the huge read instead |
| Stop `@file` mentions in a prompt from loading a file | **No** | `@` references are inserted without a tool call, so no `PreToolUse` fires. Use a `Read(...)` deny rule |
| Hard-enforce "never read this" | **Not with hooks** | Hooks are best effort (Claude can use `cat` through Bash). Use `permissions.deny` rules (`permissions-deny.snippet.json`) for the real fence |
| Switch the model for a request | **No** | Hooks only see events; they cannot change the model or the price of a request |

Limits worth knowing: `updatedToolOutput` only changes what Claude sees afterwards (the command already ran); every script **fails open** (on any error it prints nothing and exits 0, so a broken hook never blocks your work); Claude Code already caps Bash output near 30,000 characters (`BASH_MAX_OUTPUT_LENGTH`), so the trimmer matters only if you want a tighter cap.

## The scripts

| Script | Event / matcher | What it does |
|---|---|---|
| `guard-reads.js` | `PreToolUse`, `Read\|Grep\|Glob` | Denies `node_modules`, `dist`, `build`, `.next`, `coverage`, `.git`... folders, lockfiles, minified files and source maps, binaries (by extension, then by looking for NUL bytes), and text files over `--max-kb` (default 200 KB) read in full. Reads with `offset`/`limit` are allowed. Images and PDFs are allowed up to `--max-binary-kb` (default 4 MB) |
| `budget-guard.js` | `UserPromptSubmit` | Computes month-to-date spend from the local logs (same estimate as the status bar) and warns once per session at 75% and again at 90%. `--block-over 100` can refuse new prompts over the limit (off by default) |
| `trim-output.js` | `PostToolUse`, `Bash\|PowerShell\|mcp__.*` | Keeps the first and last 6,000 characters of any output field over 15,000 characters and says how much it dropped |

Options go in the hook's `args` list; see the header comment of each script. Common ones: `--mode deny|ask|warn`, `--allow <text>` (never block a path containing this text, repeatable), `--budget 1000`, `--warn 75 --crit 90`.

Files the scripts touch: they read the hook JSON from stdin and (budget guard) the Claude Code logs under `~/.claude/projects`, read-only. The **only** file any of them writes is `~/.claude/token-saver-state.json` (budget guard: which sessions were already warned, and a 60-second cache of the spend number).

## Manual install (instead of the command)

1. Copy `_common.js`, `guard-reads.js`, `budget-guard.js` and `trim-output.js` from this folder into one folder of your own, for example `%USERPROFILE%\.claude\token-saver-hooks\`. Copy `usage.js`, `pricing.js` and `paths.js` from the extension's `lib/` folder into a `lib` subfolder beside them (only the budget guard needs those).
2. Merge `settings.snippet.json` into `~/.claude/settings.json` (all projects) or `.claude/settings.local.json` (this project, not committed). Replace `<HOOKS_DIR>` with the folder from step 1. Keep your existing hooks.
3. Optionally merge `permissions-deny.snippet.json` into the same file's `permissions.deny` list.
4. Start a new Claude Code session. Run `/hooks` inside Claude Code to confirm the three hooks are listed.

The snippet uses Claude Code's exec form (`"command": "node"` plus `"args"`), which passes the script path as one argument with no shell quoting, so it behaves the same in PowerShell, Git Bash and cmd. If your Claude Code is too old to know `args`, upgrade it, or use the shell form: `"command": "node \"C:/Users/you/.claude/token-saver-hooks/guard-reads.js\" --mode deny"`.

## Also worth setting (built in, no hook needed)
- `env.BASH_MAX_OUTPUT_LENGTH`: lowers how many characters of command output Claude Code reads back (default 30000, maximum 150000).
- `env.MAX_MCP_OUTPUT_TOKENS`: caps MCP tool responses (default 25000).
- A project `CLAUDE.md` that lists what **not** to read: see `templates/CLAUDE.template.md`.

## Uninstall
Delete the `token-saver-hooks` folder and remove the entries whose command path contains `token-saver-hooks` from your settings (the installer left a `.bak-<timestamp>` copy of your settings next to the file).
