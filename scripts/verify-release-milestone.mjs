import { githubList, isEntry, releaseTag, repository } from './release-policy-common.mjs'

export async function checkReleaseMilestone({ repo: input, tag: inputTag, api = githubList }) {
  const repo = repository(input)
  const tag = releaseTag(inputTag)
  let matches
  try {
    const milestones = await api(`repos/${repo}/milestones?state=all&per_page=100`)
    if (!Array.isArray(milestones)) throw new Error('Expected milestone records')
    matches = milestones.filter((milestone) => milestone?.title === tag)
  } catch {
    throw new Error('UNVERIFIED: release milestone could not be read')
  }
  if (matches.length !== 1 || !Number.isInteger(matches[0].number)) {
    throw new Error(`Release milestone ${tag} must exist exactly once`)
  }
  let items
  try {
    items = await api(`repos/${repo}/issues?milestone=${matches[0].number}&state=open&per_page=100`)
    if (!Array.isArray(items)) throw new Error('Expected issue records')
  } catch {
    throw new Error('UNVERIFIED: release milestone readiness could not be checked')
  }
  if (items.length > 0)
    throw new Error(`Release milestone ${tag} has ${items.length} open issues or pull requests`)
  return matches[0]
}

if (isEntry(import.meta.url)) {
  try {
    const milestone = await checkReleaseMilestone({ tag: process.argv[2], repo: process.argv[3] })
    console.log(`release-milestone: ${milestone.title} has no open issues or pull requests`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
