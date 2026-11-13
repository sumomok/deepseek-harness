/** Strict historical patch approvals and their JSON string locations. */

import ts from 'typescript'

/** The only repository-relative path that can declare historical patch identities. */
export const CORE_PATCHES_HISTORY_PATH = '.claude/core-patches-history.json'

/** One explicitly approved historical commit without a Patch trailer. */
export interface CorePatchesHistoryEntry {
  /** Full lowercase commit object identifier. */
  commit: string
  /** Exact Git subject. */
  subject: string
  /** Registered patch family, including retired families. */
  patch: string
  /** Nonempty approval rationale. */
  reason: string
}

/** Version one permits one to three approvals strictly before the cutoff. */
export interface CorePatchesHistory {
  /** Supported manifest version. */
  version: 1
  /** Full lowercase commit identifier on HEAD's first-parent chain. */
  cutoff: string
  /** Explicit approvals; commit identifiers are unique. */
  entries: CorePatchesHistoryEntry[]
}

/** A JSON string's decoded value and exact source interval, including quotes. */
export interface HistoryStringToken {
  /** UTF-16 source offset of the opening quote. */
  start: number
  /** Exclusive UTF-16 source offset after the closing quote. */
  end: number
  /** Decoded string, including Unicode escapes. */
  value: string
}

/** Invalid manifests grant no reference exemptions; string tokens remain inspectable. */
export type CorePatchesHistoryParseResult = {
  /** Every JSON string token, including property names, for reference inspection. */
  stringTokens: HistoryStringToken[]
} & ({
  /** Schema-validated manifest; Git validation is a separate step. */
  manifest: CorePatchesHistory
  /** Only cutoff and entries[].commit value tokens. */
  referenceTokens: HistoryStringToken[]
  /** No error for a valid manifest. */
  error: null
} | {
  /** Invalid input has no usable manifest. */
  manifest: null
  /** Invalid input grants no exemptions. */
  referenceTokens: []
  /** Actionable parsing or schema failure. */
  error: string
})

/**
 * Parse strict JSON and the version-one schema, rejecting duplicate decoded keys.
 * @param source - Complete manifest text.
 * @returns Typed approvals and exact reference tokens, or an error with no exemptions.
 */
export function parseCorePatchesHistory(source: string): CorePatchesHistoryParseResult {
  const file = ts.parseJsonText(CORE_PATCHES_HISTORY_PATH, source)
  const stringTokens: HistoryStringToken[] = []
  const token = (node: ts.StringLiteral): HistoryStringToken => ({ start: node.getStart(file), end: node.end, value: node.text })
  function collect(node: ts.Node): void {
    if (ts.isStringLiteral(node)) stringTokens.push(token(node))
    ts.forEachChild(node, collect)
  }
  collect(file)
  try {
    // TypeScript accepts JSON extensions; the native parser enforces JSON syntax.
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
    function string(node: ts.Node | undefined, field: string, pattern?: RegExp): ts.StringLiteral {
      if (node === undefined || !ts.isStringLiteral(node) || node.text.trim() === '' || (pattern !== undefined && !pattern.test(node.text))) {
        throw new Error(`invalid ${field}`)
      }
      return node
    }
    const fullSha = /^[0-9a-f]{40}$/u
    const fields = object(file.statements[0]?.expression, ['version', 'cutoff', 'entries'])
    const version = fields.get('version')
    if (version === undefined || !ts.isNumericLiteral(version) || Number(version.text) !== 1) throw new Error('version must be 1')
    const cutoff = string(fields.get('cutoff'), 'cutoff (full lowercase commit SHA required)', fullSha)
    const entriesNode = fields.get('entries')
    if (entriesNode === undefined || !ts.isArrayLiteralExpression(entriesNode)
      || entriesNode.elements.length < 1 || entriesNode.elements.length > 3) {
      throw new Error('entries must contain one to three approvals')
    }
    const referenceTokens = [token(cutoff)]
    const commits = new Set<string>()
    const entries = entriesNode.elements.map((node): CorePatchesHistoryEntry => {
      const entry = object(node, ['commit', 'subject', 'patch', 'reason'])
      const commit = string(entry.get('commit'), 'commit (full lowercase commit SHA required)', fullSha)
      if (commits.has(commit.text)) throw new Error('duplicate commit')
      commits.add(commit.text)
      referenceTokens.push(token(commit))
      return {
        commit: commit.text,
        subject: string(entry.get('subject'), 'subject').text,
        patch: string(entry.get('patch'), 'patch slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/u).text,
        reason: string(entry.get('reason'), 'reason').text,
      }
    })
    return { manifest: { version: 1, cutoff: cutoff.text, entries }, referenceTokens, stringTokens, error: null }
  } catch (cause) {
    return { manifest: null, referenceTokens: [], stringTokens, error: cause instanceof Error ? cause.message : String(cause) }
  }
}
