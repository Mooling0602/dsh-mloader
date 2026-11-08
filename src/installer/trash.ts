/**
 * Move an installed plugin directory out of the plugin roots.
 *
 * The package format uses the platform trash as the recovery window for an
 * update. This module implements the freedesktop.org trash layout on Linux, the
 * user Trash directory on macOS, and a temporary directory fallback elsewhere.
 * A directory that moves to the fallback does not survive a reboot.
 *
 * @module installer/trash
 */

import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/** Return the timestamp suffix used for one trashed entry. */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${date}${time}-${process.pid}`
}

/** Return the local deletion date the freedesktop trash info records. */
function deletionDate(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/** Move one path, falling back to a copy when the target is on another device. */
async function movePath(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error
    await cp(source, destination, { recursive: true, force: true, errorOnExist: false })
    await rm(source, { recursive: true, force: true })
  }
}

/** Move one path to the freedesktop.org trash, or return undefined off Linux. */
async function moveToXdgTrash(path: string): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const root = join(dataHome, 'Trash')
  const files = join(root, 'files')
  const info = join(root, 'info')
  await mkdir(files, { recursive: true })
  await mkdir(info, { recursive: true })
  const name = `${basename(path)}.${stamp()}`
  const destination = join(files, name)
  await movePath(path, destination)
  await writeFile(
    join(info, `${name}.trashinfo`),
    `[Trash Info]\nPath=${path}\nDeletionDate=${deletionDate()}\n`,
    'utf8',
  )
  return destination
}

/** Move one path to the macOS user Trash, or return undefined elsewhere. */
async function moveToMacTrash(path: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const root = join(homedir(), '.Trash')
  await mkdir(root, { recursive: true })
  const destination = join(root, `${basename(path)}.${stamp()}`)
  await movePath(path, destination)
  return destination
}

/** Move one path to the temporary fallback trash. */
async function moveToTemporaryTrash(path: string): Promise<string> {
  const root = join(tmpdir(), 'mloader-trash')
  await mkdir(root, { recursive: true })
  const destination = join(root, `${basename(path)}.${stamp()}`)
  await movePath(path, destination)
  return destination
}

/**
 * Move one path to the best available trash location.
 *
 * @param path - Absolute path to move.
 * @returns The destination path.
 * @throws {Error} When no trash location accepts the path.
 */
export async function moveToTrash(path: string): Promise<string> {
  const errors: string[] = []
  for (const mover of [moveToXdgTrash, moveToMacTrash]) {
    try {
      const destination = await mover(path)
      if (destination !== undefined) return destination
    } catch (error) {
      errors.push(messageOf(error))
    }
  }
  try {
    return await moveToTemporaryTrash(path)
  } catch (error) {
    errors.push(messageOf(error))
    throw new Error(
      `cannot move ${path} to the trash: ${errors.length > 0 ? errors.join('; ') : 'no writable trash directory'}`,
    )
  }
}

/** Return the message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
