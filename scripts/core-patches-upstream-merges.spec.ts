import { describe, expect, it } from 'vitest'
import { parseCorePatchesUpstreamMerges } from './core-patches-upstream-merges.ts'

const cutoff = 'ab'.repeat(20)
const entry = { commit: 'cd'.repeat(20), firstParent: 'ef'.repeat(20), upstream: 'ad'.repeat(20), reason: 'Retain the exact prior upstream merge approval' }
const manifest = { version: 1, cutoff, entries: [entry] }

describe('bounded upstream merge manifest', () => {
  it('exempts only the cutoff and exact commit and parent identity tokens', () => {
    const source = JSON.stringify(manifest, null, 2)
    const parsed = parseCorePatchesUpstreamMerges(source)
    expect(parsed.manifest).toEqual(manifest)
    expect(parsed.error).toBeNull()
    expect(parsed.referenceTokens.map(token => token.value)).toEqual([cutoff, entry.commit, entry.firstParent, entry.upstream])
    for (const token of parsed.referenceTokens) expect(JSON.parse(source.slice(token.start, token.end))).toBe(token.value)
  })

  it('decodes escaped keys and values without losing raw token intervals', () => {
    const source = JSON.stringify(manifest).replace('firstParent', String.raw`first\u0050arent`).replace(cutoff, String.raw`\u0061` + cutoff.slice(1))
    const parsed = parseCorePatchesUpstreamMerges(source)
    expect(parsed.manifest).toEqual(manifest)
    const first = parsed.referenceTokens[0]!
    expect(source.slice(first.start, first.end)).toContain(String.raw`\u0061`)
    expect(JSON.parse(source.slice(first.start, first.end))).toBe(cutoff)
  })

  it.each([
    null, [], true, {},
    { ...manifest, version: '1' }, { ...manifest, version: 2 },
    { ...manifest, extra: true }, { cutoff, entries: [entry] },
    { ...manifest, entries: [] }, { ...manifest, entries: [entry, entry] },
    { ...manifest, entries: null }, { ...manifest, entries: [null] },
    { ...manifest, entries: [{ ...entry, extra: true }] },
    { ...manifest, entries: [{ commit: entry.commit, firstParent: entry.firstParent, upstream: entry.upstream }] },
    ...['', ' ', null, 7, cutoff.slice(0, 10), cutoff.toUpperCase()].map(value => ({ ...manifest, cutoff: value })),
    ...['commit', 'firstParent', 'upstream'].flatMap(field => ['', ' ', null, 7, 'a'.repeat(7), 'A'.repeat(40), 'a'.repeat(41)].map(value => ({ ...manifest, entries: [{ ...entry, [field]: value }] }))),
    ...['', ' ', null, 7, {}].map(reason => ({ ...manifest, entries: [{ ...entry, reason }] })),
  ])('rejects invalid schema %j without granting exemptions', (value) => {
    const parsed = parseCorePatchesUpstreamMerges(JSON.stringify(value))
    expect(parsed.manifest).toBeNull()
    expect(parsed.error).not.toBeNull()
    expect(parsed.referenceTokens).toEqual([])
  })

  it.each([
    '', '{', `/* comment */${JSON.stringify(manifest)}`, `${JSON.stringify(manifest)} {}`,
    JSON.stringify(manifest).replace('"version":1', '"version":1,'),
    ...['version', 'cutoff', 'entries', 'commit', 'firstParent', 'upstream', 'reason'].map(key => JSON.stringify(manifest).replace(`"${key}":`, `"${key}":null,"${key}":`)),
    JSON.stringify(manifest).replace('"firstParent":', String.raw`"first\u0050arent":null,"firstParent":`),
    JSON.stringify(manifest).replace('"version"', 'version'),
    JSON.stringify(manifest).replace('"version"', "'version'"),
  ])('rejects malformed JSON or duplicate decoded keys: %s', (source) => {
    const parsed = parseCorePatchesUpstreamMerges(source)
    expect(parsed.manifest).toBeNull()
    expect(parsed.error).not.toBeNull()
    expect(parsed.referenceTokens).toEqual([])
  })
})
