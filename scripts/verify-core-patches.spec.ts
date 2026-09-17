import { describe, expect, it } from 'vitest'
import {
  findRegistryViolations,
  parseRegistry,
  patchTrailers,
  REGISTRY_PATH,
  type LineCommit,
  type PatchRecord,
} from './verify-core-patches.ts'

const REGISTRY = `# core-patches 补丁登记

## 身份规则

不是补丁记录的小节不参与登记。

## alpha-seam — An alpha seam

- **改了什么**：alpha。
- **状态**：在役（core-patches-v10）

## beta-seat — A beta seat

- **改了什么**：beta。
- **状态**：退役（上游 PR #1）
`

function commit(id: string, ...slugs: string[]): LineCommit {
  return { id, subject: `subject ${id}`, slugs }
}

describe('parseRegistry', () => {
  it('reads slug, title and status, and ignores non-record headings', () => {
    expect(parseRegistry(REGISTRY)).toEqual<PatchRecord[]>([
      { slug: 'alpha-seam', title: 'An alpha seam', status: '在役' },
      { slug: 'beta-seat', title: 'A beta seat', status: '退役' },
    ])
  })

  it('keeps the first status of a record and never carries one past a plain heading', () => {
    const source = [
      '## alpha-seam — An alpha seam', '- **状态**：在役', '- **状态**：退役', '## Prose', '- **状态**：在役', '',
    ].join('\n')
    expect(parseRegistry(source)).toEqual<PatchRecord[]>([
      { slug: 'alpha-seam', title: 'An alpha seam', status: '在役' },
    ])
  })

  it('reports a record that declares no status', () => {
    expect(parseRegistry('## alpha-seam — An alpha seam\n\nno status line\n'))
      .toEqual<PatchRecord[]>([{ slug: 'alpha-seam', title: 'An alpha seam', status: null }])
  })
})

describe('patchTrailers', () => {
  it('collects every Patch trailer value in message order', () => {
    expect(patchTrailers('subject\n\nbody\n\nPatch: alpha-seam\nPatch:\tbeta-seat\n'))
      .toEqual(['alpha-seam', 'beta-seat'])
  })

  it('ignores a line that only mentions the trailer key', () => {
    expect(patchTrailers('subject\n\nThe Patch: key names one family.\nPatch: alpha-seam\n'))
      .toEqual(['alpha-seam'])
  })

  it('returns nothing for a message without the trailer', () => {
    expect(patchTrailers('subject\n\nbody only\n')).toEqual([])
  })
})

describe('findRegistryViolations', () => {
  const records = parseRegistry(REGISTRY)

  it('accepts a line whose commits name registered slugs and cover every active record', () => {
    expect(findRegistryViolations([commit('aaaaaaaaaa', 'alpha-seam')], records)).toEqual([])
  })

  it('accepts a retired record with no commit on the line', () => {
    const violations = findRegistryViolations([commit('aaaaaaaaaa', 'alpha-seam')], records)
    expect(violations.some(v => v.subject === 'beta-seat')).toBe(false)
  })

  it('rejects a commit with no trailer and one with two', () => {
    const violations = findRegistryViolations(
      [commit('aaaaaaaaaa'), commit('bbbbbbbbbb', 'alpha-seam', 'beta-seat')],
      records,
    )
    expect(violations.map(v => v.kind)).toEqual(['trailer-count', 'trailer-count', 'unused-active-slug'])
    expect(violations[0]!.detail).toContain('carries 0 Patch trailers')
    expect(violations[1]!.detail).toContain('carries 2 Patch trailers')
  })

  it('rejects a slug the registry does not register', () => {
    const violations = findRegistryViolations(
      [commit('aaaaaaaaaa', 'alpha-seam'), commit('bbbbbbbbbb', 'gamma-row')],
      records,
    )
    expect(violations).toEqual([{
      kind: 'unregistered-slug',
      subject: 'bbbbbbbbbb',
      detail: `bbbbbbbbbb (subject bbbbbbbbbb) names Patch: gamma-row, which ${REGISTRY_PATH} does not register.`,
    }])
  })

  it('rejects an active record no commit names', () => {
    const violations = findRegistryViolations([], records)
    expect(violations).toEqual([{
      kind: 'unused-active-slug',
      subject: 'alpha-seam',
      detail: `${REGISTRY_PATH} records alpha-seam as 在役, but no commit above upstream/master names it.`,
    }])
  })

  it('requires a commit for a partly retired record too', () => {
    const partial = parseRegistry('## alpha-seam — One\n- **状态**：局部退役（core-patches-v10）\n')
    expect(findRegistryViolations([], partial)).toEqual([{
      kind: 'unused-active-slug',
      subject: 'alpha-seam',
      detail: `${REGISTRY_PATH} records alpha-seam as 局部退役, but no commit above upstream/master names it.`,
    }])
    expect(findRegistryViolations([commit('aaaaaaaaaa', 'alpha-seam')], partial)).toEqual([])
  })

  it('rejects a duplicated slug and a record without a status', () => {
    const duplicated = parseRegistry([
      '## alpha-seam — One', '- **状态**：在役', '',
      '## alpha-seam — Two', '- **状态**：在役', '',
      '## gamma-row — Three', '', 'no status', '',
    ].join('\n'))
    const violations = findRegistryViolations([commit('aaaaaaaaaa', 'alpha-seam')], duplicated)
    expect(violations.map(v => v.kind)).toEqual(['duplicate-slug', 'missing-status'])
  })
})
