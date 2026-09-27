/**
 * Stopping the server's whole process tree: the tree recorded while the
 * server runs, the processes still running after the stop found by process
 * id and start time (so a reused process id is not taken for a survivor),
 * killed, and reported when they will not go. Every process here is a fake;
 * the real listing is only read, never acted on.
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  descendantsOf, ensureTreeGone, nodeProcessProbes, parsePsOutput, parseWindowsProcesses, stopServerTree, survivorsOf,
  TREE_KILL_ROUNDS, type ProcessEntry, type ProcessProbes,
} from '../src/process-tree.ts'

/** One fake process. */
function entry(pid: number, ppid: number, command = `p${String(pid)}`, startedAt = 'Mon Sep 28 10:00:00 2026'): ProcessEntry {
  return { pid, ppid, startedAt, command }
}

/** A fake process table and what was done to it. */
interface FakeSystem {
  probes: ProcessProbes
  killed: number[]
  table: ProcessEntry[]
  stopServer: (pid: number) => void
}

/**
 * A fake system: a process table, a server whose stop removes only itself
 * (its children are reparented to 1, as on POSIX), and kills that work
 * except for the processes named stubborn.
 */
function fakeSystem(table: ProcessEntry[], stubborn: number[] = []): FakeSystem {
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

describe('the server process tree', () => {
  it('finds every descendant of the server, and nothing else', () => {
    const table = [entry(1, 0), entry(100, 1, 'node'), entry(101, 100, 'mcp'), entry(102, 101, 'sh'), entry(103, 102, 'zsh'), entry(200, 1, 'other')]
    expect(descendantsOf(100, table).map(item => item.pid)).toEqual([100, 101, 102, 103])
    expect(descendantsOf(999, table)).toEqual([])
  })

  it('kills what the server left running after its stop, found although the parent is gone', async () => {
    const system = fakeSystem([entry(1, 0), entry(100, 1, 'node'), entry(101, 100, 'mcp'), entry(102, 101, 'terminal'), entry(200, 1, 'other')])
    let swept = false
    const survivors = await stopServerTree({
      pid: 100, stop: async () => { system.stopServer(100) }, sweep: async () => { swept = true }, probes: system.probes,
    })
    expect(survivors).toEqual([])
    expect(swept).toBe(true)
    expect(system.killed.sort()).toEqual([101, 102])
    expect(system.table.map(item => item.pid)).toEqual([1, 200])
  })

  it('reports a process that will not go, and never kills a later process that reused a recorded id', async () => {
    const system = fakeSystem([entry(1, 0), entry(100, 1), entry(101, 100, 'stuck'), entry(102, 100, 'exits')], [101])
    const recorded = descendantsOf(100, await system.probes.list())
    system.stopServer(100)
    // 102 exited and its id now belongs to an unrelated process started later.
    const later = { ...entry(102, 1, 'unrelated'), startedAt: 'Mon Sep 28 11:00:00 2026' }
    const probes: ProcessProbes = {
      ...system.probes,
      list: async () => [...(await system.probes.list()).filter(item => item.pid !== 102), later],
    }
    const survivors = await ensureTreeGone(recorded, probes)
    expect(survivors.map(item => item.pid)).toEqual([101])
    expect(system.killed).toEqual(Array.from({ length: TREE_KILL_ROUNDS }, () => 101))
    expect(survivorsOf(recorded, [later])).toEqual([])
  })

  it('has nothing to check without a server', async () => {
    const system = fakeSystem([entry(1, 0)])
    const none = await stopServerTree({ pid: undefined, stop: async () => undefined, sweep: async () => undefined, probes: system.probes })
    expect(none).toEqual([])
    expect(system.killed).toEqual([])
  })

  it('reads ps and the Windows listing, commands with spaces and the five-word start time included', async () => {
    expect(parsePsOutput('  812   1 Mon Sep 28 10:00:00 2026 /Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop\n junk\n')).toEqual([
      { pid: 812, ppid: 1, startedAt: 'Mon Sep 28 10:00:00 2026', command: '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop' },
    ])
    expect(parseWindowsProcesses('4\t0\t\t\r\n1200\t4\t2026-09-28T01:02:03.0000000Z\tC:\\Program Files\\DSH\\node.exe\r\nx\ty\n')).toEqual([
      { pid: 4, ppid: 0, startedAt: '', command: '' },
      { pid: 1200, ppid: 4, startedAt: '2026-09-28T01:02:03.0000000Z', command: 'C:\\Program Files\\DSH\\node.exe' },
    ])
    if (process.platform !== 'win32') {
      const self = (await nodeProcessProbes(process.platform).list()).find(item => item.pid === process.pid)
      expect(self?.ppid).toBe(process.ppid)
      expect(self?.startedAt).toMatch(/\d{4}$/)
    }
  })
})
