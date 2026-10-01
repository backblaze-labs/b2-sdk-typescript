'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');

// Zero-value test fixtures: these names resolve to loopback only inside a
// process that explicitly installs the patch below. Two simulators exist and
// each certificate names exactly one of them, so a check must address the name
// the simulator it is talking to actually serves:
//   - the standalone B2 simulator serves b2-simulator-loopback.backblaze.net;
//   - the simulator embedded in the harness serves the legacy name.
const FIXTURE_HOST = 'b2-simulator-loopback.backblaze.net';
const LEGACY_FIXTURE_HOST = 'sdkharness-loopback-fixture.backblaze.net';
const FIXTURE_HOSTS = [FIXTURE_HOST, LEGACY_FIXTURE_HOST];

function routeFixtureHostToLoopback() {
  const real = dns.lookup;
  dns.lookup = function lookup(hostname, options, callback) {
    if (!FIXTURE_HOSTS.includes(String(hostname).toLowerCase())) return real.apply(dns, arguments);
    if (typeof options === 'function') [callback, options] = [options, {}];
    const all = Boolean(options && options.all);
    process.nextTick(() =>
      all
        ? callback(null, [{ address: '127.0.0.1', family: 4 }])
        : callback(null, '127.0.0.1', 4),
    );
    return undefined;
  };
}

// The fixture host the simulator pinned by `caPath` serves: the first name in
// FIXTURE_HOSTS that its certificate carries as a DNS subject alternative name.
// Throws when the certificate names none, so a mismatch fails loudly here and
// not as a TLS error later.
function fixtureHostFor(caPath) {
  const { subjectAltName } = new crypto.X509Certificate(fs.readFileSync(caPath));
  const names = String(subjectAltName || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('DNS:'))
    .map((entry) => entry.slice(4).toLowerCase());
  const host = FIXTURE_HOSTS.find((candidate) => names.includes(candidate));
  if (!host) {
    throw new Error(`the simulator certificate names none of the fixture hosts (${FIXTURE_HOSTS.join(', ')}); it carries: ${names.join(', ') || 'no DNS names'}`);
  }
  return host;
}

module.exports = { FIXTURE_HOST, LEGACY_FIXTURE_HOST, FIXTURE_HOSTS, fixtureHostFor, routeFixtureHostToLoopback };
