import { hasHttpHeaderControlCharacter } from '../util/http.ts'
import type {
  S3CompletedMultipartPart,
  S3CompleteMultipartUploadResult,
  S3CreateMultipartUploadResult,
  S3GetBucketLocationResult,
  S3LifecycleRule,
  S3ListMultipartUploadsResult,
  S3ListObjectsV2Result,
  S3ListPartsResult,
  S3Owner,
  S3UploadPartCopyResult,
} from './client.ts'

/** Error thrown for non-successful S3-compatible responses. */
export class S3CompatibleError extends Error {
  /** HTTP status code. */
  readonly status: number
  /** S3 error code, when supplied by the service. */
  readonly code: string
  /** S3 request ID, when supplied by the service. */
  readonly requestId?: string
  /** S3 extended request ID, when supplied by the service. */
  readonly extendedRequestId?: string

  /**
   * Creates an S3-compatible response error.
   *
   * @param options - HTTP status and parsed S3 error details.
   */
  constructor(options: {
    status: number
    code: string
    message: string
    requestId?: string
    extendedRequestId?: string
  }) {
    super(options.message)
    this.name = 'S3CompatibleError'
    this.status = options.status
    this.code = options.code
    if (options.requestId !== undefined) this.requestId = options.requestId
    if (options.extendedRequestId !== undefined) this.extendedRequestId = options.extendedRequestId
  }
}

/**
 * Reads response XML and maps embedded S3 errors returned with success HTTP status codes.
 *
 * @param response - Successful HTTP response whose XML body should be read.
 *
 * @returns The response XML text.
 */
export async function responseXml(response: Response): Promise<string> {
  const xml = await response.text()
  throwIfEmbeddedS3Error(xml, response.status)
  return xml
}

/**
 * Maps a non-successful S3-compatible response into a typed SDK error.
 *
 * @param response - Non-successful HTTP response whose XML body should be parsed.
 *
 * @returns A typed S3-compatible error.
 */
export async function s3ResponseError(response: Response): Promise<S3CompatibleError> {
  const text = await response.text().catch(() => '')
  const code = xmlElementText(text, 'Code') ?? `S3Status${response.status}`
  const message = xmlElementText(text, 'Message') ?? response.statusText
  const requestId =
    response.headers.get('x-amz-request-id') ?? xmlElementText(text, 'RequestId') ?? undefined
  const extendedRequestId = response.headers.get('x-amz-id-2') ?? undefined
  return new S3CompatibleError({
    status: response.status,
    code,
    message,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(extendedRequestId !== undefined ? { extendedRequestId } : {}),
  })
}

/**
 * Serializes B2-supported S3 lifecycle rules.
 *
 * @param rules - Lifecycle rules to serialize.
 *
 * @returns S3 lifecycle XML.
 */
export function lifecycleXml(rules: readonly S3LifecycleRule[]): string {
  return [
    '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    ...rules.map(lifecycleRuleXml),
    '</LifecycleConfiguration>',
  ].join('')
}

/**
 * Serializes completed multipart parts in ascending order.
 *
 * @param parts - Completed parts to serialize.
 *
 * @returns S3 CompleteMultipartUpload XML.
 */
export function completeMultipartUploadXml(parts: readonly S3CompletedMultipartPart[]): string {
  let previousPartNumber = 0
  const partXml = parts.map((part) => {
    const partNumber = assertS3PartNumber(part.partNumber)
    if (partNumber <= previousPartNumber) {
      throw new RangeError('multipart completion parts must be in ascending partNumber order.')
    }
    previousPartNumber = partNumber
    assertSafeHeaderValue('etag', part.etag)
    return [
      '<Part>',
      `<PartNumber>${partNumber}</PartNumber>`,
      `<ETag>${escapeXml(part.etag)}</ETag>`,
      '</Part>',
    ].join('')
  })

  return ['<CompleteMultipartUpload>', ...partXml, '</CompleteMultipartUpload>'].join('')
}

/**
 * Parses a GetBucketLocation response.
 *
 * @param xml - GetBucketLocation XML response body.
 *
 * @returns The parsed location result.
 */
export function parseBucketLocation(xml: string): S3GetBucketLocationResult {
  const locationConstraint = xmlElementText(xml, 'LocationConstraint')
  return {
    ...(locationConstraint !== undefined ? { locationConstraint } : {}),
  }
}

/**
 * Parses a CreateMultipartUpload response.
 *
 * @param xml - CreateMultipartUpload XML response body.
 *
 * @returns The parsed multipart upload result.
 */
export function parseCreateMultipartUpload(xml: string): S3CreateMultipartUploadResult {
  return {
    ...optionalXmlString(xml, 'UploadId', 'uploadId'),
    ...optionalXmlString(xml, 'Bucket', 'bucket'),
    ...optionalXmlString(xml, 'Key', 'key'),
  }
}

/**
 * Parses a CompleteMultipartUpload response.
 *
 * @param xml - CompleteMultipartUpload XML response body.
 *
 * @returns The parsed completed object result.
 */
export function parseCompleteMultipartUpload(xml: string): S3CompleteMultipartUploadResult {
  return {
    ...optionalXmlString(xml, 'Location', 'location'),
    ...optionalXmlString(xml, 'Bucket', 'bucket'),
    ...optionalXmlString(xml, 'Key', 'key'),
    ...optionalXmlString(xml, 'ETag', 'etag'),
  }
}

/**
 * Parses a ListObjectsV2 response.
 *
 * @param xml - ListObjectsV2 XML response body.
 *
 * @returns Parsed objects, prefixes, and pagination state.
 */
export function parseListObjectsV2(xml: string): S3ListObjectsV2Result {
  return {
    objects: xmlElements(xml, 'Contents').map((entry) => ({
      ...optionalXmlString(entry, 'Key', 'key'),
      ...optionalXmlDate(entry, 'LastModified', 'lastModified'),
      ...optionalXmlString(entry, 'ETag', 'etag'),
      ...optionalXmlNumber(entry, 'Size', 'size'),
      ...optionalXmlString(entry, 'StorageClass', 'storageClass'),
    })),
    commonPrefixes: xmlElements(xml, 'CommonPrefixes').flatMap((entry) => {
      const prefix = xmlElementText(entry, 'Prefix')
      return prefix === undefined ? [] : [prefix]
    }),
    isTruncated: xmlElementText(xml, 'IsTruncated') === 'true',
    ...optionalXmlString(xml, 'NextContinuationToken', 'nextContinuationToken'),
    ...optionalXmlNumber(xml, 'KeyCount', 'keyCount'),
  }
}

/**
 * Parses a ListMultipartUploads response.
 *
 * @param xml - ListMultipartUploads XML response body.
 *
 * @returns Parsed uploads, prefixes, and pagination state.
 */
export function parseListMultipartUploads(xml: string): S3ListMultipartUploadsResult {
  return {
    uploads: xmlElements(xml, 'Upload').map((entry) => ({
      ...optionalXmlString(entry, 'Key', 'key'),
      ...optionalXmlString(entry, 'UploadId', 'uploadId'),
      ...optionalXmlDate(entry, 'Initiated', 'initiated'),
      ...optionalXmlString(entry, 'StorageClass', 'storageClass'),
      ...optionalOwner(entry),
    })),
    commonPrefixes: xmlElements(xml, 'CommonPrefixes').flatMap((entry) => {
      const prefix = xmlElementText(entry, 'Prefix')
      return prefix === undefined ? [] : [prefix]
    }),
    isTruncated: xmlElementText(xml, 'IsTruncated') === 'true',
    ...optionalXmlString(xml, 'NextKeyMarker', 'nextKeyMarker'),
    ...optionalXmlString(xml, 'NextUploadIdMarker', 'nextUploadIdMarker'),
  }
}

/**
 * Parses a ListParts response.
 *
 * @param xml - ListParts XML response body.
 *
 * @returns Parsed parts and pagination state.
 */
export function parseListParts(xml: string): S3ListPartsResult {
  return {
    parts: xmlElements(xml, 'Part').map((entry) => ({
      ...optionalXmlNumber(entry, 'PartNumber', 'partNumber'),
      ...optionalXmlDate(entry, 'LastModified', 'lastModified'),
      ...optionalXmlString(entry, 'ETag', 'etag'),
      ...optionalXmlNumber(entry, 'Size', 'size'),
    })),
    isTruncated: xmlElementText(xml, 'IsTruncated') === 'true',
    ...optionalXmlNumber(xml, 'NextPartNumberMarker', 'nextPartNumberMarker'),
  }
}

/**
 * Parses an UploadPartCopy response.
 *
 * @param xml - UploadPartCopy XML response body.
 *
 * @returns The copied part result.
 */
export function parseUploadPartCopy(xml: string): S3UploadPartCopyResult {
  return {
    ...optionalXmlString(xml, 'ETag', 'etag'),
    ...optionalXmlDate(xml, 'LastModified', 'lastModified'),
  }
}

function throwIfEmbeddedS3Error(xml: string, status: number): void {
  if (xmlElementRaw(xml, 'Error') === undefined) return
  const code = xmlElementText(xml, 'Code')
  if (code === undefined) return
  throw new S3CompatibleError({
    status,
    code,
    message: xmlElementText(xml, 'Message') ?? code,
    ...optionalXmlString(xml, 'RequestId', 'requestId'),
    ...optionalXmlString(xml, 'HostId', 'extendedRequestId'),
  })
}

function lifecycleRuleXml(rule: S3LifecycleRule): string {
  assertSupportedLifecycleRule(rule)
  const prefix = rule.filter?.prefix ?? ''
  const parts = [
    '<Rule>',
    `<ID>${escapeXml(rule.id)}</ID>`,
    `<Filter><Prefix>${escapeXml(prefix)}</Prefix></Filter>`,
    '<Status>Enabled</Status>',
  ]
  if (rule.expiration !== undefined) {
    parts.push('<Expiration>')
    if (rule.expiration.days !== undefined) {
      parts.push(`<Days>${assertPositiveInteger('expiration.days', rule.expiration.days)}</Days>`)
    }
    if (rule.expiration.expiredObjectDeleteMarker !== undefined) {
      parts.push('<ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker>')
    }
    parts.push('</Expiration>')
  }
  if (rule.noncurrentVersionExpiration !== undefined) {
    parts.push(
      '<NoncurrentVersionExpiration>',
      `<NoncurrentDays>${assertPositiveInteger(
        'noncurrentVersionExpiration.noncurrentDays',
        rule.noncurrentVersionExpiration.noncurrentDays,
      )}</NoncurrentDays>`,
      '</NoncurrentVersionExpiration>',
    )
  }
  if (rule.abortIncompleteMultipartUpload !== undefined) {
    parts.push(
      '<AbortIncompleteMultipartUpload>',
      `<DaysAfterInitiation>${assertPositiveInteger(
        'abortIncompleteMultipartUpload.daysAfterInitiation',
        rule.abortIncompleteMultipartUpload.daysAfterInitiation,
      )}</DaysAfterInitiation>`,
      '</AbortIncompleteMultipartUpload>',
    )
  }
  parts.push('</Rule>')
  return parts.join('')
}

function assertSupportedLifecycleRule(rule: S3LifecycleRule): void {
  if ((rule as { readonly status?: unknown }).status !== 'Enabled') {
    throw new TypeError('B2 S3 lifecycle rules must have status "Enabled".')
  }
  const expiration = rule.expiration as { readonly expiredObjectDeleteMarker?: unknown } | undefined
  if (expiration?.expiredObjectDeleteMarker === false) {
    throw new TypeError('B2 S3 lifecycle expiration.expiredObjectDeleteMarker only supports true.')
  }
}

function optionalOwner(xml: string): { readonly owner?: S3Owner } {
  const ownerXml = xmlElementRaw(xml, 'Owner')
  if (ownerXml === undefined) return {}
  const owner = {
    ...optionalXmlString(ownerXml, 'ID', 'id'),
    ...optionalXmlString(ownerXml, 'DisplayName', 'displayName'),
  }
  return Object.keys(owner).length === 0 ? {} : { owner }
}

function optionalXmlString<K extends string>(
  xml: string,
  element: string,
  key: K,
): { readonly [P in K]?: string } {
  const value = xmlElementText(xml, element)
  return value === undefined ? {} : ({ [key]: value } as { readonly [P in K]?: string })
}

function optionalXmlNumber<K extends string>(
  xml: string,
  element: string,
  key: K,
): { readonly [P in K]?: number } {
  const value = xmlElementText(xml, element)
  if (value === undefined) return {}
  const numberValue = Number(value)
  return Number.isFinite(numberValue)
    ? ({ [key]: numberValue } as { readonly [P in K]?: number })
    : {}
}

function optionalXmlDate<K extends string>(
  xml: string,
  element: string,
  key: K,
): { readonly [P in K]?: Date } {
  const value = xmlElementText(xml, element)
  if (value === undefined) return {}
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? ({ [key]: date } as { readonly [P in K]?: Date }) : {}
}

function xmlElements(xml: string, element: string): string[] {
  const pattern = elementPattern(element, 'g')
  const matches: string[] = []
  for (const match of xml.matchAll(pattern)) {
    const value = match[1]
    if (value !== undefined) matches.push(value)
  }
  return matches
}

function xmlElementRaw(xml: string, element: string): string | undefined {
  return elementPattern(element).exec(xml)?.[1]
}

function xmlElementText(xml: string, element: string): string | undefined {
  const raw = xmlElementRaw(xml, element)
  if (raw === undefined) return undefined
  return decodeXml(raw.replace(/<[^>]*>/g, ''))
}

function elementPattern(element: string, flags = ''): RegExp {
  const tag = escapeRegExp(element)
  return new RegExp(
    `<(?:[^:>/\\s]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[^:>/\\s]+:)?${tag}>`,
    flags,
  )
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      decodeCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_match, decimal: string) =>
      decodeCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function decodeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : ''
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertSafeHeaderValue(name: string, value: string): void {
  if (hasHttpHeaderControlCharacter(value)) {
    throw new TypeError(`${name} must not contain control characters.`)
  }
}

function assertS3PartNumber(partNumber: number): number {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new RangeError(`partNumber must be an integer from 1 to 10000; received ${partNumber}.`)
  }
  return partNumber
}

function assertPositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer; received ${value}.`)
  }
  return value
}
