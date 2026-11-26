/** The pinned standalone b2-simulator. */
export declare const SIMULATOR_PIN: { readonly repository: string; readonly commit: string }
/** Directory the pinned commit is fetched into. */
export declare function pinnedCacheDir(repoRoot: string): string
/** Path of serve.mjs from B2SIM_DIR or the pinned cache; throws an actionable error otherwise. */
export declare function resolveServeScript(options: {
  repoRoot: string
  env: Record<string, string | undefined>
}): string
