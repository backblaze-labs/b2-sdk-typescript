import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  pinnedCacheDir,
  resolveServeScript,
  SIMULATOR_PIN,
} from '../../scripts/b2-simulator/pin.mjs'
import { nodeExecutable, startSimulatorProcess } from './remote-simulator-process.ts'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'b2sim-harness-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !isAlive(pid)
}

function fakeServe(name: string, source: string): string {
  const file = join(scratch, name)
  writeFileSync(file, source)
  return file
}

describe('resolveServeScript (where the pinned simulator comes from)', () => {
  it('pins one full commit of backblaze-labs/b2-simulator', () => {
    expect(SIMULATOR_PIN.repository).toBe('https://github.com/backblaze-labs/b2-simulator.git')
    expect(SIMULATOR_PIN.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('prints the pinned commit when run as a script (CI checks out that commit)', async () => {
    const pinScript = join(repoRoot, 'scripts', 'b2-simulator', 'pin.mjs')
    const run = spawn(nodeExecutable(), [pinScript], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    run.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const code = await new Promise<number | null>((resolve) => run.on('exit', resolve))
    expect(code).toBe(0)
    expect(out).toBe(`${SIMULATOR_PIN.commit}\n`)
  })

  it('release.yml checks out the pinned commit before the release commit', () => {
    // The release build cannot read pin.mjs before it checks out the release
    // commit (the deploy key is used only before that checkout), so the commit is
    // repeated there; this keeps the copy in step with the pin.
    const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
    const build = workflow.slice(workflow.indexOf('\n  build:\n'))
    const simulator = build.indexOf('repository: backblaze-labs/b2-simulator')
    const release = build.indexOf(`ref: \${{ github.sha }}`)
    expect(simulator).toBeGreaterThan(-1)
    expect(build.slice(simulator, simulator + 200)).toContain(`ref: ${SIMULATOR_PIN.commit}`)
    expect(release).toBeGreaterThan(simulator)
    expect(build.lastIndexOf('secrets.SIMULATOR_DEPLOY_KEY')).toBeLessThan(release)
  })

  it('uses B2SIM_DIR when set, without fetching', () => {
    const dir = join(scratch, 'checkout')
    mkdirSync(join(dir, 'bin', 'simulator'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'simulator', 'serve.mjs'), '')
    expect(resolveServeScript({ repoRoot, env: { B2SIM_DIR: dir } })).toBe(
      join(dir, 'bin', 'simulator', 'serve.mjs'),
    )
  })

  it('names B2SIM_DIR in the error when it points at no simulator', () => {
    const dir = join(scratch, 'not-a-checkout')
    expect(() => resolveServeScript({ repoRoot, env: { B2SIM_DIR: dir } })).toThrow(
      /B2SIM_DIR.*not-a-checkout.*bin\/simulator\/serve\.mjs/s,
    )
  })

  it('says which command fetches the pin when the cache is empty', () => {
    const emptyRoot = join(scratch, 'empty-root')
    mkdirSync(emptyRoot, { recursive: true })
    expect(() => resolveServeScript({ repoRoot: emptyRoot, env: {} })).toThrow(
      /pnpm run simulator:fetch/,
    )
    expect(pinnedCacheDir(emptyRoot)).toBe(
      join(emptyRoot, 'node_modules', '.cache', 'b2-simulator', SIMULATOR_PIN.commit),
    )
  })
})

describe('startSimulatorProcess', () => {
  it('starts the real server, reports its three URLs, and stops it', async () => {
    const serveScript = resolveServeScript({ repoRoot, env: process.env })
    const sim = await startSimulatorProcess({ serveScript })
    try {
      expect(sim.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(sim.httpsUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/)
      expect(sim.controlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const reset = await fetch(`${sim.controlUrl}/reset`, { method: 'POST' })
      expect(reset.status).toBe(200)
      expect(isAlive(sim.pid)).toBe(true)
    } finally {
      await sim.stop()
    }
    expect(await waitUntilDead(sim.pid)).toBe(true)
  })

  it('fails with the exit code and stderr when the server exits before it is ready', async () => {
    const serveScript = fakeServe(
      'exits.mjs',
      "process.stderr.write('serve.mjs: unknown argument --bogus\\n'); process.exit(64)\n",
    )
    await expect(startSimulatorProcess({ serveScript })).rejects.toThrow(
      /exited with code 64.*unknown argument --bogus/s,
    )
  })

  it('fails with a clear message when the script does not exist', async () => {
    await expect(
      startSimulatorProcess({ serveScript: join(scratch, 'missing', 'serve.mjs') }),
    ).rejects.toThrow(/b2-simulator did not start.*missing/s)
  })

  it('times out, and kills the process, when the ready lines never come', async () => {
    const pidFile = join(scratch, 'silent.pid')
    const serveScript = fakeServe(
      'silent.mjs',
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`,
    )
    await expect(startSimulatorProcess({ serveScript, timeoutMs: 1500 })).rejects.toThrow(
      /did not print its ready lines within 1500 ms/,
    )
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(await waitUntilDead(pid)).toBe(true)
  })

  it('does not outlive a test process that is killed outright', async () => {
    // A worker killed with SIGKILL runs no exit handler; the launcher must notice its
    // stdin closing and take the server down with it.
    const serveScript = resolveServeScript({ repoRoot, env: process.env })
    const harness = fileURLToPath(new URL('./remote-simulator-process.ts', import.meta.url))
    const parent = spawn(
      nodeExecutable(),
      [
        '--input-type=module',
        '-e',
        `const { startSimulatorProcess } = await import(${JSON.stringify(harness)});
         const sim = await startSimulatorProcess({ serveScript: ${JSON.stringify(serveScript)} });
         process.stdout.write(String(sim.pid) + '\\n'); setInterval(() => {}, 1000)`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const serverPid = await new Promise<number>((resolve, reject) => {
      let out = ''
      parent.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        if (out.includes('\n')) resolve(Number(out.trim()))
      })
      parent.on('exit', (code) => reject(new Error(`parent exited early with ${code}`)))
    })
    expect(isAlive(serverPid)).toBe(true)
    parent.kill('SIGKILL')
    expect(await waitUntilDead(serverPid)).toBe(true)
  })
})

describe('worker isolation', () => {
  it('gives each concurrently running test file its own server', async () => {
    // Two fixture files run in two vitest workers at the same time. Each resets "its"
    // simulator, waits until the other has reset too, creates one bucket, waits until
    // the other has created its bucket, then lists buckets. On one shared server the
    // second reset would happen before either bucket exists, so each file would list
    // both buckets and fail.
    const dir = join(scratch, 'isolation')
    mkdirSync(dir, { recursive: true })
    const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
    const config = join(repoRoot, 'src', 'test-utils', 'fixtures', 'vitest.isolation.config.ts')
    const run = spawn(nodeExecutable(), [vitest, 'run', '--config', config, '--maxWorkers=2'], {
      cwd: repoRoot,
      env: { ...process.env, ISOLATION_DIR: dir },
      stdio: 'pipe',
    })
    let output = ''
    run.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    run.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    const code = await new Promise<number | null>((resolve) => run.on('exit', resolve))
    expect(code, output).toBe(0)

    const a = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'))
    const b = JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8'))
    expect(a.workerPid).not.toBe(b.workerPid)
    expect(a.serverPid).not.toBe(b.serverPid)
    expect(a.controlUrl).not.toBe(b.controlUrl)
    // Both workers have exited, so neither server may still be running.
    expect(await waitUntilDead(a.serverPid)).toBe(true)
    expect(await waitUntilDead(b.serverPid)).toBe(true)
    expect(existsSync(join(dir, 'a.created')) && existsSync(join(dir, 'b.created'))).toBe(true)
  }, 60_000)
})
