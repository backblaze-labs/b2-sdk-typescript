import { defineConfig } from 'vitest/config'

/**
 * Config for the worker-isolation check in `remote-simulator-process.node.test.ts`:
 * runs the two fixture files in two workers at the same time. Not part of any
 * suite on its own.
 */
export default defineConfig({
  test: {
    include: ['src/test-utils/fixtures/*.isolation.ts'],
    fileParallelism: true,
    testTimeout: 30_000,
  },
})
