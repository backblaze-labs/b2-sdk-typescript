export function validateFrontMatter(text, now = new Date()) {
  const errors = []
  const warnings = []
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return { errors: ['missing front matter'], warnings }
  const fields = Object.fromEntries(
    [...match[1].matchAll(/^([a-z_]+):\s*(.*)$/gm)].map((m) => [
      m[1],
      m[2].trim().replace(/^['"]|['"]$/g, ''),
    ]),
  )
  for (const key of ['type', 'title', 'description', 'status', 'owner', 'stale_after']) {
    if (!fields[key] || /^(null|~|\[\])$/i.test(fields[key])) errors.push(`missing or empty ${key}`)
  }
  if (fields.type && !['guide', 'reference', 'plan', 'index'].includes(fields.type))
    errors.push('invalid type')
  if (fields.status && !['active', 'draft', 'deprecated'].includes(fields.status))
    errors.push('invalid status')
  if (fields.owner && !/^@[a-zA-Z0-9-]+$/.test(fields.owner)) errors.push('invalid owner')
  if (fields.stale_after) {
    const date = fields.stale_after
    const parsed = new Date(`${date}T00:00:00Z`)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(parsed.valueOf()) ||
      parsed.toISOString().slice(0, 10) !== date
    )
      errors.push('invalid stale_after')
    else if (parsed < now) warnings.push(`stale_after ${date} is in the past`)
  }
  return { errors, warnings }
}
