#!/usr/bin/env bash
# Run static checks for the Python SDK without modifying its source.
set -uo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$root" || exit 1
source_dir=src/runtime/python_sdk
if [[ -f "$source_dir/.venv/bin/activate" ]]; then
    source "$source_dir/.venv/bin/activate"
elif [[ -f "$source_dir/.venv/Scripts/activate" ]]; then
    source "$source_dir/.venv/Scripts/activate"
fi
status=0

for tool in ty ruff docformatter; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        printf 'Missing required tool: %s\n' "$tool" >&2
        status=1
    fi
done

printf 'Running ty check\n'
ty check --exclude '**/.venv/**' "$source_dir" || status=1

printf 'Running ruff check\n'
ruff check --extend-exclude .venv "$source_dir" || status=1

printf 'Running ruff format check\n'
ruff format --check --extend-exclude .venv "$source_dir" || status=1

printf 'Checking combined docstring and code formatting\n'
"$root/scripts/python_sdk/format_code.sh" || status=1

exit "$status"
