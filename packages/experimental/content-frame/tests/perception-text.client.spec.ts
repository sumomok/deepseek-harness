/**
 * Every sentence the perception layer puts in front of a model, pinned word for
 * word. Nothing else tells the model what is in the content column, so a change
 * here is a change to what the agent believes about the user's screen.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import {
  columnContextText, EMPTY_COLUMN_CONTEXT, openedPageNotice, type ContextEntry,
} from '../src/perception/text.ts'

/** How the column names itself wherever the model reads about it. */
const COLUMN = 'The content column (内容区 — the column between the sidebar and this conversation; '
  + 'users also say 中间 or 右边)'

/** One listed entry. */
function entry(over: Partial<ContextEntry> & Pick<ContextEntry, 'kind' | 'title'>): ContextEntry {
  return { front: false, ...over }
}

describe('the notice a page click injects', () => {
  it('names the page and says it is in front', () => {
    expect(openedPageNotice('点位信息')).toBe(
      'The user opened the page "点位信息" in the content column (内容区); it is in front now.',
    )
  })
})

describe('the content-column context', () => {
  it('says the column is empty, and how to put something there', () => {
    expect(columnContextText([], true)).toBe(`${COLUMN} is empty. content_show puts a page there.`)
    expect(EMPTY_COLUMN_CONTEXT).toBe(`${COLUMN} is empty. content_show puts a page there.`)
    // The same sentence either way: an empty column has nothing to read.
    expect(columnContextText([], false)).toBe(EMPTY_COLUMN_CONTEXT)
  })

  it('lists a page in front, its writer, and where the app inside it has gone', () => {
    expect(columnContextText([
      entry({
        kind: 'page',
        title: '点位信息',
        front: true,
        by: 'user',
        location: { url: '/ini-web2/#/device', title: '物联感知平台 · 设备台账' },
      }),
      entry({ kind: 'chart', title: '黄金走势' }),
    ], true)).toBe(
      `${COLUMN} holds, newest first:\n`
      + '- "点位信息" (page, opened by the user)  ← in front\n'
      + '    the app inside is now at /ini-web2/#/device, title "物联感知平台 · 设备台账"\n'
      + '- "黄金走势" (chart)\n'
      + 'content_read reads the entry in front; content_show puts a page in front.\n'
      + 'Refs like e12 are your handles for content_read\'s scope and after; '
      + 'when you answer the user, name what the page shows, never a ref.',
    )
  })

  it('names the agent as the writer of a page it showed itself, and omits an empty document title', () => {
    expect(columnContextText([
      entry({ kind: 'page', title: 'Home', front: true, by: 'agent', location: { url: '/content-app/#/x', title: '' } }),
    ], true)).toBe(
      `${COLUMN} holds, newest first:\n`
      + '- "Home" (page, opened by you)  ← in front\n'
      + '    the app inside is now at /content-app/#/x\n'
      + 'content_read reads the entry in front; content_show puts a page in front.\n'
      + 'Refs like e12 are your handles for content_read\'s scope and after; '
      + 'when you answer the user, name what the page shows, never a ref.',
    )
  })

  it('marks the entry in front wherever it sits in the stream, and says nothing about a ref without a reader', () => {
    // The user picked an older chart, so the newest entry is not the one in
    // front — and this deployment offers no `content_read`, so the closing
    // line names only what it has.
    expect(columnContextText([
      entry({ kind: 'page', title: 'Home', by: 'agent' }),
      entry({ kind: 'chart', title: '黄金走势', front: true }),
    ], false)).toBe(
      `${COLUMN} holds, newest first:\n`
      + '- "Home" (page, opened by you)\n'
      + '- "黄金走势" (chart)  ← in front\n'
      + 'content_show puts a page in front.',
    )
  })

  it('lists a page whose writer the log never recorded as its kind alone', () => {
    // A frame reporting where it went before any `content/shown` named it is
    // the one way this happens; guessing a writer would be an invention.
    expect(columnContextText([entry({ kind: 'page', title: 'Home', front: true })], false))
      .toBe(`${COLUMN} holds, newest first:\n- "Home" (page)  ← in front\ncontent_show puts a page in front.`)
  })

  it('lists ten entries and counts the rest, rather than growing with the session', () => {
    const many = Array.from({ length: 13 }, (_unused, at) => entry({ kind: 'chart', title: `chart ${String(at)}` }))
    const text = columnContextText(many, false)
    expect(text.split('\n').filter(line => line.startsWith('- "'))).toHaveLength(10)
    expect(text).toContain('- … and 3 older entries not listed.')
    expect(columnContextText(many.slice(0, 11), false)).toContain('- … and 1 older entry not listed.')
    expect(columnContextText(many.slice(0, 10), false)).not.toContain('not listed')
  })

  it('cuts a title or an address rather than carrying a whole page of one into every request', () => {
    const text = columnContextText([
      entry({
        kind: 'page',
        title: 'T'.repeat(200),
        by: 'user',
        location: { url: `/${'u'.repeat(200)}`, title: 'D'.repeat(200) },
      }),
    ], false)
    expect(text).toContain(`- "${'T'.repeat(119)}…" (page, opened by the user)`)
    expect(text).toContain(`    the app inside is now at /${'u'.repeat(118)}…, title "${'D'.repeat(119)}…"`)
  })
})
