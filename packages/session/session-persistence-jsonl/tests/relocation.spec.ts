/**
 * Session relocation: the backend method's observable contract, the on-disk
 * protocol's per-step crash matrix driven through the runtime's barrier, in-call
 * failure recovery, startup recovery of left intents, and the post-lock
 * re-resolution that keeps write opens off a directory a relocation removed.
 * Filesystem faults, and other backends' operations interleaved at one
 * filesystem call, reach the backend through the module mock below; the
 * runtime takes injected filesystem, platform, and verifier dependencies.
 */

import { createHash } from 'node:crypto'
import {
  appendFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq,
  type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyOwnedError, SessionFormatUnsupportedError, SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError, type SessionPersistence, type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  encodeSegment, generationLogFilename, parseGenerationLogFilename, projectKey, scanLog, sessionDir, toHeaderLine,
  type JsonlCompression,
} from '../src/format.ts'
import { LEASE_FILENAME, SessionWriteLease } from '../src/lease.ts'
import {
  relocationHiddenName, relocationIntentPath, relocationStageName,
  type JsonlRelocationPhase, type JsonlRelocationPlan, type JsonlRelocationRuntimeOverrides,
} from '../src/relocation.ts'
import { createJsonlGenerationTestRuntime } from '../src/testing/generation.ts'
import { createJsonlRelocationTestRuntime } from '../src/testing/relocation.ts'
import { compressZstdFrame, decompressZstdFrame, decompressZstdPrefix, scanZstdFrames } from '../src/zstd.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const faults = vi.hoisted(() => ({
  rules: [] as Array<{
    op: string
    match: (path: string) => boolean
    /** Runs before the call proceeds or fails; calls it makes itself pass through. */
    action?: () => Promise<void>
    error?: Error
    times: number
  }>,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const guard = <F extends (...args: never[]) => Promise<unknown>>(op: string, fn: F): F => (async (...args: Parameters<F>) => {
    const path = String(args[0])
    const rule = faults.rules.find(candidate => candidate.op === op && candidate.times !== 0 && candidate.match(path))
    if (rule !== undefined) {
      rule.times -= 1
      await rule.action?.()
      if (rule.error !== undefined) throw rule.error
    }
    return fn(...args)
  }) as F
  return {
    ...actual,
    link: guard('link', actual.link),
    unlink: guard('unlink', actual.unlink),
    readdir: guard('readdir', actual.readdir),
    readFile: guard('readFile', actual.readFile),
    rename: guard('rename', actual.rename),
  }
})

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  faults.rules.length = 0
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Make the next lease release close its lock and then reject. */
function failNextRelease(): void {
  // oxlint-disable-next-line typescript/unbound-method -- The spy body calls the saved release with the lease as this.
  const release = SessionWriteLease.prototype.release
  vi.spyOn(SessionWriteLease.prototype, 'release').mockImplementationOnce(async function (this: SessionWriteLease) {
    await release.call(this)
    throw new Error('release failed')
  })
}

class SimulatedCrash extends Error {
  override readonly name = 'SimulatedCrash'
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code })
}

function fault(op: string, match: (path: string) => boolean, code = 'EIO', times = 1): void {
  faults.rules.push({ op, match, error: errno(code), times })
}

/** Run `action` once, just before the next matching call proceeds. */
function interleave(op: string, match: (path: string) => boolean, action: () => Promise<void>): void {
  faults.rules.push({ op, match, action, times: 1 })
}

/** Deterministic incompressible text, so a truncated frame still decodes a plaintext prefix. */
function noise(length: number): string {
  let state = 0x12345678
  let output = ''
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    output += String.fromCharCode(97 + (state % 26))
  }
  return output
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-relocate-'))
  roots.push(root)
  return root
}

async function mount(root: string, compression: JsonlCompression): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx
}

async function writeLog(persistence: SessionPersistence, header: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const handle = await persistence.create(header)
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

async function readEvents(
  persistence: SessionPersistence,
  id: SessionId,
): Promise<{ header: SessionHeader; events: readonly SessionEvent[]; inherited: number }> {
  const handle = await persistence.open(id, 'read')
  try {
    return { header: handle.header, events: (await handle.read()).events, inherited: handle.inheritedEventCount }
  } finally {
    await handle.close()
  }
}

async function encodeRecord(value: unknown, compression: JsonlCompression): Promise<Buffer> {
  const line = `${JSON.stringify(value)}\n`
  return compression === 'zstd' ? compressZstdFrame(line) : Buffer.from(line)
}

/** Split one generation file into its header record and the bytes after it. */
async function splitGeneration(path: string, compression: JsonlCompression): Promise<{ header: Record<string, unknown>; body: Buffer }> {
  const bytes = await readFile(path)
  const end = compression === 'zstd' ? scanZstdFrames(bytes, 1).frames[0]!.end : bytes.indexOf(0x0A) + 1
  const record = compression === 'zstd' ? await decompressZstdFrame(bytes.subarray(0, end)) : bytes.subarray(0, end)
  return { header: JSON.parse(record.toString('utf8')) as Record<string, unknown>, body: bytes.subarray(end) }
}

/** The last raw line of a torn tail: cut off before its newline, or complete but unreadable. */
type TornLine = 'partial' | 'unreadable'

/**
 * Store one current session at SOURCE_CWD whose current generation ends in a
 * torn tail: two complete records after the committed ones and a partial raw
 * third line (or a complete unreadable one), inside one torn final frame for
 * Zstandard, where an unreadable record in a complete frame is corruption.
 */
async function tornSession(compression: JsonlCompression, last: TornLine = 'partial') {
  const root = await freshRoot()
  const ctx = await mount(root, compression)
  const header = meta('torn', SOURCE_CWD)
  await writeLog(ctx.sessionPersistence, header, oneTurnLog())
  const path = join(sessionDir(root, SOURCE_CWD, header.id), generationLogFilename(SESSION_FORMAT_VERSION, compression))
  const open: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } },
    { type: 'step/start', seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
  ]
  if (compression === 'none') {
    const third = `{"type":"assistant/chunk","seq":8,"ti${last === 'unreadable' ? '\n' : ''}`
    await appendFile(path, `${open.map(event => JSON.stringify(event)).join('\n')}\n${third}`)
  } else {
    const frame = await compressZstdFrame(`${open.map(event => JSON.stringify(event)).join('\n')}\n{"type":"assistant/attempt","noise":"${noise(300_000)}"}\n`)
    let torn: Buffer | undefined
    for (const ratio of [0.9, 0.75, 0.6, 0.5]) {
      const candidate = frame.subarray(0, Math.floor(frame.length * ratio))
      const decoded = (await decompressZstdPrefix(candidate).catch(() => Buffer.alloc(0))).toString('utf8')
      if (torn === undefined && (decoded.match(/\n/g)?.length ?? 0) === 2) torn = candidate
    }
    await appendFile(path, torn!)
  }
  const stored = (await readEvents(ctx.sessionPersistence, header.id)).events
  expect(stored).toHaveLength(8)
  return { root, ctx, header, stored }
}

async function fingerprint(path: string): Promise<{ sha: string; ino: bigint }> {
  const [bytes, info] = await Promise.all([readFile(path), stat(path, { bigint: true })])
  return { sha: createHash('sha256').update(bytes).digest('hex'), ino: info.ino }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

function isCanonical(name: string): boolean {
  return parseGenerationLogFilename(name, 'none') !== undefined || parseGenerationLogFilename(name, 'zstd') !== undefined
}

/** Every session directory of `id` under the root, with its canonical and other entries. */
async function sessionDirectories(root: string, id: SessionId): Promise<Array<{ dir: string; canonical: string[]; other: string[] }>> {
  const found: Array<{ dir: string; canonical: string[]; other: string[] }> = []
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of await readdir(join(root, project.name), { withFileTypes: true })) {
      if (!session.isDirectory() || session.name !== encodeSegment(id)) continue
      const dir = join(root, project.name, session.name)
      const names = (await readdir(dir)).sort()
      found.push({ dir, canonical: names.filter(isCanonical), other: names.filter(name => !isCanonical(name)) })
    }
  }
  return found
}

function inProcessVerifier(): NonNullable<JsonlRelocationRuntimeOverrides['verify']> {
  const generation = createJsonlGenerationTestRuntime()
  return (path, compression, expectedId, expectedEventCount) => generation.verify(path, compression, expectedId, expectedEventCount)
}

/**
 * A Win32 no-replace publish over POSIX rename, with MoveFileExW's error order.
 * MoveFileExW opens the source and renames that open file
 * (`NtSetInformationFile(FileRenameInformation)` with `ReplaceIfExists` unset;
 * Wine's `MoveFileWithProgressW` in `dlls/kernelbase/file.c` follows the same
 * order), so a missing source fails with `ERROR_FILE_NOT_FOUND` (ENOENT) even
 * when the destination exists, and only an open source meets an existing
 * destination (`ERROR_ALREADY_EXISTS`, EEXIST).
 */
async function publishNewSimulated(existing: string, replacement: string): Promise<void> {
  if (!await exists(existing)) throw errno('ENOENT')
  if (await exists(replacement)) throw errno('EEXIST')
  await rename(existing, replacement)
}

type Platform = 'posix' | 'win32'
type Barrier = NonNullable<JsonlRelocationRuntimeOverrides['barrier']>

function platformOverrides(platform: Platform): JsonlRelocationRuntimeOverrides {
  return platform === 'win32'
    ? { platform: 'win32', publishNewWin32: publishNewSimulated, replaceWin32: rename }
    : { platform: 'darwin' }
}

const SOURCE_CWD = '/work/source'
const TARGET_CWD = '/work/target'
const THIRD_CWD = '/work/third'

/**
 * Store one current session at SOURCE_CWD with two retained prior generations,
 * create its target directory, and return a plan to move it to `targetCwd`.
 */
async function seed(compression: JsonlCompression, targetCwd = TARGET_CWD, sourceCwd = SOURCE_CWD) {
  const root = await freshRoot()
  const ctx = await mount(root, compression)
  const header = meta('relocated', sourceCwd)
  const events = oneTurnLog()
  await writeLog(ctx.sessionPersistence, header, events)
  const sourceDir = sessionDir(root, sourceCwd, header.id)
  const prior = [2, 3].map(version => generationLogFilename(version, compression))
  for (const [index, name] of prior.entries()) {
    await writeFile(join(sourceDir, name), await encodeRecord({ ...toHeaderLine(header), version: index + 2 }, compression))
  }
  const current = generationLogFilename(SESSION_FORMAT_VERSION, compression)
  const targetDir = sessionDir(root, targetCwd, header.id)
  const before = new Map<string, { sha: string; ino: bigint }>()
  for (const name of [...prior, current]) before.set(name, await fingerprint(join(sourceDir, name)))
  const sourceBody = (await splitGeneration(join(sourceDir, current), compression)).body
  const plan: JsonlRelocationPlan = {
    root,
    id: header.id,
    compression,
    sourceDir,
    targetDir,
    sameDirectory: sourceDir === targetDir,
    fromCwd: sourceCwd,
    toCwd: targetCwd,
    headerLine: `${JSON.stringify(toHeaderLine({ ...header, cwd: targetCwd }))}\n`,
    sourceEnd: undefined,
    recoveredBatch: '',
    eventCount: events.length,
  }
  return { root, ctx, header, events, sourceDir, targetDir, prior, current, before, sourceBody, plan }
}

type Seeded = Awaited<ReturnType<typeof seed>>

/** Hold both leases as the backend does around a runtime call. */
async function holdLeases(f: Seeded): Promise<() => Promise<void>> {
  const leases = [await SessionWriteLease.acquire(f.sourceDir, f.header.id)]
  if (!f.plan.sameDirectory) {
    await mkdir(f.targetDir, { recursive: true })
    leases.push(await SessionWriteLease.acquire(f.targetDir, f.header.id))
  }
  return async () => {
    for (const lease of leases) await lease.release()
  }
}

/** Assert the three disk invariants for every directory and the location of non-canonical files. */
async function assertInvariants(f: Seeded, published: boolean): Promise<void> {
  const dirs = await sessionDirectories(f.root, f.header.id)
  const holders = dirs.filter(entry => entry.canonical.length > 0)
  expect(holders.length).toBeLessThanOrEqual(1)
  for (const holder of holders) {
    const highest = holder.canonical
      .map(name => ({ name, version: parseGenerationLogFilename(name, f.plan.compression)! }))
      .sort((left, right) => right.version - left.version)[0]!
    const { header } = await splitGeneration(join(holder.dir, highest.name), f.plan.compression)
    expect(sessionDir(f.root, header['cwd'] as string, f.header.id)).toBe(holder.dir)
  }
  if (published) expect(dirs.find(entry => entry.dir === f.sourceDir)?.canonical ?? []).toEqual([])
  for (const entry of dirs) {
    if (entry.other.some(name => name !== LEASE_FILENAME)) expect([f.sourceDir, f.targetDir]).toContain(entry.dir)
  }
  const rootFiles = (await readdir(f.root, { withFileTypes: true })).filter(entry => !entry.isDirectory()).map(entry => entry.name)
  expect(rootFiles.every(name => /^\.relocate\.[0-9a-f]{64}\.json(\.[0-9a-f]+\.tmp)?$/.test(name))).toBe(true)
}

/** Assert no relocation residue anywhere under the root. */
async function assertNoResidue(root: string): Promise<void> {
  const residue: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(dir, entry.name))
      else if (entry.name.startsWith('.relocate.') || /\.relocat(e|ing)-[0-9a-f]{12}/.test(entry.name)) residue.push(join(dir, entry.name))
    }
  }
  await visit(root)
  expect(residue).toEqual([])
}

async function assertRolledBack(f: Seeded, persistence: SessionPersistence): Promise<void> {
  expect((await persistence.list()).map(row => row.header.cwd)).toEqual([SOURCE_CWD])
  for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
  expect(await exists(f.targetDir)).toBe(false)
  await assertNoResidue(f.root)
}

async function assertMoved(f: Seeded, persistence: SessionPersistence): Promise<void> {
  expect((await persistence.list()).map(row => row.header.cwd)).toEqual([f.plan.toCwd])
  if (!f.plan.sameDirectory) {
    expect(await exists(f.sourceDir)).toBe(false)
    expect((await readdir(f.targetDir)).sort()).toEqual([...f.prior, f.current, LEASE_FILENAME].sort())
  }
  for (const name of f.prior) expect(await fingerprint(join(f.targetDir, name))).toEqual(f.before.get(name))
  const moved = await splitGeneration(join(f.targetDir, f.current), f.plan.compression)
  expect(moved.header['cwd']).toBe(f.plan.toCwd)
  expect(moved.body).toEqual(f.sourceBody)
  expect((await readEvents(persistence, f.header.id)).events).toEqual(f.events)
  await assertNoResidue(f.root)
}

describe('relocation filenames', () => {
  it.each(['none', 'zstd'] as const)('keeps staged and hidden %s names outside every canonical generation', (compression) => {
    const token = '0123456789ab'
    const names = [0, 1, 2, 3, SESSION_FORMAT_VERSION].map(version => generationLogFilename(version, compression))
    for (const name of names) {
      for (const derived of [relocationHiddenName(name, token), relocationStageName(name, token)]) {
        expect(isCanonical(derived)).toBe(false)
      }
    }
    expect(relocationIntentPath('/root', SessionId('x'))).toMatch(/\/\.relocate\.[0-9a-f]{64}\.json$/)
  })
})

describe.each(['none', 'zstd'] as const)('JsonlSessionPersistence.relocate (%s)', (compression) => {
  it('moves a current session, keeps its events and body bytes, and emits one event', async () => {
    const f = await seed(compression)
    const persistence = f.ctx.sessionPersistence
    const before = (await persistence.stat(f.header.id))!
    const seen: Array<[SessionId, SessionHeader, SessionPersistenceSnapshot]> = []
    f.ctx.on('session-persistence/relocated', (id, previous, current) => { seen.push([id, previous, current]) })
    expect(typeof persistence.relocate).toBe('function')

    const snapshot = await persistence.relocate!(f.header.id, TARGET_CWD)

    expect(snapshot.header).toEqual({ ...before.header, cwd: TARGET_CWD })
    expect(snapshot.revision).not.toBe(before.revision)
    expect(await persistence.stat(f.header.id)).toEqual(snapshot)
    expect(seen).toEqual([[f.header.id, before.header, snapshot]])
    expect((await persistence.list()).map(row => row.header)).toEqual([snapshot.header])
    const writer = await persistence.open(f.header.id, 'write')
    expect(writer.header.cwd).toBe(TARGET_CWD)
    await writer.close()
    await assertMoved(f, persistence)
    expect(await exists(dirname(f.sourceDir))).toBe(true)
  })

  it('moves a session stored without a cwd', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, compression)
    const header = meta('no-cwd')
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const snapshot = await ctx.sessionPersistence.relocate!(header.id, TARGET_CWD)
    expect(snapshot.header).toEqual({ ...(await readEvents(ctx.sessionPersistence, header.id)).header, cwd: TARGET_CWD })
    expect(await exists(sessionDir(root, undefined, header.id))).toBe(false)
    expect((await readEvents(ctx.sessionPersistence, header.id)).events).toEqual(oneTurnLog())
  })

  it('keeps the inherited cut of a seeded session', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, compression)
    const header: SessionHeader = { ...meta('seeded', SOURCE_CWD), parentSession: SessionId('seed-parent'), isSeeded: true }
    const handle = await ctx.sessionPersistence.create(header, { inheritedEventCount: SessionLogOffset(1) })
    await handle.append([
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'session/end-seed', seq: SessionSeq(1), time: 1, data: { inherited: true } },
    ])
    await handle.close()
    await ctx.sessionPersistence.relocate!(header.id, TARGET_CWD)
    const moved = await readEvents(ctx.sessionPersistence, header.id)
    expect(moved.inherited).toBe(1)
    expect(moved.header).toMatchObject({ isSeeded: true, parentSession: 'seed-parent', cwd: TARGET_CWD })
  })

  it('publishes the current successor of a historical session first and moves its generations byte- and inode-identical', async () => {
    const root = await freshRoot()
    const id = SessionId('historical')
    const sourceDir = sessionDir(root, SOURCE_CWD, id)
    const v3 = join(sourceDir, generationLogFilename(3, compression))
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await mkdir(sourceDir, { recursive: true })
    const first = `${JSON.stringify({ type: 'session', version: 3, id, createdAt: 1, cwd: SOURCE_CWD, isSeeded: false, delegationDepth: 0 })}\n`
    const body = rows.map(row => `${JSON.stringify(row)}\n`).join('')
    await writeFile(v3, compression === 'none' ? first + body : Buffer.concat([await compressZstdFrame(first), await compressZstdFrame(body)]))
    const original = await fingerprint(v3)
    const ctx = await mount(root, compression)
    const restored = (await readEvents(ctx.sessionPersistence, id)).events

    await ctx.sessionPersistence.relocate!(id, TARGET_CWD)

    const targetDir = sessionDir(root, TARGET_CWD, id)
    expect((await readdir(targetDir)).filter(name => name !== LEASE_FILENAME).sort())
      .toEqual([generationLogFilename(3, compression), generationLogFilename(SESSION_FORMAT_VERSION, compression)].sort())
    expect(await fingerprint(join(targetDir, generationLogFilename(3, compression)))).toEqual(original)
    expect((await splitGeneration(join(targetDir, generationLogFilename(SESSION_FORMAT_VERSION, compression)), compression)).header)
      .toMatchObject({ version: SESSION_FORMAT_VERSION, cwd: TARGET_CWD })
    expect(await exists(sourceDir)).toBe(false)
    expect((await readEvents(ctx.sessionPersistence, id)).events).toEqual(restored)
  })

  /**
   * Store a historical parent and its historical subagent child at
   * SOURCE_CWD, then read the parent once so its preparation is memoized.
   */
  async function historicalFamily() {
    const root = await freshRoot()
    const parent = SessionId('parent')
    const write = async (id: string, cwd: string, events: unknown[], child: boolean) => {
      const path = join(sessionDir(root, cwd, SessionId(id)), generationLogFilename(3, compression))
      await mkdir(dirname(path), { recursive: true })
      const first = `${JSON.stringify({
        type: 'session', version: 3, id, createdAt: child ? 2 : 1, cwd, isSeeded: false, delegationDepth: child ? 1 : 0,
        ...(child ? { origin: 'subagent', parentSession: parent } : {}),
      })}\n`
      const body = events.map(row => `${JSON.stringify(row)}\n`).join('')
      await writeFile(path, compression === 'none' ? first + body
        : Buffer.concat([await compressZstdFrame(first), ...(body.length === 0 ? [] : [await compressZstdFrame(body)])]))
    }
    await write(parent, SOURCE_CWD, [], false)
    await write('child', SOURCE_CWD, [{ type: 'subagent/descriptor', seq: 0, time: 2, data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'old child' } }], true)
    const ctx = await mount(root, compression)
    const catalog = (await readEvents(ctx.sessionPersistence, parent)).events
    return { ctx, parent, catalog }
  }

  it('makes a moved subagent child fail one historical parent write open and lets the next succeed', async () => {
    const { ctx, parent, catalog } = await historicalFamily()

    await ctx.sessionPersistence.relocate!(SessionId('child'), TARGET_CWD)

    await expect(ctx.sessionPersistence.open(parent, 'write')).rejects.toMatchObject({ name: 'JsonlGenerationSourceChangedError' })
    const writer = await ctx.sessionPersistence.open(parent, 'write')
    expect((await writer.read()).events).toEqual(catalog)
    await writer.close()
    expect((await readEvents(ctx.sessionPersistence, parent)).events).toEqual(catalog)
  })

  it('lets the first historical parent read open after a moved subagent child succeed', async () => {
    const { ctx, parent, catalog } = await historicalFamily()

    await ctx.sessionPersistence.relocate!(SessionId('child'), TARGET_CWD)

    expect((await readEvents(ctx.sessionPersistence, parent)).events).toEqual(catalog)
  })

  it('rewrites the header in place when the target cwd shares the project directory', async () => {
    const f = await seed(compression, '/a-b', '/a/b')
    expect(projectKey('/a/b')).toBe(projectKey('/a-b'))
    await f.ctx.sessionPersistence.relocate!(f.header.id, '/a-b')
    await assertMoved(f, f.ctx.sessionPersistence)
  })

  it('treats a project directory alias of the source as the same directory', async () => {
    const f = await seed(compression, '/alias')
    await symlink(dirname(f.sourceDir), dirname(f.targetDir), 'dir')
    await f.ctx.sessionPersistence.relocate!(f.header.id, '/alias')
    const moved = await splitGeneration(join(f.sourceDir, f.current), compression)
    expect(moved.header['cwd']).toBe('/alias')
    expect(moved.body).toEqual(f.sourceBody)
    expect((await f.ctx.sessionPersistence.list()).map(row => row.header.cwd)).toEqual(['/alias'])
    await assertNoResidue(f.root)
  })

  it('rewrites a torn tail the way the write path would repair it', async () => {
    const { root, ctx, header, stored } = await tornSession(compression)

    await ctx.sessionPersistence.relocate!(header.id, TARGET_CWD)

    const moved = join(sessionDir(root, TARGET_CWD, header.id), generationLogFilename(SESSION_FORMAT_VERSION, compression))
    const bytes = await readFile(moved)
    if (compression === 'zstd') expect(scanZstdFrames(bytes).tornStart).toBeUndefined()
    else expect(bytes.at(-1)).toBe(0x0A)
    expect((await readEvents(ctx.sessionPersistence, header.id)).events).toEqual(stored)
  })

  it('does nothing for the stored cwd', async () => {
    const f = await seed(compression)
    const listener = vi.fn()
    f.ctx.on('session-persistence/relocated', listener)
    const path = join(f.sourceDir, f.current)
    const before = await stat(path, { bigint: true })
    expect(await f.ctx.sessionPersistence.relocate!(f.header.id, SOURCE_CWD)).toEqual(await f.ctx.sessionPersistence.stat(f.header.id))
    expect((await stat(path, { bigint: true })).mtimeNs).toBe(before.mtimeNs)
    expect(listener).not.toHaveBeenCalled()
    await assertNoResidue(f.root)
  })
})

describe('JsonlSessionPersistence.relocate refusals', () => {
  it('refuses while this process holds a write handle or a pending create', async () => {
    const f = await seed('none')
    const writer = await f.ctx.sessionPersistence.open(f.header.id, 'write')
    await expect(f.ctx.sessionPersistence.relocate!(f.header.id, TARGET_CWD)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await writer.close()
    const pending = await f.ctx.sessionPersistence.create(meta('pending', SOURCE_CWD))
    await expect(f.ctx.sessionPersistence.relocate!(SessionId('pending'), TARGET_CWD)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await pending.close()
    for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
    await assertNoResidue(f.root)
  })

  it('refuses while another holder keeps the source or target lock', async () => {
    const f = await seed('none')
    const source = await SessionWriteLease.acquire(f.sourceDir, f.header.id)
    await expect(f.ctx.sessionPersistence.relocate!(f.header.id, TARGET_CWD)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await source.release()
    const target = await SessionWriteLease.acquire(f.targetDir, f.header.id)
    await expect(f.ctx.sessionPersistence.relocate!(f.header.id, TARGET_CWD)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await target.release()
    expect(await readdir(f.targetDir)).toEqual([LEASE_FILENAME])
    for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
    await assertNoResidue(f.root)
  })

  it('validates its arguments and the stored log', async () => {
    const f = await seed('none')
    const relocate = f.ctx.sessionPersistence.relocate!.bind(f.ctx.sessionPersistence)
    await expect(relocate(f.header.id, 'relative/path')).rejects.toBeInstanceOf(TypeError)
    await expect(relocate(SessionId('missing'), TARGET_CWD)).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    const reason = new Error('stop')
    await expect(relocate(f.header.id, TARGET_CWD, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    const future = sessionDir(f.root, SOURCE_CWD, SessionId('future'))
    await mkdir(future, { recursive: true })
    await writeFile(join(future, generationLogFilename(SESSION_FORMAT_VERSION + 1, 'none')),
      `${JSON.stringify({ ...toHeaderLine(meta('future', SOURCE_CWD)), version: SESSION_FORMAT_VERSION + 1 })}\n`)
    await expect(relocate(SessionId('future'), TARGET_CWD)).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    const corrupt = sessionDir(f.root, SOURCE_CWD, SessionId('corrupt'))
    await mkdir(corrupt, { recursive: true })
    await writeFile(join(corrupt, generationLogFilename(SESSION_FORMAT_VERSION, 'none')),
      `${JSON.stringify(toHeaderLine(meta('corrupt', SOURCE_CWD)))}\n{"type":"turn/start","seq":3,"time":1,"data":{"turn":1}}\n{"type":"turn/end","seq":4,"time":2,"data":{"turn":1,"reason":{"kind":"completed"}}}\n`)
    await expect(relocate(SessionId('corrupt'), TARGET_CWD)).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
  })

  it('reports a throwing listener, a later cleanup failure, and a failed lock release without failing the move', async () => {
    const f = await seed('none')
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => undefined)
    f.ctx.on('session-persistence/relocated', () => { throw new Error('listener failed') })
    fault('unlink', path => path === join(f.sourceDir, LEASE_FILENAME), 'EACCES', -1)
    failNextRelease()

    const snapshot = await f.ctx.sessionPersistence.relocate!(f.header.id, TARGET_CWD)

    expect(snapshot.header.cwd).toBe(TARGET_CWD)
    const messages = warn.mock.calls.map(call => String(call[0]))
    expect(messages.some(message => message.includes('listener'))).toBe(true)
    expect(messages.some(message => message.includes('later relocation step failed'))).toBe(true)
    expect(messages.some(message => message.includes('releasing its write locks failed'))).toBe(true)
    expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(true)

    faults.rules.length = 0
    const next = await mount(f.root, 'none')
    expect((await next.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([TARGET_CWD])
    expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(false)
    expect(await exists(f.sourceDir)).toBe(false)
  })

  it('joins a lock release failure to a refused move', async () => {
    const f = await seed('none')
    const target = await SessionWriteLease.acquire(f.targetDir, f.header.id)
    failNextRelease()
    const error = await f.ctx.sessionPersistence.relocate!(f.header.id, TARGET_CWD).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBeInstanceOf(SessionAlreadyOwnedError)
    vi.restoreAllMocks()
    await target.release()
  })

  it('reports a source directory that keeps unrecognized files', async () => {
    const f = await seed('none')
    await writeFile(join(f.sourceDir, 'notes.txt'), 'kept')
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => undefined)
    await f.ctx.sessionPersistence.relocate!(f.header.id, TARGET_CWD)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('holds other files'))
    expect(await readdir(f.sourceDir)).toEqual(['notes.txt'])
  })
})

const CROSS_PHASES: Array<[JsonlRelocationPhase, number | undefined, boolean]> = [
  ['intent-written', undefined, false],
  ['staged', undefined, false],
  ['prior-hidden', 0, false],
  ['prior-hidden', 1, false],
  ['current-hidden', undefined, false],
  ['published', undefined, true],
  ['prior-restored', 0, true],
  ['prior-restored', 1, true],
  ['cleaned', undefined, true],
]

const SAME_PHASES: Array<[JsonlRelocationPhase, boolean]> = [
  ['intent-written', false],
  ['staged', false],
  ['replaced', true],
]

function crashAt(phase: JsonlRelocationPhase, index: number | undefined): Barrier {
  return (reached, at) => {
    if (reached === phase && at === index) throw new SimulatedCrash(`${phase}${index === undefined ? '' : `#${index}`}`)
  }
}

/** Run the steps until a simulated process death, then release the dead process's locks. */
async function crash(f: Seeded, platform: Platform, phase: JsonlRelocationPhase, index?: number): Promise<void> {
  const release = await holdLeases(f)
  const runtime = createJsonlRelocationTestRuntime({
    ...platformOverrides(platform),
    verify: inProcessVerifier(),
    barrier: crashAt(phase, index),
  })
  try {
    await expect(runtime.execute(f.plan)).rejects.toBeInstanceOf(SimulatedCrash)
  } finally {
    await release()
  }
}

/** One session directory as a build without relocation support reads it. */
interface UnpatchedRow {
  readonly dir: string
  /** Format version of the generation the build selects. */
  readonly version: number
  readonly header: SessionHeader
  /** Decoded events; absent when the selected generation is historical. */
  readonly events?: readonly SessionEvent[]
}

/**
 * List the root the way the JSONL backend before relocation support lists it:
 * every session directory under every project directory, each directory's
 * highest canonical generation chosen by filename alone (that backend's `resolveGenerationInDirectory`, which also refuses the
 * other encoding's names), the selected header checked against the directory
 * it sits in (its `assertStoredIdentity`, without the alias comparison the
 * matrix never needs), one directory per id (its `listArtifacts` duplicate
 * refusal), and the events decoded by the current-format scanner its read path
 * uses. Relocation changed none of these read paths. A historical selected
 * generation is returned undecoded instead of migrated; the matrix stores the
 * events only in the current generation, so selecting a historical one already
 * fails its event comparison.
 */
async function unpatchedListing(root: string, compression: JsonlCompression): Promise<UnpatchedRow[]> {
  const other = compression === 'zstd' ? 'none' : 'zstd'
  const rows: UnpatchedRow[] = []
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of await readdir(join(root, project.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(root, project.name, session.name)
      const names = await readdir(dir)
      const opposite = names.find(name => parseGenerationLogFilename(name, other) !== undefined)
      if (opposite !== undefined) throw new Error(`"${join(dir, opposite)}" belongs to the other encoding`)
      const [highest] = names
        .flatMap((name) => {
          const version = parseGenerationLogFilename(name, compression)
          return version === undefined ? [] : [{ name, version }]
        })
        .sort((left, right) => right.version - left.version)
      if (highest === undefined) continue
      const bytes = await readFile(join(dir, highest.name))
      const frames = compression === 'zstd' ? scanZstdFrames(bytes).frames : []
      const plain = compression === 'zstd'
        ? Buffer.concat(await Promise.all(frames.map(frame => decompressZstdFrame(bytes.subarray(frame.start, frame.end)))))
        : bytes
      const header = JSON.parse(plain.subarray(0, plain.indexOf(0x0A)).toString('utf8')) as SessionHeader
      if (sessionDir(root, header.cwd, header.id) !== dir) throw new Error(`"${dir}" holds a header naming another directory`)
      if (rows.some(row => row.header.id === header.id)) throw new Error(`session "${header.id}" appears in two directories`)
      rows.push(highest.version === SESSION_FORMAT_VERSION
        ? { dir, version: highest.version, header, events: scanLog(plain).events }
        : { dir, version: highest.version, header })
    }
  }
  return rows
}

/**
 * Assert that a build without relocation support lists the root, and lists the
 * seeded session with its original events unless the move left it absent.
 */
async function assertUnpatchedReads(f: Seeded, listed = true): Promise<void> {
  const rows = await unpatchedListing(f.root, f.plan.compression)
  expect(rows).toHaveLength(listed ? 1 : 0)
  for (const row of rows) {
    expect(row.version).toBe(SESSION_FORMAT_VERSION)
    expect(row.events).toEqual(f.events)
  }
}

/** Recover every intent with the runtime of `platform`, as a backend's first operation does, and require no warning. */
async function recoverOn(f: Seeded, platform: Platform): Promise<void> {
  const warn = vi.fn()
  await createJsonlRelocationTestRuntime({ ...platformOverrides(platform), verify: inProcessVerifier() })
    .sweep(f.root, f.plan.compression, warn)
  expect(warn).not.toHaveBeenCalled()
}

describe.each(['none', 'zstd'] as const)('relocation crash matrix (%s)', (compression) => {
  describe.each(['posix', 'win32'] as const)('%s namespace operations', (platform) => {
    it.each(CROSS_PHASES)('recovers a cross-directory move that died after %s %s', async (phase, index, published) => {
      const f = await seed(compression)
      await crash(f, platform, phase, index)
      await assertInvariants(f, published)
      await assertUnpatchedReads(f, phase !== 'current-hidden')
      await recoverOn(f, platform)
      const recovered = await mount(f.root, compression)
      if (published) await assertMoved(f, recovered.sessionPersistence)
      else await assertRolledBack(f, recovered.sessionPersistence)
      await assertUnpatchedReads(f)
    })

    it.each(SAME_PHASES)('recovers a same-directory move that died after %s', async (phase, replaced) => {
      const f = await seed(compression, '/work-source', '/work/source')
      expect(f.plan.sameDirectory).toBe(true)
      await crash(f, platform, phase)
      await assertInvariants(f, false)
      await assertUnpatchedReads(f)
      await recoverOn(f, platform)
      const recovered = await mount(f.root, compression)
      if (replaced) {
        await assertMoved(f, recovered.sessionPersistence)
      } else {
        expect((await recovered.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([SOURCE_CWD])
        for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
        await assertNoResidue(f.root)
      }
    })

    it('completes a full run and returns its outcome', async () => {
      const f = await seed(compression)
      const release = await holdLeases(f)
      const runtime = createJsonlRelocationTestRuntime({ ...platformOverrides(platform), verify: inProcessVerifier() })
      expect(await runtime.execute(f.plan)).toEqual({ intentRetained: false, sourceRetained: false })
      await release()
      await assertMoved(f, (await mount(f.root, compression)).sessionPersistence)
    })
  })
})

describe('Win32 namespace order and hidden-file restoration', () => {
  it('simulates MoveFileExW reporting a missing source before an existing destination', async () => {
    const root = await freshRoot()
    const [present, existing, missing] = ['present', 'existing', 'missing'].map(name => join(root, name)) as [string, string, string]
    await writeFile(present, 'present')
    await writeFile(existing, 'existing')
    await expect(publishNewSimulated(missing, existing)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(publishNewSimulated(present, existing)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it.each(['posix', 'win32'] as const)('counts a hidden prior generation removed after a refused restoration as restored (%s)', async (platform) => {
    const f = await seed('none')
    await crash(f, platform, 'published')
    const intent = JSON.parse(await readFile(relocationIntentPath(f.root, f.header.id), 'utf8')) as { token: string }
    const hidden = join(f.targetDir, relocationHiddenName(f.prior[0]!, intent.token))
    await link(hidden, join(f.targetDir, f.prior[0]!))
    const warn = vi.fn()
    await createJsonlRelocationTestRuntime({
      ...platformOverrides(platform),
      verify: inProcessVerifier(),
      fs: {
        readFile: async (path: string) => {
          // Another backend finishes this restoration between the refused move and the comparison.
          if (path === hidden) await unlink(hidden)
          return readFile(path)
        },
      },
    }).sweep(f.root, 'none', warn)
    expect(warn).not.toHaveBeenCalled()
    await assertMoved(f, (await mount(f.root, 'none')).sessionPersistence)
  })

  it('keeps the intent when a hidden prior generation cannot be read for the comparison', async () => {
    const f = await seed('none')
    await crash(f, 'posix', 'published')
    const intentPath = relocationIntentPath(f.root, f.header.id)
    const intent = JSON.parse(await readFile(intentPath, 'utf8')) as { token: string }
    const hidden = join(f.targetDir, relocationHiddenName(f.prior[0]!, intent.token))
    await link(hidden, join(f.targetDir, f.prior[0]!))
    const warn = vi.fn()
    await createJsonlRelocationTestRuntime({
      verify: inProcessVerifier(),
      fs: {
        readFile: async (path: string) => {
          if (path === hidden) throw errno('EACCES')
          return readFile(path)
        },
      },
    }).sweep(f.root, 'none', warn)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
    expect(await exists(intentPath)).toBe(true)
    expect(await exists(hidden)).toBe(true)
  })
})

/** Run a relocation through the in-call recovery path with injected dependencies. */
async function relocateWith(f: Seeded, overrides: JsonlRelocationRuntimeOverrides, signal?: AbortSignal) {
  const release = await holdLeases(f)
  try {
    return await createJsonlRelocationTestRuntime({ verify: inProcessVerifier(), ...overrides }).relocate(f.plan, signal)
  } finally {
    await release()
  }
}

describe('in-call relocation failures', () => {
  it.each([
    ['hiding a prior generation', (f: Seeded) => ({ rename: async (from: string, to: string) => {
      if (from === join(f.sourceDir, f.prior[1]!)) throw errno('EIO')
      await rename(from, to)
    } })],
    ['publishing the target', (f: Seeded) => ({ link: async (from: string, to: string) => {
      if (to === join(f.targetDir, f.current)) throw errno('EIO')
      await link(from, to)
    } })],
  ] as const)('rolls back and rethrows a failure while %s', async (_step, fs) => {
    const f = await seed('none')
    await expect(relocateWith(f, { fs: fs(f) })).rejects.toMatchObject({ code: 'EIO' })
    await assertRolledBack(f, (await mount(f.root, 'none')).sessionPersistence)
  })

  it.each([
    ['intent-written', undefined],
    ['staged', undefined],
    ['prior-hidden', 0],
    ['current-hidden', undefined],
  ] as const)('rolls back a move cancelled after %s', async (phase, index) => {
    for (const reason of [new Error('cancelled'), 'cancelled as text']) {
      const f = await seed('none')
      const controller = new AbortController()
      const barrier: Barrier = (reached, at) => {
        if (reached === phase && at === index) controller.abort(reason)
      }
      await expect(relocateWith(f, { barrier }, controller.signal)).rejects.toBe(reason)
      await assertRolledBack(f, (await mount(f.root, 'none')).sessionPersistence)
    }
  })

  it('classifies a staged log that fails verification as corruption', async () => {
    const f = await seed('zstd')
    await expect(relocateWith(f, { verify: async () => { throw new Error('bad stage') } }))
      .rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    await expect(relocateWith(f, { verify: async () => { throw errno('EACCES') } })).rejects.toMatchObject({ code: 'EACCES' })
    const controller = new AbortController()
    const aborted = new Error('verification aborted')
    await expect(relocateWith(f, { verify: async () => {
      controller.abort(aborted)
      throw aborted
    } }, controller.signal)).rejects.toBe(aborted)
    const generation = createJsonlGenerationTestRuntime()
    await expect(relocateWith(f, {
      verify: async (path, compression, id, count) => ({ ...await generation.verify(path, compression, id, count), digest: 'other' }),
    })).rejects.toThrow('changed during verification')
    await assertRolledBack(f, (await mount(f.root, 'zstd')).sessionPersistence)
  })

  it('refuses a source current generation without a complete header record', async () => {
    for (const compression of ['none', 'zstd'] as const) {
      const f = await seed(compression)
      const content = compression === 'none' ? Buffer.from('{"type"') : (await compressZstdFrame('{}\n')).subarray(0, 6)
      await writeFile(join(f.sourceDir, f.current), content)
      await expect(relocateWith(f, {})).rejects.toThrow('no complete header record')
      expect(await readFile(join(f.sourceDir, f.current))).toEqual(content)
      expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(false)
    }
  })

  it('accepts an identical target published by an earlier attempt and stops on a different one', async () => {
    const same = await seed('none')
    const outcome = await relocateWith(same, { fs: { link: async (from: string, to: string) => {
      await link(from, to)
      if (to === join(same.targetDir, same.current)) throw errno('EEXIST')
    } } })
    expect(outcome).toEqual({ intentRetained: false, sourceRetained: false })
    await assertMoved(same, (await mount(same.root, 'none')).sessionPersistence)

    const other = await seed('none')
    const error = await relocateWith(other, { fs: { link: async (from: string, to: string) => {
      if (to === join(other.targetDir, other.current)) {
        await writeFile(to, 'foreign')
        throw errno('EEXIST')
      }
      await link(from, to)
    } } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((error as Error).message).toContain(relocationIntentPath(other.root, other.header.id))
    expect(await exists(relocationIntentPath(other.root, other.header.id))).toBe(true)
  })

  it('aggregates a failed rollback and keeps the intent', async () => {
    const f = await seed('none')
    const error = await relocateWith(f, { fs: {
      link: async (from: string, to: string) => {
        if (to === join(f.targetDir, f.current) || to === join(f.sourceDir, f.current)) throw errno('EIO')
        await link(from, to)
      },
    } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message).toContain('rollback failed')
    expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(true)
    await assertRolledBack(f, (await mount(f.root, 'none')).sessionPersistence)
  })

  it('stops on a rollback that finds a different source generation', async () => {
    const f = await seed('none')
    const error = await relocateWith(f, { fs: {
      link: async (from: string, to: string) => {
        if (to === join(f.targetDir, f.current)) throw errno('EIO')
        if (to === join(f.sourceDir, f.prior[0]!)) {
          await writeFile(to, 'different')
          throw errno('EEXIST')
        }
        await link(from, to)
      },
    } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(true)
  })

  it('aggregates a failure to inspect the storage after a failed step', async () => {
    const f = await seed('none')
    let failStat = false
    const error = await relocateWith(f, { fs: {
      rename: async (from: string, to: string) => {
        if (from === join(f.sourceDir, f.current)) {
          failStat = true
          throw errno('EIO')
        }
        await rename(from, to)
      },
      stat: async (path: string) => {
        if (failStat) throw errno('EACCES')
        return stat(path, { bigint: true })
      },
    } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message).toContain('could not be inspected')
  })

  it('returns a committed move whose cleanup failed or found a conflict', async () => {
    const failing = await seed('none')
    const outcome = await relocateWith(failing, { fs: { unlink: async (path: string) => {
      if (path.endsWith('.json')) throw errno('EACCES')
      await unlink(path)
    } } })
    expect(outcome).toMatchObject({ intentRetained: true, sourceRetained: false })
    expect(outcome.failure).toBeInstanceOf(AggregateError)

    const unremovable = await seed('none')
    const kept = await relocateWith(unremovable, { fs: { rmdir: async () => { throw errno('EACCES') } } })
    expect(kept).toMatchObject({ intentRetained: true, sourceRetained: false })

    const conflicting = await seed('none')
    const conflict = await relocateWith(conflicting, { fs: { link: async (from: string, to: string) => {
      if (to === join(conflicting.targetDir, conflicting.prior[0]!)) {
        await writeFile(to, 'different')
        throw errno('EEXIST')
      }
      await link(from, to)
    } } })
    expect(conflict.intentRetained).toBe(true)
    expect(conflict.failure).toBeInstanceOf(SessionPersistenceCorruptionError)

    const late = await seed('none')
    const finished = await relocateWith(late, { barrier: (phase) => {
      if (phase === 'cleaned') throw new SimulatedCrash('late')
    } })
    expect(finished).toMatchObject({ intentRetained: false, sourceRetained: false })
    expect(finished.failure).toBeInstanceOf(SimulatedCrash)
  })

  it('settles in-call failures of a same-directory move', async () => {
    const before = await seed('none', '/work-source', '/work/source')
    await expect(relocateWith(before, { verify: async () => { throw errno('EIO') } })).rejects.toMatchObject({ code: 'EIO' })
    expect(await exists(relocationIntentPath(before.root, before.header.id))).toBe(false)

    const after = await seed('none', '/work-source', '/work/source')
    const outcome = await relocateWith(after, { barrier: (phase) => {
      if (phase === 'replaced') throw new SimulatedCrash('replaced')
    } })
    expect(outcome).toMatchObject({ intentRetained: false })
    await assertMoved(after, (await mount(after.root, 'none')).sessionPersistence)

    for (const [phase, committed] of [['staged', false], ['replaced', true]] as const) {
      const f = await seed('none', '/work-source', '/work/source')
      let failing = false
      const settled = relocateWith(f, {
        barrier: (reached) => {
          if (reached === phase) {
            failing = true
            throw new SimulatedCrash(phase)
          }
        },
        fs: { unlink: async (path: string) => {
          if (failing && path.endsWith('.json')) throw errno('EACCES')
          await unlink(path)
        } },
      })
      if (committed) {
        expect(await settled).toMatchObject({ intentRetained: true })
      } else {
        await expect(settled).rejects.toBeInstanceOf(AggregateError)
      }
    }
  })

  it('discards the target directory when a cross-filesystem move is refused and keeps an occupied one', async () => {
    const f = await seed('none')
    await expect(relocateWith(f, { fs: { stat: async (path: string) => {
      const info = await stat(path, { bigint: true })
      return path === f.sourceDir ? { dev: info.dev + 1n, ino: info.ino } : info
    } } })).rejects.toThrow('different filesystems')
    expect(await exists(f.targetDir)).toBe(false)
    expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(false)

    const unlisted = await seed('none')
    await expect(relocateWith(unlisted, { fs: { readdir: async () => { throw errno('EACCES') } } }))
      .rejects.toMatchObject({ code: 'EACCES' })
    const same = await seed('none', '/work-source', '/work/source')
    await expect(relocateWith(same, { fs: { readdir: async () => { throw errno('EACCES') } } }))
      .rejects.toMatchObject({ code: 'EACCES' })
    expect(await exists(same.sourceDir)).toBe(true)

    const occupied = await seed('none')
    await mkdir(occupied.targetDir, { recursive: true })
    await writeFile(join(occupied.targetDir, generationLogFilename(2, 'zstd')), 'other encoding')
    await expect(relocateWith(occupied, {})).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((await readdir(occupied.targetDir)).sort()).toEqual([LEASE_FILENAME, generationLogFilename(2, 'zstd')].sort())
  })
})

/** Crash a seeded move at one phase and return the seed for manual disk edits before recovery. */
async function crashed(phase: JsonlRelocationPhase, index?: number, compression: JsonlCompression = 'none'): Promise<Seeded> {
  const f = await seed(compression)
  await crash(f, 'posix', phase, index)
  return f
}

describe('startup recovery', () => {
  it('rolls back an unpublished move and keeps events appended to the source afterwards', async () => {
    for (const compression of ['none', 'zstd'] as const) {
      const f = await crashed('staged', undefined, compression)
      const appended: SessionEvent = { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } }
      await appendFile(join(f.sourceDir, f.current), await encodeRecord(appended, compression))
      const recovered = await mount(f.root, compression)
      expect((await readEvents(recovered.sessionPersistence, f.header.id)).events).toEqual([...f.events, appended])
      await assertNoResidue(f.root)
    }
  })

  it('leaves a source and target that both hold the session and refuses to relocate it again', async () => {
    const f = await crashed('published')
    await link(join(f.targetDir, f.current), join(f.sourceDir, 'copy'))
    await rename(join(f.sourceDir, 'copy'), join(f.sourceDir, f.current))
    const ctx = new Context()
    contexts.push(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression: 'none' })
    const error = await ctx.sessionPersistence.relocate!(f.header.id, '/elsewhere').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((error as Error).message).toContain(relocationIntentPath(f.root, f.header.id))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('both the source and the target hold a stored log'))
    expect(await exists(join(f.sourceDir, f.current))).toBe(true)
    expect(await exists(join(f.targetDir, f.current))).toBe(true)
  })

  it.each([
    ['a target log that differs from the staged copy', 'published', async (f: Seeded) => {
      await unlink(join(f.targetDir, f.current))
      await writeFile(join(f.targetDir, f.current), 'foreign')
    }],
    ['a target generation without its current one', 'staged', async (f: Seeded) => {
      await writeFile(join(f.targetDir, generationLogFilename(1, 'none')), 'foreign')
    }],
    ['a missing source current generation', 'current-hidden', async (f: Seeded) => {
      const intent = JSON.parse(await readFile(relocationIntentPath(f.root, f.header.id), 'utf8')) as { token: string }
      await unlink(join(f.sourceDir, relocationHiddenName(f.current, intent.token)))
    }],
    ['a different source prior during rollback', 'prior-hidden', async (f: Seeded) => {
      await writeFile(join(f.sourceDir, f.prior[0]!), 'different')
    }],
    ['a different source current during rollback', 'current-hidden', async (f: Seeded) => {
      await writeFile(join(f.sourceDir, f.current), 'different')
    }],
    ['a different target prior during completion', 'published', async (f: Seeded) => {
      await writeFile(join(f.targetDir, f.prior[0]!), 'different')
    }],
    ['a target without a complete header record once the stage is gone', 'published', async (f: Seeded) => {
      const intent = JSON.parse(await readFile(relocationIntentPath(f.root, f.header.id), 'utf8')) as { token: string }
      await unlink(join(f.targetDir, relocationStageName(f.current, intent.token)))
      await unlink(join(f.targetDir, f.current))
      await writeFile(join(f.targetDir, f.current), 'foreign')
    }],
    ['a target whose header record does not decode once the stage is gone', 'published', async (f: Seeded) => {
      const intent = JSON.parse(await readFile(relocationIntentPath(f.root, f.header.id), 'utf8')) as { token: string }
      await unlink(join(f.targetDir, relocationStageName(f.current, intent.token)))
      const moved = await splitGeneration(join(f.targetDir, f.current), 'none')
      await unlink(join(f.targetDir, f.current))
      await writeFile(join(f.targetDir, f.current), Buffer.concat([Buffer.from('foreign\n'), moved.body]))
    }],
    ['a target whose header differs beyond its cwd once the stage is gone', 'published', async (f: Seeded) => {
      const intent = JSON.parse(await readFile(relocationIntentPath(f.root, f.header.id), 'utf8')) as { token: string }
      await unlink(join(f.targetDir, relocationStageName(f.current, intent.token)))
      const moved = await splitGeneration(join(f.targetDir, f.current), 'none')
      await unlink(join(f.targetDir, f.current))
      const header = Buffer.from(`${JSON.stringify({ ...moved.header, createdAt: 2000 })}\n`)
      await writeFile(join(f.targetDir, f.current), Buffer.concat([header, moved.body]))
    }],
  ] as const)('keeps the intent for %s', async (_case, phase, edit) => {
    const f = await crashed(phase, phase === 'prior-hidden' ? 0 : undefined)
    await edit(f)
    const ctx = new Context()
    contexts.push(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression: 'none' })
    await ctx.sessionPersistence.stat(f.header.id).catch(() => undefined)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stays'))
    expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(true)
  })

  it('finishes a restoration interrupted between its link and unlink, and a removed source directory', async () => {
    const f = await crashed('published')
    const intent = JSON.parse(await readFile(relocationIntentPath(f.root, f.header.id), 'utf8')) as { token: string }
    await link(join(f.targetDir, relocationHiddenName(f.prior[0]!, intent.token)), join(f.targetDir, f.prior[0]!))
    await rm(f.sourceDir, { recursive: true })
    await assertMoved(f, (await mount(f.root, 'none')).sessionPersistence)
  })

  it('finishes a completion that died after removing the stage and the hidden source current generation', async () => {
    const f = await crashed('published')
    const intent = JSON.parse(await readFile(relocationIntentPath(f.root, f.header.id), 'utf8')) as { token: string }
    await unlink(join(f.targetDir, relocationStageName(f.current, intent.token)))
    await unlink(join(f.sourceDir, relocationHiddenName(f.current, intent.token)))
    await assertMoved(f, (await mount(f.root, 'none')).sessionPersistence)
  })

  it('rolls back a move that died while hiding prior generations even when another directory holds the id', async () => {
    const f = await crashed('prior-hidden', 0)
    // The source kept its current generation, so the session never vanished and rolling back exposes nothing new.
    const third = sessionDir(f.root, THIRD_CWD, f.header.id)
    await mkdir(third, { recursive: true })
    await writeFile(join(third, f.current), await encodeRecord(toHeaderLine(meta('relocated', THIRD_CWD)), 'none'))
    const warn = vi.fn()
    await createJsonlRelocationTestRuntime().sweep(f.root, 'none', warn)
    expect(warn).not.toHaveBeenCalled()
    for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
    expect(await exists(f.targetDir)).toBe(false)
    expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(false)
  })

  it.each([
    ['not JSON', () => 'not json'],
    ['missing fields', () => JSON.stringify({ kind: 'dsh-session-relocation' })],
    ['another session name', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, id: 'other' })],
    ['an empty id', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, id: '' })],
    ['a relative target cwd', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, toCwd: 'relative' })],
    ['a foreign target directory', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, toDir: 'elsewhere' })],
    ['a nested source directory', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, fromDir: `a/b/${encodeSegment('relocated')}` })],
    ['a parent source directory', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, fromDir: `../${encodeSegment('relocated')}` })],
    ['a source of another session', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, fromDir: `${projectKey(SOURCE_CWD)}/other` })],
    ['one directory for a cross-directory move', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, fromDir: intent['toDir'] })],
    ['two directories for a same-directory move', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, sameDirectory: true })],
    ['a foreign current name', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, current: 'session.v4.jsonl.zstd' })],
    ['a current prior name', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, prior: ['session.v4.jsonl'] })],
    ['a non-generation prior name', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, prior: ['notes.txt'] })],
    ['no committed length', ({ sourceEnd: _sourceEnd, ...intent }: Record<string, unknown>) => JSON.stringify(intent)],
    ['a negative committed length', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, sourceEnd: -1 })],
    ['a fractional committed length', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, sourceEnd: 1.5 })],
    ['a textual committed length', (intent: Record<string, unknown>) => JSON.stringify({ ...intent, sourceEnd: String(intent['sourceEnd']) })],
  ] as const)('leaves an intent with %s untouched and refuses to relocate its session', async (_reason, rewrite) => {
    const f = await crashed('staged')
    const path = relocationIntentPath(f.root, f.header.id)
    const intent = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, rewrite(intent))
    const ctx = new Context()
    contexts.push(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression: 'none' })
    expect((await ctx.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([SOURCE_CWD])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(path))
    const error = await ctx.sessionPersistence.relocate!(f.header.id, '/elsewhere').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((error as Error).message).toContain(path)
  })

  it('leaves an intent whose directory another holder keeps, then settles it once free', async () => {
    const f = await crashed('current-hidden')
    const lease = await SessionWriteLease.acquire(f.targetDir, f.header.id)
    const ctx = new Context()
    contexts.push(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression: 'none' })
    expect(await ctx.sessionPersistence.list()).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('another holder'))
    await expect(ctx.sessionPersistence.relocate!(f.header.id, '/elsewhere')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await lease.release()
    const snapshot = await ctx.sessionPersistence.relocate!(f.header.id, '/elsewhere')
    expect(snapshot.header.cwd).toBe('/elsewhere')
    await assertNoResidue(f.root)
  })

  it('keeps intent temporaries and reports intents it cannot read', async () => {
    const f = await crashed('intent-written')
    const temporary = `${relocationIntentPath(f.root, SessionId('other'))}.0123456789ab.tmp`
    await writeFile(temporary, '{}')
    const unreadable = relocationIntentPath(f.root, SessionId('unreadable'))
    await mkdir(unreadable)
    const ctx = new Context()
    contexts.push(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression: 'none' })
    expect((await ctx.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([SOURCE_CWD])
    for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
    expect(await exists(f.targetDir)).toBe(false)
    expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(false)
    expect(await exists(temporary)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(unreadable))
  })

  it('rolls back a same-directory move recorded under an alias of the source directory', async () => {
    const seeded = await seed('none', '/alias')
    await symlink(dirname(seeded.sourceDir), dirname(seeded.targetDir), 'dir')
    const f: Seeded = { ...seeded, plan: { ...seeded.plan, sameDirectory: true } }
    await crash(f, 'posix', 'staged')
    const recovered = await mount(f.root, 'none')
    expect((await recovered.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([SOURCE_CWD])
    for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
    await assertNoResidue(f.root)
  })

  it('rolls back a same-directory move whose alias was removed after the crash, then relocates again', async () => {
    const seeded = await seed('none', '/alias')
    await symlink(dirname(seeded.sourceDir), dirname(seeded.targetDir), 'dir')
    const f: Seeded = { ...seeded, plan: { ...seeded.plan, sameDirectory: true } }
    await crash(f, 'posix', 'staged')
    await unlink(dirname(f.targetDir))
    const ctx = new Context()
    contexts.push(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression: 'none' })
    expect((await ctx.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([SOURCE_CWD])
    expect(warn).not.toHaveBeenCalled()
    for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
    await assertNoResidue(f.root)
    expect((await ctx.sessionPersistence.relocate!(f.header.id, THIRD_CWD)).header.cwd).toBe(THIRD_CWD)
    expect((await readEvents(ctx.sessionPersistence, f.header.id)).events).toEqual(f.events)
  })

  it('refuses a cross-directory intent whose two directories are one physical directory', async () => {
    const f = await seed('none', '/alias')
    await symlink(dirname(f.sourceDir), dirname(f.targetDir), 'dir')
    const path = relocationIntentPath(f.root, f.header.id)
    await writeFile(path, `${JSON.stringify({
      kind: 'dsh-session-relocation', version: 1, id: f.header.id, token: '0123456789ab',
      fromDir: relative(f.root, f.sourceDir), toDir: relative(f.root, f.targetDir), fromCwd: SOURCE_CWD, toCwd: '/alias',
      current: f.current, sourceEnd: (await stat(join(f.sourceDir, f.current))).size, prior: f.prior, sameDirectory: false, createdAt: 1,
    })}\n`)
    const ctx = new Context()
    contexts.push(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression: 'none' })
    expect((await ctx.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([SOURCE_CWD])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${path}" is invalid: a cross-directory relocation names one directory`))
    const error = await ctx.sessionPersistence.relocate!(f.header.id, THIRD_CWD).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((error as Error).message).toContain(path)
    expect(await exists(path)).toBe(true)
    for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
  })

  it('keeps another backend\'s recovery off an intent whose source directory this relocation holds', async () => {
    const f = await crashed('staged')
    const intentPath = relocationIntentPath(f.root, f.header.id)
    let settledElsewhere: Array<string | undefined> = []
    interleave('readFile', path => path === intentPath, async () => {
      settledElsewhere = (await (await mount(f.root, 'none')).sessionPersistence.list()).map(row => row.header.cwd)
    })
    const snapshot = await f.ctx.sessionPersistence.relocate!(f.header.id, THIRD_CWD)
    expect(settledElsewhere).toEqual([SOURCE_CWD])
    expect(snapshot.header.cwd).toBe(THIRD_CWD)
    expect((await f.ctx.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([THIRD_CWD])
    await assertNoResidue(f.root)
  })

  it('leaves the intent temporary of a relocation in flight to its writer', async () => {
    const f = await seed('none')
    const intentPath = relocationIntentPath(f.root, f.header.id)
    let listedElsewhere: Array<string | undefined> = []
    interleave('link', path => path.startsWith(`${intentPath}.`), async () => {
      listedElsewhere = (await (await mount(f.root, 'none')).sessionPersistence.list()).map(row => row.header.cwd)
    })
    const snapshot = await f.ctx.sessionPersistence.relocate!(f.header.id, TARGET_CWD)
    expect(listedElsewhere).toEqual([SOURCE_CWD])
    expect(snapshot.header.cwd).toBe(TARGET_CWD)
    await assertMoved(f, f.ctx.sessionPersistence)
  })

  it('removes the intent temporaries of the session it relocates and no others', async () => {
    const f = await seed('none')
    const own = `${relocationIntentPath(f.root, f.header.id)}.0123456789ab.tmp`
    const other = `${relocationIntentPath(f.root, SessionId('other'))}.0123456789ab.tmp`
    await writeFile(own, '{')
    await writeFile(other, '{')
    await f.ctx.sessionPersistence.relocate!(f.header.id, TARGET_CWD)
    expect(await exists(own)).toBe(false)
    expect(await exists(other)).toBe(true)
  })

  it('reports a source directory that keeps unrecognized files after completion', async () => {
    const f = await crashed('published')
    await writeFile(join(f.sourceDir, 'notes.txt'), 'kept')
    const ctx = new Context()
    contexts.push(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression: 'none' })
    expect((await ctx.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([TARGET_CWD])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('holds other files'))
  })

  it('reports a lock failure other than contention', async () => {
    const f = await crashed('staged')
    vi.spyOn(SessionWriteLease, 'acquire').mockRejectedValueOnce(errno('EACCES'))
    const warn = vi.fn()
    await createJsonlRelocationTestRuntime().sweep(f.root, 'none', warn)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
    expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(true)
  })

  it('reports an unlistable root and ignores an absent one', async () => {
    const warn = vi.fn()
    const runtime = createJsonlRelocationTestRuntime({ fs: { readdir: async () => { throw errno('EACCES') } } })
    await runtime.sweep('/root', 'none', warn)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot be listed'))
    const absent = vi.fn()
    await createJsonlRelocationTestRuntime().sweep(join(await freshRoot(), 'absent'), 'none', absent)
    expect(absent).not.toHaveBeenCalled()
  })
})

/** Another process's relocation of the seeded session to `cwd` that dies after `phase` and releases its locks. */
async function deadRelocation(f: Seeded, cwd: string, phase: JsonlRelocationPhase, index?: number): Promise<void> {
  const targetDir = sessionDir(f.root, cwd, f.header.id)
  const headerLine = `${JSON.stringify(toHeaderLine({ ...f.header, cwd }))}\n`
  await crash({ ...f, targetDir, plan: { ...f.plan, targetDir, toCwd: cwd, headerLine } }, 'posix', phase, index)
}

/** A runtime whose `n`th read of the file at `path` returns `rewrite(bytes, n)` instead of the stored bytes. */
function rereading(path: string, rewrite: (bytes: Buffer, read: number) => Buffer) {
  let reads = 0
  return createJsonlRelocationTestRuntime({
    fs: {
      readFile: async (file: string) => {
        const bytes = await readFile(file)
        if (file !== path) return bytes
        reads += 1
        return rewrite(bytes, reads)
      },
    },
  })
}

function retokened(bytes: Buffer): Buffer {
  return Buffer.from(`${JSON.stringify({ ...JSON.parse(bytes.toString('utf8')) as object, token: 'ffffffffffff' })}\n`)
}

describe('intents left by an earlier relocation of the same session', () => {
  it.each(([THIRD_CWD, TARGET_CWD] as const).flatMap(cwd => ([
    ['intent-written', undefined], ['staged', undefined], ['prior-hidden', 0], ['prior-hidden', 1],
  ] as const).map(([phase, index]) => [cwd, phase, index] as const)))(
    'settles a move to %s that died after %s %s between this relocation\'s lookup and its lock, then moves every generation',
    async (cwd, phase, index) => {
      const f = await seed('none')
      let raced = false
      // The seeded backend already recovered the root, so its next root listing is the relocation's lookup.
      interleave('readdir', path => path === f.root, async () => {
        raced = true
        await deadRelocation(f, cwd, phase, index)
      })
      expect((await f.ctx.sessionPersistence.relocate!(f.header.id, TARGET_CWD)).header.cwd).toBe(TARGET_CWD)
      expect(raced).toBe(true)
      await assertMoved(f, f.ctx.sessionPersistence)
    },
  )

  it.each(['posix', 'win32'] as const)('refuses to record its intent over another relocation\'s intent and leaves that intent (%s)', async (platform) => {
    const f = await seed('none')
    await deadRelocation(f, THIRD_CWD, 'prior-hidden', 0)
    const intentPath = relocationIntentPath(f.root, f.header.id)
    const left = await readFile(intentPath)
    const error = await relocateWith(f, platformOverrides(platform)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((error as Error).message).toContain(intentPath)
    expect(await readFile(intentPath)).toEqual(left)
    expect((await readdir(f.root)).filter(name => name.startsWith('.relocate.'))).toEqual([basename(intentPath)])
    expect(await exists(f.targetDir)).toBe(false)
    await assertRolledBack(f, (await mount(f.root, 'none')).sessionPersistence)
  })

  it.each(['posix', 'win32'] as const)('removes its intent temporary and target directory when its intent cannot be published (%s)', async (platform) => {
    const f = await seed('none')
    const intentPath = relocationIntentPath(f.root, f.header.id)
    const refuse = async (from: string, to: string): Promise<void> => {
      if (to === intentPath) throw errno('EIO')
      await (platform === 'win32' ? publishNewSimulated(from, to) : link(from, to))
    }
    const overrides: JsonlRelocationRuntimeOverrides = platform === 'win32'
      ? { ...platformOverrides(platform), publishNewWin32: refuse }
      : { ...platformOverrides(platform), fs: { link: refuse } }
    await expect(relocateWith(f, overrides)).rejects.toMatchObject({ code: 'EIO' })
    expect((await readdir(f.root)).filter(name => name.startsWith('.relocate.'))).toEqual([])
    await assertRolledBack(f, (await mount(f.root, 'none')).sessionPersistence)
  })

  it('settles an intent once it reads the same intent under the locks', async () => {
    const f = await crashed('staged')
    const path = relocationIntentPath(f.root, f.header.id)
    const runtime = rereading(path, (bytes, read) => read === 2 ? retokened(bytes) : bytes)
    expect(await runtime.settle(f.root, 'none', f.header.id)).toBe(true)
    await assertRolledBack(f, (await mount(f.root, 'none')).sessionPersistence)
  })

  it('leaves an intent that changes between every read and its locks', async () => {
    const f = await crashed('staged')
    const path = relocationIntentPath(f.root, f.header.id)
    const runtime = rereading(path, (bytes, read) => read % 2 === 0 ? retokened(bytes) : bytes)
    await expect(runtime.settle(f.root, 'none', f.header.id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    const warn = vi.fn()
    await runtime.sweep(f.root, 'none', warn)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${path}" stays: another holder`))
    for (const [name, print] of f.before) expect(await fingerprint(join(f.sourceDir, name))).toEqual(print)
    expect(await exists(path)).toBe(true)
  })

  it.each([1, 2])('counts an intent another backend removes before read %i as settled', async (gone) => {
    const f = await crashed('staged')
    const path = relocationIntentPath(f.root, f.header.id)
    const runtime = rereading(path, (bytes, read) => {
      if (read === gone) throw errno('ENOENT')
      return bytes
    })
    expect(await runtime.settle(f.root, 'none', f.header.id)).toBe(true)
    expect(await exists(path)).toBe(true)
  })
})

describe('a same-id session stored elsewhere while the moved session is absent', () => {
  it.each((['none', 'zstd'] as const).flatMap(compression => [THIRD_CWD, SOURCE_CWD, TARGET_CWD].map(cwd => [compression, cwd] as const)))(
    '(%s) keeps a move that died with its source hidden unsettled after another process stores the id at %s',
    async (compression, cwd) => {
      const f = await crashed('current-hidden', undefined, compression)
      // This backend recovered the root before the crash, so it sees the session absent, as a sibling process would.
      expect(await f.ctx.sessionPersistence.stat(f.header.id)).toBeUndefined()
      await writeLog(f.ctx.sessionPersistence, meta('relocated', cwd), oneTurnLog().slice(0, 1))
      const intentPath = relocationIntentPath(f.root, f.header.id)
      const { token } = JSON.parse(await readFile(intentPath, 'utf8')) as { token: string }
      const ctx = new Context()
      contexts.push(ctx)
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression })

      expect((await ctx.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([cwd])
      // At most one directory holds the id and its header names it, so a build without relocation lists the root too.
      await assertInvariants(f, false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(intentPath))
      expect(await exists(intentPath)).toBe(true)
      expect(await exists(join(f.sourceDir, relocationHiddenName(f.current, token)))).toBe(true)
      const error = await ctx.sessionPersistence.relocate!(f.header.id, '/elsewhere').catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
      expect((error as Error).message).toContain(intentPath)
    },
  )

  it('stops a move before publishing its target when another process stored the id meanwhile', async () => {
    const f = await seed('none')
    const error = await relocateWith(f, { barrier: async (phase) => {
      if (phase === 'current-hidden') await writeLog(f.ctx.sessionPersistence, meta('relocated', THIRD_CWD), oneTurnLog().slice(0, 1))
    } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((error as Error).message).toContain(relocationIntentPath(f.root, f.header.id))
    expect(await exists(join(f.targetDir, f.current))).toBe(false)
    await assertInvariants(f, false)
    expect((await (await mount(f.root, 'none')).sessionPersistence.list()).map(row => row.header.cwd)).toEqual([THIRD_CWD])
    expect(await exists(relocationIntentPath(f.root, f.header.id))).toBe(true)
  })

  const platformsAndEncodings = (['posix', 'win32'] as const).flatMap(platform => (['none', 'zstd'] as const).map(compression => [platform, compression] as const))

  it.each(platformsAndEncodings)(
    '(%s, %s) keeps a move unsettled when its stage was removed and a same-id session took the target',
    async (platform, compression) => {
      const f = await seed(compression)
      await crash(f, platform, 'current-hidden')
      expect(await f.ctx.sessionPersistence.stat(f.header.id)).toBeUndefined()
      await writeLog(f.ctx.sessionPersistence, meta('relocated', TARGET_CWD), oneTurnLog().slice(0, 1))
      const intentPath = relocationIntentPath(f.root, f.header.id)
      const { token } = JSON.parse(await readFile(intentPath, 'utf8')) as { token: string }
      await unlink(join(f.targetDir, relocationStageName(f.current, token)))
      const ctx = new Context()
      contexts.push(ctx)
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression })

      expect((await ctx.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([TARGET_CWD])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${intentPath}" stays: the target log does not continue the source current generation`))
      expect(await exists(intentPath)).toBe(true)
      expect(await fingerprint(join(f.sourceDir, relocationHiddenName(f.current, token)))).toEqual(f.before.get(f.current))
      for (const name of f.prior) {
        expect(await fingerprint(join(f.targetDir, relocationHiddenName(name, token)))).toEqual(f.before.get(name))
      }
      expect((await readdir(f.targetDir)).filter(isCanonical)).toEqual([f.current])
      const error = await ctx.sessionPersistence.relocate!(f.header.id, '/elsewhere').catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
      expect((error as Error).message).toContain(intentPath)
    },
  )

  it('keeps the stage, the last copy of the moved log, when the hidden source is gone and a same-id session took the target', async () => {
    const f = await crashed('current-hidden')
    await writeLog(f.ctx.sessionPersistence, meta('relocated', TARGET_CWD), oneTurnLog().slice(0, 1))
    const intentPath = relocationIntentPath(f.root, f.header.id)
    const { token } = JSON.parse(await readFile(intentPath, 'utf8')) as { token: string }
    await unlink(join(f.sourceDir, relocationHiddenName(f.current, token)))
    const stage = join(f.targetDir, relocationStageName(f.current, token))
    const staged = await fingerprint(stage)
    const warn = vi.fn()
    await createJsonlRelocationTestRuntime().sweep(f.root, 'none', warn)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the target log does not continue the source current generation'))
    expect(await fingerprint(stage)).toEqual(staged)
    expect(await exists(intentPath)).toBe(true)
  })

  it.each(platformsAndEncodings)(
    '(%s, %s) completes a committed move whose stage is gone and whose target gained events',
    async (platform, compression) => {
      const f = await seed(compression)
      await crash(f, platform, 'published')
      const { token } = JSON.parse(await readFile(relocationIntentPath(f.root, f.header.id), 'utf8')) as { token: string }
      await rm(join(f.targetDir, relocationStageName(f.current, token)), { force: true })
      const appended: SessionEvent = { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } }
      await appendFile(join(f.targetDir, f.current), await encodeRecord(appended, compression))
      const recovered = await mount(f.root, compression)
      expect((await recovered.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([TARGET_CWD])
      expect((await readEvents(recovered.sessionPersistence, f.header.id)).events).toEqual([...f.events, appended])
      for (const name of f.prior) expect(await fingerprint(join(f.targetDir, name))).toEqual(f.before.get(name))
      expect(await exists(f.sourceDir)).toBe(false)
      await assertNoResidue(f.root)
    },
  )

  it.each([['none', 'partial'], ['zstd', 'partial'], ['none', 'unreadable']] as const)(
    '(%s) completes a committed move of a log whose torn tail ends in a %s record once its stage is gone',
    async (compression, last) => {
      const { root, ctx, header, stored } = await tornSession(compression, last)
      const current = generationLogFilename(SESSION_FORMAT_VERSION, compression)
      const sourceDir = sessionDir(root, SOURCE_CWD, header.id)
      // Cleanup removes the stage and then fails on the hidden source, so the in-call settlement compares the target with it.
      fault('unlink', path => path.startsWith(join(sourceDir, `${current}.relocating-`)), 'EACCES', -1)
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

      expect((await ctx.sessionPersistence.relocate!(header.id, TARGET_CWD)).header.cwd).toBe(TARGET_CWD)

      expect(warn.mock.calls.some(call => String(call[0]).includes('later relocation step failed'))).toBe(true)
      expect(await exists(relocationIntentPath(root, header.id))).toBe(true)
      faults.rules.length = 0
      const recovered = await mount(root, compression)
      expect((await recovered.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([TARGET_CWD])
      expect((await readEvents(recovered.sessionPersistence, header.id)).events).toEqual(stored)
      expect(await exists(sourceDir)).toBe(false)
      await assertNoResidue(root)
    },
  )

  it.each(['posix', 'win32'] as const)(
    '(%s) completes a committed move of a log ending in a complete unreadable record once its stage is gone',
    async (platform) => {
      const seeded = await seed('none')
      const source = join(seeded.sourceDir, seeded.current)
      await appendFile(source, '{"type":"turn/start","seq":6,"ti\n')
      // The backend stages the scanner's committed prefix, which ends before the unreadable record.
      const f: Seeded = { ...seeded, plan: { ...seeded.plan, sourceEnd: scanLog(await readFile(source)).committedBytes } }
      expect(f.plan.sourceEnd).toBeLessThan((await stat(source)).size)
      await crash(f, platform, 'published')
      const { token } = JSON.parse(await readFile(relocationIntentPath(f.root, f.header.id), 'utf8')) as { token: string }
      // Windows consumes the stage when publishing; on POSIX a completion that died after removing it leaves this state.
      await rm(join(f.targetDir, relocationStageName(f.current, token)), { force: true })
      const ctx = new Context()
      contexts.push(ctx)
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression: 'none' })
      expect((await ctx.sessionPersistence.list()).map(row => row.header.cwd)).toEqual([TARGET_CWD])
      expect(warn).not.toHaveBeenCalled()
      expect((await readEvents(ctx.sessionPersistence, f.header.id)).events).toEqual(f.events)
      for (const name of f.prior) expect(await fingerprint(join(f.targetDir, name))).toEqual(f.before.get(name))
      expect(await exists(f.sourceDir)).toBe(false)
      await assertNoResidue(f.root)
    },
  )

  it.each(platformsAndEncodings)(
    '(%s, %s) keeps a move of a header-only session unsettled when its stage was removed and a same-id session took the target',
    async (platform, compression) => {
      const seeded = await seed(compression)
      await writeFile(join(seeded.sourceDir, seeded.current), await encodeRecord(toHeaderLine(seeded.header), compression))
      const f: Seeded = { ...seeded, events: [], plan: { ...seeded.plan, eventCount: 0 } }
      const original = await fingerprint(join(f.sourceDir, f.current))
      await crash(f, platform, 'current-hidden')
      // A header-only newcomer leaves the bodies equal, so only its header record tells the two sessions apart.
      const newcomer = await f.ctx.sessionPersistence.create({ ...meta('relocated', TARGET_CWD), createdAt: 2000 })
      await newcomer.flush()
      await newcomer.close()
      const intentPath = relocationIntentPath(f.root, f.header.id)
      const { token } = JSON.parse(await readFile(intentPath, 'utf8')) as { token: string }
      await unlink(join(f.targetDir, relocationStageName(f.current, token)))
      const ctx = new Context()
      contexts.push(ctx)
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      await ctx.plugin(JsonlSessionPersistence, { root: f.root, compression })

      expect((await ctx.sessionPersistence.list()).map(row => row.header.createdAt)).toEqual([2000])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${intentPath}" stays: the target log does not continue the source current generation`))
      expect(await exists(intentPath)).toBe(true)
      expect(await fingerprint(join(f.sourceDir, relocationHiddenName(f.current, token)))).toEqual(original)
    },
  )

  it.each([
    ['beyond the hidden source current generation', (length: number) => length + 1],
    ['inside its header record', () => 0],
  ] as const)('keeps a committed move unsettled when its intent records a committed length %s', async (_case, forge) => {
    const f = await crashed('published')
    const intentPath = relocationIntentPath(f.root, f.header.id)
    const intent = JSON.parse(await readFile(intentPath, 'utf8')) as { token: string; sourceEnd: number }
    const hidden = join(f.sourceDir, relocationHiddenName(f.current, intent.token))
    expect(intent.sourceEnd).toBe((await stat(hidden)).size)
    await writeFile(intentPath, JSON.stringify({ ...intent, sourceEnd: forge(intent.sourceEnd) }))
    await unlink(join(f.targetDir, relocationStageName(f.current, intent.token)))
    const warn = vi.fn()
    await createJsonlRelocationTestRuntime().sweep(f.root, 'none', warn)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the target log does not continue the source current generation'))
    expect(await exists(intentPath)).toBe(true)
    expect(await fingerprint(hidden)).toEqual(f.before.get(f.current))
  })
})

/**
 * Run one action inside each of the next write-open lock acquisitions, before
 * the real acquisition; acquisitions the actions themselves make pass through.
 */
function beforeLocking(actions: Array<(dir: string, id: SessionId) => Promise<void>>): void {
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  let nested = 0
  vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, id) => {
    const action = nested === 0 ? actions.shift() : undefined
    if (action !== undefined) {
      nested += 1
      try {
        await action(dir, id)
      } finally {
        nested -= 1
      }
    }
    return acquire(dir, id)
  })
}

describe('write open after a concurrent relocation', () => {
  it('locks the session at its new location instead of the recreated old directory', async () => {
    const f = await seed('none')
    const other = await mount(f.root, 'none')
    beforeLocking([async (_dir, id) => { await other.sessionPersistence.relocate!(id, TARGET_CWD) }])
    const writer = await f.ctx.sessionPersistence.open(f.header.id, 'write')
    expect(writer.header.cwd).toBe(TARGET_CWD)
    await writer.append([{ type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } }])
    await expect(SessionWriteLease.acquire(f.targetDir, f.header.id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await writer.close()
    expect(await exists(f.sourceDir)).toBe(false)
    expect((await readEvents(other.sessionPersistence, f.header.id)).events).toHaveLength(7)
  })

  it('refuses after a second concurrent move and reports a session that vanished', async () => {
    const f = await seed('none')
    const other = await mount(f.root, 'none')
    beforeLocking([
      async (_dir, id) => { await other.sessionPersistence.relocate!(id, TARGET_CWD) },
      async (_dir, id) => { await other.sessionPersistence.relocate!(id, '/work/third') },
    ])
    await expect(f.ctx.sessionPersistence.open(f.header.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    expect(await exists(f.sourceDir)).toBe(false)
    expect(await exists(f.targetDir)).toBe(false)
    vi.restoreAllMocks()

    beforeLocking([
      async (_dir, id) => { await other.sessionPersistence.relocate!(id, TARGET_CWD) },
      async (dir) => {
        for (const name of [...f.prior, f.current]) await rm(join(dir, name))
      },
    ])
    await expect(f.ctx.sessionPersistence.open(f.header.id, 'write')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    expect(await exists(f.targetDir)).toBe(false)
  })

  it('releases its lock when re-resolution fails', async () => {
    const f = await seed('none')
    const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
    vi.spyOn(SessionWriteLease, 'acquire').mockImplementationOnce(async (dir, id) => {
      const lease = await acquire(dir, id)
      fault('readdir', path => path === f.root, 'EACCES')
      return lease
    })
    await expect(f.ctx.sessionPersistence.open(f.header.id, 'write')).rejects.toMatchObject({ code: 'EACCES' })
    const lease = await SessionWriteLease.acquire(f.sourceDir, f.header.id)
    await lease.release()
  })
})

describe('relocation runtime directory probes', () => {
  it('compares physical directories and discards only lock-only directories', async () => {
    const root = await freshRoot()
    const runtime = createJsonlRelocationTestRuntime()
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    expect(await runtime.isSameDirectory(join(root, 'a'), join(root, 'a'))).toBe(true)
    expect(await runtime.isSameDirectory(join(root, 'a'), join(root, 'b'))).toBe(false)
    expect(await runtime.isSameDirectory(join(root, 'missing'), join(root, 'a'))).toBe(false)
    expect(await runtime.isSameDirectory(join(root, 'a'), join(root, 'missing'))).toBe(false)
    await expect(createJsonlRelocationTestRuntime({ fs: { stat: async () => { throw errno('EACCES') } } })
      .isSameDirectory(join(root, 'a'), join(root, 'b'))).rejects.toMatchObject({ code: 'EACCES' })

    await writeFile(join(root, 'a', 'kept'), '')
    await runtime.discardDirectory(join(root, 'a'))
    await runtime.discardDirectory(join(root, 'missing'))
    await writeFile(join(root, 'b', LEASE_FILENAME), '')
    await runtime.discardDirectory(join(root, 'b'))
    expect(await readdir(root)).toEqual(['a'])
    await expect(createJsonlRelocationTestRuntime({ fs: { readdir: async () => { throw errno('EACCES') } } })
      .discardDirectory(join(root, 'a'))).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('tells directories on different devices apart even when their inode numbers match', async () => {
    const runtime = createJsonlRelocationTestRuntime({
      fs: { stat: async (path: string) => ({ dev: path.startsWith('/a') ? 1n : 2n, ino: 7n }) },
    })
    expect(await runtime.isSameDirectory('/a', '/a-alias')).toBe(true)
    expect(await runtime.isSameDirectory('/a', '/b')).toBe(false)
  })
})
