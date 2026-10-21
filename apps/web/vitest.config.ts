import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The code under test is pure TypeScript: the event parser and the
    // timeline model. No DOM, no browser, no server.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
