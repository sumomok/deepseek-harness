/**
 * Reading a pack root from disk: one directory per pack, each holding the
 * `SKILL.md` that is both the skill and the manifest, plus the view files that
 * manifest declares.
 *
 * Nothing here judges a pack. It answers what the files say, including what
 * they failed to say, and `reconcile.ts` decides what that means.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/scan
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { parsePackManifest } from './manifest.ts'
import { compareCodeUnits } from './order.ts'
import type { PackObservation } from './reconcile.ts'
import type { PackViewResult } from './types.ts'
import { parsePackView } from './views.ts'
import { parseYamlMapping } from './yaml.ts'

/** The file that carries a pack's instructions and its manifest. */
export const PACK_ENTRY_FILE = 'SKILL.md'

/** One pack's directory name, skill name, entry file and body, as the root holds them. */
export interface PackSource extends PackObservation {
  /** Absolute path of the pack's own directory, which is also its skill resource base. */
  readonly directory: string
  /** Absolute path of the pack's `SKILL.md`. */
  readonly path: string
  /** The frontmatter `description` a skill catalog shows. */
  readonly description: string
  /** Optional frontmatter `whenToUse` routing guidance. */
  readonly whenToUse?: string
  /** The instruction body after the frontmatter, read in the same pass as the manifest. */
  readonly body: string
}

/** Frontmatter read off a `SKILL.md`, before anything has judged the manifest. */
interface Frontmatter {
  readonly data: Readonly<Record<string, unknown>>
  readonly body: string
}

/**
 * Split a `SKILL.md` into its YAML frontmatter and its instruction body.
 * @param raw - the file's complete text.
 * @returns the parsed frontmatter mapping and the body after it, or `undefined` when the file opens
 *   with no frontmatter block, closes none, or carries a YAML value that is not a mapping.
 */
export function readFrontmatter(raw: string): Frontmatter | undefined {
  const lines = raw.split('\n')
  if (lines[0]?.replace(/\r$/, '') !== '---') return undefined
  const closing = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/, '') === '---')
  if (closing < 0) return undefined
  // The frontmatter block is re-joined without its carriage returns because a
  // pack written on Windows would otherwise carry one into every parsed value.
  const parsed = parseYamlMapping(lines.slice(1, closing).map(line => line.replace(/\r$/, '')).join('\n'))
  if (parsed === undefined) return undefined
  return { data: parsed, body: lines.slice(closing + 1).join('\n') }
}

/**
 * Read one directory's `SKILL.md` into a pack source, including its declared views.
 * @param root - absolute pack root.
 * @param directoryName - the pack directory's own name inside the root.
 * @returns the pack source, or `undefined` when the directory holds no readable `SKILL.md` with a skill name and description.
 */
export async function readPack(root: string, directoryName: string): Promise<PackSource | undefined> {
  const directory = join(root, directoryName)
  const path = join(directory, PACK_ENTRY_FILE)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // Swallowed here and nowhere else: a root entry without a readable
    // SKILL.md is not a pack, and the caller lists the ones that are.
    return undefined
  }
  const frontmatter = readFrontmatter(raw)
  if (frontmatter === undefined) return undefined
  const skill = stringField(frontmatter.data, 'name')
  const description = stringField(frontmatter.data, 'description')
  if (skill === undefined || description === undefined || !isSkillName(skill)) return undefined
  const manifest = parsePackManifest(frontmatter.data.metadata)
  const views = manifest.ok ? await readViews(directory, manifest.manifest.views) : []
  const whenToUse = stringField(frontmatter.data, 'whenToUse')
  return {
    skill,
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    directory,
    path,
    body: frontmatter.body,
    manifest,
    views,
  }
}

/**
 * Read every pack directory in a pack root.
 * @param root - absolute pack root; an absent root holds no packs.
 * @returns one source per readable pack, in directory-name order by code unit.
 */
export async function readPackRoot(root: string): Promise<PackSource[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    // Swallowed here and nowhere else: a pack root that does not exist yet is
    // a deployment with no packs installed, which is a state, not a failure.
    return []
  }
  const packs: PackSource[] = []
  for (const entry of entries.filter(candidate => candidate.isDirectory()).sort((a, b) => compareCodeUnits(a.name, b.name))) {
    const pack = await readPack(root, entry.name)
    if (pack !== undefined) packs.push(pack)
  }
  return packs
}

/** Read each declared view file, in manifest order, keeping the pack-relative path each was declared under. */
async function readViews(directory: string, declared: readonly string[]): Promise<PackViewResult[]> {
  const results: PackViewResult[] = []
  for (const relative of declared) {
    results.push(await readView(directory, relative))
  }
  return results
}

/**
 * Read one declared view file. A path leaving the pack directory is refused
 * rather than followed: a pack names files inside itself, and a manifest is
 * runtime-installed data.
 */
async function readView(directory: string, relative: string): Promise<PackViewResult> {
  const resolved = resolve(directory, relative)
  if (resolved !== directory && !resolved.startsWith(directory + sep)) {
    return { ok: false, path: relative, reason: 'leaves the pack directory' }
  }
  let raw: string
  try {
    raw = await readFile(resolved, 'utf8')
  } catch (error) {
    return { ok: false, path: relative, reason: String(error) }
  }
  return parsePackView(relative, raw)
}

/** Read one frontmatter field that must be a non-empty string. */
function stringField(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
