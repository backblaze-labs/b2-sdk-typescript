'use strict';

const dns = require('node:dns');

// A zero-value test fixture: this name resolves to loopback only inside a
// process that explicitly installs the patch below.
const FIXTURE_HOST = process.env.SDKHARNESS_SIMULATOR_FIXTURE_HOST || 'sdkharness-loopback-fixture.backblaze.net';

function routeFixtureHostToLoopback() {
  const real = dns.lookup;
  dns.lookup = function lookup(hostname, options, callback) {
    if (String(hostname).toLowerCase() !== FIXTURE_HOST) return real.apply(dns, arguments);
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

module.exports = { FIXTURE_HOST, routeFixtureHostToLoopback };
