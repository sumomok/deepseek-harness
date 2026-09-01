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
      '  e12 dialog "导入设置"  hidden',
    ].join('\n'))
  })

  it('lists a table\'s rows when the read names that table, and numbers the controls in them', () => {
    const refs = page(CONSOLE)
    read(refs)
    const snap = read(refs, { scope: refOf(refs, 'table') })
    expect(snap.text).toBe([
      'e11 table 2 rows × 3 cols',
      '  header: 名称 | 唯一标识 | 操作',
      '  row 1: 东风站 | P-0001 | e14 button "编辑"  e15 button "删除"',
      '  row 2: 朝阳站 | P-0002 | e17 button "编辑"  e18 button "删除"',
    ].join('\n'))
  })

  it('numbers a table\'s rows when it prints them, and not when it only counts them', () => {
    const refs = page(CONSOLE)
    read(refs)
    const row = document.querySelector('tbody tr')
    if (row === null) throw new Error('fixture has no row')
    // A ref nobody has printed has never been minted, so the row takes the next
    // free number rather than one spent during the walk.
    expect(refs.ref(row)).toBe('e13')
  })

  it('finds a row by its text and answers with that row alone', () => {
    const refs = page(CONSOLE)
    read(refs)
    expect(read(refs, { find: '朝阳' }).text)
      .toBe('row 2: 朝阳站 | P-0002 | e14 button "编辑"  e15 button "删除" (table)')
  })

  it('finds controls, containers, and text anywhere on the page, flat, each saying where it lives', () => {
    const refs = page(CONSOLE)
    read(refs)
    const snap = read(refs, { find: '站点' })
    expect(snap.text).toBe([
      'e1 main "站点管理"',
      'text "首页 / 站点管理" (nav)',
      'e3 heading "站点列表" (in main "站点管理")',
      'text "共 20 个站点。" (in main "站点管理")',
    ].join('\n'))
    expect(snap.total).toBe(4)
  })

  it('finds a table by its own name and answers with the table', () => {
    const refs = page('<table aria-label="配额表"><thead><tr><th>项目</th></tr></thead><tbody><tr><td>并发</td></tr></tbody></table>')
    expect(read(refs, { find: '配额' }).text).toBe([
      'e1 table "配额表" 1 rows × 1 cols',
      '  header: 项目',
      '  sample: 并发',
      "  rows: pass scope with this table's ref to list rows, or find a row by its text",
    ].join('\n'))
  })

  it('says so when nothing matches, rather than answering with nothing', () => {
    const refs = page(CONSOLE)
    const snap = read(refs, { find: '不存在的东西' })
    expect(snap.text).toBe('No item matches "不存在的东西" — try a shorter word, or read without find.')
    expect(snap.shown).toBe(0)
    expect(snap.total).toBe(0)
    expect(snap.truncated).toBe(false)
  })

  it('refuses to filter a skeleton, which lists no items to filter', () => {
    const refs = page(CONSOLE)
    expect(() => read(refs, { mode: 'map', find: '站点' }))
      .toThrow('find cannot be combined with mode "map" — read the map first, then find within a scope')
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
    const refs = page('<nav class="top" aria-label="Breadcrumb"><a href="/">首页</a><span>›</span><span>详情</span></nav>')
    expect(read(refs).header.breadcrumb).toBe('首页 › 详情')
  })

  it('reports no trail for a marked strip that shows nothing, for a label on no trail, or for a page with none', () => {
    expect(read(page('<div class="breadcrumb"></div><p>正文</p>')).header.breadcrumb).toBeUndefined()
    expect(read(page('<div class="breadcrumb" data-hidden>首页</div>')).header.breadcrumb).toBeUndefined()
    expect(read(page('<div aria-label="breadcrumb of the report">正文</div>')).header.breadcrumb).toBeUndefined()
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

  it('names the first open dialog of the page, whichever way it is written', () => {
    const refs = page(`
      <div role="dialog" aria-label="先出现的抽屉"><button>关闭</button></div>
      <dialog open aria-label="后出现的对话框"><button>确定</button></dialog>`)
    expect(read(refs).header.modal).toBe('先出现的抽屉')
  })

  it('says nothing about a dialog the page has not opened', () => {
    expect(read(page('<div role="dialog" aria-label="导入设置" data-hidden></div>')).header.modal).toBeUndefined()
  })

  it('puts a dialog the page has not opened on the skeleton, named by the title inside it', () => {
    const refs = page('<div role="dialog" data-hidden><h3>导入设置</h3><button>确定</button></div><button>导入</button>')
    expect(read(refs, { mode: 'map' }).text).toBe('e1 dialog "导入设置"  hidden')
    expect(read(refs).text).toBe('e2 button "导入"')
  })

  it('finds the closed dialogs inside the wrapper the page hides them in', () => {
    const refs = page(`
      <div class="el-dialog__wrapper" data-hidden>
        <div role="dialog" aria-modal="true" aria-label="导入设置"><button>确定</button></div>
        <div role="alertdialog" aria-label="确认删除"><button>确定</button></div>
      </div>
      <button>导入</button>`)
    expect(read(refs, { mode: 'map' }).text).toBe([
      'e1 dialog "导入设置"  hidden',
      'e2 dialog "确认删除"  hidden',
    ].join('\n'))
    expect(read(refs).text).toBe('e3 button "导入"')
    expect(read(refs).header.modal).toBeUndefined()
  })

  it('puts a closed alert dialog on the skeleton like any other', () => {
    const refs = page('<div role="alertdialog" aria-label="确认删除" data-hidden><button>确定</button></div>')
    expect(read(refs, { mode: 'map' }).text).toBe('e1 dialog "确认删除"  hidden')
  })

  it('leaves a frame it cannot read out of what find answers with', () => {
    const refs = page('<button>导出</button>')
    const refusing = document.createElement('iframe')
    Object.defineProperty(refusing, 'contentDocument', { get: () => null })
    document.body.append(refusing)
    expect(read(refs, { find: '导出' }).text).toBe('e1 button "导出"')
  })

  it('leaves a closed dialog out of what find answers with', () => {
    const refs = page('<div role="dialog" aria-label="导入设置" data-hidden></div><button>导入</button>')
    expect(read(refs, { find: '导入设置' }).text)
      .toBe('No item matches "导入设置" — try a shorter word, or read without find.')
  })

  it('looks for no dialog inside what is not page content', () => {
    const refs = page('<template><div role="dialog" aria-label="模板弹窗"></div></template><button>导入</button>')
    expect(read(refs, { mode: 'map' }).text).toBe('')
    expect(read(refs).text).toBe('e1 button "导入"')
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

  it('is not a sign-in page when the only text box sits in another part of the page', () => {
    const refs = page(`
      <header><input type="search" aria-label="搜索"><input type="text" aria-label="快捷跳转"></header>
      <main><input type="password" aria-label="新密码"><button>保存</button></main>`)
    expect(read(refs).header.signIn).toBe(false)
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

  it('names a section by the heading the page shows first, whichever way it is written', () => {
    const refs = page('<section><div role="heading" aria-level="3">先出现的</div><h3>后出现的</h3></section>')
    expect(read(refs).text).toBe([
      'e1 section "先出现的"',
      '  e2 heading "先出现的" (in section "先出现的")',
      '  e3 heading "后出现的" (in section "先出现的")',
    ].join('\n'))
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

describe('widgets built out of several elements', () => {
  /** A pointer cursor is inherited, so everything under a marked element is clickable too. */
  const pointer = (el: Element): boolean => el.closest('[data-pointer]') !== null

  it('reads a strip of tabs and the panel it opens as containers, and each tab as an item', () => {
    const refs = page(`
      <div role="tablist">
        <div role="tab" id="tab-1" aria-selected="true">站点</div>
        <div role="tab" id="tab-2">告警</div>
      </div>
      <div role="tabpanel" aria-labelledby="tab-1">
        <form aria-label="筛选"><input aria-label="名称"></form>
        <button>导出</button>
      </div>`)
    expect(read(refs).text).toBe([
      'e1 tablist',
      '  e2 tab "站点" (tablist)',
      '  e3 tab "告警" (tablist)',
      'e4 tabpanel "站点"',
      '  e5 form "筛选"',
      '    e6 textbox "名称" = "" (in form "筛选")',
      '  e7 button "导出" (in tabpanel "站点")',
    ].join('\n'))
  })

  it('reads a menu bar as a menu of its items', () => {
    const refs = page('<ul role="menubar" aria-label="主菜单"><li role="menuitem">首页</li><li role="menuitem">告警</li></ul>')
    expect(read(refs).text).toBe([
      'e1 menu "主菜单"',
      '  e2 menuitem "首页" (in menu "主菜单")',
      '  e3 menuitem "告警" (in menu "主菜单")',
    ].join('\n'))
  })

  it('reads a menu, a tree, and a list box as the containers they are', () => {
    const refs = page(`
      <div role="menu" aria-label="更多"><div role="menuitemcheckbox" aria-checked="true">紧凑</div></div>
      <div role="tree" aria-label="目录"><div role="treeitem">根节点</div></div>
      <div role="listbox" aria-label="可选项"><div role="option">甲</div></div>`)
    expect(read(refs).text).toBe([
      'e1 menu "更多"',
      '  e2 menuitemcheckbox "紧凑" (in menu "更多")',
      'e3 tree "目录"',
      '  e4 treeitem "根节点" (in tree "目录")',
      'e5 listbox "可选项"',
      '  e6 option "甲" (in listbox "可选项")',
    ].join('\n'))
  })

  it('reads a select as the field it is, not as a region holding its options', () => {
    const refs = page('<select aria-label="站点" multiple><option selected>东风站</option><option>朝阳站</option></select>')
    expect(read(refs).text).toBe('e1 listbox "站点" = "东风站"')
  })

  it('reads a radio group as its radios, and never as the text printed beside them', () => {
    const refs = page(`
      <div role="radiogroup" aria-label="状态">
        <label><input type="radio" checked>启用</label>
        <label><input type="radio">停用</label>
      </div>`)
    const text = read(refs).text
    expect(text).toBe([
      'e1 radiogroup "状态"',
      '  e2 radio "启用" [x] (in radiogroup "状态")',
      '  e3 radio "停用" [ ] (in radiogroup "状态")',
    ].join('\n'))
    expect(text).not.toContain('text "启用"')
  })

  it('reads a checkbox the page wraps in a label and a pointer as the checkbox alone', () => {
    const refs = page(`
      <main>
        <label class="el-checkbox" data-pointer>
          <span><span class="box"></span><input type="checkbox" checked></span>
          <span>仅看我的</span>
        </label>
      </main>`)
    expect(read(refs, { isClickable: pointer }).text).toBe([
      'e1 main',
      '  e2 checkbox "仅看我的" [x] (main)',
    ].join('\n'))
    expect(read(refs, { isClickable: pointer, mode: 'map' }).text).toBe('e1 main  1 fields')
  })

  it('reads a label that names nothing as the text it shows', () => {
    expect(read(page('<label>没有控件的标签</label>')).text).toBe('text "没有控件的标签"')
  })

  it('reads a page number the page draws as a list item as a click target', () => {
    const refs = page('<ul class="el-pager"><li data-pointer>1</li><li data-pointer>2</li><li data-pointer>3</li></ul>')
    expect(read(refs, { isClickable: pointer }).text).toBe([
      'e1 list',
      '  e2 clickable "1" (list)',
      '  e3 clickable "2" (list)',
      '  e4 clickable "3" (list)',
    ].join('\n'))
  })

  it('reads through a click target holding items, and stops at one holding none', () => {
    const refs = page(`
      <div data-pointer class="card"><h3>东风站</h3><p>运行中</p></div>
      <div data-pointer class="card">新建站点</div>`)
    // The card holding a heading prints no row of its own: burying its heading
    // and its text under one click target would cost the reader more than the
    // card's own row is worth. Its paragraph reads as text, because the card is
    // what the page offers to click and the paragraph only inherits the cursor.
    expect(read(refs, { isClickable: pointer }).text).toBe([
      'e1 heading "东风站"',
      'text "运行中"',
      'e2 clickable "新建站点"',
    ].join('\n'))
  })

  it('reads a click target drawn out of several pieces as the one target it is', () => {
    const refs = page('<div data-pointer><span>更多</span><span>操作</span></div>')
    expect(read(refs, { isClickable: pointer }).text).toBe('e1 clickable "更多 操作"')
  })

  it('reads the picture inside a click target rather than clicking over it', () => {
    const refs = page('<div data-pointer><img alt="站点分布图"><span>查看</span></div>')
    expect(read(refs, { isClickable: pointer }).text).toBe([
      'e1 img "站点分布图"',
      'text "查看"',
    ].join('\n'))
  })

  it('takes a click target holding nothing a reader can see as one to click', () => {
    const refs = page('<div data-pointer>新建站点<span data-hidden><button>隐藏按钮</button></span></div>')
    expect(read(refs, { isClickable: pointer }).text).toBe('e1 clickable "新建站点"')
  })

  it('reads a search form as a form and an alert dialog as a dialog', () => {
    const refs = page(`
      <form role="search" aria-label="全局搜索"><input aria-label="关键词"></form>
      <div role="alertdialog" aria-label="确认删除"><button>确定</button></div>`)
    expect(read(refs).text).toBe([
      'e1 form "全局搜索"',
      '  e2 textbox "关键词" = "" (in form "全局搜索")',
      'e3 dialog "确认删除"',
      '  e4 button "确定" (in dialog "确认删除")',
    ].join('\n'))
  })

  it('reads a feed of three as a list and reads through a feed that is not one', () => {
    const refs = page(`
      <ul role="feed" aria-label="动态"><li><a href="/a">甲</a></li><li><a href="/b">乙</a></li><li><a href="/c">丙</a></li></ul>
      <div role="feed"><p>只有一条</p></div>`)
    expect(read(refs).text).toBe([
      'e1 list "动态"',
      '  e2 link "甲" (in list "动态")',
      '  e3 link "乙" (in list "动态")',
      '  e4 link "丙" (in list "动态")',
      'text "只有一条"',
    ].join('\n'))
  })

  it('reads through what a page announces rather than what it offers', () => {
    const refs = page(`
      <div role="alert"><span>保存失败</span></div>
      <div role="status">已保存</div>
      <div role="tooltip">提示文字</div>`)
    expect(read(refs).text).toBe(['text "保存失败"', 'text "已保存"', 'text "提示文字"'].join('\n'))
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
      'e2 table "空表" 0 rows × 0 cols',
    ].join('\n'))
  })

  it('takes an undeclared first row as the header only when every cell of it heads a column', () => {
    const heads = page(`
      <div role="table"><div role="row"><div role="columnheader">名称</div></div><div role="row"><div role="cell">东风站</div></div></div>`)
    expect(read(heads).text.split('\n')[1]).toBe('  header: 名称')
    // A row of data cells is data, however the page styles it: reading it as a
    // header would lose a row and mislabel the columns.
    const data = page('<table><tr><td>东风站</td><td>P-0001</td></tr><tr><td>朝阳站</td><td>P-0002</td></tr></table>')
    expect(read(data).text).toBe([
      'e1 table 2 rows × 2 cols',
      '  sample: 东风站 | P-0001',
      "  rows: pass scope with this table's ref to list rows, or find a row by its text",
    ].join('\n'))
  })

  it('reads a table the parser gave a body it never wrote, and leaves the hidden and the footed out', () => {
    const refs = page(`
      <table>
        <tr><th>名称</th><th data-hidden>内部</th></tr>
        <tr><td>东风</td><td data-hidden>秘密列</td></tr>
        <tfoot><tr><td>合计</td></tr></tfoot>
      </table>`)
    expect(read(refs).text).toBe([
      'e1 table 1 rows × 1 cols',
      '  header: 名称',
      '  sample: 东风',
      "  rows: pass scope with this table's ref to list rows, or find a row by its text",
    ].join('\n'))
    expect(read(refs).text).not.toContain('秘密列')
  })

  it('leaves out a row the page hides', () => {
    const refs = page(`
      <table>
        <thead><tr><th>名称</th></tr></thead>
        <tbody><tr><td>东风站</td></tr><tr data-hidden><td>折叠行</td></tr></tbody>
      </table>`)
    expect(read(refs).text.split('\n')[0]).toBe('e1 table 1 rows × 1 cols')
  })

  it('heads a table by the first row of a header of several, and counts that row\'s cells as its columns', () => {
    const refs = page(`
      <table>
        <thead>
          <tr><th colspan="2">基本信息</th></tr>
          <tr><th>名称</th><th>唯一标识</th></tr>
        </thead>
        <tbody><tr><td>东风站</td><td>P-0001</td></tr></tbody>
      </table>`)
    // The column names of a table that groups its header over two rows sit in
    // the second row, which no read prints: the reader sees the grouping row.
    expect(read(refs).text).toBe([
      'e1 table 1 rows × 1 cols',
      '  header: 基本信息',
      '  sample: 东风站 | P-0001',
      "  rows: pass scope with this table's ref to list rows, or find a row by its text",
    ].join('\n'))
  })

  it('reads a grid and a tree grid as the tables they are', () => {
    const refs = page(`
      <div role="grid" aria-label="配额"><div role="row"><div role="cell">并发</div></div></div>
      <div role="treegrid" aria-label="目录"><div role="row"><div role="cell">根</div></div></div>`)
    expect(read(refs).text.split('\n').filter(line => line.includes('cols'))).toEqual([
      'e1 table "配额" 1 rows × 1 cols',
      'e2 table "目录" 1 rows × 1 cols',
    ])
  })

  it('reads past the strips that show nothing, say nothing, or are not strips at all', () => {
    const refs = page(`
      <section aria-label="站点">
        <table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>东风站</td></tr></tbody></table>
        <div class="pagination"></div>
        <div class="pagination" data-hidden>看不见的分页</div>
        <div aria-label="pagination summary">这是说明不是分页</div>
        <nav aria-label="Pagination navigation">共 2 页</nav>
      </section>`)
    expect(read(refs).text).toContain('    pagination: 共 2 页')
  })

  it('reports no pagination for a page whose only strip shows nothing', () => {
    const refs = page(`
      <section aria-label="站点">
        <table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>东风站</td></tr></tbody></table>
        <div class="pagination"></div>
      </section>`)
    expect(read(refs).text).not.toContain('pagination:')
  })

  it('gives each table on a page the strip that pages it, not the one beside its neighbour', () => {
    const refs = page(`
      <section aria-label="站点">
        <table aria-label="甲表"><thead><tr><th>名称</th></tr></thead><tbody><tr><td>东风站</td></tr></tbody></table>
        <div class="el-pagination">甲表 共 2 页</div>
        <table aria-label="乙表"><thead><tr><th>名称</th></tr></thead><tbody><tr><td>朝阳站</td></tr></tbody></table>
        <div class="el-pagination">乙表 共 9 页</div>
      </section>`)
    const text = read(refs).text
    expect(text).toContain('    pagination: 甲表 共 2 页')
    expect(text).toContain('    pagination: 乙表 共 9 页')
  })

  it('gives a strip between two tables to the table it is drawn under, and no strip to the one below', () => {
    const refs = page(`
      <section aria-label="站点">
        <table aria-label="甲表"><thead><tr><th>名称</th></tr></thead><tbody><tr><td>东风站</td></tr></tbody></table>
        <div class="el-pagination">共 2 页</div>
        <table aria-label="乙表"><thead><tr><th>名称</th></tr></thead><tbody><tr><td>朝阳站</td></tr></tbody></table>
      </section>`)
    expect(read(refs).text).toBe([
      'e1 section "站点"',
      '  e2 table "甲表" 1 rows × 1 cols',
      '    header: 名称',
      '    sample: 东风站',
      "    rows: pass scope with this table's ref to list rows, or find a row by its text",
      '    pagination: 共 2 页',
      '  text "共 2 页" (in section "站点")',
      '  e3 table "乙表" 1 rows × 1 cols',
      '    header: 名称',
      '    sample: 朝阳站',
      "    rows: pass scope with this table's ref to list rows, or find a row by its text",
    ].join('\n'))
  })

  it('takes the strip above a table when there is none below it', () => {
    const refs = page(`
      <section aria-label="站点">
        <div class="el-pagination">共 2 页</div>
        <table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>东风站</td></tr></tbody></table>
      </section>`)
    expect(read(refs).text).toContain('    pagination: 共 2 页')
  })

  it('leaves a strip drawn inside a table out of the table beside it', () => {
    const refs = page(`
      <section aria-label="站点">
        <table aria-label="甲表">
          <thead><tr><th>名称</th></tr></thead>
          <tfoot><tr><td><div class="el-pagination">表内分页</div></td></tr></tfoot>
          <tbody><tr><td>东风站</td></tr></tbody>
        </table>
        <table aria-label="乙表"><thead><tr><th>名称</th></tr></thead><tbody><tr><td>朝阳站</td></tr></tbody></table>
      </section>`)
    expect(read(refs).text).not.toContain('pagination:')
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

describe('a table drawn in two pieces', () => {
  const SPLIT = `
    <div class="wrap">
      <div class="head"><table data-rect="0,0,800,40">
        <thead><tr><th>名称</th><th>操作</th></tr></thead>
      </table></div>
      <div class="body"><table data-rect="0,40,800,200"><tbody>
        <tr><td>东风站</td><td><button>编辑</button></td></tr>
        <tr><td>朝阳站</td><td><button>编辑</button></td></tr>
      </tbody></table></div>
    </div>`

  it('reads a frozen header and the body under it as one table', () => {
    expect(read(page(SPLIT)).text).toBe([
      'e1 table 2 rows × 2 cols',
      '  header: 名称 | 操作',
      '  sample: 东风站 | [编辑]',
      "  rows: pass scope with this table's ref to list rows, or find a row by its text",
    ].join('\n'))
  })

  it('keeps the header when the read names the body by ref', () => {
    const refs = page(SPLIT)
    read(refs)
    expect(read(refs, { scope: refOf(refs, '.body table') }).text).toBe([
      'e1 table 2 rows × 2 cols',
      '  header: 名称 | 操作',
      '  row 1: 东风站 | e3 button "编辑"',
      '  row 2: 朝阳站 | e5 button "编辑"',
    ].join('\n'))
  })

  it('reads one table, not two, when a pinned column draws both pieces again', () => {
    const refs = page(`${SPLIT}
      <div class="fixed">
        <div class="head"><table data-rect="0,0,800,40">
          <thead><tr><th>名称</th><th>操作</th></tr></thead>
        </table></div>
        <div class="body"><table data-rect="0,40,800,200"><tbody>
          <tr><td>东风站</td><td><button>编辑</button></td></tr>
          <tr><td>朝阳站</td><td><button>编辑</button></td></tr>
        </tbody></table></div>
      </div>`)
    expect(read(refs).text.split('\n').filter(line => line.includes('cols'))).toEqual(['e1 table 2 rows × 2 cols'])
  })

  it('keeps a header-only table that has no body beside it', () => {
    const refs = page('<table aria-label="配额"><thead><tr><th>项目</th><th>上限</th></tr></thead></table>')
    expect(read(refs).text).toBe(['e1 table "配额" 0 rows × 2 cols', '  header: 项目 | 上限'].join('\n'))
  })

  it('keeps a header-only table whose neighbour heads its own columns', () => {
    const refs = page(`
      <table aria-label="甲"><thead><tr><th>名称</th></tr></thead></table>
      <table aria-label="乙"><thead><tr><th>标识</th></tr></thead><tbody><tr><td>P-0001</td></tr></tbody></table>`)
    expect(read(refs).text).toBe([
      'e1 table "甲" 0 rows × 1 cols',
      '  header: 名称',
      'e2 table "乙" 1 rows × 1 cols',
      '  header: 标识',
      '  sample: P-0001',
      "  rows: pass scope with this table's ref to list rows, or find a row by its text",
    ].join('\n'))
  })

  it('lends no header to a table whose neighbour has rows of its own', () => {
    const refs = page(`
      <table aria-label="甲"><thead><tr><th>名称</th></tr></thead><tbody><tr><td>东风站</td></tr></tbody></table>
      <table aria-label="乙"><tr><td>朝阳站</td></tr></table>`)
    expect(read(refs).text.split('\n').filter(line => line.includes('header:'))).toEqual(['  header: 名称'])
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

  it('reads a frame whose document has no body, and says nothing is there to read when it has nothing', () => {
    const refs = page('<button>本页按钮</button>')
    const loading = document.createElement('iframe')
    loading.title = '业务'
    Object.defineProperty(loading, 'contentDocument', { get: () => document.implementation.createDocument(null, 'root') })
    const bare = document.createElement('iframe')
    Object.defineProperty(bare, 'contentDocument', { get: () => document.implementation.createDocument(null, '') })
    document.body.append(loading, bare)
    expect(read(refs).text).toBe([
      'e1 button "本页按钮"',
      'e2 frame "业务"',
      'frame (not readable)',
    ].join('\n'))
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
    const snap = read(refs, { budgetChars: 400 })
    expect(snap.kind).toBe('map')
    expect(snap.truncated).toBe(true)
    expect(snap.cursor).toBeUndefined()
    expect(snap.text).toBe([
      'e1 main "站点管理"  3 texts',
      '  e2 nav  1 texts',
      '  e4 form "查询"  3 fields',
      '    e8 toolbar  2 buttons',
      '  e11 table  2 rows',
      '  e12 dialog "导入设置"  hidden',
      'Read a part with scope, e.g. content_read({ scope: "e1" }).',
    ].join('\n'))
    expect(snap.shown).toBe(6)
    expect(snap.total).toBe(6)
  })

  it('cuts the skeleton itself when even that is more than the budget, and says to continue as a skeleton', () => {
    const refs = page(CONSOLE)
    const snap = read(refs, { budgetChars: 60 })
    expect(snap.kind).toBe('map')
    expect(snap.truncated).toBe(true)
    expect(snap.cursor).toBe('e1')
    // A continuation carrying after alone reads the items of the page, not the
    // skeleton, so the line that ends a skeleton asks for one again.
    expect(snap.text).toBe([
      'e1 main "站点管理"  3 texts',
      '(cut after e1 — pass after: "e1" and mode: "map" to continue; 5 items remain)',
    ].join('\n'))
    expect(snap.shown).toBe(1)
    expect(snap.total).toBe(6)
  })

  it('continues a skeleton from the ref it was cut at', () => {
    const refs = page(CONSOLE)
    read(refs)
    expect(read(refs, { mode: 'map', after: 'e1' }).text).toBe([
      '  e2 nav  1 texts',
      '  e4 form "查询"  3 fields',
      '    e8 toolbar  2 buttons',
      '  e11 table  2 rows',
      '  e12 dialog "导入设置"  hidden',
    ].join('\n'))
  })

  it('renders every row when the budget is exactly what they cost, and cuts at one less', () => {
    const refs = page('<p>说明一</p><p>说明二</p>')
    const exact = read(refs, { budgetChars: 22 })
    expect(exact.text).toBe(['text "说明一"', 'text "说明二"'].join('\n'))
    expect(exact.truncated).toBe(false)
    expect(read(refs, { budgetChars: 21 }).truncated).toBe(true)
  })

  it('answers a budget too small for anything with the first row and the way on', () => {
    const refs = page(CONSOLE)
    read(refs)
    const snap = read(refs, { scope: refOf(refs, 'form'), budgetChars: 1 })
    expect(snap.text).toBe([
      'e4 form "查询"',
      '(cut after e4 — pass after: "e4" to continue; 6 items remain)',
    ].join('\n'))
    expect(snap.shown).toBe(1)
  })

  it('counts the closing line against the budget', () => {
    const refs = page(CONSOLE)
    read(refs)
    const snap = read(refs, { scope: refOf(refs, 'form'), budgetChars: 200 })
    expect(snap.truncated).toBe(true)
    expect(snap.text.length).toBeLessThanOrEqual(200)
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

  it('points a reader at the room holding the most, not at the wrapper around it', () => {
    const buttons = Array.from({ length: 30 }, (_, index) => `<button>操作${index}</button>`).join('')
    const refs = page(`
      <main>
        <section aria-label="大区">${buttons}</section>
        <section aria-label="小区"><button>唯一</button></section>
      </main>`)
    const snap = read(refs, { budgetChars: 200 })
    expect(snap.kind).toBe('map')
    expect(snap.text).toBe([
      'e1 main',
      '  e2 section "大区"  30 buttons',
      '  e33 section "小区"  1 buttons',
      'Read a part with scope, e.g. content_read({ scope: "e2" }).',
    ].join('\n'))
  })

  it('answers with what it could not read when there is no room to point at', () => {
    const refs = page(`<p>${'长'.repeat(200)}</p>`)
    const refusing = document.createElement('iframe')
    Object.defineProperty(refusing, 'contentDocument', { get: () => null })
    document.body.append(refusing)
    const snap = read(refs, { budgetChars: 30 })
    expect(snap.kind).toBe('map')
    expect(snap.text).toBe('frame (not readable)')
    expect(snap.truncated).toBe(true)
  })

  it('cuts a listing the read asked for by ref, and says where to continue', () => {
    const refs = page(CONSOLE)
    read(refs)
    const snap = read(refs, { scope: refOf(refs, 'form'), budgetChars: 140 })
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
    const first = read(refs, { scope, budgetChars: 140 })
    const rest = read(refs, { scope, after: first.cursor ?? '' })
    expect([...first.text.split('\n').slice(0, first.shown), ...rest.text.split('\n')]).toEqual(whole)
    expect(rest.truncated).toBe(false)
    expect(rest.total).toBe(5)
  })

  it('backs a cut off the trailing rows the model cannot name, so a continuation repeats none of them', () => {
    const refs = page(`<button>甲项</button><p>说明一</p><p>说明二</p><p>${'长'.repeat(190)}</p>`)
    const whole = read(refs).text.split('\n')
    const first = read(refs, { budgetChars: 130 })
    expect(first.cursor).toBe('e1')
    expect(first.text).toBe([
      'e1 button "甲项"',
      '(cut after e1 — pass after: "e1" to continue; 3 items remain)',
    ].join('\n'))
    expect(first.shown).toBe(1)
    const rest = read(refs, { after: 'e1' })
    expect([...first.text.split('\n').slice(0, first.shown), ...rest.text.split('\n')]).toEqual(whole)
  })

  it('answers a continuation that is itself too long with rows, not with a skeleton', () => {
    const refs = page(CONSOLE)
    read(refs)
    const snap = read(refs, { after: 'e3', budgetChars: 60 })
    expect(snap.kind).toBe('outline')
    expect(snap.truncated).toBe(true)
    expect(snap.text.split('\n')[0]).toBe('  text "共 20 个站点。" (in main "站点管理")')
  })

  it('says the listing ended there when a continuation names its last row', () => {
    const refs = page('<button>甲</button><button>乙</button>')
    read(refs)
    const snap = read(refs, { after: 'e2' })
    expect(snap.text).toBe('(nothing after e2 — the listing ended there)')
    expect(snap.shown).toBe(0)
    expect(snap.total).toBe(0)
    expect(snap.truncated).toBe(false)
    expect(snap.cursor).toBeUndefined()
  })

  it('says the same of a skeleton continued past its last container', () => {
    const refs = page(CONSOLE)
    read(refs)
    expect(read(refs, { mode: 'map', after: 'e12' }).text).toBe('(nothing after e12 — the listing ended there)')
  })

  it('refuses a continuation that names something this read did not list', () => {
    const refs = page(CONSOLE)
    read(refs)
    const scope = refOf(refs, 'form')
    expect(() => read(refs, { scope, after: refOf(refs, 'table') }))
      .toThrow('after: "e11" is not an item of this read — pass the cursor from the same scope and find, or omit after')
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
