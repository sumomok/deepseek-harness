/**
 * SessionProjectionCache on `session-persistence/relocated`: a record bound
 * to the moved lifecycle is rebound to the new cwd with its rows unchanged,
 * so header-only listing reads keep serving it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache from '../src/index.ts'
import { checkpointRecord, projectionCacheDomainSpec } from '../src/spec.ts'
import type { CheckpointRecord } from '../src/spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    title: string | null
  }
  interface SessionProjectionMap {
    title: string | null
  }
}

/** Mirrors the shipped title unit's storage face (stateVersion 1, bare-string state). */
const titleUnit = {
  key: 'title',
  stateSchema: z.string().nullable(),
  init: () => null,
  apply: state => state,
  wire: { viewSchema: z.string().nullable(), view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'title', string | null>

const ID = SessionId('relocated')
const FROM = '/projects/old'
const TO = '/projects/new'

const headerAt = (cwd: string, createdAt = 10): SessionHeader =>
  ({ version: SESSION_FORMAT_VERSION, id: ID, createdAt, isSeeded: false, cwd })

const rows: CheckpointRecord['rows'] = { title: { ver: 1, seq: SessionSeq(4), val: 'kept title' } }

const identityAt = (cwd: string, formatVersion = SESSION_FORMAT_VERSION): CheckpointRecord['identity'] => ({
  formatVersion,
  createdAt: 10,
  cwd,
  isSeeded: false,
  inheritedEventCount: SessionLogOffset(0),
})

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

const recordPath = (root: string): string =>
  join(root, projectionCacheDomainSpec.name, 'sessions', `${String(ID)}.json`)

async function storedRecord(root: string): Promise<CheckpointRecord> {
  const document = JSON.parse(await readFile(recordPath(root), 'utf8')) as { record: unknown }
  return checkpointRecord.parse(document.record)
}

/** Boot the cache over a json-backed domain, optionally seeded with one stored record for {@link ID}. */
async function boot(identity?: CheckpointRecord['identity']) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-relocate-'))
  roots.push(root)
  if (identity !== undefined) {
    await mkdir(dirname(recordPath(root)), { recursive: true })
    await writeFile(recordPath(root), JSON.stringify({ version: projectionCacheDomainSpec.version, record: { identity, rows } }))
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(titleUnit)
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  const puts: string[] = []
  ctx.on('domain/changed', (change) => {
    if (change.domain === projectionCacheDomainSpec.name && change.operation === 'put') puts.push(change.key)
  })
  const relocate = (previous: SessionHeader): void => {
    ctx.emit('session-persistence/relocated', ID, previous, {
      header: { ...previous, cwd: TO },
      revision: SessionPersistenceRevision('moved'),
    })
  }
  return { ctx, root, cache: ctx.sessionProjectionCache, puts, relocate }
}

describe('SessionProjectionCache on session-persistence/relocated', () => {
  it('rebinds a current record to the new cwd and keeps its rows', async () => {
    const { root, cache, puts, relocate } = await boot(identityAt(FROM))
    expect(cache.cachedSnapshot(headerAt(FROM))).toEqual({ asOfSeq: 4, values: { title: 'kept title' } })

    relocate(headerAt(FROM))
    await vi.waitFor(() => { expect(puts).toEqual([ID]) })

    expect(cache.cachedSnapshot(headerAt(TO))).toEqual({ asOfSeq: 4, values: { title: 'kept title' } })
    expect(cache.cachedSnapshot(headerAt(FROM))).toBeUndefined()
    expect(await storedRecord(root)).toEqual({ identity: identityAt(TO), rows })
  })

  it('rebinds a predecessor record so its title hint survives the move', async () => {
    const { root, cache, puts, relocate } = await boot(identityAt(FROM, SESSION_FORMAT_VERSION - 1))

    relocate(headerAt(FROM))
    await vi.waitFor(() => { expect(puts).toEqual([ID]) })

    expect(cache.cachedPredecessorTitle(headerAt(TO))).toEqual({ asOfSeq: 4, values: { title: 'kept title' } })
    expect((await storedRecord(root)).identity).toEqual(identityAt(TO, SESSION_FORMAT_VERSION - 1))
  })

  it('leaves a record of another lifecycle and an absent record unwritten', async () => {
    const unrelated = await boot(identityAt(FROM))
    unrelated.relocate(headerAt(FROM, 99))
    const absent = await boot()
    absent.relocate(headerAt(FROM))
    // A later put on the same write chain proves the relocation queued nothing before it.
    const probe = { ...headerAt(TO), id: SessionId('probe') }
    unrelated.cache.coldSnapshot(probe, SessionLogOffset(0), [])
    absent.cache.coldSnapshot(probe, SessionLogOffset(0), [])
    await vi.waitFor(() => {
      expect(unrelated.puts).toEqual([probe.id])
      expect(absent.puts).toEqual([probe.id])
    })

    expect(await storedRecord(unrelated.root)).toEqual({ identity: identityAt(FROM), rows })
    expect(absent.cache.cachedSnapshot(headerAt(TO))).toBeUndefined()
  })

  it('logs a failed rebind and keeps the old record', async () => {
    const { ctx, root, cache, relocate } = await boot(identityAt(FROM))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // A directory where the record document must land makes the atomic replacement fail.
    await rm(recordPath(root))
    await mkdir(recordPath(root))

    relocate(headerAt(FROM))
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`re-keying relocated "${ID}" failed (cache stays stale)`))
    }, { timeout: 5_000 })
    expect(cache.cachedSnapshot(headerAt(FROM))).toEqual({ asOfSeq: 4, values: { title: 'kept title' } })
  })
})
