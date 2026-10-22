#!/usr/bin/env node
/**
 * Runs before `npm start`.
 *
 * The production server serves the built web app from `apps/web/.next` and
 * runs from `apps/server/dist`. If either is missing, the failure is a
 * bare "Cannot find module" or a blank page, which tells you nothing. So
 * say what is missing and what to run.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const required = [
  { path: 'apps/server/dist/index.js', label: 'the server build' },
  { path: 'apps/web/.next/BUILD_ID', label: 'the web build' },
];

const missing = required.filter((item) => !existsSync(resolve(root, item.path)));

if (missing.length > 0) {
  console.error('');
  console.error('  Muca is not built yet.');
  for (const item of missing) {
    console.error(`    missing: ${item.path}  (${item.label})`);
  }
  console.error('');
  console.error('  Run:  npm run build');
  console.error('');
  process.exit(1);
}

console.log('  Muca is built. Starting…');
console.log('');
