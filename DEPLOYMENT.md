# Deployment

Production runs on a single droplet (`165.227.137.141`) as a Docker Compose stack,
served at **https://gym.maksymzhukov.com**. Every push to `main` auto-deploys via
GitHub Actions.

## Architecture

```
                  Internet (:80/:443)
                         │
              ┌──────────▼───────────┐
              │  caddy container     │  serves the React SPA (static)
              │  (Caddy, auto-TLS)   │  proxies /api/* ─┐
              └──────────────────────┘                  │
                                                        │  (internal network)
                                             ┌──────────▼───────────┐
                                             │  backend container   │  NestJS
                                             │  (Node, :3000)       │  GET /api/message
                                             └──────────────────────┘
```

- **Caddy** serves the built frontend and reverse-proxies `/api/*` to the backend.
  It obtains and renews TLS certificates from Let's Encrypt automatically — no certbot.
- **Backend** is internal only (never published to the host); Caddy reaches it by
  service name over the compose network.
- Same-origin in production, so there is no browser CORS in play.

Files: [`docker-compose.yml`](docker-compose.yml), [`backend/Dockerfile`](backend/Dockerfile),
[`frontend/Dockerfile`](frontend/Dockerfile), [`frontend/Caddyfile`](frontend/Caddyfile),
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## How auto-deploy works

On push to `main`, the workflow SSHes to the droplet as the unprivileged `deploy`
user and runs, in `/opt/gymhelper`:

```
git reset --hard origin/main
docker compose up -d --build --remove-orphans
docker image prune -f
```

Only changed images rebuild; unchanged containers keep running. You can also trigger
a manual redeploy from the repo's **Actions → Deploy → Run workflow**.

## First-time setup (once)

1. **Add the GitHub secret.** Repo → Settings → Secrets and variables → Actions →
   *New repository secret*:
   - Name: `DEPLOY_SSH_KEY`
   - Value: the **private** key of the dedicated deploy keypair (the matching public
     key is in [`deploy/server-setup.sh`](deploy/server-setup.sh)).

2. **Provision the server.** From your machine (with your own SSH access to root):

   ```bash
   ssh root@165.227.137.141 'bash -s' < deploy/server-setup.sh
   ```

   This installs Docker, creates the `deploy` user, opens the firewall (22/80/443),
   clones the repo, and starts the stack.

3. **Point DNS.** Create an `A` record: `gym.maksymzhukov.com → 165.227.137.141`.
   Once it resolves, Caddy issues the TLS certificate automatically (may take a minute).

4. Visit **https://gym.maksymzhukov.com**.

## Operations

Run these on the server (as the `deploy` user, in `/opt/gymhelper`):

```bash
docker compose ps            # status
docker compose logs -f       # tail logs
docker compose logs caddy    # TLS / proxy issues
docker compose restart       # restart without rebuild
docker compose down          # stop the stack
```

## Rolling back

```bash
cd /opt/gymhelper
git reset --hard <good-commit-sha>
docker compose up -d --build
```

## Secrets

There are no application secrets yet. When the app needs them (e.g. a database URL),
put them in a git-ignored `/opt/gymhelper/.env` on the server and reference them from
`docker-compose.yml` via `env_file:` — **never** commit real values (this repo is public).
