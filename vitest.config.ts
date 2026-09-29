import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // mainnet smoke tests only run when explicitly requested
    exclude: process.env.GREMLINS_MAINNET ? [] : ['**/*.mainnet.test.ts'],
    testTimeout: 60_000,
  },
})
