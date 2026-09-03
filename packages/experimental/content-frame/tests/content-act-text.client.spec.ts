/**
 * Every sentence one `content_act` call can put in front of a model or a user,
 * pinned verbatim.
 *
 * They are pinned here rather than only where they are produced because these
 * strings are the whole contract both readers have: the model reads a failure
 * to decide its next step, and the user reads the approval request to decide
 * whether the steps run at all. A change to any of them is a change to what was
 * agreed, and has to show up in this diff.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { notAPageRefusal, READ_VOICE } from '../src/access/text.ts'
import {
  ACT_VOICE, actReportText, approvalReason, cannotActReason, dialogLine, disabledReason, labelChangedReason,
  navigationLine, noOptionReason, occludedReason, ranSummary, refGoneReason, stepClause, stepRefusal,
  stepRefusalText, tooLongRefusal, tooManyStepsRefusal, unverifiedRefusal, waitedReason, windowLine,
} from '../src/access/act-text.ts'
import type { ActStep } from '../src/access/wire.ts'

/** The two steps the design's own example runs. */
const FILL: ActStep = { action: 'fill', ref: 'e4', label: '名称', text: '东风' }

/** The click that follows it. */
const CLICK: ActStep = { action: 'click', ref: 'e5', label: '查询' }

describe('what the user is asked to approve', () => {
  it('lists every step in the user\'s own words, naming the column rather than a page', () => {
    // Composed before any browser has claimed the call, so the subject is the
    // column's front entry as the user sees it and not a title the host has
    // not read.
    expect(approvalReason({ steps: [FILL, CLICK] }))
      .toBe('在「当前展示的这一项」上：填「名称」为「东风」；点「查询」')
    expect(approvalReason({
      steps: [
        { action: 'select', ref: 'e6', label: '站点', value: '东风' },
        { action: 'press', ref: 'e4', label: '名称', key: 'Enter' },
        { action: 'wait', text: '保存成功' },
      ],
    })).toBe('在「当前展示的这一项」上：在「站点」里选「东风」；在「名称」上按 Enter；等「保存成功」出现')
  })

  it('says outright when the page\'s own confirmation will be confirmed too', () => {
    expect(approvalReason({ steps: [CLICK], dialogs: 'accept' }))
      .toBe('在「当前展示的这一项」上：点「查询」，并确认页面弹出的确认框')
    // The default answers the page's dialog with cancel, which changes nothing
    // the request has to name.
    expect(approvalReason({ steps: [CLICK], dialogs: 'cancel' }))
      .toBe('在「当前展示的这一项」上：点「查询」')
  })
})

describe('what the model reads when a call is refused before it runs', () => {
  it('names the step and the parameter', () => {
    expect(stepRefusal(2, 'a "fill" step needs text, the value to type into the box'))
      .toBe('content_act step 2: a "fill" step needs text, the value to type into the box')
    expect(tooManyStepsRefusal(20)).toBe('steps must hold at most 20 steps; split the rest into another call')
    expect(tooLongRefusal('key', 32)).toBe('key must be at most 32 characters')
    // Every field one step can be refused over, keyed the way the wire names it.
    expect([
      'action', 'ref', 'label', 'fill-text', 'wait-text', 'value', 'key',
      'label-length', 'text-length', 'value-length', 'key-length',
    ].map(refusal => stepRefusalText(refusal as Parameters<typeof stepRefusalText>[0]))).toEqual([
      '"click" a control; "fill" replaces a box\'s whole value with text; "select" chooses the option whose '
      + 'visible text is value; "press" sends one key such as Enter or Escape; "wait" waits for text to appear '
      + 'anywhere on the page',
      'every step but "wait" needs ref, a ref like "e12" from a previous content_read',
      'every step but "wait" needs label, the element\'s name exactly as content_read printed it',
      'a "fill" step needs text, the value to type into the box',
      'a "wait" step needs text, the words to wait for',
      'a "select" step needs value, the option\'s visible text',
      'a "press" step needs key, such as "Enter"',
      'label must be at most 256 characters',
      'text must be at most 1000 characters',
      'value must be at most 1000 characters',
      'key must be at most 32 characters',
    ])
  })

  it('says what is unknown when the console goes quiet after claiming the call', () => {
    // The one ending that cannot say what happened: the steps may have run in
    // full, in part, or not at all, so the only honest advice is to look.
    expect(unverifiedRefusal(60000)).toBe(
      'The console claimed this call but did not report within 60s; the steps may have run partially or fully. '
      + 'Call content_read before deciding to retry.',
    )
  })
})

describe('what each tool says about an entry it cannot use', () => {
  it('pins both sentences, which differ in the tool they send the model to', () => {
    // One ending, two callers. The advice that fixes it is the same call, but
    // the tool named as unable is the one the model reaches for next, so a
    // shared sentence would send a call that asked for steps back to the
    // reader.
    const chart = { kind: 'chart', title: '黄金走势' }
    expect(notAPageRefusal(chart, READ_VOICE.cannot)).toBe(
      'The entry in front is not a page (the chart "黄金走势"), which content_read cannot read; '
      + 'a chart drawn by show_chart keeps its data in that call\'s arguments. Call content_show to put a page in front.',
    )
    expect(notAPageRefusal(chart, ACT_VOICE.cannot)).toBe(
      'The entry in front is not a page (the chart "黄金走势"), which content_act cannot act on; '
      + 'a chart drawn by show_chart keeps its data in that call\'s arguments. Call content_show to put a page in front.',
    )
    // And the two empty-column sentences, which differ in what they tell the
    // model to do once a page is there.
    expect(READ_VOICE.emptyColumn).toBe('The content column is empty. Call content_show to put a page there, then retry.')
    expect(ACT_VOICE.emptyColumn).toBe(
      'The content column is empty. Call content_show to put a page there, then read it before acting on it.',
    )
  })
})

describe('what the model reads when one step stops the call', () => {
  it('pins each failure verbatim', () => {
    expect(labelChangedReason('e5', '重置', '查询'))
      .toBe('e5 is now "重置", not "查询" — the page changed; call content_read for current refs.')
    expect(refGoneReason('e3')).toBe('e3 is no longer on the page; call content_read for current refs.')
    expect(occludedReason('e7', '编辑设备'))
      .toBe('e7 is behind the open dialog "编辑设备"; act inside the dialog or close it first.')
    expect(disabledReason('e4', '保存')).toBe('e4 "保存" is disabled.')
    expect(noOptionReason('e6', '东风')).toBe('no option reading "东风" appeared for e6; read the page to see what it offers.')
    expect(waitedReason('保存成功', 5000)).toBe('"保存成功" did not appear within 5s.')
    expect(cannotActReason('e2', 'fill')).toBe('e2 is not something "fill" can be done to; read the page for what it offers.')
  })

  it('says how much of the call ran before it stopped', () => {
    expect(ranSummary(0)).toBe('Nothing ran.')
    expect(ranSummary(1)).toBe('Step 1 ran; later steps were skipped.')
    expect(ranSummary(3)).toBe('Steps 1–3 ran; later steps were skipped.')
  })
})

describe('what the page did on its own', () => {
  it('pins the three lines', () => {
    expect(dialogLine('confirm', '确定删除？', 'cancel')).toBe('dialog (confirm) "确定删除？" — answered cancel')
    expect(dialogLine('alert', '已保存', 'accept')).toBe('dialog (alert) "已保存" — answered accept')
    expect(navigationLine('/ini-web2/#/detail/8812')).toBe('navigation to /ini-web2/#/detail/8812')
    expect(windowLine('/ini-web2/#/detail/8812'))
      .toBe('the page tried to open /ini-web2/#/detail/8812 in a new window; it was not opened')
  })
})

describe('the three sections one call answers with', () => {
  it('reads back what ran, what the page did, and how the page reads now', () => {
    expect(actReportText({
      page: '点位信息',
      steps: [FILL, CLICK],
      results: [{ index: 1, status: 'ok' }, { index: 2, status: 'ok' }],
      redacted: [false, false],
      settledMs: 800,
      events: [{ kind: 'dialog', line: dialogLine('confirm', '确定删除？', 'accept') }],
      snapshot: '1 main\n  2 button "查询" e5',
    })).toBe(
      'Done 2/2 on 点位信息: fill "名称" ← "东风"; click "查询" (settled after 0.8s).\n'
      + 'Page events during these steps:\n'
      + '  dialog (confirm) "确定删除？" — answered accept\n'
      + 'Page now:\n'
      + '1 main\n  2 button "查询" e5',
    )
  })

  it('keeps all three sections when the page did nothing and a step failed', () => {
    // Three sections every time and in the same order: a section that appears
    // only sometimes is one the model stops looking for.
    expect(actReportText({
      page: '点位信息',
      steps: [FILL, CLICK],
      results: [
        { index: 1, status: 'ok' },
        { index: 2, status: 'failed', message: labelChangedReason('e5', '重置', '查询') },
      ],
      redacted: [false, false],
      settledMs: 0,
      events: [],
      snapshot: '1 main',
    })).toBe(
      'Step 2 failed: e5 is now "重置", not "查询" — the page changed; call content_read for current refs. '
      + 'Step 1 ran; later steps were skipped.\n'
      + 'Page events during these steps: none.\n'
      + 'Page now:\n1 main',
    )
  })

  it('never reads a password box\'s value back', () => {
    // The value the model sent is the user's credential; the transcript says
    // the box was filled and not what with.
    const secret: ActStep = { action: 'fill', ref: 'e9', label: '密码', text: 'hunter2' }
    expect(stepClause(secret, true)).toBe('fill "密码" ← (hidden)')
    expect(stepClause(secret, false)).toBe('fill "密码" ← "hunter2"')
    expect(actReportText({
      page: '登录',
      steps: [secret],
      results: [{ index: 1, status: 'ok' }],
      redacted: [true],
      settledMs: 120,
      events: [],
      snapshot: '1 main',
    })).toContain('Done 1/1 on 登录: fill "密码" ← (hidden) (settled after 0.1s).')
  })

  it('reads a wait and a press back as the user would say them', () => {
    expect(stepClause({ action: 'wait', text: '保存成功' }, false)).toBe('wait for "保存成功"')
    expect(stepClause({ action: 'press', ref: 'e4', label: '名称', key: 'Enter' }, false))
      .toBe('press Enter on "名称"')
    expect(stepClause({ action: 'select', ref: 'e6', label: '站点', value: '东风' }, false))
      .toBe('select "东风" in "站点"')
  })
})
