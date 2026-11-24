/** Explicit approvals for upstream merges accepted before the declared cutoff. */
import ts from 'typescript'
import type { HistoryStringToken } from './core-patches-history.ts'

/** The sole operational manifest for historical upstream merges. */
export const CORE_PATCHES_UPSTREAM_MERGES_PATH = '.claude/core-patches-upstream-merges.json'

/** Exact commit identities; the commit also binds its Git subject and tree. */
export interface HistoricalUpstreamMerge {
  /** Full lowercase identity of the merge commit. */
  commit: string
  /** Exact first parent on the patch line. */
  firstParent: string
  /** Exact second parent from upstream history. */
  upstream: string
  /** Nonempty rationale for retaining the prior approval. */
  reason: string
}

/** Version one permits one to two historical merge approvals, independently of trailer identities. */
export interface CorePatchesUpstreamMerges {
  /** Supported manifest version. */
  version: 1
  /** First-parent commit strictly after every approved merge. */
  cutoff: string
  /** Explicit approvals (one to two unique merge commits). */
  entries: HistoricalUpstreamMerge[]
}

/** Invalid inputs grant no operational reference exemptions. */
export interface UpstreamMergesParseResult {
  manifest: CorePatchesUpstreamMerges | null
  referenceTokens: HistoryStringToken[]
  stringTokens: HistoryStringToken[]
  error: string | null
}

/**
 * Parse the bounded manifest without accepting JSON extensions or duplicate decoded keys.
 * @param source - Complete JSON text.
 * @returns Strictly typed identities and their exact token intervals, or a failure.
 */
export function parseCorePatchesUpstreamMerges(source: string): UpstreamMergesParseResult {
  const file = ts.parseJsonText(CORE_PATCHES_UPSTREAM_MERGES_PATH, source)
  const stringTokens: HistoryStringToken[] = []
  const token = (node: ts.StringLiteral): HistoryStringToken => ({ start: node.getStart(file), end: node.end, value: node.text })
  function collect(node: ts.Node): void {
    if (ts.isStringLiteral(node)) stringTokens.push(token(node))
    ts.forEachChild(node, collect)
  }
  collect(file)
  try {
    JSON.parse(source)
    function object(node: ts.Node | undefined, keys: readonly string[]): Map<string, ts.Expression> {
      if (node === undefined || !ts.isObjectLiteralExpression(node)) throw new Error('expected an object')
      const fields = new Map<string, ts.Expression>()
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) throw new Error('expected quoted object keys')
        const key = property.name.text
        if (fields.has(key)) throw new Error(`duplicate JSON key: ${key}`)
        if (!keys.includes(key)) throw new Error(`unknown field: ${key}`)
        fields.set(key, property.initializer)
      }
      if (fields.size !== keys.length) throw new Error(`expected exactly these fields: ${keys.join(', ')}`)
      return fields
    }
    const references: HistoryStringToken[] = []
    function string(node: ts.Node | undefined, field: string, identity = false): string {
      if (node === undefined || !ts.isStringLiteral(node) || node.text.trim() === ''
        || (identity && !/^[0-9a-f]{40}$/u.test(node.text))) throw new Error(`invalid ${field}`)
      if (identity) references.push(token(node))
      return node.text
    }
    const fields = object(file.statements[0]?.expression, ['version', 'cutoff', 'entries'])
    const version = fields.get('version')
    if (version === undefined || !ts.isNumericLiteral(version) || Number(version.text) !== 1) throw new Error('version must be 1')
    const cutoff = string(fields.get('cutoff'), 'cutoff (full lowercase commit SHA required)', true)
    const entriesNode = fields.get('entries')
    if (entriesNode === undefined || !ts.isArrayLiteralExpression(entriesNode)
      || entriesNode.elements.length < 1 || entriesNode.elements.length > 2) {
      throw new Error('entries must contain one to two historical upstream merges')
    }
    const commits = new Set<string>()
    const entries = entriesNode.elements.map((node): HistoricalUpstreamMerge => {
      const entry = object(node, ['commit', 'firstParent', 'upstream', 'reason'])
      const commit = string(entry.get('commit'), 'commit (full lowercase commit SHA required)', true)
      if (commits.has(commit)) throw new Error('duplicate commit')
      commits.add(commit)
      return {
        commit,
        firstParent: string(entry.get('firstParent'), 'firstParent (full lowercase commit SHA required)', true),
        upstream: string(entry.get('upstream'), 'upstream (full lowercase commit SHA required)', true),
        reason: string(entry.get('reason'), 'reason'),
      }
    })
    return { manifest: { version: 1, cutoff, entries }, referenceTokens: references, stringTokens, error: null }
  } catch (cause) {
    return { manifest: null, referenceTokens: [], stringTokens, error: cause instanceof Error ? cause.message : String(cause) }
  }
}
