import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { B2Client } from '../client.ts'
import { resetRemoteSimulator } from '../test-utils/remote-simulator.ts'
import { type AuthorizeAccountResponse, Capability } from '../types/auth.ts'
import { BucketType } from '../types/bucket.ts'
import { bucketId } from '../types/ids.ts'
import { FileAccountInfo } from './file.ts'
import { InMemoryAccountInfo } from './in-memory.ts'
import { REALM_URLS } from './realms.ts'

function makeCachedAuth(
  endpoints: Partial<{
    apiUrl: string
    downloadUrl: string
    s3ApiUrl: string
  }> = {},
): AuthorizeAccountResponse {
  return {
    accountId: 'cached-account' as AuthorizeAccountResponse['accountId'],
    authorizationToken: 'cached-token' as AuthorizeAccountResponse['authorizationToken'],
    apiInfo: {
      storageApi: {
        apiUrl: endpoints.apiUrl ?? 'https://api001.backblazeb2.com',
        bucketId: null,
        bucketName: null,
        downloadUrl: endpoints.downloadUrl ?? 'https://f001.backblazeb2.com',
        infoType: 'storageApi',
        namePrefix: null,
        s3ApiUrl: endpoints.s3ApiUrl ?? 'https://s3.us-west-001.backblazeb2.com',
        absoluteMinimumPartSize: 5_000_000,
        recommendedPartSize: 100_000_000,
        allowed: {
          capabilities: [Capability.ListBuckets],
          buckets: null,
          bucketId: null,
          bucketName: null,
          namePrefix: null,
        },
      },
    },
    applicationKeyExpirationTimestamp: null,
  }
}

function observeCredentialWrite(path: string, failure = '') {
  // Keep built-in instrumentation in a child so other tests use the real exports.
  const result = spawnSync(
    'node',
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
        import fs from 'node:fs/promises';
        import { readFileSync } from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { dirname } from 'node:path';
        const [source, path, failure] = process.argv.slice(1);
        const auth = JSON.parse(readFileSync(0, 'utf8'));
        const events = [], creationModes = [], descriptorModes = [], errors = [];
        let pathModes = 0, modeBeforeRename = null;
        const open = fs.open, chmod = fs.chmod, rename = fs.rename;
        if (failure) await fs.writeFile(path, 'previous state');
        if (process.platform !== 'win32') process.umask(0o777);
        fs.chmod = async (...args) => {
          if (args[0] !== dirname(path)) pathModes++;
          return chmod(...args);
        };
        fs.open = async (...args) => {
          const handle = await open(...args);
          creationModes.push(args[2]);
          events.push('open');
          const chmod = handle.chmod.bind(handle);
          const writeFile = handle.writeFile.bind(handle);
          const close = handle.close.bind(handle);
          handle.chmod = async (mode) => {
            events.push('mode');
            descriptorModes.push(mode);
            if (failure === 'mode') throw new Error('mode did not complete');
            return chmod(mode);
          };
          handle.writeFile = async (...args) => {
            events.push('write');
            if (failure === 'write') throw new Error('write did not complete');
            return writeFile(...args);
          };
          handle.close = async () => {
            events.push('close');
            return close();
          };
          return handle;
        };
        fs.rename = async (from, to) => {
          modeBeforeRename = (await fs.stat(from)).mode & 0o777;
          events.push('rename');
          return rename(from, to);
        };
        syncBuiltinESMExports();
        const { FileAccountInfo } = await import(source);
        const store = new FileAccountInfo(path, {
          onWriteError: ({ error }) => errors.push(error.message),
        });
        store.setAuth(auth);
        await store.flushed();
        const contents = await fs.readFile(path, 'utf8');
        console.log(JSON.stringify({ events, creationModes, descriptorModes, pathModes,
          modeBeforeRename, finalMode: (await fs.stat(path)).mode & 0o777,
          contentsMatch: contents === (failure ? 'previous state' : JSON.stringify(auth)),
          files: await fs.readdir(dirname(path)), errors }));
      `,
      new URL('./file.ts', import.meta.url).href,
      path,
      failure,
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      input: JSON.stringify(makeCachedAuth()),
      timeout: 10_000,
    },
  )
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as {
    events: string[]
    creationModes: number[]
    descriptorModes: number[]
    pathModes: number
    modeBeforeRename: number | null
    finalMode: number
    contentsMatch: boolean
    files: string[]
    errors: string[]
  }
}

describe('FileAccountInfo', () => {
  let tempDir: string
  let storePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'b2sdk-fileaccount-'))
    storePath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('round-trips authorization through disk', async () => {
    const sim = await resetRemoteSimulator()
    const accountInfo1 = new FileAccountInfo(storePath)
    await accountInfo1.load() // empty initially

    const client1 = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: sim.realm,
      transport: sim.transport(),
      accountInfo: accountInfo1,
    })
    await client1.authorize()
    await accountInfo1.flushed()

    const auth1 = accountInfo1.getAuth()
    expect(auth1).toBeTruthy()
    expect(auth1?.accountId).toBe('sim_account_0001')

    // Simulate a process restart: new FileAccountInfo instance, same path.
    const accountInfo2 = new FileAccountInfo(storePath)
    await accountInfo2.load()
    const auth2 = accountInfo2.getAuth()
    expect(auth2?.accountId).toBe(auth1?.accountId)
    expect(auth2?.authorizationToken).toBe(auth1?.authorizationToken)
    expect(accountInfo2.getApiUrl()).toBe(accountInfo1.getApiUrl())

    const client2 = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: sim.realm,
      transport: sim.transport(),
      accountInfo: accountInfo2,
    })
    expect(client2.accountInfo.getAuth()).not.toBeNull()
  })

  it('loads legacy cached auth without allowed.buckets', async () => {
    const legacyBucketId = bucketId('legacy-cache-bucket')
    const cached = makeCachedAuth()
    await writeFile(
      storePath,
      JSON.stringify({
        ...cached,
        apiInfo: {
          storageApi: {
            ...cached.apiInfo.storageApi,
            bucketId: legacyBucketId,
            bucketName: 'legacy-cache',
            allowed: {
              capabilities: [Capability.ListBuckets],
              bucketId: legacyBucketId,
              bucketName: 'legacy-cache',
              namePrefix: null,
            },
          },
        },
      }),
      'utf8',
    )
    const accountInfo = new FileAccountInfo(storePath)

    await accountInfo.load()

    expect(accountInfo.getAllowedBucketId()).toBe(legacyBucketId)
    expect(accountInfo.getAllowedBucketIds()).toEqual([legacyBucketId])
  })

  it('load() returns silently on missing file', async () => {
    const accountInfo = new FileAccountInfo(join(tempDir, 'does-not-exist.json'))
    await expect(accountInfo.load()).resolves.toBeUndefined()
    expect(accountInfo.getAuth()).toBeNull()
  })

  it('load() returns silently on corrupt JSON', async () => {
    await writeFile(storePath, 'not valid json', 'utf8')
    const accountInfo = new FileAccountInfo(storePath)
    await accountInfo.load()
    expect(accountInfo.getAuth()).toBeNull()
  })

  it('ignores cache files with an unsupported SDK metadata version', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth(),
        _b2sdk: {
          version: 2,
          realmUrl: 'https://api.backblazeb2.com',
          applicationKeyId: 'test-key-id',
        },
      }),
      'utf8',
    )
    const accountInfo = new FileAccountInfo(storePath)
    await accountInfo.load()
    expect(accountInfo.getAuth()).toBeNull()
  })

  it('clear() wipes both memory and disk state', async () => {
    const sim = await resetRemoteSimulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: sim.realm,
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()

    accountInfo.clear()
    await accountInfo.flushed()

    expect(accountInfo.getAuth()).toBeNull()
    // File still exists but should be empty.
    const onDisk = await readFile(storePath, 'utf8').catch(() => '')
    expect(onDisk).toBe('')
  })

  it('writes the cache file with owner-only permissions on POSIX platforms', async () => {
    const sim = await resetRemoteSimulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: sim.realm,
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()

    if (process.platform === 'win32') {
      return
    }

    expect((await stat(storePath)).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')(
    'creates and tightens the credential directory to mode 0700',
    async () => {
      const directory = join(tempDir, 'credentials')
      const first = new FileAccountInfo(join(directory, 'auth.json'))
      first.setAuth(makeCachedAuth())
      await first.flushed()
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      await chmod(directory, 0o755)
      first.setAuth(makeCachedAuth())
      await first.flushed()
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
    },
  )

  it('credential file is created with mode 0600 on its open descriptor', () => {
    const observed = observeCredentialWrite(storePath)
    expect(observed.events).toEqual(['open', 'mode', 'write', 'close', 'rename'])
    expect(observed.creationModes).toEqual([0o600])
    expect(observed.descriptorModes).toEqual([0o600])
    expect(observed.pathModes).toBe(0)
    expect(observed.contentsMatch).toBe(true)
    expect(observed.files).toEqual(['auth.json'])
    expect(observed.errors).toEqual([])
    if (process.platform !== 'win32') {
      expect(observed.modeBeforeRename).toBe(0o600)
      expect(observed.finalMode).toBe(0o600)
    }
  })

  it.each(['mode', 'write'])(
    'retains the prior credential file when descriptor %s fails',
    (failure) => {
      const observed = observeCredentialWrite(storePath, failure)
      expect(observed.events).toEqual(
        failure === 'mode' ? ['open', 'mode', 'close'] : ['open', 'mode', 'write', 'close'],
      )
      expect(observed.contentsMatch).toBe(true)
      expect(observed.files).toEqual(['auth.json'])
      expect(observed.errors).toEqual([`${failure} did not complete`])
    },
  )

  it('replaces a broadly-readable cache file with a private atomic write', async () => {
    await writeFile(storePath, '{"stale":true}', { encoding: 'utf8', mode: 0o666 })
    await chmod(storePath, 0o666)

    const sim = await resetRemoteSimulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: sim.realm,
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()

    const onDisk = JSON.parse(await readFile(storePath, 'utf8')) as {
      _b2sdk?: { realmUrl?: string; applicationKeyId?: string }
      accountId?: string
      auth?: { accountId?: string }
      realmUrl?: string
    }
    expect(onDisk.auth?.accountId ?? onDisk.accountId).toBe('sim_account_0001')
    expect(onDisk._b2sdk?.realmUrl).toBe(sim.realm)
    expect(onDisk._b2sdk?.applicationKeyId).toBe('test-key-id')
    expect(await readdir(tempDir)).toEqual(['auth.json'])

    if (process.platform !== 'win32') {
      expect((await stat(storePath)).mode & 0o777).toBe(0o600)
    }
  })

  it('writes auth at the top level so older readers can re-use the cache', async () => {
    const sim = await resetRemoteSimulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: sim.realm,
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()

    const onDisk = JSON.parse(await readFile(storePath, 'utf8')) as AuthorizeAccountResponse & {
      _b2sdk?: { realmUrl?: string; applicationKeyId?: string }
    }
    const oldReader = new InMemoryAccountInfo()
    oldReader.setAuth(onDisk)

    expect(onDisk._b2sdk?.realmUrl).toBe(sim.realm)
    expect(onDisk._b2sdk?.applicationKeyId).toBe('test-key-id')
    expect(oldReader.getApiUrl()).toBe(accountInfo.getApiUrl())
  })

  it('persists across multiple setAuth calls', async () => {
    const sim = await resetRemoteSimulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: sim.realm,
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await client.authorize() // re-auth
    await accountInfo.flushed()

    const loaded = new FileAccountInfo(storePath)
    await loaded.load()
    expect(loaded.getAuth()).toBeTruthy()
  })

  it('ignores a legacy cache when bound to a client key without clobbering disk', async () => {
    const cached = JSON.stringify(makeCachedAuth())
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()
    expect(accountInfo.getAuth()).not.toBeNull()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'staging',
      transport: (await resetRemoteSimulator()).transport(),
      accountInfo,
    })

    expect(client.accountInfo).toBe(accountInfo)
    expect(accountInfo.getAuth()).toBeNull()
    await accountInfo.flushed()
    expect(discards).toEqual(['application_key_mismatch'])
    expect(await readFile(storePath, 'utf8')).toBe(cached)
  })

  it('retains a legacy production cache only when endpoints match production', async () => {
    await writeFile(storePath, JSON.stringify(makeCachedAuth()), 'utf8')
    const accountInfo = new FileAccountInfo(storePath)
    await accountInfo.load()

    accountInfo.setRealmUrl('https://api.backblazeb2.com')

    expect(accountInfo.getAuth()).not.toBeNull()
  })

  it('retains a legacy production cache after REALM_URLS.production is mutated', async () => {
    const originalProduction = REALM_URLS['production'] ?? 'https://api.backblazeb2.com'
    try {
      REALM_URLS['production'] = 'https://attacker.example'
      await writeFile(
        storePath,
        JSON.stringify({
          ...makeCachedAuth(),
          _b2sdk: {
            version: 1,
            applicationKeyId: 'test-key-id',
          },
        }),
        'utf8',
      )
      const accountInfo = new FileAccountInfo(storePath)
      await accountInfo.load()

      const client = new B2Client({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        transport: (await resetRemoteSimulator()).transport(),
        accountInfo,
      })

      expect(client.accountInfo.getAuth()).not.toBeNull()
    } finally {
      REALM_URLS['production'] = originalProduction
    }
  })

  it('ignores a legacy custom-realm cache when bound to production', async () => {
    const cached = JSON.stringify(
      makeCachedAuth({
        apiUrl: 'https://api.custom.example',
        downloadUrl: 'https://download.custom.example',
        s3ApiUrl: 'https://s3.custom.example',
      }),
    )
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()
    expect(accountInfo.getAuth()).not.toBeNull()

    accountInfo.setRealmUrl('https://api.backblazeb2.com')

    expect(accountInfo.getAuth()).toBeNull()
    await accountInfo.flushed()
    expect(discards).toEqual(['realm_mismatch'])
    expect(await readFile(storePath, 'utf8')).toBe(cached)
  })

  it('ignores a persisted auth cache when the stored realm differs without clobbering disk', async () => {
    const cached = JSON.stringify({
      ...makeCachedAuth(),
      _b2sdk: {
        version: 1,
        realmUrl: 'https://api.backblazeb2.com',
        applicationKeyId: 'test-key-id',
      },
    })
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'staging',
      transport: (await resetRemoteSimulator()).transport(),
      accountInfo,
    })

    expect(client.accountInfo).toBe(accountInfo)
    expect(accountInfo.getAuth()).toBeNull()
    await accountInfo.flushed()
    expect(discards).toEqual(['realm_mismatch'])
    expect(await readFile(storePath, 'utf8')).toBe(cached)
  })

  it('ignores a persisted auth cache when the stored application key differs', async () => {
    const cached = JSON.stringify({
      ...makeCachedAuth(),
      _b2sdk: {
        version: 1,
        realmUrl: 'https://api.backblazeb2.com',
        applicationKeyId: 'privileged-key-id',
      },
    })
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()
    expect(accountInfo.getAuth()).not.toBeNull()

    const client = new B2Client({
      applicationKeyId: 'restricted-key-id',
      applicationKey: 'test-key',
      transport: (await resetRemoteSimulator()).transport(),
      accountInfo,
    })

    expect(client.accountInfo).toBe(accountInfo)
    expect(accountInfo.getAuth()).toBeNull()
    await accountInfo.flushed()
    expect(discards).toEqual(['application_key_mismatch'])
    expect(await readFile(storePath, 'utf8')).toBe(cached)
  })

  it('does not let a staging-bound client clobber a production cache from another process', async () => {
    const cached = JSON.stringify({
      ...makeCachedAuth(),
      _b2sdk: {
        version: 1,
        realmUrl: 'https://api.backblazeb2.com',
        applicationKeyId: 'test-key-id',
      },
    })
    await writeFile(storePath, cached, 'utf8')

    const stagingAccountInfo = new FileAccountInfo(storePath)
    await stagingAccountInfo.load()
    const stagingClient = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'staging',
      transport: (await resetRemoteSimulator()).transport(),
      accountInfo: stagingAccountInfo,
    })

    expect(stagingClient.accountInfo.getAuth()).toBeNull()
    expect(await readFile(storePath, 'utf8')).toBe(cached)

    const productionAccountInfo = new FileAccountInfo(storePath)
    await productionAccountInfo.load()
    const productionClient = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: (await resetRemoteSimulator()).transport(),
      accountInfo: productionAccountInfo,
    })

    expect(productionClient.accountInfo.getAuth()).not.toBeNull()
  })

  it('ignores a matching-metadata cache whose endpoints do not match the realm', async () => {
    const cached = JSON.stringify({
      ...makeCachedAuth({
        apiUrl: 'https://attacker.example/api',
        downloadUrl: 'https://attacker.example/download',
        s3ApiUrl: 'https://attacker.example/s3',
      }),
      _b2sdk: {
        version: 1,
        realmUrl: 'https://api.backblazeb2.com',
        applicationKeyId: 'test-key-id',
      },
    })
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn<typeof fetch>()
    globalThis.fetch = fetchSpy
    try {
      const client = new B2Client({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        accountInfo,
      })

      expect(client.accountInfo.getAuth()).toBeNull()
      expect(discards).toEqual(['endpoint_mismatch'])
      expect(() => client.accountInfo.getApiUrl()).toThrow('Not authorized')
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await readFile(storePath, 'utf8')).toBe(cached)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('locks the default URL guard from retained cached auth', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth(),
        _b2sdk: {
          version: 1,
          realmUrl: 'https://api.backblazeb2.com',
          applicationKeyId: 'test-key-id',
        },
      }),
      'utf8',
    )
    const accountInfo = new FileAccountInfo(storePath)
    await accountInfo.load()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      accountInfo,
    })

    expect(client.accountInfo.getAuth()).not.toBeNull()
    expect(client.urlGuard?.getAllowedSuffixes()).toContain('backblazeb2.com')
  })

  it('retains a staging cache whose endpoints are sibling staging hosts', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth({
          apiUrl: 'https://api001.backblaze.net',
          downloadUrl: 'https://f001.backblaze.net',
          s3ApiUrl: 'https://s3.us-west-001.backblaze.net',
        }),
        _b2sdk: {
          version: 1,
          realmUrl: 'https://api.backblaze.net',
          applicationKeyId: 'test-key-id',
        },
      }),
      'utf8',
    )
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'staging',
      transport: (await resetRemoteSimulator()).transport(),
      accountInfo,
    })

    expect(client.accountInfo.getAuth()).not.toBeNull()
    expect(discards).toEqual([])
  })

  it('retains a custom-realm cache whose endpoints are exact realm subdomains', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth({
          apiUrl: 'https://api.auth.custom.example',
          downloadUrl: 'https://download.auth.custom.example',
          s3ApiUrl: 'https://s3.auth.custom.example',
        }),
        _b2sdk: {
          version: 1,
          realmUrl: 'https://auth.custom.example',
          applicationKeyId: 'test-key-id',
        },
      }),
      'utf8',
    )
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'https://auth.custom.example',
      transport: (await resetRemoteSimulator()).transport(),
      accountInfo,
    })

    expect(client.accountInfo.getAuth()).not.toBeNull()
    expect(discards).toEqual([])
  })

  it('rejects custom-realm sibling endpoints under Backblaze-owned suffixes', async () => {
    const cached = JSON.stringify({
      ...makeCachedAuth({
        apiUrl: 'https://api.backblazeb2.com/api',
        downloadUrl: 'https://f001.backblazeb2.com/download',
        s3ApiUrl: 'https://s3.us-west-001.backblazeb2.com/s3',
      }),
      _b2sdk: {
        version: 1,
        realmUrl: 'https://auth.backblazeb2.com',
        applicationKeyId: 'test-key-id',
      },
    })
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn<typeof fetch>()
    globalThis.fetch = fetchSpy
    try {
      const client = new B2Client({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        realm: 'https://auth.backblazeb2.com',
        accountInfo,
      })

      expect(client.accountInfo.getAuth()).toBeNull()
      expect(discards).toEqual(['endpoint_mismatch'])
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await readFile(storePath, 'utf8')).toBe(cached)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects a custom-realm cache whose endpoints are sibling public-suffix hosts', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth({
          apiUrl: 'https://attacker.ngrok-free.app/api',
          downloadUrl: 'https://attacker.ngrok-free.app/download',
          s3ApiUrl: 'https://attacker.ngrok-free.app/s3',
        }),
        _b2sdk: {
          version: 1,
          realmUrl: 'https://victim.ngrok-free.app',
          applicationKeyId: 'test-key-id',
        },
      }),
      'utf8',
    )
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn<typeof fetch>()
    globalThis.fetch = fetchSpy
    try {
      const client = new B2Client({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        realm: 'https://victim.ngrok-free.app',
        accountInfo,
      })

      expect(client.accountInfo.getAuth()).toBeNull()
      expect(discards).toEqual(['endpoint_mismatch'])
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects loopback endpoints in cached auth by default', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth({
          apiUrl: 'http://127.0.0.1:9876/api',
          downloadUrl: 'http://localhost:9876/download',
          s3ApiUrl: 'http://[::1]:9876/s3',
        }),
        _b2sdk: {
          version: 1,
          realmUrl: 'https://auth.custom.example',
          applicationKeyId: 'test-key-id',
        },
      }),
      'utf8',
    )
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'https://auth.custom.example',
      transport: (await resetRemoteSimulator()).transport(),
      accountInfo,
    })

    expect(client.accountInfo.getAuth()).toBeNull()
    expect(discards).toEqual(['endpoint_mismatch'])
  })

  it.each([
    ['sibling IPv4', 'http://127.0.0.2:8180'],
    ['localhost alias', 'http://localhost:8180'],
    ['IPv6 alias', 'http://[::1]:8180'],
    ['different port', 'http://127.0.0.1:9999'],
  ])('rejects %s loopback endpoints for a loopback realm', async (_label, endpoint) => {
    const cached = JSON.stringify({
      ...makeCachedAuth({
        apiUrl: `${endpoint}/api`,
        downloadUrl: `${endpoint}/download`,
        s3ApiUrl: `${endpoint}/s3`,
      }),
      _b2sdk: {
        version: 1,
        realmUrl: 'http://127.0.0.1:8180',
        applicationKeyId: 'test-key-id',
      },
    })
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn<typeof fetch>()
    globalThis.fetch = fetchSpy
    try {
      const client = new B2Client({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        realm: 'http://127.0.0.1:8180',
        accountInfo,
      })

      expect(client.accountInfo.getAuth()).toBeNull()
      expect(discards).toEqual(['endpoint_mismatch'])
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await readFile(storePath, 'utf8')).toBe(cached)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('delegates every AccountInfo getter to the in-memory backing', async () => {
    const sim = await resetRemoteSimulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: sim.realm,
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()

    expect(accountInfo.getAccountId()).toBe('sim_account_0001')
    expect(accountInfo.getApiUrl()).toBeTruthy()
    expect(accountInfo.getDownloadUrl()).toBeTruthy()
    expect(accountInfo.getAuthToken()).toBeTruthy()
    expect(accountInfo.getRecommendedPartSize()).toBeGreaterThan(0)
    expect(accountInfo.getAbsoluteMinimumPartSize()).toBeGreaterThan(0)
    expect(accountInfo.getS3ApiUrl()).toBeTruthy()
    expect(accountInfo.getAllowedBucketId()).toBeNull()
    expect(accountInfo.getAllowedBucketIds()).toBeNull()

    const cached = accountInfo.getAuth()
    expect(cached?.apiInfo.storageApi.allowed.buckets).toBeNull()
    expect(cached?.apiInfo.storageApi.allowed.bucketId).toBeNull()
    expect(cached?.apiInfo.storageApi.bucketId).toBeNull()
    expect(cached?.apiInfo.storageApi.infoType).toBe('storageApi')

    const persisted = JSON.parse(await readFile(storePath, 'utf8')) as AuthorizeAccountResponse
    expect(persisted.apiInfo.storageApi.allowed.buckets).toBeNull()
    expect(persisted.apiInfo.storageApi.allowed.bucketId).toBeNull()
    expect(persisted.apiInfo.storageApi.bucketId).toBeNull()
    expect(persisted.apiInfo.storageApi.infoType).toBe('storageApi')
  })

  it('delegates the upload URL pool methods to the in-memory backing', async () => {
    const sim = await resetRemoteSimulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: sim.realm,
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()
    const bucket = await client.createBucket({
      bucketName: 'pool-delegate',
      bucketType: BucketType.AllPrivate,
    })

    const entry = { uploadUrl: 'http://u', authorizationToken: 'tok' }
    accountInfo.returnUploadUrl(bucket.id, entry)
    expect(accountInfo.checkoutUploadUrl(bucket.id)).toEqual(entry)
    accountInfo.returnUploadUrl(bucket.id, entry)
    accountInfo.evictUploadUrl(bucket.id, entry)
    expect(accountInfo.checkoutUploadUrl(bucket.id)).toBeNull()

    const partEntry = { uploadUrl: 'http://p', authorizationToken: 'ptok' }
    accountInfo.returnPartUploadUrl('file-id', partEntry)
    expect(accountInfo.checkoutPartUploadUrl('file-id')).toEqual(partEntry)
    accountInfo.returnPartUploadUrl('file-id', partEntry)
    accountInfo.evictPartUploadUrl('file-id', partEntry)
    expect(accountInfo.checkoutPartUploadUrl('file-id')).toBeNull()
  })
})
