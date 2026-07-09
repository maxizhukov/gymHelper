import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The version the UI displays, baked in at build time from the manifest that
// `scripts/bump-version.mjs` rewrites on every commit. Read here rather than
// imported so the bundle carries the string alone, not the whole package.json —
// and because this file is inside the frontend's Docker build context, which
// the repository root is not.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 5173,
    // Proxy API calls to the NestJS backend during development so the
    // frontend can call `/api/*` on the same origin (no CORS in the browser).
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
