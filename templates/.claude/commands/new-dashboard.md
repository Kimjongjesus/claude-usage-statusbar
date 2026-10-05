---
description: Scaffold a new dashboard for the hub from the existing pattern
argument-hint: <dashboard-name> <one-line purpose>
allowed-tools: Read, Write, Edit, Glob, Grep
---
<!-- Template: replace every {{PLACEHOLDER}} (they match the ones in CLAUDE.md), then save as .claude/commands/new-dashboard.md in your repo. -->

Create a new dashboard for the hub.

- Name: `$0` (kebab-case)
- Purpose: everything after the name in `$ARGUMENTS`

Follow the "How a dashboard registers with the hub" section of CLAUDE.md. Work in this order, and keep it cheap:

1. Read ONLY `{{PATTERN_DIR}}/` (the pattern dashboard) and `{{REGISTRY_FILE}}`. Do not explore anything else and do not read other dashboards.
2. Create `{{DASHBOARD_DIR}}/$0/` by copying the pattern's files and renaming identifiers. Keep the same structure: `index.{{EXT}}`, `data.{{EXT}}`, `dashboard.json`, `$0.test.{{EXT}}`.
3. Fill `dashboard.json` (`id`, `title`, `route`, `owner`, `dataSources`, `permissions`) from the purpose above. If a value is unknown, put `TODO` and list it at the end.
4. Add exactly one line for `$0` to `{{REGISTRY_FILE}}`, in the same style as the others.
5. Write one smoke test that renders the dashboard with empty data.
6. Run `{{TEST_ONE_CMD}}` for this dashboard only. Fix failures in the new files; do not edit the hub shell.

Finish with a 5-line summary: files created, registry line added, test result, TODOs, what to build next.
