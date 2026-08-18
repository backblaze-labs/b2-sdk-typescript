import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export function walkFiles(dir) {
  /** @type {string[]} */
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(file))
    } else if (entry.isFile()) {
      files.push(file)
    }
  }
  return files
}

export const publicExportProbes = [
  {
    subpath: '.',
    checks: [
      ["typeof entry.B2Client === 'function'", 'B2Client runtime export missing'],
      ["typeof entry.VERSION === 'string' && entry.VERSION.length > 0", 'VERSION export missing'],
      ["entry.BucketType?.AllPublic === 'allPublic'", 'BucketType enum export drifted'],
    ],
  },
  {
    subpath: './raw',
    checks: [["typeof entry.RawClient === 'function'", 'RawClient runtime export missing']],
  },
  {
    subpath: './errors',
    checks: [
      ["typeof entry.B2Error === 'function'", 'B2Error runtime export missing'],
      ["typeof entry.classifyError === 'function'", 'classifyError runtime export missing'],
    ],
  },
  {
    subpath: './auth',
    checks: [
      ["typeof entry.InMemoryAccountInfo === 'function'", 'InMemoryAccountInfo export missing'],
      ["typeof entry.getRealmUrl === 'function'", 'getRealmUrl export missing'],
    ],
  },
  {
    subpath: './auth/file',
    checks: [["typeof entry.FileAccountInfo === 'function'", 'FileAccountInfo export missing']],
  },
  {
    subpath: './partner',
    checks: [
      ["typeof entry.PartnerClient === 'function'", 'PartnerClient export missing'],
      ["typeof entry.PartnerRawClient === 'function'", 'PartnerRawClient export missing'],
      [
        "typeof entry.InMemoryPartnerAccountInfo === 'function'",
        'InMemoryPartnerAccountInfo export missing',
      ],
      ["entry.PartnerCapability?.All === 'all'", 'PartnerCapability enum export drifted'],
    ],
  },
  {
    subpath: './backup',
    checks: [
      ["typeof entry.BackupClient === 'function'", 'BackupClient export missing'],
      ["typeof entry.BackupRawClient === 'function'", 'BackupRawClient export missing'],
      [
        "typeof entry.InMemoryPartnerAccountInfo === 'function'",
        'InMemoryPartnerAccountInfo export missing',
      ],
      ["entry.PartnerCapability?.All === 'all'", 'PartnerCapability enum export drifted'],
      ["typeof entry.accountId === 'function'", 'accountId export missing'],
      ["typeof entry.computerId === 'function'", 'computerId export missing'],
      ["typeof entry.partnerToken === 'function'", 'partnerToken export missing'],
    ],
  },
  {
    subpath: './streams',
    checks: [
      ["typeof entry.BufferSource === 'function'", 'BufferSource export missing'],
      ["typeof entry.IncrementalSha1 === 'function'", 'IncrementalSha1 export missing'],
      ["typeof entry.sha1Hex === 'function'", 'sha1Hex export missing'],
    ],
  },
  {
    subpath: './sync',
    checks: [
      ["typeof entry.synchronize === 'function'", 'synchronize export missing'],
      ["typeof entry.LocalFolder === 'function'", 'LocalFolder export missing'],
      ["typeof entry.B2Folder === 'function'", 'B2Folder export missing'],
    ],
  },
  {
    subpath: './simulator',
    checks: [
      ["typeof entry.B2Simulator === 'function'", 'B2Simulator export missing'],
      ["typeof entry.BUCKET_NAME_MIN === 'number'", 'simulator constants missing'],
    ],
  },
  {
    subpath: './notifications',
    checks: [
      [
        "typeof entry.verifyWebhookSignature === 'function'",
        'verifyWebhookSignature export missing',
      ],
      ["typeof entry.B2_WEBHOOK_SIGNATURE_HEADER === 'string'", 'webhook header export missing'],
    ],
  },
  {
    subpath: './s3',
    checks: [
      ["typeof entry.createS3ClientConfig === 'function'", 'createS3ClientConfig export missing'],
      ["typeof entry.presignS3GetObjectUrl === 'function'", 'presignS3GetObjectUrl export missing'],
      ["typeof entry.presignS3PutObjectUrl === 'function'", 'presignS3PutObjectUrl export missing'],
      ["typeof entry.trustedUnsafeS3PresignOptIn === 'object'", 'trusted S3 opt-in token missing'],
    ],
  },
]

export function exportedSubpaths(pkg) {
  return Object.keys(pkg.exports ?? {}).filter(
    (subpath) => subpath === '.' || subpath.startsWith('./'),
  )
}

export function packageSpecifier(pkgName, subpath) {
  return subpath === '.' ? pkgName : `${pkgName}/${subpath.slice(2)}`
}

export function checkProbeCoverage(pkg, fail) {
  const exported = exportedSubpaths(pkg)
  const probed = new Set(publicExportProbes.map(({ subpath }) => subpath))
  for (const subpath of exported) {
    if (!probed.has(subpath)) {
      fail(`package export "${subpath}" has no runtime smoke probe`)
    }
  }
  for (const subpath of probed) {
    if (!exported.includes(subpath)) {
      fail(`runtime smoke probe references missing package export "${subpath}"`)
    }
  }
}
