#!/usr/bin/env bash
#
# Create GymHelper's database + login role in the shared Postgres, and store the
# connection string in /opt/gymhelper/.env (git-ignored, server-only).
# Safe to run on the server:
#   curl -fsSL https://raw.githubusercontent.com/maxizhukov/gymHelper/main/deploy/postgres/create-app-db.sh | bash
set -euo pipefail

APP=gymhelper
APP_ENV=/opt/gymhelper/.env

# URL-safe (hex) password for the app's DB user.
DBPASS="$(openssl rand -hex 32)"

echo ">> Creating role and database '${APP}'..."
docker exec -i postgres psql -v ON_ERROR_STOP=1 -U postgres <<SQL
CREATE ROLE ${APP} WITH LOGIN PASSWORD '${DBPASS}';
CREATE DATABASE ${APP} OWNER ${APP};
SQL

echo ">> Granting schema ownership (needed to create tables on PG 15+)..."
docker exec -i postgres psql -v ON_ERROR_STOP=1 -U postgres -d "${APP}" <<SQL
GRANT ALL ON SCHEMA public TO ${APP};
ALTER SCHEMA public OWNER TO ${APP};
SQL

echo ">> Writing DATABASE_URL to ${APP_ENV}..."
touch "${APP_ENV}"
if grep -q '^DATABASE_URL=' "${APP_ENV}"; then
  echo "   DATABASE_URL already present in ${APP_ENV} — leaving it as is."
else
  printf 'DATABASE_URL=postgres://%s:%s@postgres:5432/%s\n' "${APP}" "${DBPASS}" "${APP}" >> "${APP_ENV}"
fi
chown deploy:deploy "${APP_ENV}" 2>/dev/null || true
chmod 600 "${APP_ENV}"

echo
echo "===== ${APP} DATABASE_URL (also saved in ${APP_ENV}) ====="
grep '^DATABASE_URL=' "${APP_ENV}"
