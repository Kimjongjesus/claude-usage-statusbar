# {{HUB_NAME}} (dashboards hub)

<!-- Starter CLAUDE.md for a dashboards hub. Save it as CLAUDE.md at the root of your repo and replace every {{PLACEHOLDER}}.
     This file is loaded into EVERY session, so keep it short: each line you add is re-sent with every request.
     Move long reference material into docs/ and link it. -->

## What this is
One hub app that hosts many small dashboards for {{AUDIENCE, e.g. desktop client support}}. Stack: {{STACK, e.g. TypeScript, React, Vite, Node API}}.
Each dashboard is an independent module; the hub only knows what a dashboard tells it through its manifest.

## Architecture (read this instead of exploring)
- `{{HUB_SHELL_DIR}}/` : hub shell (navigation, auth, layout). Do not put dashboard logic here.
- `{{DASHBOARD_DIR}}/<name>/` : one folder per dashboard. Entry: `index.{{EXT}}`, manifest: `dashboard.json`, data access: `data.{{EXT}}`.
- `{{REGISTRY_FILE}}` : the list of registered dashboards (one line per dashboard).
- `{{SHARED_DIR}}/` : shared UI, API client, helpers. Reuse before writing new ones.

## How a dashboard registers with the hub
1. Create `{{DASHBOARD_DIR}}/<name>/` from the pattern in `{{PATTERN_DIR}}/` (or run `/new-dashboard <name> <purpose>`).
2. Fill `dashboard.json`: `id`, `title`, `route`, `owner`, `dataSources`, `permissions`.
3. Add one line for it to `{{REGISTRY_FILE}}`. Nothing else in the hub changes.

## Conventions
- {{NAMING, e.g. kebab-case folders, PascalCase components}}
- Data access only through `{{SHARED_DIR}}/api`; no direct fetch/SQL inside components.
- Every dashboard gets a smoke test in `<name>/<name>.test.{{EXT}}`.
- Keep changes small and focused: one dashboard or one shared module per change.

## Commands
- Install: `{{INSTALL_CMD}}`
- Dev server: `{{DEV_CMD}}`
- Test (all): `{{TEST_CMD}}`   Test (one dashboard): `{{TEST_ONE_CMD}}`
- Build: `{{BUILD_CMD}}`   Lint/format: `{{LINT_CMD}}`

## Do not read (waste tokens, never relevant)
`node_modules/`, `dist/`, `build/`, `coverage/`, `.next/`, lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`),
`*.min.js`, `*.map`, `{{FIXTURES_DIR}}/` (large sample data), `{{GENERATED_DIR}}/` (generated code: change the generator instead).
Use Grep to find things, then Read with offset/limit. Do not re-read a file already in this conversation.

## Working agreement
- Ask before adding a dependency or changing the registry format.
- Plan first for anything touching more than 3 files; otherwise just do it.
- Run `{{TEST_ONE_CMD}}` for the dashboard you changed before saying it is done.
