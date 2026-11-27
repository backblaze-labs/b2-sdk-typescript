/**
 * Node (and Bun) side of the standalone-simulator harness: starts the
 * b2-simulator server as a child process and keeps exactly one per test
 * process.
 *
 * Isolation: Vitest runs one test file at a time in each worker process (and,
 * with the default `isolate: true`, a fresh process per file), and the tests
 * inside a file run one after another. One server per process therefore means
 * no two concurrently running files ever share a server, so a reset in one
 * file can never wipe another file's state. Do not use `describe.concurrent` /
 * `it.concurrent` in a file that resets the simulator.
 *
 * Shutdown: the server runs under `scripts/b2-simulator/launch.mjs`, which
 * exits when its stdin closes, i.e. when this process exits for any reason.
 * A normal exit also sends SIGTERM through an `exit` handler.
 *
 * Node-only: imported dynamically by `remote-simulator.ts` so browser bundles
 * never load `node:child_process`.
 *
 * @packageDocumentation
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveServeScript } from '../../scripts/b2-simulator/pin.mjs'

/** A running standalone simulator. */
export interface SimulatorProcess {
  /** HTTP origin of the B2 native API realm, e.g. `http://127.0.0.1:41234`. */
  readonly apiUrl: string
  /** HTTPS origin of the same realm (self-signed loopback certificate). */
  readonly httpsUrl: string
  /** Origin of the control plane. */
  readonly controlUrl: string
  /** PID of the process that runs the server. */
  readonly pid: number
  /** Stops the server and waits for the process to exit. Idempotent. */
  stop(): Promise<void>
}

/** Options for {@link startSimulatorProcess}. */
export interface StartSimulatorOptions {
  /** Path of the simulator's `bin/simulator/serve.mjs`. */
  readonly serveScript: string
  /** Extra serve.mjs options; `--control --profile ts-sdk` are always passed. */
  readonly args?: readonly string[]
  /** How long to wait for the three ready lines. Defaults to 15 s. */
  readonly timeoutMs?: number
}

const LAUNCHER = fileURLToPath(new URL('../../scripts/b2-simulator/launch.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * The Node executable to run the simulator with. Under Bun this is `node` from
 * PATH, because the simulator's contract is Node 20 or later.
 *
 * @returns A command or absolute path.
 */
export function nodeExecutable(): string {
  return process.versions['bun'] !== undefined ? 'node' : process.execPath
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    // Hold the event loop until the exit arrives (the child is unref'd once ready).
    child.ref()
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
  })
}

/**
 * Starts one standalone simulator and waits for its ready lines
 * (`SIMULATOR-LISTENING http://…`, `SIMULATOR-LISTENING https://…`,
 * `SIMULATOR-CONTROL http://…`).
 *
 * @param options - Script path, extra options and start-up timeout.
 *
 * @returns The running server's URLs and a `stop()` function.
 *
 * @throws Error naming the script, exit code and stderr when the server exits or
 *   stays silent before it is ready; the process is killed in the timeout case.
 */
export function startSimulatorProcess(options: StartSimulatorOptions): Promise<SimulatorProcess> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const child = spawn(
    nodeExecutable(),
    [LAUNCHER, options.serveScript, '--control', '--profile', 'ts-sdk', ...(options.args ?? [])],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  const prefix = `b2-simulator did not start (${options.serveScript})`
  let stdout = ''
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString()
  })

  return new Promise<SimulatorProcess>((resolve, reject) => {
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void stopChild(child).then(() =>
        reject(new Error(`${prefix}: ${message}${stderr ? `\nstderr: ${stderr.trim()}` : ''}`)),
      )
    }
    const timer = setTimeout(
      () => fail(`it did not print its ready lines within ${timeoutMs} ms`),
      timeoutMs,
    )
    child.once('error', (error) => fail(`could not spawn ${nodeExecutable()}: ${error.message}`))
    child.once('exit', (code, signal) => {
      // Let stderr drain before reporting it.
      setImmediate(() =>
        fail(`it exited with code ${code ?? `null (signal ${signal})`} before it was ready`),
      )
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      stdout += chunk.toString()
      const lines = stdout.split('\n').filter((line) => line.trim() !== '')
      if (lines.length < 3 || !stdout.endsWith('\n')) return
      const [api, https, control] = lines.map((line) => line.trim().split(/\s+/))
      if (
        api?.[0] !== 'SIMULATOR-LISTENING' ||
        https?.[0] !== 'SIMULATOR-LISTENING' ||
        control?.[0] !== 'SIMULATOR-CONTROL' ||
        api[1] === undefined ||
        https[1] === undefined ||
        control[1] === undefined
      ) {
        fail(`unexpected ready lines: ${JSON.stringify(lines)}`)
        return
      }
      settled = true
      clearTimeout(timer)
      child.removeAllListeners('exit')
      // The server must not keep the test process's event loop alive.
      child.unref()
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        ;(stream as unknown as { unref?: () => void } | null)?.unref?.()
      }
      const onExit = (): void => {
        child.kill('SIGTERM')
      }
      process.once('exit', onExit)
      let stopping: Promise<void> | undefined
      resolve({
        apiUrl: api[1],
        httpsUrl: https[1],
        controlUrl: control[1],
        pid: child.pid ?? -1,
        stop() {
          process.removeListener('exit', onExit)
          stopping ??= stopChild(child)
          return stopping
        },
      })
    })
  })
}

const SINGLETON = Symbol.for('@backblaze-labs/b2-sdk/test-utils/standalone-simulator')

/**
 * The one standalone simulator of this test process, started on first use.
 * Keyed on `globalThis` so it is shared even when the test runner re-evaluates
 * modules between files in the same process (`isolate: false`).
 *
 * @returns The running simulator.
 */
export function processSimulator(): Promise<SimulatorProcess> {
  const holder = globalThis as { [SINGLETON]?: Promise<SimulatorProcess> }
  let pending = holder[SINGLETON]
  if (pending === undefined) {
    pending = (async () =>
      startSimulatorProcess({
        serveScript: resolveServeScript({ repoRoot: REPO_ROOT, env: process.env }),
      }))()
    // A failed start is not cached, so the next test reports the same clear error.
    pending.catch(() => {
      if (holder[SINGLETON] === pending) delete holder[SINGLETON]
    })
    holder[SINGLETON] = pending
  }
  return pending
}
