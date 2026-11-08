/**
 * Installation of dsh-mloader plugin packages.
 *
 * WebAssembly packages are installed in this process: the archive is extracted
 * into a staging directory outside the watched plugin root, the install index
 * is written, and the staging directory replaces the installed one after the
 * previous installation moved to the trash. Python packages are delegated to
 * the Python runtime command line, which owns the requirements merge and the
 * shared environment of a profile.
 *
 * @module installer/install
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { expandHome } from '../contract.js'
import { PYTHON_CLI_SCRIPT } from '../python-env.js'
import { withShellPath } from '../shell-path.js'
import type { BackendKind, LoaderLogger } from '../types.js'
import {
  INDEX_NAME,
  INDEX_SCHEMA_VERSION,
  MANIFEST_NAME,
  openPackage,
  PackageError,
  type OpenedPackage,
} from './package.js'
import { moveToTrash } from './trash.js'

/** Timeout for one Python command line invocation. */
const DEFAULT_TIMEOUT_MS = 300_000

/** Maximum stdout or stderr text kept from one Python invocation. */
const MAX_CAPTURE_CHARS = 64 * 1024

/** State of one installation attempt. */
export type InstallStatus = 'installed' | 'updated' | 'needs-confirmation' | 'failed'

/** Outcome of installing one package. */
export interface InstallResult {
  /** Path as the caller supplied it. */
  path: string
  /** What happened to the package. */
  status: InstallStatus
  /** Plugin id, when the manifest was readable. */
  id?: string
  /** Manifest version, when the manifest was readable. */
  version?: string
  /** Backend that installed the package, when it was detected. */
  backend?: BackendKind
  /** Installed directory, when the installation succeeded. */
  directory?: string
  /** Problems worth showing to the operator. */
  warnings: string[]
  /** Failure reason, or the confirmation reasons of a pending package. */
  message?: string
}

/** The install index one installed plugin directory carries. */
export interface InstallIndex {
  /** Version of the index format. */
  schemaVersion: number
  /** Plugin id, equal to the manifest id. */
  id: string
  /** ISO 8601 timestamp of the first installation. */
  installedAt: string
  /** ISO 8601 timestamp of the most recent installation or update. */
  updatedAt: string
  /** File name of the archive the plugin was installed from. */
  packageFile: string
  /** Lowercase hexadecimal MD5 of the archive file. */
  packageMd5: string
  /** Map from a path relative to the plugin directory to the file MD5. */
  fileMd5: Record<string, string>
}

/** Outcome of one spawned command. */
export interface CommandOutcome {
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
  /** Exit code, or null when the process did not exit normally. */
  code: number | null
  /** True when the process was killed because it exceeded the deadline. */
  timedOut: boolean
}

/** Runner used for the Python package path, injectable for tests. */
export type PythonInstallRunner = (
  args: string[],
  options: { timeoutMs: number },
) => Promise<CommandOutcome>

/** Options of one package installer. */
export interface InstallerOptions {
  /** Profile directory. Required; installation targets the profile plugin root. */
  profileDir?: string
  /** Plugin directory. Defaults to <profile>/mloader/plugins. */
  pluginsDir?: string
  /** Base Python interpreter used by the Python command line. */
  pythonBin: string
  /** Extra executable search directories for child processes. */
  shellPath?: readonly string[]
  /** Logger for debug output. */
  logger?: LoaderLogger
  /** Timeout for one Python installation. Defaults to five minutes. */
  timeoutMs?: number
  /** Command runner override, for tests. */
  pythonRunner?: PythonInstallRunner
}

/** Options of one install call. */
export interface InstallCallOptions {
  /** Replace an identical archive or an edited installation. */
  force?: boolean
}

/** Installer the command group calls. */
export interface PackageInstaller {
  /** Install several packages sequentially, continuing after a failure. */
  install(paths: string[], options?: InstallCallOptions): Promise<InstallResult[]>
  /** Install one package. */
  installOne(path: string, options?: InstallCallOptions): Promise<InstallResult>
}

/** The resolved state of a target directory before installing. */
interface Preflight {
  target: string
  existing: boolean
  index: Record<string, unknown> | undefined
  needsConfirmation: boolean
  reasons: string[]
}

/** Return the message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Return true when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Return an ISO 8601 timestamp with second precision. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z')
}

/** Return the lowercase hexadecimal MD5 of one file, streamed. */
async function md5OfFile(path: string): Promise<string> {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** Return the file checksums of one directory, excluding the install index. */
async function directoryMd5(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const relative = absolute.slice(directory.length + 1).split(sep).join('/')
      if (relative === INDEX_NAME) continue
      result[relative] = await md5OfFile(absolute)
    }
  }
  await walk(directory)
  const sorted: Record<string, string> = {}
  for (const key of Object.keys(result).sort()) sorted[key] = result[key] as string
  return sorted
}

/** Return a stable index serialization, sorted like the Python implementation. */
function serializeIndex(index: InstallIndex): string {
  const payload: Record<string, unknown> = {
    fileMd5: index.fileMd5,
    id: index.id,
    installedAt: index.installedAt,
    packageFile: index.packageFile,
    packageMd5: index.packageMd5,
    schemaVersion: index.schemaVersion,
    updatedAt: index.updatedAt,
  }
  return JSON.stringify(payload, null, 2) + '\n'
}

/** Read one install index, returning undefined when the file does not exist. */
async function readInstallIndex(directory: string): Promise<Record<string, unknown> | undefined> {
  const path = join(directory, INDEX_NAME)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT') return undefined
    throw new PackageError(`cannot read the install index ${path}: ${messageOf(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new PackageError(`cannot read the install index ${path}: ${messageOf(error)}`)
  }
  if (!isRecord(parsed)) {
    throw new PackageError(`the install index ${path} must be a JSON object`)
  }
  return parsed
}

/** Return the names of installed files that changed after the installation. */
async function changedFiles(directory: string, fileMd5: unknown): Promise<string[]> {
  if (!isRecord(fileMd5)) return []
  const changed: string[] = []
  for (const [relative, expected] of Object.entries(fileMd5)) {
    if (typeof expected !== 'string') continue
    const parts = relative.split('/')
    if (
      relative.length === 0 ||
      relative.startsWith('/') ||
      parts.some((part) => part === '' || part === '.' || part === '..')
    ) {
      continue
    }
    const absolute = join(directory, ...parts)
    try {
      const info = await stat(absolute)
      if (!info.isFile() || (await md5OfFile(absolute)) !== expected.toLowerCase()) {
        changed.push(relative)
      }
    } catch {
      changed.push(relative)
    }
  }
  return changed
}

/** Return the nested manifest prefixes that an extraction must skip. */
function nestedPrefixes(packageDir: { entries: readonly { name: string }[] }): string[] {
  const prefixes: string[] = []
  for (const entry of packageDir.entries) {
    if (entry.name === MANIFEST_NAME) continue
    if (entry.name.endsWith('/' + MANIFEST_NAME)) {
      prefixes.push(entry.name.slice(0, -MANIFEST_NAME.length))
    }
  }
  return prefixes
}

/** Resolve and check the installation state of one target directory. */
async function preflightInstall(
  pluginsDir: string,
  opened: OpenedPackage,
): Promise<Preflight> {
  const target = join(pluginsDir, opened.manifest.id)
  let info
  try {
    info = await lstat(target)
  } catch {
    info = undefined
  }
  if (info === undefined) {
    return { target, existing: false, index: undefined, needsConfirmation: false, reasons: [] }
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PackageError(`${target} exists and is not a plugin directory`)
  }
  const index = await readInstallIndex(target)
  if (index === undefined) {
    return {
      target,
      existing: true,
      index: undefined,
      needsConfirmation: true,
      reasons: [`${target} exists without an install index`],
    }
  }
  const version = index.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version > INDEX_SCHEMA_VERSION) {
    throw new PackageError(
      `${target} was installed by a newer loader (schemaVersion=${JSON.stringify(version)}); refusing to replace it`,
    )
  }
  if (index.packageMd5 === opened.archiveMd5) {
    return {
      target,
      existing: true,
      index,
      needsConfirmation: true,
      reasons: [`${opened.path} is already installed at ${target}`],
    }
  }
  const changed = await changedFiles(target, index.fileMd5)
  if (changed.length > 0) {
    return {
      target,
      existing: true,
      index,
      needsConfirmation: true,
      reasons: [
        `${target} has files changed after installation (${changed.slice(0, 5).join(', ')})`,
      ],
    }
  }
  return { target, existing: true, index, needsConfirmation: false, reasons: [] }
}

/** Extract one opened archive into one staging directory. */
async function extractPackage(opened: OpenedPackage, staging: string): Promise<void> {
  const skipped = nestedPrefixes(opened.archive)
  const entries = [...opened.archive.entries].sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (entry.name === INDEX_NAME) continue
    if (skipped.some((prefix) => entry.name.startsWith(prefix))) continue
    const target = join(staging, ...entry.name.replace(/\/+$/u, '').split('/'))
    if (!resolve(target).startsWith(resolve(staging) + sep)) {
      throw new PackageError(`the archive entry ${JSON.stringify(entry.name)} escapes the plugin directory`)
    }
    if (entry.directory) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, opened.archive.read(entry))
  }
  const entry = join(staging, opened.manifest.entry)
  try {
    const info = await stat(entry)
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    throw new PackageError(
      `the manifest entry ${JSON.stringify(opened.manifest.entry)} was not extracted`,
    )
  }
}

/** Install one WebAssembly package into the profile plugin directory. */
async function installWasm(
  opened: OpenedPackage,
  preflight: Preflight,
  pluginsDir: string,
  logger: LoaderLogger | undefined,
): Promise<InstallResult> {
  await mkdir(pluginsDir, { recursive: true })
  const stagingParent = dirname(pluginsDir)
  await mkdir(stagingParent, { recursive: true })
  let staging: string | undefined
  try {
    staging = await mkdtemp(join(stagingParent, `.mloader-${opened.manifest.id}-`))
    await extractPackage(opened, staging)
    const oldInstalledAt = preflight.index?.installedAt
    const installedAt = typeof oldInstalledAt === 'string' && oldInstalledAt.length > 0
      ? oldInstalledAt
      : nowIso()
    const index: InstallIndex = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      id: opened.manifest.id,
      installedAt,
      updatedAt: nowIso(),
      packageFile: basename(opened.path),
      packageMd5: opened.archiveMd5,
      fileMd5: await directoryMd5(staging),
    }
    await writeFile(join(staging, INDEX_NAME), serializeIndex(index), 'utf8')

    if (preflight.existing) {
      const trashed = await moveToTrash(preflight.target)
      try {
        await rename(staging, preflight.target)
      } catch (error) {
        await rename(trashed, preflight.target).catch(() => undefined)
        throw error
      }
    } else {
      await rename(staging, preflight.target)
    }
    staging = undefined
    const status = preflight.existing ? 'updated' : 'installed'
    logger?.debug?.(`dsh-mloader: ${status} ${opened.manifest.id} at ${preflight.target}`)
    return {
      path: opened.path,
      status,
      id: opened.manifest.id,
      version: opened.manifest.version,
      backend: 'wasm',
      directory: preflight.target,
      warnings: opened.warnings,
    }
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Keep a capture buffer bounded while appending one chunk. */
function appendCapped(current: string, chunk: string): string {
  const next = current + chunk
  return next.length > MAX_CAPTURE_CHARS ? next.slice(0, MAX_CAPTURE_CHARS) : next
}

/** Run the Python command line with captured output and a deadline. */
async function runPythonCommand(args: string[], options: InstallerOptions): Promise<CommandOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return await new Promise<CommandOutcome>((resolvePromise, reject) => {
    const child = spawn(options.pythonBin, args, {
      env: withShellPath(process.env, options.shellPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout = appendCapped(stdout, chunk.toString('utf8')) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendCapped(stderr, chunk.toString('utf8')) })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`cannot run the Python command line: ${messageOf(error)}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ stdout, stderr, code, timedOut })
    })
  })
}

/** Install one Python package through the Python runtime command line. */
async function installPython(
  opened: OpenedPackage,
  preflight: Preflight,
  options: InstallerOptions,
  force: boolean,
  pluginsDir: string,
  profileDir: string | undefined,
): Promise<InstallResult> {
  const args = [PYTHON_CLI_SCRIPT, 'install', opened.path, '--plugins-dir', pluginsDir, '--python', options.pythonBin, '--json']
  if (profileDir !== undefined) args.push('--profile', profileDir)
  if (force) args.push('--force')
  const runner = options.pythonRunner ?? ((commandArgs) => runPythonCommand(commandArgs, options))
  const outcome = await runner(args, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  if (outcome.timedOut) {
    throw new PackageError(`installing ${opened.path} timed out`)
  }
  if (outcome.code !== 0) {
    const lines = outcome.stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
    const detail = lines.length > 0 ? lines[lines.length - 1] as string : `exit code ${outcome.code}`
    throw new PackageError(detail.replace(/^error:\s*/u, ''))
  }
  const last = outcome.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0).pop()
  if (last === undefined) {
    throw new PackageError('the Python command line returned no install result')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(last)
  } catch (error) {
    throw new PackageError(`the Python command line returned an invalid install result: ${messageOf(error)}`)
  }
  if (!isRecord(parsed)) {
    throw new PackageError('the Python command line returned an invalid install result')
  }
  const warnings = [
    ...opened.warnings,
    ...(Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []),
  ]
  const status = parsed.updated === true ? 'updated' : 'installed'
  return {
    path: opened.path,
    status,
    id: typeof parsed.id === 'string' ? parsed.id : opened.manifest.id,
    version: typeof parsed.version === 'string' ? parsed.version : opened.manifest.version,
    backend: 'python',
    directory: typeof parsed.directory === 'string' ? parsed.directory : preflight.target,
    warnings,
  }
}

/**
 * Create the package installer the command group uses.
 *
 * The installer never trusts an archive and never executes plugin code.
 * WebAssembly packages are installed by this module; Python packages are
 * delegated to the Python runtime command line, which owns the requirements
 * merge and the shared environment.
 *
 * @param options - Profile, plugin directory, interpreter and logger.
 * @returns The installer, whose install calls never throw for a package failure.
 */
export function createPackageInstaller(options: InstallerOptions): PackageInstaller {
  const pluginsDir = options.pluginsDir
  const installer: PackageInstaller = {
    async install(paths: string[], callOptions: InstallCallOptions = {}): Promise<InstallResult[]> {
      const results: InstallResult[] = []
      for (const path of paths) {
        results.push(await installer.installOne(path, callOptions))
      }
      return results
    },
    async installOne(path: string, callOptions: InstallCallOptions = {}): Promise<InstallResult> {
      const force = callOptions.force === true
      try {
        if (pluginsDir === undefined || pluginsDir.length === 0) {
          throw new PackageError(
            'the profile plugin directory is unknown; the loader cannot install a package',
          )
        }
        const opened = await openPackage(resolve(expandHome(path)))
        const preflight = await preflightInstall(pluginsDir, opened)
        if (preflight.needsConfirmation && !force) {
          return {
            path,
            status: 'needs-confirmation',
            id: opened.manifest.id,
            version: opened.manifest.version,
            backend: opened.backend,
            warnings: opened.warnings,
            message: preflight.reasons.join('; '),
          }
        }
        const result = opened.backend === 'python'
          ? await installPython(opened, preflight, options, force, pluginsDir, options.profileDir)
          : await installWasm(opened, preflight, pluginsDir, options.logger)
        return { ...result, path }
      } catch (error) {
        return {
          path,
          status: 'failed',
          warnings: [],
          message: messageOf(error),
        }
      }
    },
  }
  return installer
}
