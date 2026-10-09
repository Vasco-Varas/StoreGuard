import { defineConfig } from 'vitest/config'

// One run for both packages: any *.test.ts(x) under frontend/ or server/. A test that needs a browser-like
// DOM can put `// @vitest-environment jsdom` at the top (and `pnpm add -D -w jsdom`).
export default defineConfig({
  test: {
    include: ['{frontend,server}/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
})
