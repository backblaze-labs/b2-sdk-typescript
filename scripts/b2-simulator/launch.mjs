// Runs the standalone simulator's serve.mjs in this process and exits when
// stdin closes. The test process that spawned us holds the other end of stdin,
// so when it exits for any reason (including SIGKILL, which runs no exit
// handler) the pipe closes and the simulator goes with it: no leaked servers.
//
// Usage: node launch.mjs <path/to/serve.mjs> [serve.mjs options...]
import { pathToFileURL } from 'node:url'

const [serve, ...args] = process.argv.slice(2)
if (!serve) {
  process.stderr.write('usage: node launch.mjs <serve.mjs> [options...]\n')
  process.exit(64)
}
process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))
process.stdin.resume()
// serve.mjs reads its options from process.argv.slice(2).
process.argv = [process.argv[0], serve, ...args]
await import(pathToFileURL(serve).href)
