import { describe, expect, it } from 'vitest'
import { buildFileInfoHeaders, decodeFileName, encodeFileName, parseFileInfoHeaders } from './encoding.js'

describe('encodeFileName', () => {
  it('passes through lowercase letters', () => {
    expect(encodeFileName('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrstuvwxyz')
  })

  it('passes through uppercase letters', () => {
    expect(encodeFileName('ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  })

  it('passes through digits', () => {
    expect(encodeFileName('0123456789')).toBe('0123456789')
  })

  it('passes through B2 safe special characters', () => {
    const safeSpecials = "-._~/!$&'()*+,;=:@"
    expect(encodeFileName(safeSpecials)).toBe(safeSpecials)
  })

  it('passes through a mix of safe characters including slashes', () => {
    expect(encodeFileName('photos/2024/vacation.jpg')).toBe('photos/2024/vacation.jpg')
  })

  it('encodes spaces as %20', () => {
    expect(encodeFileName('hello world')).toBe('hello%20world')
  })

  it('encodes the hash character', () => {
    expect(encodeFileName('file#1')).toBe('file%231')
  })

  it('encodes the question mark', () => {
    expect(encodeFileName('what?')).toBe('what%3F')
  })

  it('encodes square brackets', () => {
    expect(encodeFileName('[test]')).toBe('%5Btest%5D')
  })

  it('encodes non-ASCII characters as UTF-8 percent-encoded bytes', () => {
    // "日" is U+65E5, encoded as UTF-8 bytes E6 97 A5
    // "本" is U+672C, encoded as UTF-8 bytes E6 9C AC
    // "語" is U+8A9E, encoded as UTF-8 bytes E8 AA 9E
    expect(encodeFileName('日本語')).toBe('%E6%97%A5%E6%9C%AC%E8%AA%9E')
  })

  it('returns an empty string for empty input', () => {
    expect(encodeFileName('')).toBe('')
  })

  it('encodes a percent sign itself', () => {
    expect(encodeFileName('%')).toBe('%25')
  })

  it('handles a mix of safe and unsafe characters', () => {
    expect(encodeFileName('path/to/my file#2.txt')).toBe('path/to/my%20file%232.txt')
  })

  it('encodes backslash', () => {
    expect(encodeFileName('a\\b')).toBe('a%5Cb')
  })

  it('encodes curly braces', () => {
    expect(encodeFileName('{key}')).toBe('%7Bkey%7D')
  })

  it('encodes pipe character', () => {
    expect(encodeFileName('a|b')).toBe('a%7Cb')
  })

  it('encodes caret', () => {
    expect(encodeFileName('^top')).toBe('%5Etop')
  })

  it('encodes backtick', () => {
    expect(encodeFileName('`code`')).toBe('%60code%60')
  })
})

describe('decodeFileName', () => {
  it('decodes percent-encoded ASCII characters', () => {
    expect(decodeFileName('hello%20world')).toBe('hello world')
  })

  it('decodes percent-encoded UTF-8 bytes', () => {
    expect(decodeFileName('%E6%97%A5%E6%9C%AC%E8%AA%9E')).toBe('日本語')
  })

  it('returns an unencoded string as-is', () => {
    expect(decodeFileName('simple.txt')).toBe('simple.txt')
  })

  it('decodes an empty string', () => {
    expect(decodeFileName('')).toBe('')
  })

  it('round-trips with encodeFileName for plain ASCII', () => {
    const original = 'photos/2024/summer vacation.jpg'
    expect(decodeFileName(encodeFileName(original))).toBe(original)
  })

  it('round-trips with encodeFileName for non-ASCII text', () => {
    const original = 'docs/日本語/ファイル.txt'
    expect(decodeFileName(encodeFileName(original))).toBe(original)
  })

  it('round-trips with encodeFileName for special characters', () => {
    const original = 'file#1?query=[value]'
    expect(decodeFileName(encodeFileName(original))).toBe(original)
  })

  it('round-trips with encodeFileName for an empty string', () => {
    expect(decodeFileName(encodeFileName(''))).toBe('')
  })
})

describe('buildFileInfoHeaders', () => {
  it('returns an empty object when fileInfo is undefined', () => {
    expect(buildFileInfoHeaders(undefined)).toEqual({})
  })

  it('returns an empty object when fileInfo is an empty record', () => {
    expect(buildFileInfoHeaders({})).toEqual({})
  })

  it('builds X-Bz-Info-* headers from plain key/value pairs', () => {
    const result = buildFileInfoHeaders({ author: 'alice', version: '1' })
    expect(result).toEqual({
      'X-Bz-Info-author': 'alice',
      'X-Bz-Info-version': '1',
    })
  })

  it('percent-encodes keys that contain special characters', () => {
    const result = buildFileInfoHeaders({ 'my key': 'value' })
    expect(result).toEqual({
      'X-Bz-Info-my%20key': 'value',
    })
  })

  it('percent-encodes values that contain special characters', () => {
    const result = buildFileInfoHeaders({ tag: 'hello world' })
    expect(result).toEqual({
      'X-Bz-Info-tag': 'hello%20world',
    })
  })

  it('handles non-ASCII characters in both keys and values', () => {
    const result = buildFileInfoHeaders({ '名前': '太郎' })
    const encodedKey = encodeFileName('名前')
    const encodedValue = encodeFileName('太郎')
    expect(result).toEqual({
      [`X-Bz-Info-${encodedKey}`]: encodedValue,
    })
  })

  it('handles multiple entries with mixed encoding needs', () => {
    const result = buildFileInfoHeaders({
      simple: 'plain',
      'needs encoding': 'value with spaces',
    })
    expect(result).toEqual({
      'X-Bz-Info-simple': 'plain',
      'X-Bz-Info-needs%20encoding': 'value%20with%20spaces',
    })
  })
})

describe('parseFileInfoHeaders', () => {
  it('extracts x-bz-info-* headers and decodes keys and values', () => {
    const headers = new Headers({
      'x-bz-info-author': 'alice',
      'x-bz-info-version': '1',
    })
    expect(parseFileInfoHeaders(headers)).toEqual({
      author: 'alice',
      version: '1',
    })
  })

  it('handles case-insensitive header names', () => {
    const headers = new Headers()
    // Headers normalizes to lowercase internally, but we test that
    // the function handles the canonical lowercase form correctly
    headers.set('X-Bz-Info-Author', 'bob')
    expect(parseFileInfoHeaders(headers)).toEqual({
      author: 'bob',
    })
  })

  it('decodes percent-encoded key suffixes', () => {
    const headers = new Headers()
    headers.set('x-bz-info-my%20key', 'value')
    expect(parseFileInfoHeaders(headers)).toEqual({
      'my key': 'value',
    })
  })

  it('decodes percent-encoded values', () => {
    const headers = new Headers()
    headers.set('x-bz-info-tag', 'hello%20world')
    expect(parseFileInfoHeaders(headers)).toEqual({
      tag: 'hello world',
    })
  })

  it('decodes percent-encoded UTF-8 in both keys and values', () => {
    const headers = new Headers()
    const encodedKey = encodeFileName('名前')
    const encodedValue = encodeFileName('太郎')
    headers.set(`x-bz-info-${encodedKey}`, encodedValue)
    expect(parseFileInfoHeaders(headers)).toEqual({
      '名前': '太郎',
    })
  })

  it('ignores headers that do not start with x-bz-info-', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'x-bz-file-name': 'test.txt',
      'x-bz-info-custom': 'data',
      authorization: 'Bearer token',
    })
    expect(parseFileInfoHeaders(headers)).toEqual({
      custom: 'data',
    })
  })

  it('returns an empty object when there are no info headers', () => {
    const headers = new Headers({
      'content-type': 'text/plain',
      'x-bz-file-name': 'doc.pdf',
    })
    expect(parseFileInfoHeaders(headers)).toEqual({})
  })

  it('returns an empty object for completely empty headers', () => {
    const headers = new Headers()
    expect(parseFileInfoHeaders(headers)).toEqual({})
  })

  it('round-trips with buildFileInfoHeaders', () => {
    const original: Record<string, string> = {
      author: 'alice',
      'file name': 'my doc.txt',
    }
    const built = buildFileInfoHeaders(original)
    // Simulate what a server would return: lowercase header names
    const responseHeaders = new Headers()
    for (const [key, value] of Object.entries(built)) {
      responseHeaders.set(key, value)
    }
    expect(parseFileInfoHeaders(responseHeaders)).toEqual(original)
  })
})
