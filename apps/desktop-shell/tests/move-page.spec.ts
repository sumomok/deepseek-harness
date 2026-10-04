/**
 * The data move's pages as data: the links their buttons carry, which
 * sentence and which buttons each stopped move gets, the progress line, and
 * the documents, escaped.
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  blockedPage, moveLinkUrl, pageDocument, parseMoveLink, progressDocument, progressView, stopPage, type MoveLink, type ProgressClock,
} from '../src/move-page.ts'
import { formatBytes, MOVE_TEXT, moveText } from '../src/move-text.ts'
import type { MoveOutcome } from '../src/move/run.ts'

const text = MOVE_TEXT.zh
const across = { source: '/Users/p/.dsh', target: '/Volumes/D/DSH-Data', hidden: '/Users/p/.dsh-moved-m', sameVolume: false, targetExposed: true }
const input = { platform: 'darwin' as const, unusedName: 'DSH-Data（未使用的副本 2026-09-28）', refreshed: false }

/** A blocked outcome. */
function blocked(reason: Extract<MoveOutcome, { kind: 'blocked' }>['reason'], choices: Array<'keep-target' | 'rollback'>, dataAt: string[] = []): Extract<MoveOutcome, { kind: 'blocked' }> {
  return { kind: 'blocked', reason, choices, dataAt, targetPrint: null }
}

describe('the links on the move pages', () => {
  it('round-trips every link and ignores anything else', () => {
    const links: MoveLink[] = [
      { kind: 'cancel' }, { kind: 'quit' }, { kind: 'choose', choice: 'keep-target' }, { kind: 'choose', choice: 'rollback' },
      { kind: 'reveal', index: 1 }, { kind: 'discard-lock' }, { kind: 'confirm' }, { kind: 'back' },
    ]
    for (const link of links) expect(parseMoveLink(moveLinkUrl(link))).toEqual(link)
    expect(parseMoveLink('dsh-move://choose?c=delete-everything')).toBeUndefined()
    expect(parseMoveLink('dsh-move://reveal?i=-1')).toBeUndefined()
    expect(parseMoveLink('https://quit')).toBeUndefined()
    expect(parseMoveLink('file://cancel/')).toBeUndefined()
    expect(parseMoveLink('not a url')).toBeUndefined()
  })
})

describe('the page of a move stopped partway', () => {
  it('picks the sentence for each case and offers only the choices the move offers', () => {
    const used = blockedPage(across, blocked('choice-needed', ['keep-target', 'rollback']), text, input)
    expect(used.paragraphs).toEqual([text.choiceAcrossUsed(across.target, across.source, input.unusedName, '/Volumes/D')])
    expect(used.buttons.map(button => button.label)).toEqual([text.keepTarget, text.goBack, text.quit])
    expect(blockedPage({ ...across, targetExposed: false }, blocked('choice-needed', ['rollback']), text, input).paragraphs)
      .toEqual([text.choiceAcrossUnused(across.target, across.source)])
    expect(blockedPage({ ...across, sameVolume: true }, blocked('choice-needed', ['rollback']), text, input).paragraphs)
      .toEqual([text.choiceSame(across.target, across.source)])
    expect(blockedPage(across, blocked('target-changed', ['rollback']), text, input).paragraphs[0]).toContain('新增或修改')
    const missing = blockedPage(across, blocked('target-missing', ['rollback']), text, input)
    expect(missing.buttons.map(button => button.label)).toEqual([text.goBackWithout, text.quit])
    const occupied = blockedPage(across, blocked('target-occupied', ['rollback']), text, input)
    expect(occupied.reveal).toEqual([across.hidden])
    expect(occupied.buttons.map(button => button.link)).toEqual([
      { kind: 'choose', choice: 'rollback' }, { kind: 'reveal', index: 0 }, { kind: 'quit' },
    ])
    expect(blockedPage(across, blocked('original-missing', ['keep-target']), text, input).paragraphs)
      .toEqual([text.originalMissing(across.source, across.target, input.unusedName)])
    const both = blockedPage(across, blocked('original-missing', []), text, input)
    expect(both.paragraphs).toEqual([text.bothMissing(across.source, across.target)])
    expect(both.buttons.map(button => button.link)).toEqual([{ kind: 'quit' }])
  })

  it('names where an occupied original leaves the data, on one volume and across', () => {
    const same = blockedPage({ ...across, sameVolume: true }, blocked('source-occupied', ['keep-target'], [across.target]), text, input)
    expect(same.paragraphs).toEqual([
      text.sourceOccupiedSame(across.source, across.target), text.sourceOccupiedWays(across.target, across.source),
    ])
    expect(same.reveal).toEqual([])
    const alone = blockedPage(across, blocked('source-occupied', [], [across.hidden]), text, input)
    expect(alone.paragraphs).toEqual([text.sourceOccupiedAcross(across.source)])
    expect(blockedPage(across, blocked('choice-needed', ['rollback']), text, { ...input, refreshed: true }).notice).toBe(text.refreshed)
  })

  it('builds a one-sentence page with a way to show the file', () => {
    expect(stopPage(text.journalUnreadableTitle, text.journalUnreadable('/u/j.json'), text, { platform: 'win32', reveal: '/u/j.json' }))
      .toEqual({
        title: text.journalUnreadableTitle, paragraphs: [text.journalUnreadable('/u/j.json')], reveal: ['/u/j.json'],
        buttons: [{ label: '在资源管理器中显示', link: { kind: 'reveal', index: 0 } }, { label: '退出', link: { kind: 'quit' } }],
      })
  })
})

describe('the progress window', () => {
  it('shows bytes and time left while copying, with cancel, and none once the copy is in place', () => {
    const clock: ProgressClock = { startedAt: 0, stage: undefined }
    expect(progressView({ stage: 'copying', phase: 'copying', done: 0, total: 2e9 }, text, clock, 1000))
      .toEqual({ line: '已搬 0 B / 2.0 GB', cancellable: true, fraction: 0 })
    expect(progressView({ stage: 'copying', phase: 'copying', done: 8.2e8, total: 2e9 }, text, clock, 11_000).line)
      .toBe('已搬 820 MB / 2.0 GB，还需约 14 秒')
    expect(progressView({ stage: 'checking', phase: 'verifying', done: 1, total: 2 }, text, clock, 12_000))
      .toEqual({ line: text.checking, cancellable: true, fraction: 0.5 })
    expect(progressView({ stage: 'finishing', phase: 'hiding-source' }, text, clock, 13_000))
      .toEqual({ line: text.finishing, cancellable: false, fraction: undefined })
    expect(progressView({ stage: 'finishing', phase: 'rolling-back' }, text, clock, 14_000).line).toBe(text.rollingBack)
    expect(progressView({ stage: 'copying', phase: 'cancelling' }, text, clock, 15_000)).toMatchObject({ line: text.cancelling, cancellable: false })
    expect(MOVE_TEXT.en.progress('1 GB', '2 GB', 200)).toBe('1 GB of 2 GB moved, about 3 minutes left')
  })

  it('formats sizes and picks the language by locale', () => {
    expect([formatBytes(512), formatBytes(4_000), formatBytes(820e6), formatBytes(1.24e9)]).toEqual(['512 B', '4 KB', '820 MB', '1.2 GB'])
    expect(moveText('zh-CN')).toBe(MOVE_TEXT.zh)
    expect(moveText('en-US')).toBe(MOVE_TEXT.en)
  })

  it('escapes what a page shows and links its buttons to the move scheme', () => {
    const page = stopPage('<t>', 'a "b" & <c>', text, { platform: 'darwin' })
    const html = decodeURIComponent(pageDocument(page, 'dark').slice('data:text/html;charset=utf-8,'.length))
    expect(html).toContain('a &quot;b&quot; &amp; &lt;c&gt;')
    expect(html).not.toContain('<c>')
    expect(html).toContain('href="dsh-move://quit"')
    const progress = decodeURIComponent(progressDocument(text, 'light'))
    expect(progress).toContain('href="dsh-move://cancel"')
    // The cancel row is a flex box; without this rule its hidden attribute would not hide it.
    expect(progress).toContain('[hidden] { display: none !important; }')
  })
})
