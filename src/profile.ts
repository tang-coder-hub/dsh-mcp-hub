/**
 * Profile discovery and managed-block IO.
 *
 * `resolveProfileDir` exists because the desktop host does **not** export
 * `DSH_PROFILE_DIR` to itself — the app receives its profile directory as a
 * command-line argument. Falling back to a hard-coded profile name would
 * silently edit the wrong profile, so every step records where it came from
 * and the source is surfaced in the UI.
 *
 * @module dsh-mcp-hub/profile
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BLOCK_BEGIN, BLOCK_END } from './constants'

/** Where the harness home and the active profile directory are. */
export interface ProfileLocations {
  home: string
  dataDir: string
  storeFile: string
  profileDir: string
  patchFile: string
  /** How {@link profileDir} was determined; shown in the UI. */
  profileSource: 'DSH_PROFILE_DIR' | 'argv' | 'DSH_PROFILE' | 'default-name' | 'fallback'
}

/** Where a profile directory was found, and how. */
export interface ProfileResolution {
  dir: string
  source: ProfileLocations['profileSource']
}

/** Resolve the harness home without importing `@deepseek-ai/dsh-home-paths`. */
export function resolveHome(): string {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** Whether a directory carries a patch layer we could edit. */
function hasPatch(candidate: string): boolean {
  try {
    return existsSync(join(candidate, 'cordis.patch.yml'))
  } catch {
    return false
  }
}

/**
 * Find the profile directory whose patch layer this page should edit.
 *
 * Resolution order: `DSH_PROFILE_DIR` → the desktop host's command-line
 * arguments → `DSH_PROFILE` → well-known profile names. Each fallback is
 * recorded so a wrong guess is visible in the UI instead of silent.
 */
export function resolveProfileDir(home: string): ProfileResolution {
  const profilesRoot = join(home, 'profiles')

  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && hasPatch(fromEnv)) {
    return { dir: fromEnv, source: 'DSH_PROFILE_DIR' }
  }

  // The desktop host is launched as: <exe> … <dshDir> <profileDir> <runtime> …
  for (const argument of process.argv) {
    if (typeof argument !== 'string' || argument.length === 0) continue
    let candidate: string
    try {
      candidate = resolve(argument)
    } catch {
      continue
    }
    if (candidate.startsWith(profilesRoot) && hasPatch(candidate)) {
      return { dir: candidate, source: 'argv' }
    }
  }

  const named = process.env.DSH_PROFILE
  if (typeof named === 'string' && named.length > 0) {
    const candidate = join(profilesRoot, named)
    if (hasPatch(candidate)) return { dir: candidate, source: 'DSH_PROFILE' }
  }

  for (const candidate of [join(profilesRoot, 'desktop'), join(profilesRoot, 'web')]) {
    if (hasPatch(candidate)) return { dir: candidate, source: 'default-name' }
  }
  return { dir: join(profilesRoot, 'web'), source: 'fallback' }
}

/** Resolve every location this page reads and writes. */
export function resolveLocations(): ProfileLocations {
  const home = resolveHome()
  const dataDir = join(home, 'mcp-hub')
  const storeFile = join(dataDir, 'servers.json')
  const { dir: profileDir, source: profileSource } = resolveProfileDir(home)
  return { home, dataDir, storeFile, profileDir, patchFile: join(profileDir, 'cordis.patch.yml'), profileSource }
}

/** Read the profile patch text (empty when absent). */
export function readPatch(patchFile: string): string {
  try {
    return existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  } catch {
    return ''
  }
}

/** Atomically write text over a file, creating parent directories. */
export function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** Remove a previously managed block, if present. */
export function stripBlock(text: string, beginMarker: string, endMarker: string): string {
  const start = text.indexOf(beginMarker)
  if (start < 0) return text
  const end = text.indexOf(endMarker, start)
  if (end < 0) return text.slice(0, start)
  return text.slice(0, start) + text.slice(end + endMarker.length)
}
