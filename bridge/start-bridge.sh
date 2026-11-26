#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "=========================================="
echo "   Eaglercraft <-> Java TCP Bridge"
echo "=========================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed. Please install Node.js (https://nodejs.org) first."
  exit 1
fi

WS_PORT=${1:-8081}
case "$(printf %s "${WSS:-0}" | tr 'A-Z' 'a-z')" in
  1|true|yes|on) SCHEME=https ;;
  *) SCHEME=http ;;
esac
echo "Bridge is starting! Open ${SCHEME}://localhost:${WS_PORT} in your browser to configure."
echo "Press Ctrl+C to stop."
echo
exec node bridge.js "$WS_PORT" "${@:2}"
