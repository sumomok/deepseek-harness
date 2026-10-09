/**
 * What the model is told of a user message's points: after each user message
 * carrying references of the `content-point` source, one logged message whose
 * text writes each reference's key line and display text, and never a DataPage
 * row and no record text of an original-system page. It is appended once per
 * message however often a step is proposed, for at most the protocol's 16 of
 * this plugin's references, and a reference this build cannot read is written
 * as unreadable rather than dropped.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MAX_PROMPT_REFERENCES } from '@deepseek-ai/dsh-attachment'
import type { PromptReference } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ANCHOR_FORMAT, DESCRIBE_FORMAT, toPromptReference } from '@haoran/dsh-point-anchor'
import type { PointDescription } from '@haoran/dsh-point-anchor'
import * as contentPoint from '../src/index.ts'
import { blockData } from '../src/block.ts'
import { POINT_MESSAGE_KIND, withPointNotices } from '../src/notice.ts'
import { pointNotice, POINT_SOURCE } from '../src/text.ts'

/** A DataPage cell as point-anchor describes it for a reference, its row included. */
const CELL: PointDescription = {
  v: DESCRIBE_FORMAT,
  anchorFormat: ANCHOR_FORMAT,
  what: { kind: 'data-page', region: 'table', part: 'cell' },
  anchor: { kind: 'data-page', model: 'SpaceLayer', region: 'table', part: 'cell', column: 'layerName' },
  shown: { page: '图层管理', target: '图层名称' },
  row: { layerName: '张三的道路', owner: '13800000000' },
}

/** A column header. */
const HEADER: PointDescription = {
  v: DESCRIBE_FORMAT,
  anchorFormat: ANCHOR_FORMAT,
  what: { kind: 'data-page', region: 'table', part: 'header' },
  anchor: { kind: 'data-page', model: 'SpaceLayer', region: 'table', part: 'header', column: 'layerName' },
  shown: { page: '图层管理', target: '图层名称' },
}

/** A sidebar entry. */
const NAV: PointDescription = {
  v: DESCRIBE_FORMAT,
  anchorFormat: ANCHOR_FORMAT,
  what: { kind: 'nav' },
  anchor: { kind: 'nav', nav: 'view', id: 'space-layer-crud' },
  shown: { target: '图层管理' },
}

/**
 * A reference this plugin files for a description.
 * @param point - the description.
 * @returns the reference.
 */
function pointRef(point: PointDescription): PromptReference {
  const reference = toPromptReference(point, POINT_SOURCE)
  if (reference === undefined) throw new Error('fixture over the bound')
  return { source: reference.source, label: reference.label, data: JSON.parse(JSON.stringify(reference.data)) as PromptReference['data'] }
}

/** A block reference of an info card. */
const CARD = blockData({ seat: 'component', component: 'toy.info-card', node: 'card', page: '图层管理', target: '信息卡' })

/**
 * A browser prompt recording references.
 * @param text - the prompt.
 * @param references - the recorded references.
 * @returns the message.
 */
function prompt(text: string, references?: readonly PromptReference[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: brandString<SessionRequestId>(`rpc-${text}`), ...references !== undefined ? { references } : {} },
  })
}

/**
 * The text of a message.
 * @param message - the message.
 * @returns its text blocks joined.
 */
function textOf(message: UserMessage): string {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

describe('the notice a user message\'s points add', () => {
  it('follows the message, naming it, and writes each point\'s key line and display text', () => {
    const message = prompt('这一列是什么意思', [pointRef(HEADER), pointRef(NAV)])
    const out = withPointNotices([message])
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(message)
    const notice = out[1] as UserMessage
    expect(notice.source).toEqual({ kind: POINT_MESSAGE_KIND, message: message.id, form: 'notice', summary: '指着：列「图层名称」、侧栏「图层管理」' })
    expect(textOf(notice)).toContain('锚点：`data-page model=SpaceLayer region=table part=header column=layerName`')
    expect(textOf(notice)).toContain('`nav nav=view id=space-layer-crud`')
    expect(textOf(notice).split('\n\n')).toHaveLength(2)
  })

  it('carries no DataPage row, whatever the logged data holds', () => {
    const recorded = pointRef(CELL)
    expect(JSON.stringify(recorded.data)).toContain('张三的道路')
    const text = textOf(withPointNotices([prompt('这一格是什么', [recorded])])[1] as UserMessage)
    expect(text).toContain('column=layerName')
    expect(text).not.toContain('张三的道路')
    expect(text).not.toContain('13800000000')
    expect(text).not.toContain('这一行')
  })

  it('writes a block reference with its key line', () => {
    const text = pointNotice([{ source: POINT_SOURCE, label: '信息卡', data: CARD }], MAX_PROMPT_REFERENCES)?.text
    expect(text).toBe('用户在内容栏里指着「信息卡」这一整块。\n锚点：`block seat=component component=toy.info-card node=card`\n显示：图层管理 · 信息卡')
    const bare = blockData({ seat: 'office' })
    expect(pointNotice([{ source: POINT_SOURCE, label: 'office', data: bare }], 16)?.text).toBe('用户在内容栏里指着「office」这一整块。\n锚点：`block seat=office`')
  })

  it('is appended once, however often a step holding the message is proposed', () => {
    const message = prompt('这是什么', [pointRef(HEADER)])
    const once = withPointNotices([message])
    const twice = withPointNotices(once)
    expect(twice).toEqual(once)
    expect(twice.filter(item => item.source.kind === POINT_MESSAGE_KIND)).toHaveLength(1)
  })

  it('follows each message carrying points, in place, and leaves the rest alone', () => {
    const first = prompt('一', [pointRef(HEADER)])
    const plain = prompt('二')
    const other = prompt('三', [{ source: 'other-owner', label: '别的', data: { x: 1 } }])
    const third = prompt('四', [{ source: 'other-owner', label: '别的', data: { x: 1 } }, pointRef(NAV)])
    const out = withPointNotices([first, plain, other, third])
    expect(out.map(item => (item.source.kind === POINT_MESSAGE_KIND ? `notice:${item.source.message === first.id ? '一' : '四'}` : textOf(item))))
      .toEqual(['一', 'notice:一', '二', '三', '四', 'notice:四'])
    expect(textOf(out[5] as UserMessage)).not.toContain('别的')
  })

  it('returns the messages unchanged when none carries a point', () => {
    const messages = [prompt('一'), createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'skill-invocation', name: 's', form: 'instructions' } })]
    expect(withPointNotices(messages)).toEqual(messages)
  })

  it('writes at most 16 points of one message', () => {
    const many = Array.from({ length: MAX_PROMPT_REFERENCES + 2 }, () => pointRef(HEADER))
    const notice = pointNotice(many, MAX_PROMPT_REFERENCES)
    expect(notice?.labels).toHaveLength(16)
    expect(notice?.text.split('\n\n')).toHaveLength(16)
  })

  it('writes no row line for a point that carries only the count of columns left out', () => {
    const { row: _row, ...withoutRow } = pointRef(CELL).data
    const text = pointNotice([{ source: POINT_SOURCE, label: 'x', data: { ...withoutRow, rowOmitted: 3 } }], MAX_PROMPT_REFERENCES)?.text
    expect(text).toContain('column=layerName')
    expect(text).not.toContain('这一行')
    expect(text).not.toContain('还有 3 列')
  })

  it('names a control in an original-system table cell by its column and role, whatever name and target the logged data holds', () => {
    const control = {
      v: DESCRIBE_FORMAT, anchorFormat: ANCHOR_FORMAT, what: { kind: 'frame', role: 'button' },
      anchor: { kind: 'frame', page: 'orders', column: '名称', role: 'button', name: '张三的道路工程', in: 'main' },
      shown: { page: '订单', target: '张三的道路工程' },
    }
    const notice = pointNotice([{ source: POINT_SOURCE, label: '张三的道路工程', data: control }], MAX_PROMPT_REFERENCES)
    expect(notice?.text).toBe('用户在内容栏里指着「「名称」列里的按钮」。\n锚点：`frame page=orders column="名称" role=button in=main`\n显示：页面「订单」 · 「名称」列里的按钮')
    expect(notice?.labels).toEqual(['「名称」列里的按钮'])
  })

  it('names a control of a role describe format 1 does not name as a control, with no page when none was shown', () => {
    const control = {
      v: DESCRIBE_FORMAT, anchorFormat: ANCHOR_FORMAT, what: { kind: 'frame', role: 'widget' },
      anchor: { kind: 'frame', page: 'orders', column: '名称', role: 'widget' }, shown: { target: '张三' },
    }
    expect(pointNotice([{ source: POINT_SOURCE, label: 'x', data: control }], MAX_PROMPT_REFERENCES)?.text)
      .toBe('用户在内容栏里指着「「名称」列里的控件」。\n锚点：`frame page=orders column="名称" role=widget`\n显示：「名称」列里的控件')
  })

  it('names an original-system place no column can be told for as a place in a table, with no target', () => {
    const loose = {
      v: DESCRIBE_FORMAT, anchorFormat: ANCHOR_FORMAT, what: { kind: 'frame', role: 'link' }, unanchored: 'no-column',
      shown: { nav: '订单管理', page: '订单', target: '13800000000' },
    }
    const notice = pointNotice([{ source: POINT_SOURCE, label: '13800000000', data: loose }], MAX_PROMPT_REFERENCES)
    expect(notice?.text).toBe('用户在内容栏里指着「表格里的链接」。\n锚点：没有（这一格对不上列名）\n显示：侧栏「订单管理」 · 页面「订单」 · 表格里的链接')
  })

  it('writes the content-frame page id in the key line of a whole original-system page', () => {
    const page = blockData({ seat: 'page', pageId: 'orders', page: '订单', target: '原系统页面' })
    expect(pointNotice([{ source: POINT_SOURCE, label: '原系统页面', data: page }], MAX_PROMPT_REFERENCES)?.text)
      .toBe('用户在内容栏里指着「原系统页面」这一整块。\n锚点：`block seat=page page=orders`\n显示：订单 · 原系统页面')
  })

  it('writes the first 16 of this plugin\'s points of a message, another owner\'s ahead of them not counted', () => {
    const others = [{ source: 'other-owner', label: '别的', data: { x: 1 } }]
    const ours = Array.from({ length: MAX_PROMPT_REFERENCES + 1 }, () => pointRef(HEADER))
    const out = withPointNotices([prompt('很多', [...others, ...ours])])
    expect(textOf(out[1] as UserMessage).split('\n\n')).toHaveLength(MAX_PROMPT_REFERENCES)
  })

  it('appends for a message the step holds no notice of, beside one it already holds a notice of', () => {
    const answered = prompt('一', [pointRef(HEADER)])
    const fresh = prompt('二', [pointRef(NAV)])
    const out = withPointNotices([...withPointNotices([answered]), fresh])
    expect(out.map(item => item.source.kind)).toEqual(['user', POINT_MESSAGE_KIND, 'user', POINT_MESSAGE_KIND])
    expect(out[3]?.source).toMatchObject({ message: fresh.id })
  })

  it('appends once for a message the step holds twice', () => {
    const message = prompt('一', [pointRef(HEADER)])
    expect(withPointNotices([message, message]).filter(item => item.source.kind === POINT_MESSAGE_KIND)).toHaveLength(1)
  })

  it('writes a point without an anchor with the reason it has none', () => {
    const unanchored = toPromptReference({ v: DESCRIBE_FORMAT, anchorFormat: ANCHOR_FORMAT, what: { kind: 'frame', role: 'button' }, unanchored: 'nameless', shown: { page: '订单' } }, POINT_SOURCE)
    const text = unanchored === undefined ? '' : pointNotice([{ source: POINT_SOURCE, label: unanchored.label, data: unanchored.data }], MAX_PROMPT_REFERENCES)?.text
    expect(text).toContain('锚点：没有（')
  })

  it.each([
    ['no object', null, '这条引用的内容本版本读不了'],
    ['a describe format that is no number', { ...pointRef(HEADER).data, v: 'x' }, '格式本版本读不了（本版本读格式 1）'],
  ])('writes a point carrying %s as unreadable', (_name, data, words) => {
    expect(pointNotice([{ source: POINT_SOURCE, label: '旧的', data }], MAX_PROMPT_REFERENCES)?.text).toContain(words)
  })

  it.each([
    ['a describe format this build does not read', { ...pointRef(HEADER).data, v: 9 }, '格式 9 本版本读不了（本版本读格式 1）'],
    ['an anchor format this build does not read', { ...pointRef(HEADER).data, anchorFormat: 7 }, '格式 7 本版本读不了'],
    ['a field this build would not write', { ...pointRef(HEADER).data, extra: 1 }, '这条引用的内容本版本读不了'],
    ['a block format this build does not read', { ...CARD, v: 2 }, '这条引用的格式 2 本版本读不了（本版本读格式 1）'],
    ['a block field this build would not write', { ...CARD, extra: 1 }, '一整块，但这条引用的内容本版本读不了'],
  ])('writes a point carrying %s as unreadable, labelled as recorded', (_name, data, words) => {
    const notice = pointNotice([{ source: POINT_SOURCE, label: '旧的', data }], MAX_PROMPT_REFERENCES)
    expect(notice?.text).toContain(words)
    expect(notice?.labels).toEqual(['旧的'])
  })
})

/**
 * An agent on a fresh session, the fields the dispatch reads.
 * @returns the agent.
 */
function agent(): Agent {
  const id = SessionId('content-point-agent')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: '/tmp', isSeeded: false })
  return {
    ctx: new Context(), id, options: {}, session, inbox: unsupportedInbox(), status: 'idle',
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
}

describe('the plugin', () => {
  it('appends the notice in the step\'s pre-step, and passes a rejected step through', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(contentPoint)
    const subject = agent()
    const message = prompt('这是什么', [pointRef(HEADER)])
    const propose = (decision: PreStepDecision): Promise<PreStepDecision> => agentEvents(ctx, subject).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve(decision),
    )
    const entered = await propose({ kind: 'enter', messages: [message] })
    expect(entered.kind === 'enter' && entered.messages.map(item => item.source.kind)).toEqual(['user', POINT_MESSAGE_KIND])
    expect(await propose({ kind: 'reject' })).toEqual({ kind: 'reject' })
  })
})
