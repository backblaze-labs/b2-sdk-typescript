import pkg from '../package.json' with { type: 'json' }

/**
 * Current SDK version. Read directly from package.json so there is no
 * second-source-of-truth to keep in sync — bumping `version` in package.json
 * automatically propagates here, into the SDK's User-Agent header, and into
 * the published artifact.
 *
 * Works in every runtime the SDK targets:
 *   - Node 22.3+, Bun, Deno: native JSON import attributes.
 *   - Vite / esbuild / rollup builds: the JSON import is statically inlined
 *     as a JS module exporting the parsed object.
 *   - Vitest browser mode: Vite handles the import the same way as build.
 */
export const VERSION: string = pkg.version
