/** Exercise the Python SDK maintenance scripts in an isolated fixture. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'mloader-sdk-scripts-'))
try {
  const scripts = join(root, 'scripts', 'python_sdk')
  const source = join(root, 'src', 'runtime', 'python_sdk')
  const bin = join(root, 'bin')
  const log = join(root, 'tools.log')
  await mkdir(scripts, { recursive: true })
  await mkdir(source, { recursive: true })
  await mkdir(bin, { recursive: true })
  await cp(join(repo, 'scripts', 'python_sdk'), scripts, { recursive: true })
  await writeFile(join(source, 'sample.py'), 'original\n')
  const tools = {
    uv: '#!/usr/bin/env bash\nprintf "uv %s\\n" "$*" >> "$TOOL_LOG"\nif [[ "$1" == venv ]]; then mkdir -p "$4/bin"; touch "$4/pyvenv.cfg"; printf "#!/usr/bin/env bash\\nexit 0\\n" > "$4/bin/python"; chmod +x "$4/bin/python"; fi\nexit "$UV_EXIT"\n',
    ty: '#!/usr/bin/env bash\nprintf "ty %s\\n" "$*" >> "$TOOL_LOG"\nexit "$TY_EXIT"\n',
    ruff: '#!/usr/bin/env bash\nprintf "ruff %s\\n" "$*" >> "$TOOL_LOG"\nexit "$RUFF_EXIT"\n',
    docformatter: '#!/usr/bin/env bash\nprintf "docformatter %s\\n" "$*" >> "$TOOL_LOG"\n[[ "$4" == --exclude && "$5" == .venv ]] || exit 19\nif [[ "$3" == *python-sdk-format* && -e "$3/.venv" ]]; then exit 20; fi\nif [[ "$CHANGE" == 1 ]]; then printf "formatted\\n" > "$3/sample.py"; fi\nexit "$DOC_EXIT"\n',
  }
  for (const [name, content] of Object.entries(tools)) {
    await writeFile(join(bin, name), content)
    await chmod(join(bin, name), 0o755)
  }
  function run(script, args = [], extra = {}) {
    return spawnSync(join(scripts, script), args, {
      cwd: tmpdir(), encoding: 'utf8',
      env: { ...process.env, TY_EXIT: '0', RUFF_EXIT: '0', DOC_EXIT: '0', UV_EXIT: '0', CHANGE: '0', ...extra, TOOL_LOG: log, PATH: bin + ':' + process.env.PATH },
    })
  }
  const venv = join(source, '.venv')
  await mkdir(venv)
  await writeFile(join(venv, 'sentinel.py'), 'untouched\n')
  let result = run('format_code.sh', [], { CHANGE: '1', DOC_EXIT: '3' })
  assert.equal(result.status, 1, result.stderr)
  assert.equal(await readFile(join(source, 'sample.py'), 'utf8'), 'original\n')
  assert.match(result.stdout, /formatted/)
  assert.equal((await readdir(root)).filter(name => name.startsWith('.python-sdk-format.')).length, 0)

  result = run('format_code.sh', ['--apply'], { CHANGE: '1', DOC_EXIT: '3' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(join(source, 'sample.py'), 'utf8'), 'formatted\n')
  assert.equal(await readFile(join(venv, 'sentinel.py'), 'utf8'), 'untouched\n')
  result = run('format_code.sh', ['--unknown'])
  assert.equal(result.status, 2)
  result = run('format_code.sh', [], { DOC_EXIT: '4' })
  assert.equal(result.status, 4)
  assert.equal((await readdir(root)).filter(name => name.startsWith('.python-sdk-format.')).length, 0)

  await writeFile(log, '')
  result = run('check_code.sh', [], { TY_EXIT: '2' })
  assert.equal(result.status, 1)
  const calls = await readFile(log, 'utf8')
  assert.match(calls, /ty check --exclude .*\.venv.* src\/runtime\/python_sdk/)
  assert.match(calls, /ruff check --extend-exclude \.venv src\/runtime\/python_sdk/)
  assert.match(calls, /ruff format --check --extend-exclude \.venv src\/runtime\/python_sdk/)
  assert.match(calls, /docformatter --in-place -r/)
  assert.ok(calls.indexOf('docformatter') < calls.lastIndexOf('ruff format '))
  const venvBin = join(venv, 'bin')
  await mkdir(venvBin)
  await writeFile(join(venvBin, 'activate'), 'export PATH="${BASH_SOURCE[0]%/*}:$PATH"\n')
  for (const name of ['ty', 'ruff', 'docformatter']) {
    const wrapper = join(venvBin, name)
    await writeFile(wrapper, `#!/usr/bin/env bash\nprintf "venv ${name}\\n" >> "$TOOL_LOG"\nexec "${bin}/${name}" "$@"\n`)
    await chmod(wrapper, 0o755)
  }
  for (const script of ['check_code.sh', 'format_code.sh']) {
    await writeFile(log, '')
    result = run(script)
    assert.equal(result.status, 0, result.stderr)
    const activatedCalls = await readFile(log, 'utf8')
    assert.match(activatedCalls, /venv ruff/)
    assert.match(activatedCalls, /venv docformatter/)
    if (script === 'check_code.sh') assert.match(activatedCalls, /venv ty/)
  }
  await writeFile(log, '')
  result = run('init_env.sh', ['--unknown'])
  assert.equal(result.status, 2)
  result = run('init_env.sh')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Refusing to replace/)
  await rm(venv, { recursive: true })
  result = run('init_env.sh')
  assert.equal(result.status, 0, result.stderr)
  result = run('init_env.sh')
  assert.equal(result.status, 0, result.stderr)
  const initCalls = await readFile(log, 'utf8')
  assert.equal((initCalls.match(/uv venv /g) ?? []).length, 1)
  assert.equal((initCalls.match(/uv pip install /g) ?? []).length, 2)
  assert.match(initCalls, /ty ruff docformatter/)
  console.log('Python SDK maintenance script tests passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
