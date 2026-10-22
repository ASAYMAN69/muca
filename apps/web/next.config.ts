import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The development build goes in its own directory.
 *
 * `next build` empties the build directory, and the development server
 * keeps its cache there. When they share it, a build leaves the
 * development cache pointing at files that no longer exist, and the next
 * `npm run dev` fails with "Loading persistence directory failed".
 * Two directories, no collision.
 */
const isProduction = process.env.NODE_ENV === 'production';

const nextConfig: NextConfig = {
  cacheComponents: true,
  distDir: isProduction ? '.next' : '.next-dev',
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
