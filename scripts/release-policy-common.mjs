import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function releaseTag(value = '') {
  const tag = value.replace(/^refs\/tags\//, '')
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/.test(
      tag,
    )
  ) {
    throw new Error('A release tag such as v1.2.3 is required')
  }
  return tag
}

export function repository(
  value = process.env.GITHUB_REPOSITORY ?? 'backblaze-labs/b2-sdk-typescript',
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error('Expected an owner/repository name')
  return value
}

export function isEntry(url) {
  return (
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url))
  )
}

export async function githubList(path, run = spawnSync) {
  const result = run('gh', ['api', '--paginate', '--slurp', path], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw new Error('GitHub API data is unavailable')
  const pages = JSON.parse(result.stdout)
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error('GitHub API did not return list pages')
  }
  return pages.flat()
}
