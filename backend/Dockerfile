# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app

# Install deps (incl. dev) against the lockfile for a reproducible build.
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy only what's needed to run.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
