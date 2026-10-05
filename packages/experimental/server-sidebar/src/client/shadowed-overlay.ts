/**
 * Reading the `shell.overlay` entries this package shadows.
 *
 * `shell.overlay` is a list slot whose cell is the entry id, and only a cell's
 * lowest-priority entry renders (`SlotCore.register`'s shadowing rule). This
 * package registers its own entry under another package's id at
 * {@link REPLACING_PRIORITY}, so the owner's entry never mounts, while the
 * owner's inject face still carries the state and actions the replacement
 * draws from. The ledger erases that face's types, so each reader checks the
 * members it reads; a face missing one reads as no entry at all.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/shadowed-overlay
 */
import type { HostObservable, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Shadowing rank of the entries this package registers in place of another
 * package's — its `shell.overlay` entries and the conversation header's
 * corner: below the owners' default 0.
 */
export const REPLACING_PRIORITY = -1

/** The share of the slot ledger a shadowed entry is read from. */
export interface OverlayLedger {
  /**
   * Every entry registered into the slot, shadowed ones included.
   * @param key - the slot key.
   * @returns the entries.
   */
  entries(key: 'shell.overlay'): readonly StoredEntry[]
  /**
   * Follow the slot's registrations.
   * @param key - the slot key.
   * @param fn - called after each change.
   * @returns the unsubscribe.
   */
  subscribe(key: 'shell.overlay', fn: () => void): () => void
}

/**
 * Whether a value is an observable snapshot source.
 * @param value - the candidate.
 * @returns true when it carries `getSnapshot` and `subscribe` functions.
 */
function isObservable(value: unknown): value is HostObservable<unknown> {
  return typeof value === 'object' && value !== null
    && 'getSnapshot' in value && typeof value.getSnapshot === 'function'
    && 'subscribe' in value && typeof value.subscribe === 'function'
}

/**
 * Whether a face member is a function its reader invokes with no argument.
 * @param value - the candidate.
 * @returns true for any function.
 */
export function isAction(value: unknown): value is () => unknown {
  return typeof value === 'function'
}

/**
 * Whether a face member is a function its reader invokes with a conversation id.
 * @param value - the candidate.
 * @returns true for any function.
 */
export function isSessionAction(value: unknown): value is (sessionId: SessionId) => unknown {
  return typeof value === 'function'
}

/**
 * One source in a face's `hooks` compartment.
 * @param face - what the shadowed entry's inject factory returned.
 * @param name - the hook's name in that compartment.
 * @returns the source, or undefined when the face carries no observable under that name.
 */
export function hookOf(face: Record<string, unknown>, name: string): HostObservable<unknown> | undefined {
  const { hooks } = face
  if (typeof hooks !== 'object' || hooks === null) return undefined
  const hook: unknown = Reflect.get(hooks, name)
  return isObservable(hook) ? hook : undefined
}

/**
 * A reader for the face of the entry another package registered under `id`.
 * Each entry's face is read once and kept for as long as that entry is on the
 * ledger.
 * @param ledger - the slot ledger both entries are registered on.
 * @param id - the shadowed entry's id.
 * @param replacement - this package's component under the same id, which the reader skips.
 * @param read - picks the members the caller reads; undefined when one is missing.
 * @returns the reader, which answers undefined while no such entry with a recognised face is registered.
 */
export function shadowedFace<Face>(
  ledger: OverlayLedger, id: string, replacement: unknown, read: (face: Record<string, unknown>) => Face | undefined,
): () => Face | undefined {
  const faces = new WeakMap<StoredEntry, Face | null>()
  return () => {
    const entry = ledger.entries('shell.overlay')
      .find(candidate => candidate.options.id === id && candidate.component !== replacement)
    if (entry?.inject === undefined) return undefined
    let face = faces.get(entry)
    if (face === undefined) {
      face = read(entry.inject()) ?? null
      faces.set(entry, face)
    }
    return face ?? undefined
  }
}

/**
 * One observable member of a shadowed face, parsed. A subscriber follows the
 * ledger as well: an owner entry registered, replaced, or removed after it
 * subscribed moves its subscription to the entry now on the ledger and tells
 * it to read again.
 * @param ledger - the slot ledger the shadowed entry is registered on.
 * @param face - the reader {@link shadowedFace} built.
 * @param source - picks the member's source from the face.
 * @param parse - reads one published value; null when it carries nothing the caller draws.
 * @returns the parsed source, which answers null while no owner entry is registered.
 */
export function followShadowed<Face, T>(
  ledger: OverlayLedger,
  face: () => Face | undefined,
  source: (face: Face) => HostObservable<unknown>,
  parse: (raw: unknown) => T | null,
): HostObservable<T | null> {
  // A snapshot must keep its identity while nothing changed, so the parsed
  // value is reused for as long as the shadowed source returns the same one.
  let lastRaw: unknown = null
  let last: T | null = null
  return {
    getSnapshot: () => {
      const current = face()
      const raw = current === undefined ? null : source(current).getSnapshot()
      if (raw !== lastRaw) {
        lastRaw = raw
        last = parse(raw)
      }
      return last
    },
    subscribe: (listener) => {
      const follow = (current: Face | undefined) => (current === undefined ? undefined : source(current).subscribe(listener))
      let current = face()
      let release = follow(current)
      const stopLedger = ledger.subscribe('shell.overlay', () => {
        const next = face()
        if (next === current) return
        release?.()
        current = next
        release = follow(current)
        listener()
      })
      return () => {
        stopLedger()
        release?.()
      }
    },
  }
}
