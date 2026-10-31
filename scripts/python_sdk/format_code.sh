#!/usr/bin/env bash
# Check or apply docformatter followed by ruff format to the Python SDK.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$root"
source_dir=src/runtime/python_sdk
if [[ -f "$source_dir/.venv/bin/activate" ]]; then
    source "$source_dir/.venv/bin/activate"
elif [[ -f "$source_dir/.venv/Scripts/activate" ]]; then
    source "$source_dir/.venv/Scripts/activate"
fi

if [[ $# -gt 1 || ( $# -eq 1 && $1 != --apply ) ]]; then
    printf 'Usage: %s [--apply]\n' "$0" >&2
    exit 2
fi
for tool in docformatter ruff; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        printf 'Missing required tool: %s\n' "$tool" >&2
        exit 1
    fi
done

run_docformatter() {
    local status=0
    docformatter --in-place -r "$1" --exclude .venv || status=$?
    if [[ $status -ne 0 && $status -ne 3 ]]; then
        printf 'docformatter failed with exit code %s\n' "$status" >&2
        return "$status"
    fi
}

# Run Ruff last so both formatters converge on blank lines.
if [[ ${1:-} == --apply ]]; then
    run_docformatter "$source_dir"
    ruff format --extend-exclude .venv "$source_dir"
    printf 'Formatted Python SDK docstrings and code.\n'
else
    tmp=$(mktemp -d "$root/.python-sdk-format.XXXXXXXX")
    case "$tmp" in
        "$root"/.python-sdk-format.*) ;;
        *) printf 'Unexpected temporary directory: %s\n' "$tmp" >&2; exit 1 ;;
    esac
    trap 'rm -rf -- "$tmp"' EXIT
    mkdir -p "$tmp/src/runtime/python_sdk"
    tar -C "$source_dir" --exclude=.venv -cf - . | tar -C "$tmp/src/runtime/python_sdk" -xf -
    run_docformatter "$tmp/src/runtime/python_sdk"
    ruff format --extend-exclude .venv "$tmp/src/runtime/python_sdk" >/dev/null
    if diff -ru --exclude=.venv --exclude=__pycache__ --exclude='*.pyc' "$source_dir" "$tmp/src/runtime/python_sdk"; then
        printf 'Python SDK formatting is converged.\n'
    else
        status=$?
        if [[ $status -ne 1 ]]; then
            exit "$status"
        fi
        printf 'Python SDK formatting differs. Run scripts/python_sdk/format_code.sh --apply to apply it.\n' >&2
        exit 1
    fi
fi
