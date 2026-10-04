/**
 * A fake process table for the server-tree tests: processes, a server stop
 * that hands the children to process 1 as POSIX does, and kills that work
 * except on the processes named stubborn.
 * @module
 */

import type { ProcessEntry, ProcessProbes } from '../src/process-tree.ts'

/**
 * One fake process.
 * @param pid - its id.
 * @param ppid - its parent's id.
 * @param command - its command.
 * @param startedAt - its start time.
 * @returns the entry.
 */
export function entry(pid: number, ppid: number, command = `p${String(pid)}`, startedAt = 'Mon Sep 28 10:00:00 2026'): ProcessEntry {
  return { pid, ppid, startedAt, command }
}

/** A fake process table and what was done to it. */
export interface FakeSystem {
  probes: ProcessProbes
  killed: number[]
  table: ProcessEntry[]
  stopServer: (pid: number) => void
}

/**
 * A fake system: a process table, a server whose stop removes only itself
 * (its children are reparented to 1, as on POSIX), and kills that work
 * except for the processes named stubborn.
 * @param table - the processes at the start.
 * @param stubborn - the processes a kill leaves running.
 * @returns the system.
 */
export function fakeSystem(table: ProcessEntry[], stubborn: number[] = []): FakeSystem {
  const killed: number[] = []
  const state = { table: [...table] }
  return {
    killed,
    get table() { return state.table },
    stopServer: (pid) => {
      state.table = state.table.filter(item => item.pid !== pid).map(item => item.ppid === pid ? { ...item, ppid: 1 } : item)
    },
    probes: {
      list: async () => state.table.map(item => ({ ...item })),
      kill: async (pid) => {
        killed.push(pid)
        if (!stubborn.includes(pid)) state.table = state.table.filter(item => item.pid !== pid)
      },
      sleep: async () => undefined,
    },
  }
}
