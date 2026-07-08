# GymHelper — Project Rules

The ultimate personal gym helper: a **web app + backend**, developed in the open as a
**public GitHub repository** (`git@github.com:maxizhukov/gymHelper.git`).

Because the repo is public, treat every commit as world-readable and permanent.
These rules are binding for all work in this repo.

---

## 1. Security — no secrets, ever

This is the highest-priority rule. A public repo means anything committed is
public forever, even if later deleted (it stays in git history and on forks/mirrors).

**Never commit:**
- API keys, tokens, passwords, connection strings, private keys, certificates
- `.env` files or any file with real credentials
- OAuth client secrets, JWT signing secrets, session secrets
- Database dumps, backups, or anything with real user data (PII)
- Cloud provider credentials (AWS, GCP, Azure), service-account JSON files

**Always do instead:**
- Read secrets from environment variables (`process.env.X` / equivalent) at runtime.
- Keep a committed `.env.example` with **placeholder** values documenting every
  required variable — never real values.
- Real secrets live only in a local, git-ignored `.env` and in the deploy platform's
  secret store.
- If a secret is ever committed by accident: **rotate/revoke it immediately** — do not
  assume deleting the file is enough. Then tell the user.

**Before every commit:** scan the staged diff for anything that looks like a
credential. If unsure whether something is sensitive, ask before committing.

## 2. Git workflow

- Do **not** commit or push unless the user explicitly asks.
- Never force-push to `main` or rewrite shared history without explicit approval.
- Write clear, conventional commit messages describing the *why*.
- Keep commits focused and reviewable.

## 3. Code quality

- Match the existing style and conventions of the file being edited.
- Prefer clear, readable code over cleverness. No dead code or leftover debug logs.
- Validate and sanitize all external input (this is a web app — assume hostile input).
- Handle errors explicitly; don't swallow exceptions silently.
- No hardcoded config that varies by environment — use env vars / config files.

## 4. Design — mobile first

- Design and build **mobile first**: base styles target small screens; layer on
  larger layouts with `min-width` media queries, not the other way around.
- Use responsive units and fluid layouts; avoid fixed widths that break on phones.
- Keep tap targets comfortably sized and keep form inputs at ≥16px font so mobile
  browsers don't auto-zoom on focus.
- Verify the UI works at a narrow viewport before widening it.

## 5. Web + backend specifics

- **Input validation** on every API endpoint and form.
- **AuthN/AuthZ**: never trust the client; enforce permissions server-side.
- Use parameterized queries / an ORM — never string-concatenate SQL.
- Set security headers, CORS, and rate limiting deliberately, not by copy-paste.
- Don't log secrets, tokens, or full PII.

## 6. Working style

- When the stack/framework choices are still open, ask before locking one in.
- Keep dependencies minimal and justified; each new dependency is a maintenance and
  supply-chain cost on a public repo.
- Explain trade-offs briefly and give a recommendation rather than a survey.

## 7. Production-ready, secure by default

Write every change as if it ships to production today — not as a prototype to be
hardened "later." Later rarely comes, and this is a public repo serving real users.

- **Authentication uses server-side sessions.** The server is the source of truth
  for who is signed in: on login, create a session and return an opaque,
  high-entropy token in an **HttpOnly, `SameSite`, `Secure`-in-production cookie**.
  Never keep identity or trust decisions in client storage (`localStorage`, a
  client-sent username) — the client is untrusted. Store only a **hash** of the
  session token at rest, set an expiry, and invalidate sessions on logout and on
  password change.
- **Derive the acting user from the session, never from the request body.** An
  endpoint must act on the authenticated principal, not on an id/username the client
  supplies — otherwise one user can act as another.
- **Secure defaults, not afterthoughts:** validate and sanitize all input, enforce
  authZ server-side, parameterized queries only, deliberate CORS/headers/rate limits,
  constant-time comparisons for secrets, and no secrets or full PII in logs.
- **Fail safe:** on any doubt (missing session, malformed input, unreachable
  dependency) deny the request rather than falling through to a permissive path.
- **Handle every error path**, including the ones "that can't happen." Don't swallow
  exceptions; surface actionable errors without leaking internals to the client.
- Prefer Node/framework built-ins and well-vetted primitives for security-sensitive
  code; when you must hand-roll (to avoid a dependency), follow the established
  pattern in this repo and keep it auditable.

---

_Update this file as the project's stack and conventions solidify._
