import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      rollupTypes: false,
      include: ['src'],
      // Without this exclude, `vite-plugin-dts` walks every `.ts` file under
      // `src/` and emits a `.d.ts` for it — including ~40 test files and the
      // `test-utils/` helper module. These artifacts shipped to npm via the
      // `package.json` "files" entry without serving any consumer purpose
      // (the runtime `.js`/`.cjs` outputs are clean because they're driven
      // by the explicit `lib.entry` map below). Excluding here keeps the
      // declaration output aligned with the runtime entry points.
      exclude: ['src/**/*.test.ts', 'src/test-utils/**'],
      outDir: 'dist',
      // Source uses .ts import extensions (source-isomorphism). vite-plugin-dts
      // doesn't honour `rewriteRelativeImportExtensions` even when passed via
      // compilerOptions, so we rewrite relative .ts -> .js in the emitted
      // .d.ts content directly. Npm consumers then see normal imports that
      // resolve against the dist .js + .d.ts siblings.
      beforeWriteFile(filePath, content) {
        return {
          filePath,
          content: content.replace(/(\.\.?\/[^'"\s]*)\.ts(['";])/g, '$1.js$2'),
        }
      },
    }),
  ],
  build: {
    target: 'es2023',
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'raw/index': resolve(__dirname, 'src/raw/index.ts'),
        'errors/index': resolve(__dirname, 'src/errors/index.ts'),
        'auth/index': resolve(__dirname, 'src/auth/index.ts'),
        'auth/file': resolve(__dirname, 'src/auth/file.ts'),
        'streams/index': resolve(__dirname, 'src/streams/index.ts'),
        'sync/index': resolve(__dirname, 'src/sync/index.ts'),
        'simulator/index': resolve(__dirname, 'src/simulator/index.ts'),
        'notifications/index': resolve(__dirname, 'src/notifications/index.ts'),
        's3/index': resolve(__dirname, 'src/s3/index.ts'),
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [/^node:/, '@aws-sdk/client-s3'],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
    minify: false,
    sourcemap: true,
  },
  test: {
    globals: true,
    // Fast tier: every `*.test.ts` except the slow tier. Slow tests live in
    // `*.slow.test.ts` files and run under `pnpm test:slow` against
    // `vitest.slow.config.ts`. The split lets PRs get green/red feedback in
    // under a minute without sacrificing coverage of the multipart paths.
    //
    // `pnpm test:coverage` uses `vitest.coverage.config.ts` which runs the
    // union of both tiers under the slow-tier constraints — that's the only
    // config that owns coverage instrumentation and threshold gates.
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.slow.test.ts', 'node_modules/**', 'dist/**'],
  },
})
