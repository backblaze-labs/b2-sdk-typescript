import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      rollupTypes: false,
      include: ['src'],
      outDir: 'dist',
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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
})
