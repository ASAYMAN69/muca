import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  // `next build` type-checks the app, which is most of the time the
  // build takes. `npm run typecheck` is the gate instead, so a build
  // only has to compile.
  typescript: { ignoreBuildErrors: true },
  partialPrefetching: true,
  turbopack: {
    // `next` is hoisted to the npm workspace root, so Turbopack must be
    // told to resolve modules from the workspace root rather than from
    // `apps/web`.
    root: path.resolve(__dirname, '../..'),
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
