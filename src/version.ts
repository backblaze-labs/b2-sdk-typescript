import pkg from '../package.json' with { type: 'json' }

declare const __B2_SDK_RELEASE_CHANNEL__: string | undefined

/**
 * Release channel used to decide what the SDK advertises in its User-Agent
 * product token.
 */
export type ReleaseChannel = 'dev' | 'published'

/**
 * Resolved version metadata for the current build.
 */
export interface VersionResolution {
  /** Build semver read from package.json. */
  readonly version: string
  /** Release channel after applying the positive release signal. */
  readonly releaseChannel: ReleaseChannel
  /** Whether this build is a stable package published through the release path. */
  readonly isPublishedRelease: boolean
  /** Version segment for the SDK User-Agent product token. */
  readonly productVersion: string
}

/**
 * Current SDK version. Read directly from package.json so there is no
 * second-source-of-truth to keep in sync — bumping `version` in package.json
 * automatically propagates here and into the published artifact. The outbound
 * SDK User-Agent uses {@link productVersion} so source, CI, `npm pack`, and
 * prerelease builds advertise `dev` instead of a real-looking release number.
 *
 * Works in every runtime the SDK targets:
 *   - Node 22.3+, Bun, Deno: native JSON import attributes.
 *   - Vite builds: the JSON import is replaced with a version-only shim, and
 *     the release channel is injected as a string define only on the publish
 *     path, so runtime chunks do not carry unrelated package metadata.
 *   - Vitest browser mode: Vite handles the import the same way as build.
 */
export const VERSION: string = pkg.version

const configuredReleaseChannel =
  typeof __B2_SDK_RELEASE_CHANNEL__ === 'string' ? __B2_SDK_RELEASE_CHANNEL__ : 'dev'

/**
 * Resolve build version metadata from a version and positive release signal.
 *
 * @param version - Build semver read from package.json.
 * @param releaseSignal - Build-time release signal. Only `published` enables
 * the published channel, and prerelease semvers still resolve to `dev`.
 *
 * @returns The release-channel decision and User-Agent version segment.
 */
export function resolveVersion(
  version: string,
  releaseSignal: string | undefined = configuredReleaseChannel,
): VersionResolution {
  const isStableVersion = !version.includes('-')
  const isRelease = releaseSignal === 'published' && isStableVersion
  const releaseChannel = isRelease ? 'published' : 'dev'

  return {
    version,
    releaseChannel,
    isPublishedRelease: isRelease,
    productVersion: isRelease ? version : 'dev',
  }
}

const resolvedVersion = resolveVersion(VERSION)

/**
 * Current release channel. Defaults to `dev` unless the publish path injected
 * the positive release signal for a stable semver.
 */
export const RELEASE_CHANNEL: ReleaseChannel = resolvedVersion.releaseChannel

/**
 * Whether the current artifact is a stable package built through the publish path.
 */
export const isPublishedRelease: boolean = resolvedVersion.isPublishedRelease

/**
 * Version segment for the SDK User-Agent product token.
 *
 * @returns The package semver for stable published releases, otherwise `dev`.
 */
export function productVersion(): string {
  return resolvedVersion.productVersion
}
