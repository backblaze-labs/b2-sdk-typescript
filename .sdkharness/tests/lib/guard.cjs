'use strict';

/*
 * Shared guard for every sdkharness check in this repository (the conformance
 * and resilience leaves and health-golden-path). One implementation, so a rule
 * cannot drift between the 54 leaves:
 *
 *   - the simulator must be a plain-HTTP IPv4 loopback origin,
 *     http://127.0.0.1:<port> (https://127.0.0.1:<port> only for the TLS
 *     listener). [::1], localhost, userinfo, paths and queries are refused;
 *   - the only credential is the simulator's fixed test pair;
 *   - proxy variables are scrubbed so a developer or CI proxy cannot turn a
 *     loopback request into something else;
 *   - an SDK that is built but throws on import is a FAIL. Only a missing
 *     build (no dist target on disk, nothing of the SDK has run) is amber;
 *   - a "the SDK refused this" proof must name the specific expected error.
 *
 * Unit tests: tests/unit/guard.test.cjs. Run `pnpm run test:sdkharness`.
 */

const fs = require('node:fs');
const path = require('node:path');

const FIXED_KEY_ID = 'test-key-id';
const FIXED_KEY = 'test-key';

// tests/lib -> tests -> .sdkharness -> repository root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** A violated guard rule. Message is safe to print: it never echoes a secret. */
class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
  }
}

// Variable names (either case) that route or alter outbound HTTP.
const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
];

/**
 * Remove every proxy variable from `env` (default: this process). Returns the
 * names removed, never their values (a proxy URL can carry credentials).
 */
function scrubProxyEnv(env = process.env) {
  const removed = [];
  for (const name of Object.keys(env)) {
    if (PROXY_VARIABLES.includes(name.toUpperCase())) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

// Describe the shape of a rejected value without echoing userinfo or a path.
function shapeOf(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return 'an unparsable value';
  }
}

/**
 * The validated origin for `value`: http://127.0.0.1:<port>, or
 * https://127.0.0.1:<port> with `{ scheme: 'https' }`. A trailing slash is
 * accepted and dropped. Anything else throws a GuardError that names `label`.
 */
function requireLoopbackOrigin(value, label, { scheme = 'http' } = {}) {
  if (typeof value !== 'string' || value === '') {
    throw new GuardError(`${label} is unset; it must be ${scheme}://127.0.0.1:<port>`);
  }
  const match = new RegExp(`^${scheme}://127\\.0\\.0\\.1:([0-9]{1,5})/?$`).exec(value);
  const port = match ? Number(match[1]) : 0;
  if (!match || port < 1 || port > 65535) {
    throw new GuardError(
      `${label} must be ${scheme}://127.0.0.1:<port> (IPv4 loopback only), got ${shapeOf(value)}`,
    );
  }
  return `${scheme}://127.0.0.1:${port}`;
}

/**
 * Read env var `name` and validate it. Unset or empty returns undefined so the
 * caller keeps its own "no realm" verdict. A set-but-wrong value throws
 * whatever `onInvalid(message)` returns (a leaf passes a Failure builder).
 */
function originFromEnv(name, onInvalid, options, env = process.env) {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  try {
    return requireLoopbackOrigin(value, name, options);
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    throw onInvalid(error.message);
  }
}

/** Throw unless this is exactly the simulator's fixed test credential. */
function requireFixedCredential(keyId, key) {
  if (keyId !== FIXED_KEY_ID || key !== FIXED_KEY) {
    throw new GuardError('only the fixed simulator credential is accepted');
  }
}

/**
 * One-line error text with the underlying reason: name, message, and the
 * first causes (the SDK wraps socket errors in a NetworkError whose own
 * message may say nothing).
 */
function describeError(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; depth < 3 && current != null; depth += 1) {
    if (current instanceof Error) {
      const code = current.code ? ` [${current.code}]` : '';
      const message = current.message ? `: ${current.message}` : '';
      parts.push(`${current.name}${code}${message}`);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' <- ');
}

function oneLine(text, limit = 200) {
  return String(text).replace(/[\r\n\t]+/g, ' ').slice(0, limit);
}

// The built package target for a specifier, from this checkout's own exports.
function distTarget(specifier, root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const name = manifest.name;
  if (specifier !== name && !specifier.startsWith(`${name}/`)) return { kind: 'foreign' };
  const key = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
  const entry = manifest.exports && manifest.exports[key];
  const target = entry && entry.import && (entry.import.default || entry.import);
  if (typeof target !== 'string') return { kind: 'unexported', key };
  return { kind: 'file', key, file: path.join(root, target) };
}

/**
 * Import one specifier of this checkout's SDK.
 *
 * - The built file for the specifier is absent: nothing of the SDK has run,
 *   the question could not be asked. Returns `hooks.missing(detail)` thrown.
 * - Anything else that goes wrong (the file is there but throws on import, an
 *   internal module is missing, the export was removed) is an SDK defect and
 *   throws `hooks.broken(detail)`.
 *
 * `root` and `importer` are injectable for tests only.
 */
async function importBuiltSdk(specifier, hooks, { root = REPO_ROOT, importer } = {}) {
  const doImport = importer || ((target) => import(target));
  let target;
  try {
    target = distTarget(specifier, root);
  } catch (error) {
    throw hooks.broken(oneLine(`cannot read package.json exports for ${specifier}: ${describeError(error)}`));
  }
  if (target.kind === 'unexported') {
    throw hooks.broken(`${specifier} is not exported by package.json (${target.key})`);
  }
  if (target.kind === 'file' && !fs.existsSync(target.file)) {
    throw hooks.missing(`${specifier} is unavailable -- build this exact checkout first (missing ${path.relative(root, target.file)})`);
  }
  try {
    return await doImport(specifier);
  } catch (error) {
    throw hooks.broken(oneLine(`importing the built ${specifier} failed: ${describeError(error)}`));
  }
}

/** Run `action`; return the error it threw, or null when it did not throw. */
async function capture(action) {
  try {
    await action();
  } catch (error) {
    return error === null || error === undefined ? new Error(String(error)) : error;
  }
  return null;
}

/**
 * Compare a thrown SDK error with the specific refusal a check expects.
 * `spec`: { names?: string[], statuses?: number[], codes?: string[],
 * message?: RegExp }. Returns '' on a match, otherwise a one-line reason that
 * says what was seen. Every given field must match.
 */
function explainMismatch(error, spec) {
  const problems = [];
  const seen = error instanceof Error ? error : null;
  if (!seen) return `threw a non-Error value (${oneLine(String(error), 60)})`;
  if (spec.names && !spec.names.includes(seen.name)) problems.push(`type ${seen.name}`);
  if (spec.statuses && !spec.statuses.includes(seen.status)) problems.push(`status ${seen.status}`);
  if (spec.codes && !spec.codes.includes(seen.code)) problems.push(`code ${seen.code}`);
  if (spec.message && !spec.message.test(String(seen.message))) problems.push('message');
  if (problems.length === 0) return '';
  return oneLine(`unexpected ${problems.join(', ')}: ${describeError(seen)}`);
}

module.exports = {
  FIXED_KEY_ID,
  FIXED_KEY,
  GuardError,
  PROXY_VARIABLES,
  REPO_ROOT,
  capture,
  describeError,
  explainMismatch,
  importBuiltSdk,
  originFromEnv,
  requireFixedCredential,
  requireLoopbackOrigin,
  scrubProxyEnv,
};
