// @vitest-environment jsdom
/**
 * The structural read of a page. Every string the model sees is pinned here
 * word for word: the rows, the counts, the table block, and each of the three
 * things a read says when it cannot show everything — the skeleton, the cursor,
 * and the refusal of a ref the page no longer has.
 *
 * Visibility and geometry arrive injected, as they do in the browser: these
 * fixtures declare them with `data-hidden` and `data-rect` because jsdom lays
 * nothing out.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RefTable } from '../src/client/access/refs.ts'
import { snapshot, type Snapshot, type SnapshotOptions } from '../src/client/access/snapshot.ts'

/** The parts of a read a test varies. */
type Ask = Partial<Pick<SnapshotOptions, 'mode' | 'scope' | 'after' | 'find' | 'isClickable' | 'budgetChars'>>

/** Hidden by marker, and hidden inside anything marked hidden. */
function isVisible(el: Element): boolean {
  return el.closest('[data-hidden]') === null
}

/** Geometry from `data-rect="x,y,width,height"`, absent for anything unmarked. */
function rectOf(el: Element): DOMRectReadOnly | undefined {
  const raw = el.getAttribute('data-rect')
  if (raw === null) return undefined
  const [x = 0, y = 0, width = 0, height = 0] = raw.split(',').map(Number)
  return new DOMRect(x, y, width, height)
}

/** Put one page up, with a fresh numbering. */
function page(html: string): RefTable {
  document.body.innerHTML = html
  return new RefTable()
}

/** Read the page up. */
function read(refs: RefTable, ask: Ask = {}): Snapshot {
  return snapshot(document, { refs, budgetChars: 4000, isVisible, rectOf, ...ask })
}

/** The ref of one element, which the read has already numbered. */
function refOf(refs: RefTable, selector: string): string {
  const el = document.querySelector(selector)
  if (el === null) throw new Error(`fixture has no ${selector}`)
  return refs.ref(el)
}

afterEach(() => {
  document.body.innerHTML = ''
  document.title = ''
})

const CONSOLE = `
<main aria-label="站点管理">
  <nav class="el-breadcrumb"><span>首页</span><span class="sep">/</span><span>站点管理</span></nav>
  <h2>站点列表</h2>
  <p>共 <span>20</span> 个站点。</p>
  <form aria-label="查询">
    <input type="text" aria-label="名称" value="东风">
    <select aria-label="状态"><option>启用</option><option selected>停用</option></select>
    <input type="checkbox" aria-label="仅看我的" checked>
    <div class="ops"><button>查询</button><button disabled>导出</button></div>
  </form>
  <table>
    <thead><tr><th>名称</th><th>唯一标识</th><th>操作</th></tr></thead>
    <tbody>
      <tr><td>东风站</td><td>P-0001</td><td><button>编辑</button><button>删除</button></td></tr>
      <tr><td>朝阳站</td><td>P-0002</td><td><button>编辑</button><button>删除</button></td></tr>
    </tbody>
  </table>
  <div class="el-pagination">上一页 1 2 下一页</div>
  <div role="dialog" aria-label="导入设置" data-hidden><button>确定</button></div>
</main>`

describe('reading a page', () => {
  it('reads a console page as its containers, its controls, and the text between them', () => {
    const refs = page(CONSOLE)
    const snap = read(refs)
    expect(snap.kind).toBe('outline')
    expect(snap.truncated).toBe(false)
    expect(snap.cursor).toBeUndefined()
    expect(snap.shown).toBe(snap.total)
    expect(snap.text).toBe([
      'e1 main "站点管理"',
      '  e2 nav',
      '    text "首页 / 站点管理" (nav)',
      '  e3 heading "站点列表" (in main "站点管理")',
      '  text "共 20 个站点。" (in main "站点管理")',
      '  e4 form "查询"',
      '    e5 textbox "名称" = "东风" (in form "查询")',
      '    e6 combobox "状态" = "停用" (in form "查询")',
      '    e7 checkbox "仅看我的" [x] (in form "查询")',
      '    e8 toolbar',
      '      e9 button "查询" (toolbar)',
      '      e10 button "导出" (disabled) (toolbar)',
      '  e11 table 2 rows × 3 cols',
      '    header: 名称 | 唯一标识 | 操作',
      '    sample: 东风站 | P-0001 | [编辑 删除]',
      "    rows: pass scope with this table's ref to list rows, or find a row by its text",
      '    pagination: 上一页 1 2 下一页',
      '  text "上一页 1 2 下一页" (in main "站点管理")',
    ].join('\n'))
  })

  it('counts what a container holds itself, and says nothing about one that only holds another', () => {
    const refs = page('<main><nav aria-label="侧栏"><a href="/a">站点</a><a href="/b">告警</a></nav></main>')
    expect(read(refs, { mode: 'map' }).text).toBe(['e1 main', '  e2 nav "侧栏"  2 links'].join('\n'))
  })

  it('reads the same page as a skeleton when asked for one, counting what each container holds', () => {
    const refs = page(CONSOLE)
    read(refs)
    const snap = read(refs, { mode: 'map' })
    expect(snap.kind).toBe('map')
    expect(snap.truncated).toBe(false)
    expect(snap.text).toBe([
      'e1 main "站点管理"  3 texts',
      '  e2 nav  1 texts',
      '  e4 form "查询"  3 fields',
      '    e8 toolbar  2 buttons',
      '  e11 table  2 rows',
      '  e18 dialog "导入设置"  hidden',
    ].join('\n'))
  })

  it('lists a table\'s rows when the read names that table, and numbers the controls in them', () => {
    const refs = page(CONSOLE)
    read(refs)
    const snap = read(refs, { scope: refOf(refs, 'table') })
    expect(snap.text).toBe([
      'e11 table 2 rows × 3 cols',
      '  header: 名称 | 唯一标识 | 操作',
      '  row 1: 东风站 | P-0001 | e13 button "编辑"  e14 button "删除"',
      '  row 2: 朝阳站 | P-0002 | e16 button "编辑"  e17 button "删除"',
    ].join('\n'))
  })

  it('finds a row by its text and answers with that row alone', () => {
    const refs = page(CONSOLE)
    read(refs)
    expect(read(refs, { find: '朝阳' }).text)
      .toBe('row 2: 朝阳站 | P-0002 | e16 button "编辑"  e17 button "删除" (table)')
  })

  it('finds controls and text anywhere on the page, flat, each saying where it lives', () => {
    const refs = page(CONSOLE)
    read(refs)
    const snap = read(refs, { find: '站点' })
    expect(snap.text).toBe([
      'text "首页 / 站点管理" (nav)',
      'e3 heading "站点列表" (in main "站点管理")',
      'text "共 20 个站点。" (in main "站点管理")',
    ].join('\n'))
    expect(snap.total).toBe(3)
  })

  it('matches without regard to case', () => {
    const refs = page('<button>Save Draft</button><p>saved</p>')
    expect(read(refs, { find: 'SAVE' }).text).toBe(['e1 button "Save Draft"', 'text "saved"'].join('\n'))
  })

  it('reads only the subtree a read names', () => {
    const refs = page(CONSOLE)
    read(refs)
    expect(read(refs, { scope: refOf(refs, 'form') }).text).toBe([
      'e4 form "查询"',
      '  e5 textbox "名称" = "东风" (in form "查询")',
      '  e6 combobox "状态" = "停用" (in form "查询")',
      '  e7 checkbox "仅看我的" [x] (in form "查询")',
      '  e8 toolbar',
      '    e9 button "查询" (toolbar)',
      '    e10 button "导出" (disabled) (toolbar)',
    ].join('\n'))
  })
})

describe('what a page says about itself', () => {
  it('reports the document it read and the trail saying where the user is', () => {
    document.title = '站点管理 - 运维平台'
    const refs = page(CONSOLE)
    const header = read(refs).header
    expect(header.url).toBe(document.URL)
    expect(header.title).toBe('站点管理 - 运维平台')
    expect(header.breadcrumb).toBe('首页 › 站点管理')
    expect(header.modal).toBeUndefined()
    expect(header.signIn).toBe(false)
  })

  it('reads a breadcrumb a page marks with a navigation label', () => {
    const refs = page('<nav aria-label="Breadcrumb"><a href="/">首页</a><span>›</span><span>详情</span></nav>')
    expect(read(refs).header.breadcrumb).toBe('首页 › 详情')
  })

  it('reports no trail for a marked strip that shows nothing, or for a page with none', () => {
    expect(read(page('<div class="breadcrumb"></div><p>正文</p>')).header.breadcrumb).toBeUndefined()
    expect(read(page('<div class="breadcrumb" data-hidden>首页</div>')).header.breadcrumb).toBeUndefined()
    expect(read(page('<p>正文</p>')).header.breadcrumb).toBeUndefined()
  })

  it('names the dialog the page has open, preferring the one that declares itself modal', () => {
    const refs = page(`
      <div role="dialog" aria-label="侧边抽屉"></div>
      <div role="dialog" aria-modal="true"><h3>导入设置</h3><button>确定</button></div>`)
    expect(read(refs).header.modal).toBe('导入设置')
  })

  it('names a dialog that only sits on top when none declares itself modal', () => {
    expect(read(page('<div role="dialog" aria-label="侧边抽屉"></div>')).header.modal).toBe('侧边抽屉')
  })

  it('says nothing about a dialog the page has not opened', () => {
    expect(read(page('<div role="dialog" aria-label="导入设置" data-hidden></div>')).header.modal).toBeUndefined()
  })

  it('puts a dialog the page has not opened on the skeleton, named by the title inside it', () => {
    const refs = page('<div role="dialog" data-hidden><h3>导入设置</h3><button>确定</button></div><button>导入</button>')
    expect(read(refs, { mode: 'map' }).text).toBe('e1 dialog "导入设置"  hidden')
    expect(read(refs).text).toBe('e2 button "导入"')
  })

  it('recognises a sign-in page by a password box beside a box naming the account', () => {
    const refs = page(`
      <form aria-label="登录">
        <input type="text" aria-label="账号">
        <input type="password" aria-label="密码">
        <button>登录</button>
      </form>`)
    expect(read(refs).header.signIn).toBe(true)
  })

  it('recognises a sign-in page whose fields sit in no form at all', () => {
    expect(read(page('<input aria-label="账号"><input type="password" aria-label="密码">')).header.signIn).toBe(true)
  })

  it('is not a sign-in page when the account box is hidden, or when there is none', () => {
    expect(read(page('<div data-hidden><input type="text"></div><input type="password">')).header.signIn).toBe(false)
    expect(read(page('<input type="password" aria-label="密码">')).header.signIn).toBe(false)
    expect(read(page('<div data-hidden><input type="password"></div><input type="text">')).header.signIn).toBe(false)
  })
})

describe('what never reaches the model', () => {
  it('reports a password box and never what it holds', () => {
    const refs = page('<input type="password" aria-label="密码" value="hunter2">')
    expect(read(refs).text).toBe('e1 textbox "密码" = (hidden)')
    expect(read(refs).text).not.toContain('hunter2')
  })

  it('skips what the page hides, what it marks hidden from readers, and what is not content', () => {
    const refs = page(`
      <script>const secret = 1</script>
      <style>.a { color: red }</style>
      <template><button>模板按钮</button></template>
      <noscript><button>无脚本按钮</button></noscript>
      <div aria-hidden="true"><button>装饰按钮</button></div>
      <div hidden><button>折叠按钮</button></div>
      <div data-hidden><button>不可见按钮</button></div>
      <button>真按钮</button>`)
    expect(read(refs).text).toBe('e1 button "真按钮"')
  })

  it('reads past a comment', () => {
    expect(read(page('<!-- 说明 --><button>确定</button>')).text).toBe('e1 button "确定"')
  })
})

describe('text', () => {
  it('joins text either side of an inline element and breaks it at a block', () => {
    const refs = page('<div><p>共 <b>20</b> 个站点</p><p>已停用 <i>2</i> 个</p></div>')
    expect(read(refs).text).toBe(['text "共 20 个站点"', 'text "已停用 2 个"'].join('\n'))
  })

  it('cuts an over-long run and says it was cut', () => {
    const refs = page(`<p>${'长'.repeat(240)}</p>`)
    expect(read(refs).text).toBe(`text "${'长'.repeat(197)}…"`)
  })

  it('keeps a run that is exactly as long as it may be', () => {
    const refs = page(`<p>${'长'.repeat(200)}</p>`)
    expect(read(refs).text).toBe(`text "${'长'.repeat(200)}"`)
  })

  it('says nothing for whitespace between elements', () => {
    expect(read(page('<div>   \n  </div><button>确定</button>')).text).toBe('e1 button "确定"')
  })
})

describe('containers the page does not name outright', () => {
  it('reads a row of buttons as a toolbar, and a row of other things as neither', () => {
    const refs = page('<div><button>新增</button><button>导入</button></div><div><button>删除</button><span>提示</span></div>')
    expect(read(refs).text).toBe([
      'e1 toolbar',
      '  e2 button "新增" (toolbar)',
      '  e3 button "导入" (toolbar)',
      'e4 button "删除"',
      'text "提示"',
    ].join('\n'))
  })

  it('counts only what a reader can see when deciding a row of buttons is a toolbar', () => {
    const refs = page('<div><button>新增</button><button>导入</button><span data-hidden>提示</span></div>')
    expect(read(refs).text.startsWith('e1 toolbar')).toBe(true)
  })

  it('reads a list of three as a list and a list of two as its contents', () => {
    const refs = page(`
      <ul aria-label="站点"><li><a href="/a">甲</a></li><li><a href="/b">乙</a></li><li><a href="/c">丙</a></li></ul>
      <ol><li>一</li><li>二</li></ol>
      <div role="list"><span>不是列表</span></div>`)
    expect(read(refs).text).toBe([
      'e1 list "站点"',
      '  e2 link "甲" (in list "站点")',
      '  e3 link "乙" (in list "站点")',
      '  e4 link "丙" (in list "站点")',
      'text "一"',
      'text "二"',
      'text "不是列表"',
    ].join('\n'))
  })

  it('reads a titled region as a section and an untitled one as its contents', () => {
    const refs = page(`
      <section><h3>近期告警</h3><p>无</p></section>
      <article aria-label="公告"><p>系统维护</p></article>
      <aside><p>无标题</p></aside>`)
    expect(read(refs).text).toBe([
      'e1 section "近期告警"',
      '  e2 heading "近期告警" (in section "近期告警")',
      '  text "无" (in section "近期告警")',
      'e3 section "公告"',
      '  text "系统维护" (in section "公告")',
      'text "无标题"',
    ].join('\n'))
  })

  it('names a section by its heading only when a reader can see that heading', () => {
    expect(read(page('<section><h3 data-hidden>看不见</h3><p>正文</p></section>')).text).toBe('text "正文"')
  })

  it('reads an element the page makes clickable as a click target', () => {
    const refs = page('<div class="card">新建站点</div><div class="plain">说明</div>')
    const clickable = (el: Element): boolean => el.className === 'card'
    expect(read(refs, { isClickable: clickable }).text).toBe([
      'e1 clickable "新建站点"',
      'text "说明"',
    ].join('\n'))
  })

  it('takes a pointer cursor as the page saying an element is clickable', () => {
    const refs = page('<div style="cursor: pointer">新建站点</div><div>说明</div>')
    expect(read(refs).text).toBe(['e1 clickable "新建站点"', 'text "说明"'].join('\n'))
  })
})

describe('controls', () => {
  it('reports what each control holds and whether the page has switched it off', () => {
    const refs = page(`
      <textarea aria-label="备注">两行\n备注</textarea>
      <input type="search" aria-label="搜索" value="东风">
      <input type="number" aria-label="数量" value="3">
      <select aria-label="空选择"></select>
      <div role="textbox" aria-label="富文本"></div>
      <input type="checkbox" aria-label="甲">
      <input type="radio" aria-label="乙" checked>
      <div role="switch" aria-checked="true" aria-label="丙"></div>
      <div role="switch" aria-checked="false" aria-label="丁"></div>
      <div role="checkbox" aria-label="戊"></div>
      <button aria-disabled="true">禁用按钮</button>
      <div role="button" aria-label="可用">图标</div>`)
    expect(read(refs).text).toBe([
      'e1 textbox "备注" = "两行 备注"',
      'e2 searchbox "搜索" = "东风"',
      'e3 spinbutton "数量" = "3"',
      'e4 combobox "空选择" = ""',
      'e5 textbox "富文本"',
      'e6 checkbox "甲" [ ]',
      'e7 radio "乙" [x]',
      'e8 switch "丙" [x]',
      'e9 switch "丁" [ ]',
      'e10 checkbox "戊" [ ]',
      'e11 button "禁用按钮" (disabled)',
      'e12 button "可用"',
    ].join('\n'))
  })
})

describe('tables', () => {
  it('reads a table that keeps its rows outside a body, and one that has no rows at all', () => {
    const refs = page(`
      <div role="table" aria-label="配额">
        <div role="row"><div role="columnheader">项目</div><div role="columnheader">上限</div></div>
        <div role="row"><div role="cell">并发</div><div role="cell">10</div></div>
      </div>
      <div role="table" aria-label="空表"></div>`)
    expect(read(refs).text).toBe([
      'e1 table "配额" 1 rows × 2 cols',
      '  header: 项目 | 上限',
      '  sample: 并发 | 10',
      "  rows: pass scope with this table's ref to list rows, or find a row by its text",
      'e3 table "空表" 0 rows × 0 cols',
    ].join('\n'))
  })

  it('takes the first row as the header when the table declares none', () => {
    const refs = page(`
      <div role="table"><div role="row"><div role="cell">名称</div></div><div role="row"><div role="cell">东风站</div></div></div>`)
    expect(read(refs).text.split('\n')[1]).toBe('  header: 名称')
  })

  it('reports the pagination strip beside a table, and nothing when the strip shows nothing', () => {
    const refs = page(`
      <section aria-label="站点">
        <div class="pagination"></div>
        <table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>东风站</td></tr></tbody></table>
        <nav aria-label="Pagination navigation">共 2 页</nav>
      </section>`)
    expect(read(refs).text).toContain('    pagination: 共 2 页')
  })

  it('reads what a cell shows, through the wrappers around it and past what it hides', () => {
    const refs = page(`
      <table>
        <thead><tr><th>名称</th><th>操作</th></tr></thead>
        <tbody><tr>
          <td><!-- 内部备注 --> <span data-hidden>P-0001</span> <span>东风站</span></td>
          <td><div class="cell"><button>编辑</button></div></td>
        </tr></tbody>
      </table>`)
    expect(read(refs).text).toContain('  sample: 东风站 | [编辑]')
  })

  it('reports no pagination for a table that has none beside it', () => {
    const refs = page('<table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>东风站</td></tr></tbody></table>')
    expect(read(refs).text).not.toContain('pagination')
  })
})

describe('frames and shadow roots', () => {
  it('reads a same-origin frame inside a same-origin frame as one page', () => {
    const refs = page('<iframe title="业务系统"></iframe>')
    const outer = document.querySelector('iframe')?.contentDocument
    if (outer === null || outer === undefined) throw new Error('jsdom gave the frame no document')
    outer.body.innerHTML = '<h1>站点管理</h1><iframe title="报表"></iframe>'
    const inner = outer.querySelector('iframe')?.contentDocument
    if (inner === null || inner === undefined) throw new Error('jsdom gave the inner frame no document')
    inner.body.innerHTML = '<button>导出报表</button>'
    expect(read(refs).text).toBe([
      'e1 frame "业务系统"',
      '  e2 heading "站点管理" (in frame "业务系统")',
      '  e3 frame "报表"',
      '    e4 button "导出报表" (in frame "报表")',
    ].join('\n'))
  })

  it('says a frame of another origin cannot be read, whether it refuses or answers nothing', () => {
    const refs = page('<button>本页按钮</button>')
    const refusing = document.createElement('iframe')
    Object.defineProperty(refusing, 'contentDocument', {
      get() {
        throw new Error('SecurityError')
      },
    })
    const empty = document.createElement('iframe')
    Object.defineProperty(empty, 'contentDocument', { get: () => null })
    document.body.append(refusing, empty)
    expect(read(refs).text).toBe([
      'e1 button "本页按钮"',
      'frame (not readable)',
      'frame (not readable)',
    ].join('\n'))
    expect(read(refs, { mode: 'map' }).text).toBe(['frame (not readable)', 'frame (not readable)'].join('\n'))
  })

  it('reads what an open shadow root renders in place of its host\'s children', () => {
    const refs = page('<div id="host"><span>被替换</span></div>')
    const host = document.querySelector('#host')
    if (host === null) throw new Error('fixture has no host')
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>影子按钮</button>'
    expect(read(refs).text).toBe('e1 button "影子按钮"')
  })
})

describe('the same thing drawn twice', () => {
  const PINNED = `
    <table data-rect="0,0,800,200">
      <thead><tr><th data-rect="0,0,100,40">名称</th><th data-rect="100,0,100,40">操作</th></tr></thead>
      <tbody><tr><td data-rect="0,40,100,40">东风站</td><td data-rect="100,40,100,40">编辑</td></tr></tbody>
    </table>
    <table data-rect="0,0,100,200">
      <thead><tr><th data-rect="0,0,100,40">名称</th></tr></thead>
      <tbody><tr><td data-rect="0,40,100,40">东风站</td></tr></tbody>
    </table>`

  it('drops the copy a pinned column draws over the table it belongs to', () => {
    expect(read(page(PINNED)).text).toBe([
      'e1 table 1 rows × 2 cols',
      '  header: 名称 | 操作',
      '  sample: 东风站 | 编辑',
      "  rows: pass scope with this table's ref to list rows, or find a row by its text",
    ].join('\n'))
  })

  it('keeps two elements that say the same thing in different places', () => {
    const refs = page('<button data-rect="0,0,80,30">保存</button><button data-rect="0,600,80,30">保存</button>')
    expect(read(refs).text).toBe(['e1 button "保存"', 'e2 button "保存"'].join('\n'))
  })

  it('keeps both when the page reports no size for them', () => {
    const refs = page('<button data-rect="0,0,0,0">保存</button><button data-rect="0,0,0,0">保存</button>')
    expect(read(refs).text).toBe(['e1 button "保存"', 'e2 button "保存"'].join('\n'))
  })

  it('drops a control the page draws twice over the same spot', () => {
    const refs = page('<button data-rect="0,0,80,30">保存</button><button data-rect="0,0,80,30">保存</button>')
    expect(read(refs).text).toBe('e1 button "保存"')
  })

  it('drops a cell a pinned column repeats inside one table', () => {
    const refs = page(`
      <table data-rect="0,0,400,80">
        <thead><tr>
          <th data-rect="0,0,100,40">名称</th><th data-rect="0,0,100,40">名称</th><th data-rect="100,0,100,40">操作</th>
        </tr></thead>
        <tbody><tr>
          <td data-rect="0,40,100,40">东风站</td><td data-rect="0,40,100,40">东风站</td><td data-rect="100,40,100,40">P-0001</td>
        </tr></tbody>
      </table>`)
    expect(read(refs).text).toBe([
      'e1 table 1 rows × 2 cols',
      '  header: 名称 | 操作',
      '  sample: 东风站 | P-0001',
      "  rows: pass scope with this table's ref to list rows, or find a row by its text",
    ].join('\n'))
  })

  it('drops a container the page draws twice, and everything inside the copy', () => {
    const refs = page(`
      <div role="toolbar" aria-label="操作" data-rect="0,0,200,40"><button>新增</button></div>
      <div role="toolbar" aria-label="操作" data-rect="0,0,200,40"><button>新增</button></div>`)
    expect(read(refs).text).toBe(['e1 toolbar "操作"', '  e2 button "新增" (in toolbar "操作")'].join('\n'))
  })
})

describe('when there is more page than budget', () => {
  it('answers a whole page too large for the budget with its skeleton, and where to read next', () => {
    const refs = page(CONSOLE)
    const snap = read(refs, { budgetChars: 60 })
    expect(snap.kind).toBe('map')
    expect(snap.truncated).toBe(true)
    expect(snap.cursor).toBeUndefined()
    expect(snap.text.split('\n').at(-1)).toBe('Read a part with scope, e.g. content_read({ scope: "e1" }).')
    expect(snap.shown).toBe(6)
    expect(snap.total).toBe(14)
  })

  it('answers a page with no skeleton to draw with the rows it has, cut short', () => {
    const refs = page('<p>说明一</p><p>说明二</p><p>说明三</p>')
    const snap = read(refs, { budgetChars: 5 })
    expect(snap.kind).toBe('outline')
    expect(snap.truncated).toBe(true)
    expect(snap.cursor).toBeUndefined()
    expect(snap.text).toBe([
      'text "说明一"',
      '(cut here; 2 items remain — narrow the read with find, or read a part with scope)',
    ].join('\n'))
  })

  it('points a reader at the table when the table is the biggest thing on the page', () => {
    const rows = Array.from({ length: 6 }, (_, index) => `<tr><td>站点${index}</td></tr>`).join('')
    const refs = page(`<p>说明</p><table><thead><tr><th>名称</th></tr></thead><tbody>${rows}</tbody></table>`)
    const snap = read(refs, { budgetChars: 30 })
    expect(snap.kind).toBe('map')
    expect(snap.text).toBe([
      'e1 table  6 rows',
      'Read a part with scope, e.g. content_read({ scope: "e1" }).',
    ].join('\n'))
  })

  it('cuts a listing the read asked for by ref, and says where to continue', () => {
    const refs = page(CONSOLE)
    read(refs)
    const snap = read(refs, { scope: refOf(refs, 'form'), budgetChars: 60 })
    expect(snap.kind).toBe('outline')
    expect(snap.truncated).toBe(true)
    expect(snap.cursor).toBe('e5')
    expect(snap.text).toBe([
      'e4 form "查询"',
      '  e5 textbox "名称" = "东风" (in form "查询")',
      '(cut after e5 — pass after: "e5" to continue; 5 items remain)',
    ].join('\n'))
    expect(snap.shown).toBe(2)
    expect(snap.total).toBe(7)
  })

  it('tells a read cut at rows the model cannot name to narrow itself instead', () => {
    const refs = page('<p>站点甲的说明</p><p>站点乙的说明</p><button>站点新增</button><a href="/x">站点帮助</a>')
    const snap = read(refs, { find: '站点', budgetChars: 20 })
    expect(snap.text).toBe([
      'text "站点甲的说明"',
      '(cut here; 3 items remain — narrow the read with find, or read a part with scope)',
    ].join('\n'))
    expect(snap.cursor).toBeUndefined()
    expect(snap.truncated).toBe(true)
  })

  it('continues after the cursor, covering the listing exactly once', () => {
    const refs = page(CONSOLE)
    read(refs)
    const scope = refOf(refs, 'form')
    const whole = read(refs, { scope }).text.split('\n')
    const first = read(refs, { scope, budgetChars: 60 })
    const rest = read(refs, { scope, after: first.cursor ?? '' })
    expect([...first.text.split('\n').slice(0, first.shown), ...rest.text.split('\n')]).toEqual(whole)
    expect(rest.truncated).toBe(false)
    expect(rest.total).toBe(5)
  })

  it('starts from the top for a continuation that names something outside the listing', () => {
    const refs = page(CONSOLE)
    read(refs)
    const scope = refOf(refs, 'form')
    expect(read(refs, { scope, after: refOf(refs, 'table') }).text).toBe(read(refs, { scope }).text)
  })

  it('refuses a ref the page no longer has', () => {
    const refs = page(CONSOLE)
    read(refs)
    const scope = refOf(refs, 'form')
    document.querySelector('form')?.remove()
    expect(() => read(refs, { scope })).toThrow('scope: "e4" names no element on the page now')
    expect(() => read(refs, { after: 'e99' })).toThrow('after: "e99" names no element on the page now')
  })
})
