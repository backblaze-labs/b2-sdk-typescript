import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { presignS3Request } from './sigv4.ts'

/**
 * Independent SigV4 reference. It is written directly from the AWS
 * "Signature Version 4 signing process" and "Authenticating requests: using
 * query parameters" documents using only `node:crypto`, and shares no code
 * with `sigv4.ts`. The pinned signatures in `sigv4.test.ts` come from the
 * implementation itself, so they cannot catch a wrong canonicalization or key
 * derivation; this suite can.
 */

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const SIGNING_DATE = new Date('2013-05-24T00:00:00Z')

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

interface ReferenceInput {
  readonly method: 'GET' | 'PUT'
  readonly host: string
  readonly origin: string
  readonly bucket: string
  readonly key: string
  readonly region: string
  readonly expires: number
  readonly extraQuery: ReadonlyArray<readonly [string, string]>
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>
}

/** Splits a presigned URL into a comparison form that ignores query order. */
function parts(url: string): { readonly base: string; readonly query: string[] } {
  const parsed = new URL(url)
  return {
    base: `${parsed.origin}${parsed.pathname}`,
    query: parsed.search.slice(1).split('&').sort(),
  }
}

function referencePresign(input: ReferenceInput): string {
  const longDate = '20130524T000000Z'
  const shortDate = '20130524'
  const scope = `${shortDate}/${input.region}/s3/aws4_request`
  const headers = [['host', input.host], ...input.extraHeaders].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const signedHeaders = headers.map(([name]) => name).join(';')
  const params: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${ACCESS_KEY}/${scope}`],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
    ['X-Amz-Date', longDate],
    ['X-Amz-Expires', String(input.expires)],
    ['X-Amz-SignedHeaders', signedHeaders],
    ...input.extraQuery.map(([k, v]) => [k, v] as [string, string]),
  ]
  const canonicalQuery = params
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .sort()
    .join('&')
  const canonicalUri = `/${rfc3986(input.bucket)}/${input.key.split('/').map(rfc3986).join('/')}`
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    headers.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    longDate,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n')
  const kDate = hmac(`AWS4${SECRET}`, shortDate)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
  return `${input.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

describe('presignS3Request against an independent SigV4 reference', () => {
  it('matches the reference for a GET with special characters in the key', async () => {
    const actual = await presignS3Request(
      'GET',
      {
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET,
        bucketName: 'examplebucket',
        fileName: "photos/2013/my file+(1)!*'.txt",
        expiresIn: 86_400,
        signingDate: SIGNING_DATE,
      },
      [['x-id', 'GetObject']],
      [],
    )

    expect(parts(actual)).toEqual(
      parts(
        referencePresign({
          method: 'GET',
          host: 's3.us-west-004.backblazeb2.com',
          origin: 'https://s3.us-west-004.backblazeb2.com',
          bucket: 'examplebucket',
          key: "photos/2013/my file+(1)!*'.txt",
          region: 'us-west-004',
          expires: 86_400,
          extraQuery: [['x-id', 'GetObject']],
          extraHeaders: [],
        }),
      ),
    )
  })

  it('matches the reference for a PUT with signed headers and a non-default port', async () => {
    const actual = await presignS3Request(
      'PUT',
      {
        endpoint: 'https://s3.example.test:8443',
        region: 'us-east-1',
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET,
        bucketName: 'examplebucket',
        fileName: 'a/b.bin',
        expiresIn: 60,
        signingDate: SIGNING_DATE,
      },
      [['x-id', 'PutObject']],
      [
        ['x-amz-meta-owner', 'alice'],
        ['content-type', 'application/octet-stream'],
      ],
    )

    expect(parts(actual)).toEqual(
      parts(
        referencePresign({
          method: 'PUT',
          host: 's3.example.test:8443',
          origin: 'https://s3.example.test:8443',
          bucket: 'examplebucket',
          key: 'a/b.bin',
          region: 'us-east-1',
          expires: 60,
          extraQuery: [['x-id', 'PutObject']],
          extraHeaders: [
            ['x-amz-meta-owner', 'alice'],
            ['content-type', 'application/octet-stream'],
          ],
        }),
      ),
    )
  })
})
