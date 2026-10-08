#!/usr/bin/env bash

sdkharness_valid_loopback_origin() {
  local value="$1" port
  case "$value" in http://127.0.0.1:[0-9]*|http://127.0.0.1:[0-9]*/) ;; *) return 1 ;; esac
  port="${value#http://127.0.0.1:}"
  port="${port%/}"
  case "$port" in ''|*[!0-9]*) return 1 ;; esac
  [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null
}

# The TLS listener of the same simulator: https://127.0.0.1:<port>. Empty is
# accepted (a scenario that needs TLS says so itself); anything else must match.
sdkharness_valid_loopback_https_origin() {
  local value="$1" port
  case "$value" in https://127.0.0.1:[0-9]*|https://127.0.0.1:[0-9]*/) ;; *) return 1 ;; esac
  port="${value#https://127.0.0.1:}"
  port="${port%/}"
  case "$port" in ''|*[!0-9]*) return 1 ;; esac
  [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null
}

# A proxy variable must not reroute loopback traffic. Unset them (either case);
# nothing here prints a value, a proxy URL can carry credentials.
sdkharness_scrub_proxy_env() {
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY NODE_USE_ENV_PROXY \
    http_proxy https_proxy all_proxy no_proxy
}

# Build this checkout, unless the harness is testing a PUBLISHED release.
# A published package ships no sources, so `pnpm build` cannot run there; the
# harness installs the release and sets SDKHARNESS_SDK_PREBUILT=1 to say the
# built output is already in place. Unset (the default) is exactly `pnpm build`.
# With the variable set, the build is skipped only if every file the package
# exports map points at for "." exists; otherwise this fails loudly rather than
# letting a later import report a vaguer error. Run from the package root.
sdkharness_build_or_prebuilt() {
  if [ "${SDKHARNESS_SDK_PREBUILT:-}" != 1 ]; then
    pnpm build
    return
  fi
  local missing
  missing="$(node -e '
const fs = require("node:fs")
const exp = JSON.parse(fs.readFileSync("package.json", "utf8")).exports?.["."] ?? {}
const files = [exp.import?.default, exp.require?.default].filter(Boolean)
const missing = files.length ? files.filter((f) => !fs.existsSync(f)) : ["(no \".\" import/require entry in package.json exports)"]
process.stdout.write(missing.join(", "))
process.exit(missing.length ? 1 : 0)' 2>&1)" || {
    printf '%s\n' "SDKHARNESS_SDK_PREBUILT=1 but the built output is missing: ${missing:-package.json unreadable}" >&2
    return 1
  }
  printf '%s\n' 'SDKHARNESS_SDK_PREBUILT=1: built output present, skipping pnpm build'
}
