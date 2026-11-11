#!/usr/bin/env bash
# Packs the built dist, installs the tarball into a throwaway Nest app (test/consumer) pinned to one
# Nest major, compiles it with plain tsc, boots it and probes it over HTTP. The repo's own specs and
# the example app compile the sources, so only this shows what a consumer of the published package
# gets (SPI-452: the dist lacked decorator metadata and IntegrationRuntime crashed on boot).
#
# Usage: scripts/consumer-smoke.sh <nest-major> [port]   (run `npm run build` first)
set -euo pipefail

major="${1:?usage: consumer-smoke.sh <nest-major> [port]}"
port="${2:-3112}"
root="$(cd "$(dirname "$0")/.." && pwd)"

# @nestjs/swagger majors inside this package's peer range (^7 || ^8). Swagger 8 itself only declares
# Nest ^9 || ^10, so Nest 11 installs with --legacy-peer-deps, the same pairing the repo's own
# devDependencies and .npmrc use. SWAGGER_MAJOR overrides it (e.g. 11, which pairs with Nest 11).
case "$major" in
  10) swagger="${SWAGGER_MAJOR:-7}" ;;
  11) swagger="${SWAGGER_MAJOR:-8}" ;;
  *) echo "unsupported Nest major: $major (peers allow 10 and 11)" >&2; exit 2 ;;
esac

[ -f "$root/dist/index.js" ] || { echo "dist/ is missing: run npm run build first" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/estela-consumer-XXXXXX")"
pid=""
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "[consumer-smoke] packing into $work"
tarball="$(cd "$root" && npm pack --silent --pack-destination "$work" | tail -n 1)"
cp -R "$root/test/consumer/src" "$root/test/consumer/tsconfig.json" "$work/"

cat >"$work/package.json" <<EOF
{
  "name": "estela-consumer-nest${major}",
  "private": true,
  "version": "0.0.0",
  "dependencies": {
    "@estela/nest": "file:./${tarball}",
    "@nestjs/common": "^${major}.0.0",
    "@nestjs/core": "^${major}.0.0",
    "@nestjs/platform-express": "^${major}.0.0",
    "@nestjs/swagger": "^${swagger}.0.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "typescript": "^5.5.4"
  }
}
EOF

cd "$work"
echo "[consumer-smoke] installing Nest ${major} + @nestjs/swagger ${swagger} + ${tarball}"
npm install --no-audit --no-fund --loglevel=error --legacy-peer-deps
node -e "console.log('[consumer-smoke] resolved @nestjs/core', require('@nestjs/core/package.json').version)"

echo "[consumer-smoke] compiling with tsc"
npx --no-install tsc -p tsconfig.json

PORT="$port" node out/main.js >"$work/app.log" 2>&1 &
pid=$!

ready=""
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${port}/integration/graph" >/dev/null; then ready=1; break; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
if [ -z "$ready" ]; then
  echo "[consumer-smoke] app did not become ready; log:" >&2
  cat "$work/app.log" >&2
  exit 1
fi

graph="$(curl -sf "http://127.0.0.1:${port}/integration/graph")"
echo "$graph" | grep -q '"greet"' || { echo "graph is missing the greet flow: $graph" >&2; exit 1; }

reply="$(curl -s -X POST "http://127.0.0.1:${port}/greet" \
  -H 'content-type: application/json' -d '{"name":"ada"}')"
echo "[consumer-smoke] POST /greet -> $reply"
echo "$reply" | grep -q '"status":"ok"' || { echo "request/reply failed" >&2; cat "$work/app.log" >&2; exit 1; }
echo "$reply" | grep -q 'hello ADA' || { echo "activator reply missing" >&2; exit 1; }

echo "[consumer-smoke] Nest ${major}: packed dist boots and serves"
