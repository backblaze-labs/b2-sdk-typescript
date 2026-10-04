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
