/**
 * The packaged payload prune: documentation names go, runtime Markdown stays.
 *
 * A plugin's locale `meta.detail` may name a localized description such as
 * `docs/DETAIL.zh.md`; pruning every `.zh.md` deleted that document and left the
 * plugin detail page reporting a missing file.
 */
import { describe, expect, it } from 'vitest'
import { prunesDocumentationMarkdown } from '../scripts/payload-prune.ts'

describe('the packaged payload documentation prune', () => {
  it('drops documentation names, with or without a language segment', () => {
    expect(prunesDocumentationMarkdown('README.md')).toBe(true)
    expect(prunesDocumentationMarkdown('README.zh.md')).toBe(true)
    expect(prunesDocumentationMarkdown('CHANGELOG.zh.md')).toBe(true)
    expect(prunesDocumentationMarkdown('readme.markdown')).toBe(true)
  })

  it('keeps runtime Markdown that is not named as documentation', () => {
    expect(prunesDocumentationMarkdown('SKILL.md')).toBe(false)
    expect(prunesDocumentationMarkdown('DETAIL.md')).toBe(false)
    expect(prunesDocumentationMarkdown('DETAIL.zh.md')).toBe(false)
    expect(prunesDocumentationMarkdown('guide.zh.md')).toBe(false)
  })

  it('ignores files that are not Markdown', () => {
    expect(prunesDocumentationMarkdown('readme.txt')).toBe(false)
  })
})
