#!/usr/bin/env bash
# Build the Go wasip1 command fixture used by test/command-plugin.mjs.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
artifact="$here/command.wasm"

cd "$here"
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o "$artifact" .
printf 'built %s\n' "$artifact"
