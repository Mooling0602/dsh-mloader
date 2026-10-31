/**
 * Standard stream isolation suite.
 *
 * The Python runtime owns the process standard streams. Plugin code must not
 * be able to send log content to the loader through print, sys.stderr, the
 * logging or warnings modules, os.write or a subprocess that inherits a
 * standard descriptor. Only ctx.logger reaches the loader logger.
 *
 * Every probe writes a unique marker. The suite asserts that the marker never
 * appears in the loader log, that no protocol warning appears, that the
 * protocol keeps working, and that ctx.logger still forwards, including from
 * a cleanup.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`)
  }
}

const section = (title) => console.log(`\n${title}`)

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until the predicate holds or the deadline passes. */
async function waitFor(predicate, timeoutMs = 20000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick(intervalMs)
  }
  return predicate()
}

/** Logger stub that records every call. */
function makeLogger() {
  const records = []
  const record = (level, args) => {
    records.push({ level, text: args.map((arg) => String(arg)).join(' ') })
    return logger
  }
  const logger = (...args) => record('trace', args)
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (...args) => record(level, args)
  }
  logger.records = records
  return logger
}

function systemPromptStub() {
  return {
    section: () => () => {},
    context: () => () => {},
    tools: () => () => {},
    variable: () => () => {},
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    suppressRuntimeContext: () => () => {},
    refreshContext: (assembly) => assembly,
    assemble: async () => ({ sections: [] }),
  }
}

/** Marker that must never reach the loader log. */
const LEAK = 'stream-leak-marker'

/** The plugin source the suite installs. */
const PLUGIN_SOURCE = `"""Plugin used by the standard stream isolation suite."""

import logging
import os
import subprocess
import sys
import warnings
from pathlib import Path

from dsh_mloader_sdk import plugin

LEAK = "${LEAK}"
CAPTURED_OUT = sys.stdout
CAPTURED_ERR = sys.stderr


@plugin
def apply(ctx):
    @ctx.tools.register(name="emit_everything", description="Write to every detached output route")
    def emit_everything(_args) -> dict:
        print(f"print-stdout {LEAK}")
        print(f"print-stderr {LEAK}", file=sys.stderr)
        sys.stdout.write(f"sys-stdout {LEAK}\\n")
        sys.stderr.write(f"sys-stderr {LEAK}\\n")
        sys.__stdout__.write(f"dunder-stdout {LEAK}\\n")
        sys.__stderr__.write(f"dunder-stderr {LEAK}\\n")
        sys.stdout.buffer.write(f"buffer-stdout {LEAK}\\n".encode())
        sys.stderr.buffer.write(f"buffer-stderr {LEAK}\\n".encode())
        CAPTURED_OUT.write(f"captured-stdout {LEAK}\\n")
        CAPTURED_ERR.write(f"captured-stderr {LEAK}\\n")
        os.write(1, f"fd1 {LEAK}\\n".encode())
        os.write(2, f"fd2 {LEAK}\\n".encode())
        os.write(os.dup(1), f"dup-fd1 {LEAK}\\n".encode())
        logger = logging.getLogger("probe")
        logger.addHandler(logging.StreamHandler(sys.stderr))
        logger.warning(f"logging {LEAK}")
        warnings.warn(f"warnings {LEAK}")
        subprocess.run([sys.executable, "-c", f"print('child {LEAK}')"], check=True)
        print('{"v":1,"id":999,"ok":true,"result":{}}')
        ctx.logger.info("ctx-logger-marker")
        return {"ok": True}

    @ctx.tools.register(name="read_stdin", description="Read one character from detached standard input")
    def read_stdin(_args) -> dict:
        return {"read": sys.stdin.read(1)}

    @ctx.tools.register(name="after_noise", description="Prove the protocol still works")
    def after_noise(_args) -> dict:
        return {"ok": True}

    ctx.effect.register(
        "cleanup",
        lambda: (
            print(f"cleanup {LEAK}"),
            sys.stderr.write(f"cleanup-stderr {LEAK}\\n"),
            ctx.logger.info("cleanup-log-marker"),
            Path(__file__).with_name("cleanup.marker").write_text("ran", encoding="utf-8"),
        ),
    )
`

/** Mount the loader on a fresh context with one temporary plugin root. */
async function mountLoader(rootPath, logger) {
  const root = new Context()
  root.provide('logger', logger)
  root.provide('systemPrompt', systemPromptStub())
  root.plugin(ToolRuntime, {})
  await tick(200)
  const tools = root.get('tools')
  const fiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      roots: [rootPath],
      profilePlugins: false,
      seedExamples: false,
      console: false,
      pythonBin: 'python3',
      watch: false,
    },
  )
  return { root, tools, fiber }
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'mloader-streams-'))
  const pluginRoot = join(tempRoot, 'plugins')
  const pluginDir = join(pluginRoot, 'stream-guard')
  const markerPath = join(pluginDir, 'cleanup.marker')
  try {
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'mloader.plugin.json'),
      JSON.stringify({
        id: 'stream-guard',
        name: 'Stream guard',
        version: '1.0.0',
        backend: 'python',
        entry: 'plugin.py',
        enabled: true,
        inject: ['tools'],
      }, null, 2),
    )
    await writeFile(join(pluginDir, 'plugin.py'), PLUGIN_SOURCE)

    const logger = makeLogger()
    const { root, tools, fiber } = await mountLoader(pluginRoot, logger)
    try {
      const mounted = await waitFor(() => (root.get('mloader')?.list() ?? [])
        .some((plugin) => plugin.id === 'stream-guard' && plugin.state === 'applied'))
      check('the plugin mounts', mounted,
        JSON.stringify(root.get('mloader')?.list() ?? []))

      /** Run one tool call, reporting a thrown error as a failed assertion. */
      const call = async (name, args = {}) => {
        try {
          return { value: await tools.get(name).execute(args) }
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      }

      section('1. Every direct output route is blocked')
      const emitted = await call('emit_everything')
      check('the noisy tool call succeeds', emitted.value?.ok === true,
        emitted.error ?? JSON.stringify(emitted.value))

      section('2. The protocol streams are private')
      const stdinRead = await call('read_stdin')
      check('standard input is detached and reads as empty', stdinRead.value?.read === '',
        stdinRead.error ?? JSON.stringify(stdinRead.value))
      const after = await call('after_noise')
      check('the protocol still round trips after the noise', after.value?.ok === true,
        after.error ?? JSON.stringify(after.value))

      section('3. Only ctx.logger reaches the loader logger')
      check('ctx.logger.info is forwarded', logger.records.some((record) =>
        record.level === 'info' && record.text.includes('ctx-logger-marker')),
        JSON.stringify(logger.records))
      check('ctx.logger.info is forwarded once', logger.records.filter((record) =>
        record.text.includes('ctx-logger-marker')).length === 1,
        JSON.stringify(logger.records))
      check('no direct output reaches the logger at any level',
        !logger.records.some((record) => record.text.includes(LEAK)),
        JSON.stringify(logger.records.filter((record) => record.text.includes(LEAK))))
      check('no non-protocol stdout warning is logged',
        !logger.records.some((record) => record.text.includes('non-protocol stdout')),
        JSON.stringify(logger.records.filter((record) => record.text.includes('non-protocol'))))
      check('the printed frame is not parsed as a protocol reply',
        !logger.records.some((record) => record.text.includes('reply for unknown id')),
        JSON.stringify(logger.records.filter((record) => record.text.includes('unknown id'))))
    } finally {
      await fiber.dispose()
      await tick(400)
    }

    section('4. Cleanup output is blocked, and its ctx.logger call still works')
    check('the cleanup ran', existsSync(markerPath))
    check('cleanup writes do not reach the loader logger',
      !logger.records.some((record) => record.text.includes(LEAK)),
      JSON.stringify(logger.records.filter((record) => record.text.includes(LEAK))))
    check('the cleanup log reaches the loader logger', logger.records.some((record) =>
      record.level === 'info' && record.text.includes('cleanup-log-marker')),
      JSON.stringify(logger.records))

    console.log('')
    if (failures.length === 0) {
      console.log(`PASS: ${passed} assertions`)
      process.exitCode = 0
    } else {
      console.log(`FAIL: ${failures.length} of ${passed + failures.length} assertions`)
      for (const failure of failures) console.log(`  - ${failure}`)
      process.exitCode = 1
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
