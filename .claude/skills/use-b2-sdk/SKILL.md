---
name: use-b2-sdk
description: Use the TypeScript SDK when asked to "upload a file to B2 from Node", "list B2 objects", or "create a scoped B2 key". For third-party S3 clients use S3 client helpers instead.
---

# Use the B2 SDK

Install with `npm install @backblaze-labs/b2-sdk`. The SDK reads no env vars automatically — pass them explicitly at construction. B2 is S3-compatible. When using third-party S3 clients instead of this SDK, use the S3-compatible client helpers in `@backblaze-labs/b2-sdk/s3`.

Choose only the operations the user requested; the following illustrates each one, not a sequence to run unchanged. Use credentials from a secure source and never log a key secret.

```ts
import { B2Client, BufferSource, Capability } from '@backblaze-labs/b2-sdk'
import { FileSource, StreamSource } from '@backblaze-labs/b2-sdk/streams'
import { B2Error, BadAuthTokenError } from '@backblaze-labs/b2-sdk/errors'

const applicationKeyId = process.env.B2_APPLICATION_KEY_ID
const applicationKey = process.env.B2_APPLICATION_KEY
if (!applicationKeyId || !applicationKey) throw new Error('B2 credentials are required')
const client = new B2Client({
  applicationKeyId,
  applicationKey,
})
try {
  await client.authorize()
} catch (err) {
  if (err instanceof BadAuthTokenError) console.error('Authorization failed')
  if (err instanceof B2Error) console.error(err.status, err.code)
  throw err
}
const bucket = await client.getBucket('my-bucket')
if (!bucket) throw new Error('Bucket not found')

// Small data uses a single request; large sources use multipart automatically.
await bucket.upload({ fileName: 'hello.txt', source: new BufferSource(new TextEncoder().encode('Hello, B2!')) })
const source = await FileSource.fromPath('/tmp/backup.tar')
await bucket.upload({ fileName: 'backup.tar', source, resume: true })

// Forward-only streams require the total size in bytes.
const stream = new ReadableStream<Uint8Array>()
const size = 0
await bucket.upload({ fileName: 'stream.bin', source: new StreamSource(stream, size) })

// Unknown-size writes do not require a source size.
const { writable, done } = bucket.file('logs.ndjson').createWriteStream()
const writer = writable.getWriter()
await writer.write(new TextEncoder().encode('line\n'))
await writer.close()
await done

const result = await bucket.file('hello.txt').download()
const text = new TextDecoder().decode(await new Response(result.body).arrayBuffer())
console.log(text)
for await (const file of bucket.paginateFileNames({ prefix: 'logs/' })) {
  console.log(file.fileName, file.contentLength)
}
const info = await bucket.getFileInfoByName('hello.txt')
if (info) await bucket.deleteFileVersion(info.fileName, info.fileId)

// Scope a key to the needed capabilities, bucket, prefix, and lifetime.
const key = await client.createKey({
  keyName: 'my-app-key',
  capabilities: [Capability.ReadFiles, Capability.WriteFiles],
  bucketIds: [bucket.id],
  namePrefix: 'uploads/',
  validDurationInSeconds: 86400,
})
void key
```

Resume discovery uses `resume: true` with a sliceable source; use `resumeFileId` to target a known unfinished file. Forward-only streams cannot resume. For unknown-size writes, use `bucket.file(name).createWriteStream()` and await its `done` promise.

For offline tests inject the simulator transport:

```ts
import { B2Client } from '@backblaze-labs/b2-sdk'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'

const sim = new B2Simulator()
const client = new B2Client({ applicationKeyId: 'test', applicationKey: 'test', transport: sim.transport() })
await client.authorize()
```
