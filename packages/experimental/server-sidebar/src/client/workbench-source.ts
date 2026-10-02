/**
 * The workbench conversation's id, for the session header.
 *
 * The sidebar's workflow store holds `workbenchSessionId`, but a store handle
 * mounts under one scope, and the store is the root-scoped `sidebar` entry's
 * while the header's untitled title is a session-scoped entry, so the title
 * cannot read that store. This source is the header's copy: it starts from
 * the server-menu document the client half reads before registering, and
 * `client/index.ts` publishes the id of every document the server answers a
 * save with, right after committing the same document to the store. Both are
 * fed from the same answers at the same call site, so they hold the same id.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/workbench-source
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** An observable workbench id that the server-menu writer publishes to. */
export interface WorkbenchSource extends HostObservable<string | undefined> {
  /**
   * Record the id the latest server-menu document names, notifying
   * subscribers when it changed.
   * @param id - the document's `workbenchSessionId`, or `undefined` before first use.
   */
  publish(id: string | undefined): void
}

/**
 * Create the source.
 * @param initial - the id the document read before registration names.
 * @returns the source, holding `initial` until the first publish.
 */
export function createWorkbenchSource(initial: string | undefined): WorkbenchSource {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish: (id) => {
      if (id === current) return
      current = id
      for (const listener of [...listeners]) listener()
    },
  }
}
