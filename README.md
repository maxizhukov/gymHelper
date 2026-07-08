# GymHelper

The ultimate personal gym helper — a web app with a **React** frontend and a **NestJS** backend.

## Structure

```
GymHelper/
├── backend/    # NestJS API (TypeScript). Serves everything under /api.
├── frontend/   # React + Vite + TypeScript UI.
└── package.json # Root scripts to run both together.
```

Right now the app is a connectivity check: the React UI fetches `GET /api/message`
from the NestJS backend and displays the returned message.

## Prerequisites

- Node.js 20+ (developed on Node 22)
- npm 10+

## Setup

```bash
npm run install:all
```

This installs the root, backend, and frontend dependencies.

## Running (development)

Run both apps together from the repo root:

```bash
npm run dev
```

- Backend → http://localhost:3000/api
- Frontend → http://localhost:5173

The Vite dev server proxies `/api/*` to the backend, so open the frontend URL
and you should see the message from NestJS.

You can also run them separately:

```bash
npm run dev:backend
npm run dev:frontend
```

## Build

```bash
npm run build
```

## Deployment

Production is a Docker Compose stack on a droplet, served at
**https://gym.maksymzhukov.com**, with auto-deploy on every push to `main`.
See [DEPLOYMENT.md](DEPLOYMENT.md) for the architecture and first-time setup.

## Configuration

Copy `.env.example` to `.env` and fill in values as needed. `.env` is git-ignored —
never commit real secrets (this is a public repo). Relevant variables for the backend:

- `PORT` — backend port (default `3000`)
- `CORS_ORIGIN` — comma-separated allowed origins (default `http://localhost:5173`)
