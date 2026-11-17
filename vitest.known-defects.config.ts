import { defineConfig } from 'vitest/config'

/**
 * Vitest config for the known-defect tests: tests of the correct behaviour that
 * currently fail because the defect is still present. They live outside `src/`
 * so the default `pnpm test`, `bun test src/`, the browser run and coverage never
 * collect them. Run on demand with `pnpm test:known-defects`; it is expected to
 * exit non-zero until every defect is fixed. See tests/known-defects/README.md.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/known-defects/**/*.known-defect.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
})
