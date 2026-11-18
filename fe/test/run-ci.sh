#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

node be/dist/index.js > /tmp/sharebill-api.log 2>&1 &
api_pid=$!
(cd fe && exec node node_modules/serve/build/main.js out --listen 3000) > /tmp/sharebill-fe.log 2>&1 &
web_pid=$!
cleanup() {
  local status=$?
  kill "$api_pid" "$web_pid" 2>/dev/null || true
  if (( status != 0 )); then
    tail -n 30 /tmp/sharebill-api.log /tmp/sharebill-fe.log
  fi
}
trap cleanup EXIT

curl --fail --silent --show-error --retry 20 --retry-connrefused --retry-delay 1 http://localhost:3001/health > /dev/null
curl --fail --silent --show-error --retry 20 --retry-connrefused --retry-delay 1 http://localhost:3000/ > /dev/null
pnpm --dir fe test:browser
