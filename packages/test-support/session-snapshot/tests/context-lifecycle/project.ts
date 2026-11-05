/**
 * Structure-preserving redaction of a real Session log (v4 `.jsonl`) into a
 * replayable fixture.
 *
 * The output keeps every event's type, ordering, ids (re-minted), turn/step,
 * surface operations and tool-call pairing, and keeps message *structure*
 * (roles, content block types) so a fixture can be appended to a `Session` and
 * driven through the real loop. Content is replaced by `<redacted:class:bytes>`
 * placeholders that preserve the original UTF-8 byte length, so a fixture still
 * proves shrink and budget arithmetic. Item identities harvested from the raw
 * log (provider and model names) are forbidden from the output by default.
 *
 * Usage:
 *   tsx project.ts <raw.jsonl> <out-dir> [--name <class>] [--range from:to]
 *
 * Writes `<out-dir>/session.jsonl` and `<out-dir>/meta.json`. The raw log is
 * only read.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Keys whose string values are product enums and survive verbatim. */
const ENUM_KEYS = new Set([
  'type', 'role', 'kind', 'status', 'op', 'reason', 'mode', 'policyKey', 'blockType',
  'producerReported', 'startsSeries', 'sourceKind', 'outcome', 'operation', 'eventKind',
  'preset', 'agentPreset', 'encoding', 'format', 'causeKind', 'name',
])

/** Numeric or boolean scalars that are evidence, not content. */
const NUMERIC_KEYS = new Set([
  'turn', 'step', 'seq', 'startSeq', 'endSeq', 'start', 'target', 'removedCount',
  'shadowedSeqs', 'shadowedRange', 'shadowedTokenCount', 'contextWindow', 'maxTokens',
  'retry', 'maxRetries', 'delayMs', 'version', 'isSeeded', 'delegationDepth',
  'inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens',
  'startedAt', 'finishedAt', 'createdAt', 'childCreatedAt',
])

/** Keys holding opaque identifiers; re-minted consistently across events. */
const ID_KINDS = {
  callId: 'call', toolCallId: 'call', jobId: 'job', compactionId: 'comp',
  childId: 'child', teamId: 'team', memberId: 'member', taskId: 'task',
  retryId: 'retry', sessionId: 'session', id: 'id', owner: 'owner',
  turnId: 'turn', stepId: 'step', toolName: 'mcp',
} as const

/**
 * The single source of truth for what a content string becomes. Projection and
 * the self-check both read this: a value that is neither an enum, an identifier,
 * a number, nor a bare tool name must serialize as `<redacted:class:bytes>`.
 */
const REDACTION_CLASS: Readonly<Record<string, string>> = {
  model: 'model',
  provider: 'provider',
  summary: 'summary',
  rawOutput: 'summary',
  arguments: 'arguments',
  command: 'command',
  cwd: 'path',
  path: 'path',
  text: 'text',
  content: 'text',
  message: 'text',
  label: 'text',
  description: 'text',
  prompt: 'text',
  title: 'text',
  subject: 'text',
  detail: 'text',
  value: 'text',
  inserted: 'text',
  changes: 'text',
  error: 'error',
  failure: 'error',
  cause: 'error',
  header: 'header',
  systemPrompt: 'header',
  tools: 'header',
}

const PATH_RE = /(?:\/Users\/|\/Volumes\/|\/private\/|\/home\/|[A-Za-z]:\\)/
const PLACEHOLDER_RE = /^<redacted:[a-z]+:\d+>$/
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/i

/** A projected event: the committed fixture row (no `seq`/`time` envelope). */
export interface ProjectedEvent {
  readonly type: string
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: readonly number[]
}

/** What one projection run produced. */
export interface ProjectionStats {
  readonly events: number
  readonly bytes: number
  readonly maxLineBytes: number
  readonly toolCalls: number
  readonly toolResults: number
  readonly compactions: number
  readonly redactions: number
  /** Redacted UTF-8 bytes by class, so a fixture can report what it hid. */
  readonly redactedBytes: Readonly<Record<string, number>>
}

/** Options for one projection run. */
export interface ProjectionOptions {
  /** Strings that must never appear in the output. Defaults to harvested identities. */
  readonly forbidden?: readonly string[]
  /** Reject a projected line larger than this many UTF-8 bytes. */
  readonly maxLineBytes?: number
}

/** Everything the sanitization pass refuses to find in a projected fixture. */
export interface SanitizationReport {
  readonly pathHits: number
  readonly longLines: number
  readonly forbiddenHits: number
  readonly unredactedContent: number
  readonly orphanCalls: number
  readonly orphanResults: number
}

/** Re-mints identifiers so one raw id maps to one token everywhere. */
class Minter {
  private readonly maps = new Map<string, Map<string, string>>()
  readonly counts: Record<string, number> = {}

  mint(key: string, raw: string): string {
    const kind = ID_KINDS[key as keyof typeof ID_KINDS] ?? 'id'
    let map = this.maps.get(key)
    if (map === undefined) { map = new Map(); this.maps.set(key, map) }
    let token = map.get(raw)
    if (token === undefined) {
      this.counts[key] = (this.counts[key] ?? 0) + 1
      token = `${kind}-${String(this.counts[key]).padStart(4, '0')}`
      map.set(raw, token)
    }
    return token
  }
}

/** Two byte counters: how many redactions, and how many bytes each class hid. */
interface RedactionTally {
  redactions: number
  readonly bytes: Record<string, number>
}

function placeholder(redactionClass: string, value: string, tally: RedactionTally): string {
  const bytes = Buffer.byteLength(value, 'utf8')
  tally.redactions += 1
  tally.bytes[redactionClass] = (tally.bytes[redactionClass] ?? 0) + bytes
  return `<redacted:${redactionClass}:${bytes}>`
}

/** Classify a content string; `path` wins over the key's own class. */
function classOf(key: string, value: string): string {
  if (PATH_RE.test(value)) return 'path'
  return REDACTION_CLASS[key] ?? 'text'
}

function isStructuralLiteral(key: string, value: string): boolean {
  if (PLACEHOLDER_RE.test(value) || value === '<trimmed:blocks>') return true
  if (value === 'session-fixture' || value === '/work/fixture') return true
  if (STRUCTURAL_KEYS.has(key)) return !/\s/.test(value) && Buffer.byteLength(value) <= 64
  if (key in ID_KINDS) return TOKEN_RE.test(value)
  if (key === 'name') return TOOL_NAME_RE.test(value) && !value.startsWith('mcp__')
  return false
}

/** Keys whose surviving literals are wiring, not gathered content. */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  ...ENUM_KEYS, ...NUMERIC_KEYS, ...Object.keys(ID_KINDS),
  'surfaceOp', 'op', 'startSeq', 'endSeq', 'reason', 'startsSeries',
])

const TOKEN_RE = /^[a-z]+-\d{4}$/

function projectValue(value: unknown, key: string, minter: Minter, tally: RedactionTally): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    // MCP tool names embed the server (and therefore vendor) name; mint them.
    if (key === 'name' && value.startsWith('mcp__')) return minter.mint('toolName', value)
    if (key in ID_KINDS) return minter.mint(key, value)
    if (isStructuralLiteral(key, value)) return value
    return placeholder(classOf(key, value), value, tally)
  }
  if (Array.isArray(value)) return value.map(entry => projectValue(entry, key, minter, tally))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (['time', 'createdAt', 'startedAt', 'finishedAt', 'seq', 'seq0', 'time0'].includes(childKey)) continue
      out[childKey] = projectValue(childValue, childKey, minter, tally)
    }
    return out
  }
  return null
}

/** Keep only the surface-operation evidence a fixture needs. */
function projectSurfaceOp(value: unknown): unknown {
  if (value === 'append') return 'append'
  if (value !== null && typeof value === 'object') {
    const op = value as Record<string, unknown>
    return { op: op['op'], startSeq: op['startSeq'], endSeq: op['endSeq'] }
  }
  return value
}

/** Project one parsed raw event. */
export function projectEvent(raw: Record<string, unknown>, minter: Minter, tally: RedactionTally): ProjectedEvent {
  const type = String(raw['type'])
  if (type === 'session') {
    return {
      type,
      data: {
        version: raw['version'],
        isSeeded: raw['isSeeded'],
        delegationDepth: raw['delegationDepth'],
        agentPreset: raw['agentPreset'],
        id: 'session-fixture',
        cwd: '/work/fixture',
      },
    }
  }
  // Request headers carry the system prompt and every tool schema: the largest
  // payloads in the log, and none of the boundary assertions need them.
  if (type === 'request/header') {
    const data = raw['data'] as Record<string, unknown> | undefined
    const header = typeof data?.['header'] === 'undefined' ? undefined : '<redacted:header:0>'
    return { type, data: { reason: data?.['reason'], startsSeries: data?.['startsSeries'], header } }
  }
  const data = capPayload(type, projectValue(raw['data'] ?? {}, '', minter, tally) as Record<string, unknown>)
  const sourceEventSeqs = sourceEventSeqsOf(raw)
  return {
    type,
    data,
    ...'surfaceOp' in raw ? { surfaceOp: projectSurfaceOp(raw['surfaceOp']) } : {},
    ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs },
  }
}

/**
 * Read a raw `sourceEventSeqs` as event numbers.
 * @param raw - parsed fixture row
 * @returns the validated numbers, or undefined when the row carries none
 */
function sourceEventSeqsOf(raw: Record<string, unknown>): readonly number[] | undefined {
  if (!Object.hasOwn(raw, 'sourceEventSeqs')) return undefined
  const value = raw['sourceEventSeqs']
  if (!Array.isArray(value)) throw new Error('projectEvent: sourceEventSeqs must be an array')
  return value.map((entry: unknown) => {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) {
      throw new Error(`projectEvent: sourceEventSeqs must hold integers, saw ${typeof entry}`)
    }
    return entry
  })
}

/**
 * Bound each event's size while keeping its structural evidence. A recorded
 * provider stream is trimmed to its ends, tool-result and summary bodies to
 * their leading blocks, job labels dropped. Package-level fixtures drive a
 * scripted adapter, so the trimmed tails carry no assertion weight.
 */
function capPayload(type: string, data: Record<string, unknown>): Record<string, unknown> {
  if (type === 'assistant/message') {
    const message = data['message'] as Record<string, unknown> | undefined
    if (message !== undefined && Array.isArray(message['content'])) message['content'] = trim(message['content'], 2)
    const stream = data['stream']
    if (Array.isArray(stream) && stream.length > 4) data['stream'] = [stream[0], stream[stream.length - 1]]
  }
  if (type === 'tool/result' || type === 'developer/message' || type === 'user/message' || type === 'system/message') {
    const message = (data['message'] ?? data) as Record<string, unknown> | undefined
    if (message !== undefined && Array.isArray(message['content'])) {
      message['content'] = trim(message['content'], type === 'tool/result' ? 1 : 2)
    }
  }
  if (type === 'compaction/summary') {
    delete data['rawOutput']
    data['summary'] = '<redacted:summary:0>'
  }
  if (type === 'tool/result' && data['meta'] !== undefined) {
    data['meta'] = boundArrays(data['meta'], 3)
  }
  if (type === 'job/registered' || type === 'job/settled') {
    delete data['label']
    if (typeof data['detail'] !== 'undefined') data['detail'] = placeholder('text', '', { redactions: 0, bytes: {} })
  }
  return data
}

/** Cap every array inside a tool-result metadata blob so one event stays small. */
function boundArrays(node: unknown, keep: number): unknown {
  if (Array.isArray(node)) {
    const head = node.slice(0, keep).map(entry => boundArrays(entry, keep))
    return node.length <= keep ? head : [...head, '<trimmed:blocks>']
  }
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) out[key] = boundArrays(value, keep)
  return out
}

function trim(blocks: readonly unknown[], keep: number): unknown[] {
  return blocks.length <= keep ? [...blocks] : [...blocks.slice(0, keep), '<trimmed:blocks>']
}

/** Every provider/model string the raw log mentions, in first-seen order. */
export function harvestIdentities(raw: string): string[] {
  const found = new Set<string>()
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    collect(JSON.parse(line) as Record<string, unknown>, found)
  }
  return [...found].filter(value => value.length >= 3 && !PATH_RE.test(value)).sort()
}

function collect(node: unknown, found: Set<string>): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const entry of node) collect(entry, found); return }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key === 'model' || key === 'provider') && typeof value === 'string' && value.length >= 3) found.add(value)
    collect(value, found)
  }
}

/** Check a projected fixture against every leak, redaction and pairing rule. */
export function assertSanitized(
  lines: readonly string[],
  options: ProjectionOptions = {},
): SanitizationReport {
  const maxLineBytes = options.maxLineBytes ?? 4096
  const forbidden = options.forbidden ?? []
  let pathHits = 0
  let longLines = 0
  let forbiddenHits = 0
  let unredactedContent = 0
  const examples: string[] = []
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const line of lines) {
    if (Buffer.byteLength(line) > maxLineBytes) longLines += 1
    if (PATH_RE.test(line)) pathHits += 1
    for (const word of forbidden) {
      if (!lineMentions(line, word)) continue
      forbiddenHits += 1
      if (examples.length < 5) examples.push(`${word} in ${line.slice(0, 120)}`)
    }
    const event = JSON.parse(line) as { type?: string; data?: Record<string, unknown> }
    unredactedContent += countUnredacted(event)
    const callId = asString(event.data?.['callId'])
    if (event.type === 'tool/call' && callId !== undefined) calls.add(callId)
    if (event.type === 'tool/result') {
      const message = event.data?.['message'] as Record<string, unknown> | undefined
      const resultId = asString(message?.['toolCallId'])
      if (resultId !== undefined) results.add(resultId)
    }
  }
  const orphanCalls = [...calls].filter(id => !results.has(id)).length
  const orphanResults = [...results].filter(id => !calls.has(id)).length
  const report = { pathHits, longLines, forbiddenHits, unredactedContent, orphanCalls, orphanResults }
  if (pathHits > 0) throw new Error(`fixture leaks ${pathHits} path-looking lines`)
  if (longLines > 0) throw new Error(`fixture has ${longLines} lines over ${maxLineBytes} bytes`)
  if (forbiddenHits > 0) {
    throw new Error(`fixture repeats ${forbiddenHits} forbidden identity occurrences: ${examples.join(' | ')}`)
  }
  if (unredactedContent > 0) throw new Error(`fixture has ${unredactedContent} content strings that are neither redacted nor structural`)
  if (orphanCalls > 0 || orphanResults > 0) {
    throw new Error(`fixture breaks tool pairing: ${orphanCalls} orphan calls, ${orphanResults} orphan results`)
  }
  return report
}

/**
 * A harvested identity counts as a leak when it appears as a whole string value,
 * or as a substring of one when the identity names a routed path (`a/b`). Plain
 * substring matching would flag unrelated tool names that merely contain it.
 */
function lineMentions(line: string, identity: string): boolean {
  if (!identity.includes('/') && !line.includes(identity)) return false
  let hit = false
  walk(JSON.parse(line), (value) => {
    if (value === identity || (identity.includes('/') && value.includes(identity))) hit = true
  })
  return hit
}

function walk(node: unknown, visit: (value: string) => void): void {
  if (typeof node === 'string') { visit(node); return }
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const entry of node) walk(entry, visit); return }
  for (const value of Object.values(node as Record<string, unknown>)) walk(value, visit)
}

/**
 * Read one string field of an untrusted JSON record.
 * @param value - candidate taken from a parsed row
 * @returns the value when it is a string, else undefined
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function countUnredacted(node: unknown, key = ''): number {
  if (typeof node === 'string') {
    if (PLACEHOLDER_RE.test(node) || node === '<trimmed:blocks>') return 0
    return isStructuralLiteral(key, node) ? 0 : 1
  }
  if (node === null || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce<number>((sum, entry) => sum + countUnredacted(entry, key), 0)
  let total = 0
  for (const [childKey, value] of Object.entries(node as Record<string, unknown>)) total += countUnredacted(value, childKey)
  return total
}

/** Project a raw Session log into fixture lines plus its statistics. */
export function projectSession(
  raw: string,
  options: ProjectionOptions = {},
): { lines: string[]; stats: ProjectionStats } {
  const forbidden = options.forbidden ?? harvestIdentities(raw)
  const rows = raw.split('\n').filter(line => line.trim().length > 0)
  const minter = new Minter()
  const tally: RedactionTally = { redactions: 0, bytes: {} }
  const events = rows.map(row => projectEvent(JSON.parse(row) as Record<string, unknown>, minter, tally))
  const lines = events.map(event => JSON.stringify(event))
  assertSanitized(lines, options.maxLineBytes === undefined
    ? { forbidden }
    : { forbidden, maxLineBytes: options.maxLineBytes })
  let toolCalls = 0
  let toolResults = 0
  let compactions = 0
  for (const event of events) {
    if (event.type === 'tool/call') toolCalls += 1
    if (event.type === 'tool/result') toolResults += 1
    if (event.type.startsWith('compaction/')) compactions += 1
  }
  const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
  const maxLineBytes = lines.reduce((max, line) => Math.max(max, Buffer.byteLength(line)), 0)
  return {
    lines,
    stats: {
      events: events.length, bytes, maxLineBytes, toolCalls, toolResults, compactions,
      redactions: tally.redactions, redactedBytes: tally.bytes,
    },
  }
}

/** Keep only events whose projected position falls inside an inclusive range. */
export function sliceLines(lines: readonly string[], from: number, to: number): string[] {
  return lines.slice(from - 1, to)
}

/** Keep the session header plus every event whose original `seq` falls in range. */
function selectBySeq(raw: string, from: number, to: number): string {
  const kept = raw.split('\n').filter((line) => {
    if (line.trim().length === 0) return false
    const event = JSON.parse(line) as { type?: string; seq?: number }
    if (event.type === 'session') return true
    return typeof event.seq === 'number' && event.seq >= from && event.seq <= to
  })
  return `${kept.join('\n')}\n`
}

async function main(): Promise<void> {
  const [rawPath, outDir, ...rest] = process.argv.slice(2)
  if (rawPath === undefined || outDir === undefined) {
    throw new Error('usage: project.ts <raw.jsonl> <out-dir> [--name class] [--range from:to] [--max-line bytes]')
  }
  const raw = await readFile(rawPath, 'utf8')
  const range = option(rest, '--range')
  const seqRange = option(rest, '--seq-range')
  const maxLineBytes = Number(option(rest, '--max-line') ?? '4096')
  const source = seqRange === undefined ? raw : selectBySeq(raw, ...parseRange(seqRange))
  const { lines, stats } = projectSession(source, { maxLineBytes })
  const selected = range === undefined ? lines : sliceLines(lines, ...parseRange(range))
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'session.jsonl'), `${selected.join('\n')}\n`)
  const meta = {
    name: option(rest, '--name') ?? 'context-lifecycle',
    source: 'current DSH session (read-only copy)',
    events: selected.length,
    bytes: selected.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0),
    maxLineBytes: selected.reduce((max, line) => Math.max(max, Buffer.byteLength(line)), 0),
    toolCalls: stats.toolCalls,
    toolResults: stats.toolResults,
    compactions: stats.compactions,
    redactions: stats.redactions,
    redactedBytes: stats.redactedBytes,
    range: range ?? 'all',
  }
  await writeFile(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`)
}

function option(rest: readonly string[], flag: string): string | undefined {
  const index = rest.indexOf(flag)
  return index === -1 ? undefined : rest[index + 1]
}

function parseRange(value: string): [number, number] {
  const [from, to] = value.split(':').map(Number)
  if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error(`bad --range ${value}`)
  }
  return [from, to]
}

if (process.argv[1]?.endsWith('project.ts') === true) await main()
