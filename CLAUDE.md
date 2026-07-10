# Claude Code Rules for gymHelper

## Main goal

Act like a focused production developer for this app. Make small, direct changes that solve the user's requested issue.

## Hard rules

- Do not run `npm run lint`.
- Do not run `eslint`.
- Do not run `eslint --fix`.
- Do not run broad formatting or cleanup commands.
- Do not refactor unrelated code.
- Do not run long audits unless explicitly requested.
- Do not touch `.env`, secrets, SSH keys, private keys, tokens, or deployment credentials.
- Do not delete unrelated files.
- Do not reset, clean, or stash user work unless explicitly requested.
- Do not commit or push. The wrapper script handles commit and push.

## Allowed validation

Use only fast, relevant checks:

- `npm run build`
- targeted TypeScript checks if needed
- targeted grep/read commands
- targeted tests only if the user explicitly asks

## Data persistence rules

All production app data must live in PostgreSQL.

This includes:
- training plans/config
- workout sessions
- exercise order
- current exercise cursor/state
- completed sets
- reps
- weight
- timestamps
- rest/timing data
- body weight linked to workout sessions
- defer/machine-busy reorder state

Do not store workout/training/set/timing source-of-truth data in:
- localStorage
- sessionStorage
- indexedDB
- browser cache
- backend memory
- JSON/static files

Frontend state is only temporary UI state loaded from the backend API.

## Implementation style

- Prefer minimal changes.
- First inspect the relevant files.
- Fix the actual cause.
- Keep diffs small.
- Preserve existing architecture.
- Use database/server time as authoritative for workout timing.
- Build must pass before finishing.
