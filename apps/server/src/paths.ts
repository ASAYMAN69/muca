import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locates the repository root (the directory that holds `apps/`).
 * Works from `src/` in dev and `dist/` after a build.
 */
function findRepoRoot(): string {
  // apps/server/src -> apps/server -> apps -> <root>
  const candidates = [
    resolve(here, '../../..'),
    resolve(here, '../..'),
    resolve(process.cwd(), '..'),
    resolve(process.cwd()),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'apps/web')) && existsSync(resolve(candidate, 'apps/server'))) {
      return candidate;
    }
  }
  return resolve(process.cwd());
}

export const REPO_ROOT = findRepoRoot();
export const WEB_DIR = resolve(REPO_ROOT, 'apps/web');

/**
 * Loads `.env` from the repository root, then from `apps/server/.env`.
 * Real environment variables always win over the file.
 */
export function loadEnv(): void {
  dotenv.config({ path: resolve(REPO_ROOT, '.env') });
  dotenv.config({ path: resolve(REPO_ROOT, 'apps/server/.env'), override: true });
}
