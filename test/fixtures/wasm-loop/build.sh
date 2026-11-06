#!/usr/bin/env bash
# Build the Go wasip1 loop fixture used by test/wasm-safety.mjs.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
artifact="$here/loop.wasm"

cd "$here"
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o "$artifact" .
printf 'built %s\n' "$artifact"
