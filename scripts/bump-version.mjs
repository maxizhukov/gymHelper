#!/usr/bin/env node
/**
 * Bumps the application's patch version — 1.0.0 -> 1.0.1 -> 1.0.2 — and keeps
 * every file that records it in step.
 *
 * `frontend/package.json` is the source of truth: it is the only one of these
 * files inside the frontend's Docker build context, so it is the only one Vite
 * can read when baking the version into the bundle (see `vite.config.ts`). The
 * root manifest mirrors it so the repository and the deployed app never
 * disagree about which build is which.
 *
 * The lockfiles carry the version twice each. `npm ci` — which is what the
 * Docker build runs — refuses to install when a lockfile disagrees with its
 * manifest, so both copies are rewritten or the next deploy fails.
 *
 * Run by the pre-commit hook (`.githooks/pre-commit`), so every commit ships a
 * version the UI can display and a human can read back off the screen.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The version the app reports, and the file the rest are copied from. */
const SOURCE = 'frontend/package.json';

/** Every file holding a copy of the version, and where inside it that copy sits. */
const TARGETS = [
  { file: 'frontend/package.json', paths: [['version']] },
  {
    file: 'frontend/package-lock.json',
    paths: [['version'], ['packages', '', 'version']],
  },
  { file: 'package.json', paths: [['version']] },
  {
    file: 'package-lock.json',
    paths: [['version'], ['packages', '', 'version']],
  },
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function readJson(file) {
  return JSON.parse(readFileSync(join(root, file), 'utf8'));
}

/** npm writes these files with two-space indent and a trailing newline. Match it. */
function writeJson(file, data) {
  writeFileSync(join(root, file), `${JSON.stringify(data, null, 2)}\n`);
}

/** Sets a nested key, but only where one already exists — never invents one. */
function setIfPresent(object, path, value) {
  let node = object;
  for (const key of path.slice(0, -1)) {
    if (typeof node !== 'object' || node === null || !(key in node)) return false;
    node = node[key];
  }
  const leaf = path[path.length - 1];
  if (typeof node !== 'object' || node === null || !(leaf in node)) return false;
  node[leaf] = value;
  return true;
}

const current = readJson(SOURCE).version;
const parsed = SEMVER.exec(current ?? '');
if (!parsed) {
  // Fail rather than guess: a malformed version would be baked into the UI.
  console.error(
    `bump-version: ${SOURCE} has no usable version (found ${JSON.stringify(current)}).`,
  );
  process.exit(1);
}

const [, major, minor, patch] = parsed;
const next = `${major}.${minor}.${Number(patch) + 1}`;

const written = [];
for (const { file, paths } of TARGETS) {
  const json = readJson(file);
  // A lockfile that has drifted is a real problem, so say which copy was missed
  // rather than silently leaving a stale version behind.
  for (const path of paths) {
    if (!setIfPresent(json, path, next)) {
      console.error(`bump-version: ${file} has no "${path.join('.')}" to update.`);
      process.exit(1);
    }
  }
  writeJson(file, json);
  written.push(file);
}

console.log(`bump-version: ${current} -> ${next}`);
// The hook stages these; printing them keeps the two lists from drifting apart.
for (const file of written) console.log(`  ${file}`);
