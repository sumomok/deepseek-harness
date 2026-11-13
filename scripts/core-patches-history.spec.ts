import { describe, expect, it } from 'vitest'
import { parseCorePatchesHistory } from './core-patches-history.ts'

const cutoff = 'ab'.repeat(20)
const commit = 'cd'.repeat(20)
const entry = { commit, subject: 'Historical subject', patch: 'alpha-seam', reason: 'Explicit approval' }
const manifest = { version: 1, cutoff, entries: [entry] }

// Each fixture changes the durable JSON input, not a typed in-process value.
describe('historical patch manifest parsing', () => {
  it.each([1, 2, 3])('accepts %i approvals and returns only their exact identity token locations', (count) => {
    const entries = Array.from({ length: count }, (_, index) => ({ ...entry, commit: String(index).repeat(40) }))
    const source = JSON.stringify({ version: 1, cutoff, entries }, null, 2)
    const result = parseCorePatchesHistory(source)
    expect(result.error).toBeNull()
    expect(result.manifest).toEqual({ version: 1, cutoff, entries })
    expect(result.referenceTokens.map(token => token.value)).toEqual([cutoff, ...entries.map(item => item.commit)])
    for (const token of result.referenceTokens) expect(JSON.parse(source.slice(token.start, token.end))).toBe(token.value)
  })

  it('decodes escaped keys and SHA values while retaining raw token intervals', () => {
    const source = JSON.stringify(manifest).replace('cutoff', String.raw`cut\u006fff`).replace(cutoff, String.raw`\u0061` + cutoff.slice(1))
    const result = parseCorePatchesHistory(source)
    expect(result.error).toBeNull()
    expect(result.manifest).toEqual(manifest)
    expect(result.referenceTokens[0]?.value).toBe(cutoff)
    expect(source.slice(result.referenceTokens[0]!.start, result.referenceTokens[0]!.end)).toContain(String.raw`\u0061`)
  })

  it.each([
    null, [], {}, true,
    { ...manifest, version: '1' }, { ...manifest, version: 2 }, { ...manifest, version: null },
    { ...manifest, extra: true }, { cutoff, entries: [entry] },
    { ...manifest, cutoff: null }, { ...manifest, cutoff: 123 },
    { ...manifest, cutoff: '' }, { ...manifest, cutoff: cutoff.slice(0, 10) },
    { ...manifest, cutoff: cutoff.toUpperCase() }, { ...manifest, cutoff: ` ${cutoff}` },
    { ...manifest, entries: [] }, { ...manifest, entries: {} },
    { ...manifest, entries: [entry, entry] },
    { ...manifest, entries: ['0', '1', '2', '3'].map(value => ({ ...entry, commit: value.repeat(40) })) },
    ...[null, [], 'entry', { ...entry, extra: true }, { commit, subject: entry.subject, patch: entry.patch }].map(value => ({ ...manifest, entries: [value] })),
    ...['', ' ', null, 7, {}, commit.slice(0, 10), commit.toUpperCase()].map(value => ({ ...manifest, entries: [{ ...entry, commit: value }] })),
    ...['subject', 'patch', 'reason'].flatMap(field => ['', '  ', null, 7, {}].map(value => ({ ...manifest, entries: [{ ...entry, [field]: value }] }))),
    ...['Bad-slug', '-slug', 'slug-', 'two--parts', 'two parts'].map(patch => ({ ...manifest, entries: [{ ...entry, patch }] })),
  ])('rejects invalid schema %j without granting any token exemptions', (value) => {
    const result = parseCorePatchesHistory(JSON.stringify(value))
    expect(result.error).not.toBeNull()
    expect(result.manifest).toBeNull()
    expect(result.referenceTokens).toEqual([])
  })

  it.each([
    '', '{', `/* comment */${JSON.stringify(manifest)}`, `${JSON.stringify(manifest)} {}`,
    JSON.stringify(manifest).replace('"version":1', '"version":1,'),
    JSON.stringify(manifest).replace('"version":1', '"version":1,"version":1'),
    JSON.stringify(manifest).replace('"cutoff":', '"cutoff":"ignored","cutoff":'),
    JSON.stringify(manifest).replace('"commit":', '"commit":"ignored","commit":'),
    JSON.stringify(manifest).replace('"reason":', '"reason":"ignored","reason":'),
    JSON.stringify(manifest).replace('"subject":', String.raw`"sub\u006aect":"ignored","subject":`),
    JSON.stringify(manifest).replace('"patch":', String.raw`"p\u0061tch":"alpha-seam","patch":`),
    JSON.stringify(manifest).replace('"version"', 'version'),
    JSON.stringify(manifest).replace('"version"', "'version'"),
  ])('rejects invalid JSON or duplicate decoded keys: %s', (source) => {
    const result = parseCorePatchesHistory(source)
    expect(result.error).not.toBeNull()
    expect(result.referenceTokens).toEqual([])
  })
})
