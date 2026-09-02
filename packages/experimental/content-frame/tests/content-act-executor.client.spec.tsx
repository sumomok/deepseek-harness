// @vitest-environment jsdom
/**
 * The acting half in the seat: what each step dispatches at the page, what
 * stops a call, what the watch reports the page doing on its own, and what the
 * two stand-ins do while they are installed.
 *
 * The events are asserted by listening for them on the fixture, because that is
 * exactly what an application does: a framework's handler is the only thing
 * that ever sees what a step produced, and a step that sets a property without
 * firing what the page listens for looks identical from the outside until a
 * real application ignores it.
 *
 * Restoration is pinned as hard as the interception. A frame left holding this
 * package's `confirm` is a frame whose own dialogs never open again, and
 * nothing in the product would report that.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { TAB_ID, useContentRead, type ContentReadSeat } from '../src/client/access/executor.ts'
import { CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, type ActOutcome, type ClaimAck } from '../src/access/wire.ts'
import { FRAME_WIDE_LISTING_MESSAGE } from '../src/access/text.ts'
import { RefTable } from '../src/client/access/refs.ts'
import type { ContentActRequest } from '../src/types.ts'

/** The frame id every case here acts through. */
const FRAME = 'session_1 home'

/** The seat's settings: deadlines short enough for a test to sit through. */
const ACCESS = {
  outlineChars: 4000, claimTimeoutMs: 300, readTimeoutMs: 1000, settleQuietMs: 5,
  actTimeoutMs: 1000, maxSteps: 20, settleMaxMs: 20,
}

/** One page entry as the column resolves it. */
const PAGE_ENTRY: ContentSurfaceEntry = {
  kind: 'page', entryId: 'home', seq: 1, title: 'Home', payload: { state: 'shown' },
}

/** Every document posted to a channel route, in order. */
let posted: { route: string; body: Record<string, unknown> }[] = []

/** The claim answers the stub hands out; exhausted means "claimed". */
let claims: ClaimAck[] = []

/** The frame this suite's steps run against, and the numbering they resolve through. */
let frame: HTMLIFrameElement
let refs: RefTable

/** Answer both channel routes without a host. */
function stubRoutes(): void {
  vi.stubGlobal('fetch', vi.fn((route: string, init: RequestInit) => {
    posted.push({ route, body: JSON.parse(init.body as string) as Record<string, unknown> })
    const answer = route === CONTENT_CLAIM_ROUTE ? claims.shift() ?? { claimed: true } : { accepted: true }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) })
  }))
}

/** The frame's own document, which every fixture is built in. */
function doc(): Document {
  const view = frame.contentWindow
  if (view === null) throw new Error('jsdom gave the mounted frame no window')
  return view.document
}

/** The frame's own window. */
function view(): Window {
  const held = frame.contentWindow
  if (held === null) throw new Error('jsdom gave the mounted frame no window')
  return held
}

/** Mount one document in the frame and number the elements the steps will name. */
function mount(html: string): void {
  doc().body.innerHTML = html
}

/** Number one element the way a read would have, and answer the ref the model would hold. */
function ref(selector: string): string {
  const el = doc().querySelector(selector)
  if (el === null) throw new Error(`the fixture has no ${selector}`)
  return refs.ref(el)
}

/** The element behind one selector, for a case that listens on it. */
function at(selector: string): Element {
  const el = doc().querySelector(selector)
  if (el === null) throw new Error(`the fixture has no ${selector}`)
  return el
}

/**
 * Mount a page holding a same-origin frame of its own, which is the topology
 * the product runs against: a thin shell page with the application inside it.
 * @param outer - the shell page's markup, which must hold `<iframe id="inner">`.
 * @param inner - the application's markup, mounted inside that frame.
 * @returns the inner document and its window.
 */
function nest(outer: string, inner: string): { doc: Document; view: Window } {
  mount(outer)
  const view = (at('#inner') as HTMLIFrameElement).contentWindow
  if (view === null) throw new Error('jsdom gave the nested frame no window')
  view.document.body.innerHTML = inner
  return { doc: view.document, view }
}

/** Number one element of a nested document the way a read would have. */
function refIn(nested: Document, selector: string): string {
  const el = nested.querySelector(selector)
  if (el === null) throw new Error(`the nested fixture has no ${selector}`)
  return refs.ref(el)
}

/** The element behind one selector of a nested document. */
function atIn(nested: Document, selector: string): Element {
  const el = nested.querySelector(selector)
  if (el === null) throw new Error(`the nested fixture has no ${selector}`)
  return el
}

/** Build one seat over the mounted frame. */
function seatOf(request: ContentActRequest): ContentReadSeat {
  return {
    entries: [PAGE_ENTRY],
    pending: [request],
    page: { id: 'home', title: 'Home' },
    activeFrameId: FRAME,
    frames: { current: new Map([[FRAME, frame]]) },
    tables: { current: new Map([[FRAME, refs]]) },
    access: ACCESS,
    tabId: TAB_ID,
  }
}

/** Mount the seat over one pending call. */
function Probe({ seat }: { seat: ContentReadSeat }) {
  useContentRead(seat)
  return null
}

/** Run one call to its report, and answer with what the seat posted. */
async function run(
  steps: ContentActRequest['args']['steps'],
  dialogs?: ContentActRequest['args']['dialogs'],
): Promise<ActOutcome> {
  const request: ContentActRequest = {
    callId: 'call_1',
    tool: 'content_act',
    args: { steps, ...dialogs === undefined ? {} : { dialogs } },
  }
  render(<Probe seat={seatOf(request)} />)
  await vi.waitFor(
    () => { expect(posted.filter(entry => entry.route === CONTENT_REPORT_ROUTE)).toHaveLength(1) },
    { timeout: 5000 },
  )
  return posted.find(entry => entry.route === CONTENT_REPORT_ROUTE)?.body.outcome as ActOutcome
}

/** Every event of one type the fixture saw, by the element it reached. */
function listen(el: Element, types: readonly string[]): string[] {
  const seen: string[] = []
  for (const type of types) el.addEventListener(type, () => { seen.push(type) })
  return seen
}

beforeEach(() => {
  posted = []
  claims = []
  refs = new RefTable()
  frame = document.createElement('iframe')
  document.body.append(frame)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  stubRoutes()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('what each step dispatches at the page', () => {
  it('clicks with the whole pointer sequence a user produces', async () => {
    mount('<main><button id="go">查询</button></main>')
    const seen = listen(at('#go'), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '查询' }])
    // Some frameworks listen for `mousedown` alone and never see a bare
    // `click`; a step that fired one event would work on half the pages.
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    expect(outcome.status).toBe('done')
    expect(outcome.steps).toEqual([{ index: 1, status: 'ok' }])
  })

  it('fills a box the listing named by the word written in it', async () => {
    // The console's own query field, and the loop it used to cause: the
    // listing printed `textbox = ""`, the model had no name to copy, and every
    // label it invented failed the seat's check. The two halves share one
    // naming function, so what the listing printed is what passes here.
    mount('<main><input id="q" class="el-input__inner" placeholder="请输入资源名称">'
      + '<button id="go">查询</button></main>')
    const outcome = await run([
      { action: 'fill', ref: ref('#q'), label: '请输入资源名称', text: 'mill-09' },
      { action: 'click', ref: ref('#go'), label: '查询' },
    ])
    expect((at('#q') as HTMLInputElement).value).toBe('mill-09')
    expect(outcome.status).toBe('done')
    expect(outcome.text).toContain('Page now:')
    expect(outcome.text).toContain('textbox "请输入资源名称"')
  })

  it('fills a textarea the same way', async () => {
    mount('<main><label for="note">备注</label><textarea id="note"></textarea></main>')
    const seen = listen(at('#note'), ['input', 'change'])
    const outcome = await run([{ action: 'fill', ref: ref('#note'), label: '备注', text: '东风' }])
    expect((at('#note') as HTMLTextAreaElement).value).toBe('东风')
    expect(seen).toEqual(['input', 'change'])
    expect(outcome.status).toBe('done')
  })

  it('fills through the value setter, then says so with input and change', async () => {
    mount('<main><label for="name">名称</label><input id="name"></main>')
    const seen = listen(at('#name'), ['input', 'change'])
    const outcome = await run([{ action: 'fill', ref: ref('#name'), label: '名称', text: '东风' }])
    expect((at('#name') as HTMLInputElement).value).toBe('东风')
    expect(seen).toEqual(['input', 'change'])
    expect(outcome.status).toBe('done')
  })

  it('chooses a native option by the text the user reads', async () => {
    mount('<main><label for="site">站点</label>'
      + '<select id="site"><option value="1">北京</option><option value="2">东风</option></select></main>')
    const seen = listen(at('#site'), ['input', 'change'])
    const outcome = await run([{ action: 'select', ref: ref('#site'), label: '站点', value: '东风' }])
    expect((at('#site') as HTMLSelectElement).value).toBe('2')
    expect(seen).toEqual(['input', 'change'])
    expect(outcome.status).toBe('done')
  })

  it('opens a list the page draws itself and clicks the option', async () => {
    // The picker an application framework draws where the platform would draw
    // a `<select>`: a box the user cannot type into, and a popup underneath.
    mount('<main><div id="site" role="combobox" aria-label="站点" tabindex="0">北京</div>'
      + '<div id="popup" hidden><div role="option">北京</div><div role="option">东风</div></div></main>')
    at('#site').addEventListener('click', () => { at('#popup').removeAttribute('hidden') })
    let chose = ''
    doc().addEventListener('click', (event) => {
      const option = (event.target as Element).closest('[role~="option"]')
      if (option !== null) chose = option.textContent ?? ''
    })
    const outcome = await run([{ action: 'select', ref: ref('#site'), label: '站点', value: '东风' }])
    expect(chose).toBe('东风')
    expect(outcome.status).toBe('done')
  })

  it('sends one key without submitting anything', async () => {
    mount('<main><form id="form"><label for="name">名称</label><input id="name"></form></main>')
    const keys: string[] = []
    let submitted = false
    for (const type of ['keydown', 'keypress', 'keyup']) {
      at('#name').addEventListener(type, (event) => { keys.push(`${type}:${(event as KeyboardEvent).key}`) })
    }
    at('#form').addEventListener('submit', () => { submitted = true })
    const outcome = await run([{ action: 'press', ref: ref('#name'), label: '名称', key: 'Enter' }])
    expect(keys).toEqual(['keydown:Enter', 'keypress:Enter', 'keyup:Enter'])
    // The page decides what Enter means; a step that submitted the form would
    // be acting on a page that chose not to.
    expect(submitted).toBe(false)
    expect(outcome.status).toBe('done')
  })

  it('waits for text the page has not drawn yet', async () => {
    mount('<main><button id="go">保存</button><div id="toast"></div></main>')
    at('#go').addEventListener('click', () => {
      setTimeout(() => { at('#toast').textContent = '保存成功' }, 30)
    })
    const outcome = await run([
      { action: 'click', ref: ref('#go'), label: '保存' },
      { action: 'wait', text: '保存成功' },
    ])
    expect(outcome.status).toBe('done')
    expect(outcome.steps).toEqual([{ index: 1, status: 'ok' }, { index: 2, status: 'ok' }])
  })
})

describe('what stops a call', () => {
  it('refuses a step whose element is called something else now', async () => {
    mount('<main><button id="go">查询</button></main>')
    const held = ref('#go')
    at('#go').textContent = '重置'
    const outcome = await run([
      { action: 'click', ref: held, label: '重置' },
      { action: 'click', ref: held, label: '查询' },
    ])
    expect(outcome.status).toBe('failed')
    expect(outcome.steps).toEqual([
      { index: 1, status: 'ok' },
      {
        index: 2,
        status: 'failed',
        message: 'e1 is now "重置", not "查询" — the page changed; call content_read for current refs.',
      },
    ])
    expect(outcome.text).toContain(
      'Step 2 failed: e1 is now "重置", not "查询" — the page changed; call content_read for current refs. '
      + 'Step 1 ran; later steps were skipped.',
    )
  })

  it('reports every step after the failure as skipped, and runs none of them', async () => {
    mount('<main><button id="go">查询</button><button id="save">保存</button></main>')
    const seen = listen(at('#save'), ['click'])
    const gone = ref('#go')
    at('#go').remove()
    const outcome = await run([
      { action: 'click', ref: gone, label: '查询' },
      { action: 'click', ref: ref('#save'), label: '保存' },
    ])
    expect(outcome.steps).toEqual([
      { index: 1, status: 'failed', message: 'e1 is no longer on the page; call content_read for current refs.' },
      { index: 2, status: 'skipped' },
    ])
    expect(seen).toEqual([])
    expect(outcome.text).toContain('Nothing ran.')
  })

  it('refuses a target the page has covered with a dialog', async () => {
    mount('<main><button id="go">查询</button>'
      + '<div role="dialog" aria-modal="true" aria-label="编辑设备"><button id="ok">确定</button></div></main>')
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '查询' }])
    expect(outcome.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'e1 is behind the open dialog "编辑设备"; act inside the dialog or close it first.',
    }])
  })

  it('acts inside the dialog the page has open', async () => {
    mount('<main><button id="go">查询</button>'
      + '<div role="dialog" aria-modal="true" aria-label="编辑设备"><button id="ok">确定</button></div></main>')
    const seen = listen(at('#ok'), ['click'])
    const outcome = await run([{ action: 'click', ref: ref('#ok'), label: '确定' }])
    expect(seen).toEqual(['click'])
    expect(outcome.status).toBe('done')
  })

  it('acts past a dialog the page is not showing', async () => {
    // A dialog in the markup and not on the screen covers nothing.
    mount('<main><button id="go">查询</button>'
      + '<div role="dialog" aria-label="编辑设备" style="display: none"><button>确定</button></div></main>')
    const seen = listen(at('#go'), ['click'])
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '查询' }])
    expect(seen).toEqual(['click'])
    expect(outcome.status).toBe('done')
  })

  it('refuses a target the page has hidden since the read', async () => {
    // A hidden element answers to its name, takes an event, and runs the
    // handler behind it — so nothing else on the way to a step would stop one.
    mount('<main><div id="wrap"><button id="del">删除</button></div></main>')
    const held = ref('#del')
    const seen = listen(at('#del'), ['pointerdown', 'mousedown', 'click'])
    at('#wrap').setAttribute('style', 'display: none')
    const outcome = await run([{ action: 'click', ref: held, label: '删除' }])
    expect(seen).toEqual([])
    expect(outcome.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'e1 is not visible now; call content_read for current refs.',
    }])
  })

  it('runs nothing when the column moved to another page while the user decided', async () => {
    // The user is asked about steps on "the entry on display" and answers when
    // they answer; the switcher strip is one click away the whole time.
    mount('<main><button id="del">删除</button></main>')
    const seen = listen(at('#del'), ['click'])
    claims = [{ claimed: true, page: { id: 'reports', title: '报表' } }]
    const outcome = await run([{ action: 'click', ref: ref('#del'), label: '删除' }])
    expect(seen).toEqual([])
    expect(outcome).toEqual({
      status: 'error',
      code: 'front-changed',
      message: 'The page in front is now "Home", not "报表" the steps were approved for; '
        + 'nothing was done. Ask the user, then retry.',
    })
  })

  it('runs the steps when the column still has the page they were approved against', async () => {
    mount('<main><button id="del">删除</button></main>')
    const seen = listen(at('#del'), ['click'])
    claims = [{ claimed: true, page: { id: 'home', title: 'Home' } }]
    const outcome = await run([{ action: 'click', ref: ref('#del'), label: '删除' }])
    expect(seen).toEqual(['click'])
    expect(outcome.status).toBe('done')
  })

  it('refuses to act on a page asking the user to sign in', async () => {
    // The listing of such a page is withheld from `content_read`; a channel
    // that typed into it would be the way around that.
    mount('<main><form><label for="u">用户名</label><input id="u">'
      + '<label for="p">密码</label><input id="p" type="password">'
      + '<button id="in">登录</button></form></main>')
    const held = ref('#u')
    render(<Probe seat={seatOf({
      callId: 'call_1',
      tool: 'content_act',
      args: { steps: [{ action: 'fill', ref: held, label: '用户名', text: 'admin' }] },
    })} />)
    await vi.waitFor(
      () => { expect(posted.filter(entry => entry.route === CONTENT_REPORT_ROUTE)).toHaveLength(1) },
      { timeout: 5000 },
    )
    expect((at('#u') as HTMLInputElement).value).toBe('')
    expect(posted.find(entry => entry.route === CONTENT_REPORT_ROUTE)?.body.outcome).toEqual({
      status: 'error',
      code: 'sign-in',
      message: 'The page shows a sign-in form; content_act will not act on it. '
        + 'Ask the user to sign in, then retry.',
    })
  })

  it('refuses a control the page has switched off', async () => {
    mount('<main><button id="save" disabled>保存</button></main>')
    const outcome = await run([{ action: 'click', ref: ref('#save'), label: '保存' }])
    expect(outcome.steps).toEqual([{ index: 1, status: 'failed', message: 'e1 "保存" is disabled.' }])
  })

  it('refuses an option no native list offers', async () => {
    mount('<main><label for="site">站点</label>'
      + '<select id="site"><option value="1">北京</option></select></main>')
    const native = await run([{ action: 'select', ref: ref('#site'), label: '站点', value: '东风' }])
    expect(native.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'no option reading "东风" appeared for e1; read the page to see what it offers.',
    }])
  })

  it('gives up on a drawn list that never offers the option', async () => {
    // The list opens and draws something else: the step spends its polls and
    // says what the page did not offer, rather than the call's whole deadline.
    mount('<main><div id="site" role="combobox" aria-label="站点">北京</div>'
      + '<div role="option">北京</div></main>')
    const outcome = await run([{ action: 'select', ref: ref('#site'), label: '站点', value: '东风' }])
    expect(outcome.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'no option reading "东风" appeared for e1; read the page to see what it offers.',
    }])
  }, 10_000)

  it('names a dialog that never called itself modal', async () => {
    mount('<main><button id="go">查询</button>'
      + '<div role="dialog" aria-label="筛选"><button id="ok">确定</button></div></main>')
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '查询' }])
    expect(outcome.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'e1 is behind the open dialog "筛选"; act inside the dialog or close it first.',
    }])
  })

  it('refuses to fill something that is not a box', async () => {
    mount('<main><button id="go">查询</button></main>')
    const outcome = await run([{ action: 'fill', ref: ref('#go'), label: '查询', text: '东风' }])
    expect(outcome.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'e1 is not something "fill" can be done to; read the page for what it offers.',
    }])
  })

  it('gives up on text that never appears, and says how long it waited', async () => {
    mount('<main><h1>Fleet</h1></main>')
    const outcome = await run([{ action: 'wait', text: '保存成功' }])
    expect(outcome.status).toBe('failed')
    expect(outcome.steps[0]?.status).toBe('failed')
    expect((outcome.steps[0] as { message: string }).message).toMatch(/^"保存成功" did not appear within 0\.7\d*s\.$/)
  })

  it('stops at the step the call had no time left to start', async () => {
    // The deadline is the host's: it started when the claim was granted, and
    // the steps get a share of it. A step that would start past that point is
    // not run, because nothing is waiting for its answer any more.
    mount('<main><button id="slow">查询</button><button id="save">保存</button></main>')
    at('#slow').addEventListener('click', () => {
      // An application taking its time over a click, in the only way a
      // synchronous handler can: the seat's own clock moves and nothing else.
      let spins = 0
      const until = Date.now() + 300
      while (Date.now() < until) spins += 1
      expect(spins).toBeGreaterThan(0)
    })
    const seen = listen(at('#save'), ['click'])
    render(<Probe seat={{
      ...seatOf({
        callId: 'call_1',
        tool: 'content_act',
        args: {
          steps: [
            { action: 'click', ref: ref('#slow'), label: '查询' },
            { action: 'click', ref: ref('#save'), label: '保存' },
            { action: 'wait', text: '保存成功' },
          ],
        },
      }),
      access: { ...ACCESS, actTimeoutMs: 200 },
    }} />)
    await vi.waitFor(
      () => { expect(posted.filter(entry => entry.route === CONTENT_REPORT_ROUTE)).toHaveLength(1) },
      { timeout: 5000 },
    )
    const outcome = posted.find(entry => entry.route === CONTENT_REPORT_ROUTE)?.body.outcome as ActOutcome
    expect(outcome.steps).toEqual([
      { index: 1, status: 'ok' },
      { index: 2, status: 'failed', message: 'the console\'s time for this call ran out before step 2.' },
      { index: 3, status: 'skipped' },
    ])
    expect(seen).toEqual([])
    expect(outcome.text).toContain(
      'Step 2 failed: the console\'s time for this call ran out before step 2. Step 1 ran; later steps were skipped.',
    )
  })

  it('never reads a password box\'s value back', async () => {
    mount('<main><label for="pass">密码</label><input id="pass" type="password"></main>')
    const outcome = await run([{ action: 'fill', ref: ref('#pass'), label: '密码', text: 'hunter2' }])
    expect((at('#pass') as HTMLInputElement).value).toBe('hunter2')
    expect(outcome.text).toContain('fill "密码" ← (hidden)')
    expect(outcome.text).not.toContain('hunter2')
  })

  it('withholds the value of a box the page is showing the password in', async () => {
    // A show/hide toggle makes it a `text` box; `autocomplete` is where the
    // page still says what it holds, and the value is a credential either way.
    mount('<main><label for="pass">密码</label>'
      + '<input id="pass" type="text" autocomplete="current-password"></main>')
    const outcome = await run([{ action: 'fill', ref: ref('#pass'), label: '密码', text: 'hunter2' }])
    expect((at('#pass') as HTMLInputElement).value).toBe('hunter2')
    expect(outcome.text).toContain('fill "密码" ← (hidden)')
    expect(outcome.text).not.toContain('hunter2')
  })
})

describe('what the page did on its own', () => {
  it('reports a message that came and went', async () => {
    mount('<main><button id="go">保存</button><div id="host"></div></main>')
    at('#go').addEventListener('click', () => {
      const toast = doc().createElement('div')
      toast.textContent = '查询成功'
      at('#host').append(toast)
      setTimeout(() => { toast.remove() }, 10)
    })
    const outcome = await run([
      { action: 'click', ref: ref('#go'), label: '保存' },
      { action: 'wait', text: 'Fleet' },
    ], undefined)
    expect(outcome.text).toMatch(/message "查询成功" \(shown for \d\.\ds, gone before the snapshot\)/)
  })

  it('reports a message the page wrote while it was hidden and then showed', async () => {
    // What an application actually does: the box is in the markup all along,
    // the words are written into it hidden, and it is revealed. Watching for
    // added text alone sees the words on no screen and reports nothing.
    mount('<main><button id="go">添加</button><div id="toast" hidden></div><div id="done"></div></main>')
    at('#go').addEventListener('click', () => {
      const toast = at('#toast') as HTMLElement
      toast.textContent = 'Added mill-09'
      toast.hidden = false
      setTimeout(() => {
        toast.hidden = true
        toast.textContent = ''
        // Waited for below, so the toast is gone before the report is composed
        // however the scheduler orders the two.
        at('#done').textContent = '完成'
      }, 20)
    })
    const outcome = await run([
      { action: 'click', ref: ref('#go'), label: '添加' },
      { action: 'wait', text: '完成' },
    ])
    expect(outcome.text).toMatch(/message "Added mill-09" \(shown for \d\.\ds, gone before the snapshot\)/)
  })

  it('reports a message a class change put in front of the user', async () => {
    mount('<style>.is-hidden { display: none }</style>'
      + '<main><button id="go">保存</button><div id="toast" class="toast is-hidden">已保存</div>'
      + '<div id="done"></div></main>')
    at('#go').addEventListener('click', () => {
      at('#toast').setAttribute('class', 'toast')
      setTimeout(() => {
        at('#toast').setAttribute('class', 'toast is-hidden')
        at('#done').textContent = '完成'
      }, 20)
    })
    const outcome = await run([
      { action: 'click', ref: ref('#go'), label: '保存' },
      { action: 'wait', text: '完成' },
    ])
    expect(outcome.text).toMatch(/message "已保存" \(shown for \d\.\ds, gone before the snapshot\)/)
  })

  it('reports a message the page has not taken away yet', async () => {
    // The closing read shows it too, and says nothing about where it came
    // from; this line is what says these steps produced it.
    mount('<main><button id="go">保存</button><div id="host"></div></main>')
    at('#go').addEventListener('click', () => {
      const toast = doc().createElement('div')
      toast.textContent = '保存成功'
      at('#host').append(toast)
    })
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '保存' }])
    expect(outcome.text).toContain('message "保存成功" (still shown)')
    expect(outcome.text).toContain('Page now:')
  })

  it('says nothing of text the page took away, and finds what an aria reveal showed', async () => {
    // Two halves of the same rule. What was on the page before the steps is
    // the page, not a message: hiding it is a change the closing read shows.
    // What the steps put in front of the user is a message however the page
    // uncovered it.
    mount('<main><button id="go">切换</button><div id="panel">面板</div>'
      + '<div id="toast" aria-hidden="true">已保存</div><div id="done"></div></main>')
    at('#go').addEventListener('click', () => {
      ;(at('#panel') as HTMLElement).hidden = true
      at('#toast').removeAttribute('aria-hidden')
      setTimeout(() => {
        at('#toast').setAttribute('aria-hidden', 'true')
        at('#done').textContent = '完成'
      }, 20)
    })
    const outcome = await run([
      { action: 'click', ref: ref('#go'), label: '切换' },
      { action: 'wait', text: '完成' },
    ])
    expect(outcome.text).toMatch(/message "已保存" \(shown for \d\.\ds, gone before the snapshot\)/)
    expect(outcome.text).not.toContain('面板')
  })

  it('lets go of text the page rewrote and removed in the same breath', async () => {
    // The one mutation whose target has no element left to look at.
    mount('<main><button id="go">刷新</button><div id="host">旧</div></main>')
    at('#go').addEventListener('click', () => {
      const text = at('#host').firstChild as Text
      text.data = '新'
      text.remove()
    })
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '刷新' }])
    expect(outcome.text).toContain('Page events during these steps: none.')
  })

  it('answers a confirm the page opens, and says what it said', async () => {
    mount('<main><button id="drop">删除</button></main>')
    let answered: boolean | undefined
    at('#drop').addEventListener('click', () => { answered = view().confirm('确定删除？') })
    const cancelled = await run([{ action: 'click', ref: ref('#drop'), label: '删除' }])
    expect(answered).toBe(false)
    expect(cancelled.text).toContain('dialog (confirm) "确定删除？" — answered cancel')

    posted = []
    cleanup()
    const accepted = await run([{ action: 'click', ref: ref('#drop'), label: '删除' }], 'accept')
    expect(answered).toBe(true)
    expect(accepted.text).toContain('dialog (confirm) "确定删除？" — answered accept')
  })

  it('answers an alert and a prompt without blocking the frame', async () => {
    mount('<main><button id="go">保存</button></main>')
    let typed: string | null = 'unset'
    at('#go').addEventListener('click', () => {
      view().alert('已保存')
      typed = view().prompt('叫什么？', '东风')
    })
    const cancelled = await run([{ action: 'click', ref: ref('#go'), label: '保存' }])
    expect(typed).toBeNull()
    expect(cancelled.text).toContain('dialog (alert) "已保存" — answered cancel')
    expect(cancelled.text).toContain('dialog (prompt) "叫什么？" — answered cancel')

    posted = []
    cleanup()
    const accepted = await run([{ action: 'click', ref: ref('#go'), label: '保存' }], 'accept')
    // The default the page offered is what a user pressing OK would send.
    expect(typed).toBe('东风')
    expect(accepted.text).toContain('dialog (prompt) "叫什么？" — answered accept')
  })

  it('reports a route change the page made while the steps ran', async () => {
    mount('<main><button id="go">详情</button></main>')
    at('#go').addEventListener('click', () => { view().location.hash = '#/detail/8812' })
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '详情' }])
    expect(outcome.text).toContain('navigation to ')
    expect(outcome.text).toContain('#/detail/8812')
  })

  it('reports a route change once, whether the page announced it or not', async () => {
    // Both halves of the same fact. The listener hears a router that announces
    // itself; the address is compared for one that does not, since `pushState`
    // fires nothing a listener can hear. A page doing both is reported once.
    mount('<main><button id="go">详情</button></main>')
    at('#go').addEventListener('click', () => {
      view().location.hash = '#/detail/8812'
      view().dispatchEvent(new Event('hashchange'))
    })
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '详情' }])
    // Once: jsdom answers one hash change with a `hashchange` and a
    // `popstate` of its own on top of the page's, and the model is being told
    // where the page went, not how many events said so.
    expect(outcome.text.split('\n').filter(line => line.includes('navigation to '))).toHaveLength(1)
  })

  it('reports a window the page tried to open, and opens none', async () => {
    mount('<main><button id="go">导出</button></main>')
    let opened: Window | null = null
    at('#go').addEventListener('click', () => { opened = view().open('/reports/8812') })
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '导出' }])
    expect(opened).toBeNull()
    expect(outcome.text)
      .toContain('the page tried to open /reports/8812 in a new window; it was not opened')
  })

  it('stops a link that would open a new window, and reports the attempt', async () => {
    mount('<main><a id="out" href="/reports/8812" target="_blank">导出</a>'
      + '<a id="bare" role="link" target="_new">导出全部</a></main>')
    let defaultPrevented = false
    doc().addEventListener('click', (event) => { defaultPrevented = event.defaultPrevented })
    const outcome = await run([{ action: 'click', ref: ref('#out'), label: '导出' }, { action: 'click', ref: ref('#bare'), label: '导出全部' }])
    expect(defaultPrevented).toBe(true)
    expect(outcome.text)
      .toContain('the page tried to open /reports/8812 in a new window; it was not opened')
    // A link with a target and no address still opens a window, and is still
    // reported rather than followed.
    expect(outcome.text).toContain('the page tried to open  in a new window; it was not opened')
  })

  it('reports what it can of a page that churns, and stops at the bound', async () => {
    // An application redrawing a list adds and removes far more than a model
    // can use; the watch keeps the first few and drops the rest.
    mount('<main><button id="go">刷新</button><div id="host"></div><div id="done"></div></main>')
    at('#go').addEventListener('click', () => {
      const host = at('#host')
      // A node that is neither text nor an element, which is what a framework
      // leaves behind as a placeholder.
      host.append(doc().createComment('anchor'))
      // A wrapper removed with the message inside it, rather than the message
      // itself: what went away is the subtree, and the text went with it.
      const wrapper = doc().createElement('div')
      const inner = doc().createElement('span')
      inner.textContent = '正在刷新'
      wrapper.append(inner)
      host.append(wrapper)
      for (let at = 0; at < 12; at += 1) {
        const toast = doc().createElement('div')
        toast.textContent = `第 ${String(at)} 条`
        host.append(toast)
      }
      setTimeout(() => { host.replaceChildren() }, 10)
      // Once the bound is full nothing further can be reported, and the watch
      // stops looking: this one arrives in a batch of its own after it.
      setTimeout(() => { at('#done').textContent = '完成'; host.append('迟到的一条') }, 30)
    })
    const outcome = await run([
      { action: 'click', ref: ref('#go'), label: '刷新' },
      { action: 'wait', text: '完成' },
    ])
    expect(outcome.text).toContain('message "正在刷新" (shown for')
    expect(outcome.text.split('\n').filter(line => line.includes('message "'))).toHaveLength(8)
    expect(outcome.text).not.toContain('message "迟到的一条"')
  })

  it('reports the text a user could read, and nothing else the page added', async () => {
    // Everything an application adds while it re-renders passes through the
    // same observer: a bare text node and a hidden node are added and removed
    // like any other, and neither is something the user saw.
    mount('<main><button id="go">保存</button><div id="host"></div></main>')
    at('#go').addEventListener('click', () => {
      const host = at('#host')
      const bare = doc().createTextNode('已保存')
      const blank = doc().createTextNode('   ')
      const hidden = doc().createElement('div')
      hidden.setAttribute('style', 'display: none')
      hidden.textContent = '内部状态'
      const empty = doc().createElement('div')
      host.append(bare, blank, hidden, empty)
      setTimeout(() => { host.replaceChildren() }, 10)
    })
    const outcome = await run([
      { action: 'click', ref: ref('#go'), label: '保存' },
      { action: 'wait', text: '保存' },
    ])
    expect(outcome.text).toContain('message "已保存" (shown for')
    expect(outcome.text).not.toContain('内部状态')
  })

  it('stands in for a dialog and a window the page opens with nothing to say', async () => {
    mount('<main><button id="go">保存</button></main>')
    let typed: string | null = 'unset'
    at('#go').addEventListener('click', () => {
      view().confirm()
      view().alert()
      typed = view().prompt()
      view().open()
    })
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '保存' }], 'accept')
    // `accept` with no default offered is the empty line a user would send by
    // pressing OK on an empty box.
    expect(typed).toBe('')
    expect(outcome.text).toContain('dialog (confirm) "" — answered accept')
    expect(outcome.text).toContain('the page tried to open  in a new window; it was not opened')
  })

  it('leaves a link that opens in this window alone', async () => {
    mount('<main><button id="go">导出</button>'
      + '<a id="plain" href="/reports">报表</a><a id="self" href="/here" target="_self">本页</a></main>')
    const followed: string[] = []
    at('#go').addEventListener('click', () => {
      for (const link of ['#plain', '#self']) {
        at(link).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
      // A click whose target is not an element at all, which is what a
      // synthetic event dispatched at the document is.
      doc().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    doc().addEventListener('click', (event) => {
      const anchor = (event.target as Element | null)?.closest?.('a')
      if (anchor !== null && anchor !== undefined && !event.defaultPrevented) followed.push(anchor.id)
    })
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '导出' }])
    expect(followed).toEqual(['plain', 'self'])
    expect(outcome.text).toContain('Page events during these steps: none.')
  })

  it('says so in one line when the page did nothing of its own', async () => {
    mount('<main><button id="go">查询</button></main>')
    const outcome = await run([{ action: 'click', ref: ref('#go'), label: '查询' }])
    expect(outcome.text).toContain('Page events during these steps: none.')
  })

  it('puts both stand-ins back when the call is over', async () => {
    // A frame left holding this package's `confirm` is a frame whose own
    // dialogs never open again, and nothing in the product would report it.
    mount('<main><button id="go">查询</button></main>')
    // oxlint-disable-next-line typescript/unbound-method -- identity is the assertion: these are compared, never called.
    const before = { confirm: view().confirm, alert: view().alert, prompt: view().prompt, open: view().open }
    await run([{ action: 'click', ref: ref('#go'), label: '查询' }])
    // oxlint-disable typescript/unbound-method -- as above.
    expect(view().confirm).toBe(before.confirm)
    expect(view().alert).toBe(before.alert)
    expect(view().prompt).toBe(before.prompt)
    expect(view().open).toBe(before.open)
    // oxlint-enable typescript/unbound-method
  })
})

describe('the documents one call reaches', () => {
  // The product's own topology: a shell page holding the application in a
  // same-origin frame of its own. The reader walks into it, so its refs name
  // elements there, and everything a step needs has to reach as far.
  it('acts on an element the page holds in a frame of its own', async () => {
    const inner = nest(
      '<main><h1>壳</h1><iframe id="inner"></iframe></main>',
      '<main><button id="go">查询</button></main>',
    )
    const seen = listen(atIn(inner.doc, '#go'), ['pointerdown', 'mousedown', 'click'])
    const outcome = await run([{ action: 'click', ref: refIn(inner.doc, '#go'), label: '查询' }])
    expect(seen).toEqual(['pointerdown', 'mousedown', 'click'])
    expect(outcome.status).toBe('done')
  })

  it('answers a confirm the application opens from inside that frame', async () => {
    // Unanswered, this blocks the whole tab until somebody presses a button
    // nobody can see: the stand-ins exist for exactly this, and installing
    // them on the outer document alone would leave it uncovered.
    const inner = nest(
      '<main><iframe id="inner"></iframe></main>',
      '<main><button id="drop">删除</button></main>',
    )
    let answered: boolean | undefined
    atIn(inner.doc, '#drop').addEventListener('click', () => { answered = inner.view.confirm('确定删除？') })
    const outcome = await run([{ action: 'click', ref: refIn(inner.doc, '#drop'), label: '删除' }], 'accept')
    expect(answered).toBe(true)
    expect(outcome.text).toContain('dialog (confirm) "确定删除？" — answered accept')
  })

  it('puts that frame\'s own stand-ins back too', async () => {
    const inner = nest('<main><iframe id="inner"></iframe></main>', '<main><button id="go">查询</button></main>')
    // oxlint-disable-next-line typescript/unbound-method -- identity is the assertion: these are compared, never called.
    const before = { confirm: inner.view.confirm, open: inner.view.open }
    await run([{ action: 'click', ref: refIn(inner.doc, '#go'), label: '查询' }])
    // oxlint-disable typescript/unbound-method -- as above.
    expect(inner.view.confirm).toBe(before.confirm)
    expect(inner.view.open).toBe(before.open)
    // oxlint-enable typescript/unbound-method
  })

  it('waits for text the application draws inside that frame', async () => {
    const inner = nest(
      '<main><iframe id="inner"></iframe></main>',
      '<main><button id="go">保存</button><div id="toast"></div></main>',
    )
    atIn(inner.doc, '#go').addEventListener('click', () => {
      setTimeout(() => { atIn(inner.doc, '#toast').textContent = '保存成功' }, 30)
    })
    const outcome = await run([
      { action: 'click', ref: refIn(inner.doc, '#go'), label: '保存' },
      { action: 'wait', text: '保存成功' },
    ])
    expect(outcome.steps).toEqual([{ index: 1, status: 'ok' }, { index: 2, status: 'ok' }])
  })

  it('reports a message and a route change from inside that frame', async () => {
    const inner = nest(
      '<main><iframe id="inner"></iframe></main>',
      '<main><button id="go">保存</button><div id="host"></div></main>',
    )
    atIn(inner.doc, '#go').addEventListener('click', () => {
      const toast = inner.doc.createElement('div')
      toast.textContent = '查询成功'
      atIn(inner.doc, '#host').append(toast)
      setTimeout(() => { toast.remove() }, 10)
      inner.view.location.hash = '#/detail/8812'
    })
    const outcome = await run([
      { action: 'click', ref: refIn(inner.doc, '#go'), label: '保存' },
      { action: 'wait', text: '保存' },
    ])
    expect(outcome.text).toMatch(/message "查询成功" \(shown for \d\.\ds, gone before the snapshot\)/)
    expect(outcome.text).toContain('#/detail/8812')
  })

  it('stops a link inside that frame from opening a window', async () => {
    const inner = nest(
      '<main><iframe id="inner"></iframe></main>',
      '<main><a id="out" href="/reports/8812" target="_blank">导出</a></main>',
    )
    let defaultPrevented = false
    inner.doc.addEventListener('click', (event) => { defaultPrevented = event.defaultPrevented })
    const outcome = await run([{ action: 'click', ref: refIn(inner.doc, '#out'), label: '导出' }])
    expect(defaultPrevented).toBe(true)
    expect(outcome.text).toContain('the page tried to open /reports/8812 in a new window; it was not opened')
  })

  it('refuses a target inside that frame when the shell has a dialog over it', async () => {
    const inner = nest(
      '<main><iframe id="inner"></iframe>'
      + '<div role="dialog" aria-modal="true" aria-label="编辑设备"><button id="ok">确定</button></div></main>',
      '<main><button id="go">查询</button></main>',
    )
    const seen = listen(atIn(inner.doc, '#go'), ['click'])
    const outcome = await run([{ action: 'click', ref: refIn(inner.doc, '#go'), label: '查询' }])
    expect(seen).toEqual([])
    expect(outcome.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'e1 is behind the open dialog "编辑设备"; act inside the dialog or close it first.',
    }])
  })

  it('acts inside a dialog the shell draws the frame in', async () => {
    // The dialog holds the frame, so what is in the frame is what the user is
    // being shown; `contains` alone answers false across the boundary.
    const inner = nest(
      '<main><div role="dialog" aria-modal="true" aria-label="编辑设备">'
      + '<iframe id="inner"></iframe></div></main>',
      '<main><button id="ok">确定</button></main>',
    )
    const seen = listen(atIn(inner.doc, '#ok'), ['click'])
    const outcome = await run([{ action: 'click', ref: refIn(inner.doc, '#ok'), label: '确定' }])
    expect(seen).toEqual(['click'])
    expect(outcome.status).toBe('done')
  })

  it('refuses a target the application covered with a dialog of its own', async () => {
    const inner = nest(
      '<main><iframe id="inner"></iframe></main>',
      '<main><button id="go">查询</button>'
      + '<div role="dialog" aria-modal="true" aria-label="编辑设备"><button id="ok">确定</button></div></main>',
    )
    const outcome = await run([{ action: 'click', ref: refIn(inner.doc, '#go'), label: '查询' }])
    expect(outcome.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'e1 is behind the open dialog "编辑设备"; act inside the dialog or close it first.',
    }])
  })

  it('never reads back a password box the application holds in that frame', async () => {
    const inner = nest(
      '<main><iframe id="inner"></iframe></main>',
      '<main><label for="pass">密码</label><input id="pass" type="password"></main>',
    )
    const outcome = await run([{ action: 'fill', ref: refIn(inner.doc, '#pass'), label: '密码', text: 'hunter2' }])
    expect((atIn(inner.doc, '#pass') as HTMLInputElement).value).toBe('hunter2')
    expect(outcome.text).toContain('fill "密码" ← (hidden)')
    expect(outcome.text).not.toContain('hunter2')
  })
})

describe('what the call answers with', () => {
  it('carries the three sections and a fresh reading of the page', async () => {
    mount('<main><label for="name">名称</label><input id="name">'
      + '<button id="go">查询</button></main>')
    at('#go').addEventListener('click', () => {
      const heading = doc().createElement('h2')
      heading.textContent = '结果'
      at('main').append(heading)
    })
    const outcome = await run([
      { action: 'fill', ref: ref('#name'), label: '名称', text: '东风' },
      { action: 'click', ref: ref('#go'), label: '查询' },
    ])
    expect(outcome.page).toEqual({ id: 'home', title: 'Home' })
    const [first, ...rest] = outcome.text.split('\n')
    expect(first).toMatch(/^Done 2\/2 on Home: fill "名称" ← "东风"; click "查询" \(settled after \d\.\ds\)\.$/)
    // What the click drew is still on the page, and the closing read shows it
    // without saying these steps produced it — which is what this line says.
    expect(rest[0]).toBe('Page events during these steps:')
    expect(rest[1]).toBe('  message "结果" (still shown)')
    expect(rest[2]).toBe('Page now:')
    // The closing snapshot is a whole read at the deployment's own budget, so
    // the refs it names are the ones the model's next call can use.
    expect(rest.slice(3).join('\n')).toContain('textbox "名称"')
  })

  it('withholds the page when the steps left a sign-in form in front of the user', async () => {
    // A sign-out, or a session that expired mid-call: the closing read is a
    // read like any other, and `content_read` would not hand this one over.
    mount('<main><button id="out">退出登录</button><div id="host"></div></main>')
    at('#out').addEventListener('click', () => {
      at('#host').innerHTML = '<form><label for="u">用户名</label><input id="u">'
        + '<label for="p">密码</label><input id="p" type="password"><button>登录</button></form>'
    })
    const outcome = await run([{ action: 'click', ref: ref('#out'), label: '退出登录' }])
    expect(outcome.status).toBe('done')
    expect(outcome.text).toContain('Page now:\nThe page shows a sign-in form; ask the user to sign in, then retry.')
    // The message lines go with the listing: they are the only ones that quote
    // what the page draws, and what it draws here is the credential form.
    expect(outcome.text).toContain('Page events during these steps: none.')
    expect(outcome.text).not.toContain('用户名')
    expect(outcome.truncated).toBe(false)
  })

  it('says the page is too wide rather than posting a body the route refuses', async () => {
    // The renderer prints a listing's first row however long that row is, so a
    // budget this small meets a row it cannot cut — and the seat says so
    // instead of posting a body the route would refuse for its size.
    mount(`<main><button id="go">查询</button><h1>${'长'.repeat(300)}</h1></main>`)
    render(<Probe seat={{
      ...seatOf({ callId: 'call_1', tool: 'content_act', args: { steps: [{ action: 'click', ref: ref('#go'), label: '查询' }] } }),
      access: { ...ACCESS, outlineChars: 30 },
    }} />)
    await vi.waitFor(
      () => { expect(posted.filter(entry => entry.route === CONTENT_REPORT_ROUTE)).toHaveLength(1) },
      { timeout: 5000 },
    )
    expect(posted.find(entry => entry.route === CONTENT_REPORT_ROUTE)?.body.outcome)
      .toEqual({ status: 'error', code: 'frame', message: FRAME_WIDE_LISTING_MESSAGE })
  })

  it('says what the reader threw rather than leaving the call unanswered', async () => {
    mount('<main><button id="go">查询</button></main>')
    const held = ref('#go')
    vi.spyOn(refs, 'resolve').mockImplementation(() => { throw new Error('the numbering is gone') })
    const request: ContentActRequest = {
      callId: 'call_1',
      tool: 'content_act',
      args: { steps: [{ action: 'click', ref: held, label: '查询' }] },
    }
    render(<Probe seat={seatOf(request)} />)
    await vi.waitFor(
      () => { expect(posted.filter(entry => entry.route === CONTENT_REPORT_ROUTE)).toHaveLength(1) },
      { timeout: 5000 },
    )
    expect(posted.find(entry => entry.route === CONTENT_REPORT_ROUTE)?.body.outcome)
      .toEqual({ status: 'error', code: 'engine', message: 'the numbering is gone' })
  })

  it('answers the four endings a read answers when there is no page to act on', async () => {
    const request: ContentActRequest = {
      callId: 'call_1',
      tool: 'content_act',
      args: { steps: [{ action: 'click', ref: 'e1', label: '查询' }] },
    }
    render(<Probe seat={{ ...seatOf(request), entries: [] }} />)
    await vi.waitFor(
      () => { expect(posted.filter(entry => entry.route === CONTENT_REPORT_ROUTE)).toHaveLength(1) },
      { timeout: 5000 },
    )
    expect(posted.find(entry => entry.route === CONTENT_REPORT_ROUTE)?.body.outcome)
      .toEqual({ status: 'error', code: 'empty', message: 'the content column is empty' })
  })
})
