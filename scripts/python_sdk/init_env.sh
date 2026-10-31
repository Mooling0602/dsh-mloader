#!/usr/bin/env bash
# Initialize the Python SDK development environment and its maintenance tools.
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
venv="$root/src/runtime/python_sdk/.venv"

if [[ $# -ne 0 ]]; then
    printf 'Usage: %s\n' "$0" >&2
    exit 2
fi
if ! command -v uv >/dev/null 2>&1; then
    printf 'Missing required tool: uv\n' >&2
    exit 1
fi

if [[ -e "$venv" || -L "$venv" ]]; then
    if [[ ! -f "$venv/pyvenv.cfg" ]]; then
        printf 'Refusing to replace a non-virtual environment: %s\n' "$venv" >&2
        exit 1
    fi
else
    uv venv --python '>=3.10' "$venv"
fi

if [[ -x "$venv/bin/python" ]]; then
    python="$venv/bin/python"
    activate="$venv/bin/activate"
elif [[ -f "$venv/Scripts/python.exe" ]]; then
    python="$venv/Scripts/python.exe"
    activate="$venv/Scripts/activate"
else
    printf 'The virtual environment has no Python interpreter: %s\n' "$venv" >&2
    exit 1
fi
"$python" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || {
    printf 'The Python SDK requires Python 3.10 or later: %s\n' "$python" >&2
    exit 1
}
uv pip install --python "$python" ty ruff docformatter
printf 'Python SDK development environment is ready: %s\n' "$venv"
printf 'Activate it with: source "%s"\n' "$activate"
