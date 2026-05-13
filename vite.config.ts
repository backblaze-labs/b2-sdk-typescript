import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      rollupTypes: false,
      include: ['src'],
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
        's3/index': resolve(__dirname, 'src/s3/index.ts'),
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [/^node:/, '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
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
    include: ['src/**/*.test.ts'],
    // The multipart upload/copy/stream tests round-trip 5-15 MB Uint8Array
    // buffers per test. Vitest defaults to one worker per CPU core, and each
    // worker is its own Node process with its own ~2 GB default heap.
    // On a 4-core GitHub-hosted runner that's 4 workers × 2 GB = 8 GB of
    // potential resident memory, which exceeds the 7 GB of a macOS runner
    // (and pushes Linux/Windows runners uncomfortably close). Capping at
    // 2 forks keeps total demand bounded; combined with the
    // NODE_OPTIONS=--max-old-space-size=4096 in CI workflows, each fork has
    // ample headroom for the largest tests in the suite.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 2,
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/index.ts',
        'src/types/**',
        'src/version.ts',
        'src/auth/account-info.ts',
        'src/sync/types.ts',
      ],
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // CI gate: drop below these and the coverage job fails. Adjust upward
      // as coverage improves; never adjust downward to paper over a drop.
      // Current real values: 98.31% stmts / 90.3% branches / 98.47% funcs.
      // We pin a half-point below current so a single test edit doesn't
      // accidentally trip the gate.
      thresholds: {
        statements: 97,
        lines: 97,
        functions: 97,
        branches: 89,
      },
    },
  },
})
