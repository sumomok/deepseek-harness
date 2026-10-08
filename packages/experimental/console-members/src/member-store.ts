/**
 * Per-member non-secret storage: one JSON file per member and unit at
 * `dshHomePath('console-members', <directory id>, '<unit>.json')`.
 *
 * A write replaces the file whole through a temporary sibling and a rename,
 * with mode 0600 in a 0700 directory. A read of stored text that is not JSON
 * fails without quoting the text.
 * @module @deepseek-ai/dsh-experimental-console-members/src/member-store
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { MemberStore } from './types.ts'

/** The characters a unit name may use; the name becomes a file name. */
const UNIT_NAME = /^[a-z0-9-]+$/

/**
 * Refuse a unit name that is not lower-case letters, digits and `-`.
 * @param unit - the caller's name for its data.
 * @throws {Error} when the name is empty or has any other character.
 */
export function requireUnit(unit: string): void {
  if (!UNIT_NAME.test(unit)) {
    throw new Error(`console-members: a member store unit name uses only a-z, 0-9 and -, received ${JSON.stringify(unit)}`)
  }
}

/**
 * The store of one member directory and one unit.
 * @param directory - the member's directory id from the root registry.
 * @param unit - a unit name {@link requireUnit} accepted.
 * @returns the store.
 */
export function memberStoreAt(directory: string, unit: string): MemberStore {
  const file = dshHomePath('console-members', directory, `${unit}.json`)
  return {
    read: async () => {
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      try {
        return JSON.parse(text) as JsonValue
      } catch (_syntax) {
        // The parser's message quotes the stored text.
        throw new Error(`console-members: the stored ${unit} data is not valid JSON`)
      }
    },
    write: async (value) => {
      await writeFileAtomic(file, `${JSON.stringify(value)}\n`, { mode: 0o600, dirMode: 0o700 })
    },
  }
}
