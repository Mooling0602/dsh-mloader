/**
 * Shared Python environment of one dsh profile.
 *
 * Every Python plugin hosted from a profile runs in one virtual environment at
 * <profile>/mloader/.venv. The environment is created with uv and the
 * dependencies a plugin declares in pyproject.toml are installed into it. A
 * plugin that ships only requirements.txt is installed with the venv module and
 * pip instead, and reports a warning.
 *
 * The Python runtime owns the dependency rules. This module runs its command
 * line before a Python plugin starts and returns the interpreter the backend
 * must use.
 *
 * @module python-env
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoaderLogger } from './types.js'

/** Command line script of the Python runtime, beside this compiled module. */
export const PYTHON_CLI_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  'runtime',
  'python_sdk',
  'run_cli.py',
)

/** How the shared environment is managed for one plugin. */
export type PythonEnvironmentMode = 'uv' | 'python-venv' | 'none'

/** Result of preparing the shared environment for one plugin. */
export interface PythonEnvironment {
  /** Interpreter inside the shared virtual environment. */
  python: string
  /** Virtual environment directory. */
  venv: string
  /** Dependency manager that prepared the environment. */
  mode: PythonEnvironmentMode
  /** Dependencies the plugin declared, after the requirements merge. */
  dependencies: string[]
  /** Non fatal problems worth showing to the operator. */
  warnings: string[]
}

/** Options of {@link syncPythonEnvironment}. */
export interface PythonEnvironmentOptions {
  /** Profile directory. The environment is profile scoped, so it is required. */
  profileDir?: string
  /** Base interpreter used to create the environment and run the CLI. */
  pythonBin: string
  /** Logger for debug output. */
  logger?: LoaderLogger
  /** Deadline for environment setup. Defaults to five minutes. */
  timeoutMs?: number
}

/** Timeout used when the caller supplies none. */
const DEFAULT_TIMEOUT_MS = 300_000

/** Maximum stdout or stderr text kept from the CLI. */
const MAX_CAPTURE_CHARS = 64 * 1024

/** Outcome of one subprocess. */
interface CommandOutcome {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

/**
 * Return the shared environment directory of one profile.
 *
 * @param profileDir - Profile directory.
 * @returns Absolute environment directory, whether or not it exists.
 */
export function sharedVenvDir(profileDir: string): string {
  return join(profileDir, 'mloader', '.venv')
}

/**
 * Return the shared interpreter path of one profile.
 *
 * @param profileDir - Profile directory.
 * @returns Absolute interpreter path, whether or not it exists.
 */
export function sharedVenvPython(profileDir: string): string {
  return process.platform === 'win32'
    ? join(sharedVenvDir(profileDir), 'Scripts', 'python.exe')
    : join(sharedVenvDir(profileDir), 'bin', 'python')
}

/**
 * Prepare the shared environment for one plugin and return the interpreter.
 *
 * Without a profile directory the loader falls back to the configured
 * interpreter and performs no environment management, because an environment
 * belongs to a profile.
 *
 * @param pluginDir - Absolute plugin directory.
 * @param options - Profile, base interpreter, logger and deadline.
 * @returns The shared environment, or undefined when no profile is known.
 * @throws {Error} When the CLI cannot run, fails, times out or returns an
 *   invalid result.
 */
export async function syncPythonEnvironment(
  pluginDir: string,
  options: PythonEnvironmentOptions,
): Promise<PythonEnvironment | undefined> {
  const { profileDir, pythonBin, logger, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  if (profileDir === undefined || profileDir.length === 0) {
    logger?.debug?.(
      'dsh-mloader: no profile detected; Python plugins use the configured interpreter ' +
      'without a shared virtual environment',
    )
    return undefined
  }
  if (!existsSync(PYTHON_CLI_SCRIPT)) {
    throw new Error('python runtime command line not found: ' + PYTHON_CLI_SCRIPT)
  }

  const args = [
    '-u',
    PYTHON_CLI_SCRIPT,
    'env',
    'sync',
    '--profile',
    profileDir,
    '--plugin',
    pluginDir,
    '--python',
    pythonBin,
    '--json',
  ]
  // Once the environment exists, its interpreter runs the CLI too, so a
  // changed pythonBin does not affect an established environment.
  const interpreter = existsSync(sharedVenvPython(profileDir))
    ? sharedVenvPython(profileDir)
    : pythonBin
  const outcome = await runCommand(interpreter, args, timeoutMs)
  if (outcome.timedOut) {
    throw new Error('python environment setup timed out after ' + String(timeoutMs) + 'ms')
  }
  const detail = (outcome.stderr || outcome.stdout).trim()
  if (outcome.code !== 0) {
    throw new Error(
      'python environment setup failed (exit ' + String(outcome.code) + ')' +
      (detail ? ': ' + tail(detail) : ''),
    )
  }

  const payload = parsePayload(outcome.stdout)
  if (payload === undefined || typeof payload.python !== 'string' || payload.python.length === 0) {
    throw new Error('python environment setup returned no interpreter: ' + tail(outcome.stdout))
  }
  if (!existsSync(payload.python)) {
    throw new Error('python environment interpreter not found: ' + payload.python)
  }

  const mode = payload.mode
  return {
    python: payload.python,
    venv: typeof payload.venv === 'string' ? payload.venv : sharedVenvDir(profileDir),
    mode: mode === 'uv' || mode === 'python-venv' || mode === 'none' ? mode : 'none',
    dependencies: Array.isArray(payload.dependencies)
      ? payload.dependencies.filter((item): item is string => typeof item === 'string')
      : [],
    warnings: Array.isArray(payload.warnings)
      ? payload.warnings.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

/**
 * Parse the last JSON object line the Python CLI wrote to stdout.
 *
 * @param stdout - Captured standard output.
 * @returns The result object, or undefined when no line parses.
 */
function parsePayload(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = (lines[index] ?? '').trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // A non-JSON line is not the result. Keep looking for the result line.
    }
  }
  return undefined
}

/**
 * Run one subprocess and capture a bounded tail of both output streams.
 *
 * @param command - Executable.
 * @param args - Arguments.
 * @param timeoutMs - Deadline after which the process is killed.
 * @returns The exit status and captured output.
 */
function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        windowsHide: true,
      })
    } catch (error: unknown) {
      reject(new Error('cannot run ' + command + ': ' + messageOf(error)))
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = tail(stdout + chunk)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = tail(stderr + chunk)
    })

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // The process already exited.
      }
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('cannot run ' + command + ': ' + error.message))
    })

    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut })
    })
  })
}

/**
 * Keep only the last MAX_CAPTURE_CHARS characters.
 *
 * @param text - Captured text.
 * @returns The tail of the text.
 */
function tail(text: string): string {
  return text.length > MAX_CAPTURE_CHARS ? text.slice(text.length - MAX_CAPTURE_CHARS) : text
}

/**
 * Return the message of an unknown thrown value.
 *
 * @param error - Caught value.
 * @returns A message safe to log.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
