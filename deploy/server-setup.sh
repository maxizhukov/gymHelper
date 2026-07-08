#!/usr/bin/env bash
#
# One-time provisioning for the GymHelper production droplet (165.227.137.141).
# Run this ONCE as root on a fresh Ubuntu server:
#
#   ssh root@165.227.137.141 'bash -s' < deploy/server-setup.sh
#
# It installs Docker, creates an unprivileged `deploy` user that GitHub Actions
# uses, opens the firewall, clones the repo, and brings the stack up. After this,
# every push to main auto-deploys via .github/workflows/deploy.yml.
set -euo pipefail

REPO_URL="https://github.com/maxizhukov/gymHelper.git"
APP_DIR="/opt/gymhelper"
DEPLOY_USER="deploy"

# Public half of the dedicated CI deploy key. The PRIVATE half lives only in the
# GitHub Actions secret DEPLOY_SSH_KEY — never in this repo.
DEPLOY_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOc+/sOTdHjJMtrSAvWYk7h/lZT+pJOza6rwdZOPtZlW github-actions-deploy@gymhelper"

echo ">> Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw

echo ">> Installing Docker..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo ">> Creating '$DEPLOY_USER' user..."
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

echo ">> Installing CI deploy public key..."
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
printf '%s\n' "$DEPLOY_PUBKEY" > "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"

echo ">> Configuring firewall..."
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ">> Cloning repository to $APP_DIR..."
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

echo ">> Starting the stack (first build may take a couple of minutes)..."
sudo -u "$DEPLOY_USER" bash -c "cd '$APP_DIR' && docker compose up -d --build"

cat <<'DONE'

Provisioning complete.

Next:
  1. Point DNS: create an A record  gym.maksymzhukov.com -> 165.227.137.141
  2. Once it resolves, Caddy automatically obtains a Let's Encrypt certificate.
  3. Verify:  https://gym.maksymzhukov.com

From now on, every push to `main` redeploys automatically.
DONE
