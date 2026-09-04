// @vitest-environment jsdom
/**
 * The page as it was written. Every string the model sees is pinned here word
 * for word: the tree line, the attribute line, the lines of text, and each of
 * the things a markup read says when it cannot show everything — the cut text,
 * the cursor, and the refusal of a ref the page no longer has.
 *
 * Visibility arrives injected, as it does in the browser: these fixtures
 * declare it with `data-hidden` because jsdom shows everything.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { markup } from '../src/client/access/markup.ts'
import { RefTable } from '../src/client/access/refs.ts'
import type { Snapshot } from '../src/client/access/model.ts'
import type { ContentMarkupRequest } from '../src/types.ts'

/** Hidden by marker, and hidden inside anything marked hidden. */
function isVisible(el: Element): boolean {
  return el.closest('[data-hidden]') === null
}

/** Put one page up, with a fresh numbering. */
function page(html: string): RefTable {
  document.body.innerHTML = html
  return new RefTable()
}

/** The ref of one element, minted here the way a previous read would have. */
function refOf(refs: RefTable, selector: string): string {
  const el = document.querySelector(selector)
  if (el === null) throw new Error(`fixture has no ${selector}`)
  return refs.ref(el)
}

/** Read the page up. */
function read(refs: RefTable, request: ContentMarkupRequest, budgetChars = 4000): Snapshot {
  return markup(document, request, { refs, budgetChars, isVisible })
}

/** One tree read of the element a selector names. */
function tree(refs: RefTable, selector: string, budgetChars = 4000, after?: string): Snapshot {
  const scope = refOf(refs, selector)
  return read(refs, {
    callId: 'call_1',
    tool: 'content_read_dom',
    args: { scope, ...after === undefined ? {} : { after } },
  }, budgetChars)
}

/** One attribute read of the element a selector names. */
function attrs(refs: RefTable, selector: string): Snapshot {
  return read(refs, { callId: 'call_1', tool: 'content_read_attrs', args: { ref: refOf(refs, selector) } })
}

/** One whole-text read of the element a selector names. */
function textOf(refs: RefTable, selector: string): Snapshot {
  return read(refs, { callId: 'call_1', tool: 'content_read_dom_content', args: { ref: refOf(refs, selector) } })
}

/** What each row of {@link LIST} draws: short enough to print whole, long enough that three rows outrun a budget. */
const ROW_TEXT = 'a'.repeat(40)

/** Three rows under one list, which is the shape a cut tree is measured on. */
const LIST = `<ul id="list"><li>${ROW_TEXT}</li><li>${ROW_TEXT}</li><li>${ROW_TEXT}</li></ul>`

/**
 * A budget holding the list's row and one item, with the closing line's own
 * reserve on top of them and the third item outside it.
 */
const LIST_BUDGET = 146

afterEach(() => {
  document.body.innerHTML = ''
  document.title = ''
})

describe('printing one subtree as it was written', () => {
  it('prints a line per element with its tag, id, class tokens and own text', () => {
    const refs = page(`
      <section id="ops" class="panel wide">
        <h2>操作</h2>
        <div><i class="el-tooltip operation-modify el-icon-edit"></i></div>
        <script>var hidden = 1</script>
      </section>`)
    const read = tree(refs, '#ops')
    expect(read.kind).toBe('dom')
    expect(read.text).toBe([
      'e1 section#ops {class: panel wide}',
      '  e2 h2 "操作"',
      '  e3 div',
      '    e4 i {class: el-tooltip operation-modify el-icon-edit}',
    ].join('\n'))
    expect(read.truncated).toBe(false)
    expect(read.shown).toBe(4)
    expect(read.total).toBe(4)
    expect(read.cursor).toBeUndefined()
  })

  it('prints an element the listing would have dropped for being invisible', () => {
    const refs = page('<div id="host"><span class="ghost" data-hidden>gone</span></div>')
    expect(tree(refs, '#host').text).toBe('e1 div#host\n  e2 span {class: ghost} "gone"')
  })

  it('names the call that prints the rest of a text it cut', () => {
    const long = 'x'.repeat(120)
    const refs = page(`<p id="note">${long}</p>`)
    expect(tree(refs, '#note').text).toBe(
      `e1 p#note "${'x'.repeat(79)}…" (text cut)`,
    )
  })

  it('leaves a page\'s own text nodes to the element that holds them', () => {
    const refs = page('<div id="row">outer<span>inner</span></div>')
    expect(tree(refs, '#row').text).toBe('e1 div#row "outer"\n  e2 span "inner"')
  })

  it('cuts at the budget and says which scope to continue with', () => {
    const refs = page(LIST)
    const cut = tree(refs, '#list', LIST_BUDGET)
    expect(cut.truncated).toBe(true)
    expect(cut.shown).toBe(2)
    expect(cut.total).toBe(4)
    expect(cut.cursor).toBe('e2')
    expect(cut.text).toBe([
      'e1 ul#list',
      `  e2 li "${ROW_TEXT}"`,
      '(cut after e2 — pass after: "e2", with the same scope, to continue; 2 items remain)',
    ].join('\n'))
  })

  it('continues after the cursor it returned', () => {
    const refs = page(LIST)
    tree(refs, '#list', LIST_BUDGET)
    expect(tree(refs, '#list', 4000, 'e2').text).toBe(`  e3 li "${ROW_TEXT}"\n  e4 li "${ROW_TEXT}"`)
  })

  it('refuses a cursor that is not a row of this tree, naming the parameter it takes', () => {
    const refs = page('<ul id="list"><li>a</li></ul><div id="other">x</div>')
    const stray = refOf(refs, '#other')
    expect(() => tree(refs, '#list', 4000, stray)).toThrow(
      `after: "${stray}" is not an item of this read — pass the cursor from the same scope, or omit after`,
    )
  })

  it('refuses a scope the page no longer has', () => {
    const refs = page('<div id="gone">x</div>')
    const scope = refOf(refs, '#gone')
    document.body.innerHTML = ''
    expect(() => read(refs, { callId: 'call_1', tool: 'content_read_dom', args: { scope } }))
      .toThrow(`scope: "${scope}" names no element on the page now`)
  })
})

describe('printing one element\'s attributes', () => {
  it('prints every attribute the page wrote, in the order it wrote them', () => {
    const refs = page('<i id="edit" class="a b" data-v-1 title="编 辑"></i>')
    const read = attrs(refs, '#edit')
    expect(read.kind).toBe('attrs')
    expect(read.text).toBe([
      'e1 i',
      '  id="edit"',
      '  class="a b"',
      '  data-v-1=""',
      '  title="编 辑"',
    ].join('\n'))
    expect(read.shown).toBe(4)
    expect(read.total).toBe(4)
    expect(read.truncated).toBe(false)
  })

  it('quotes a value holding a quote or a line break so one attribute is one line', () => {
    const refs = page('<b id="odd"></b>')
    document.querySelector('#odd')?.setAttribute('data-note', 'a"b\nc')
    expect(attrs(refs, '#odd').text).toBe('e1 b\n  id="odd"\n  data-note="a\\"b\\nc"')
  })

  it('says so for an element the page wrote no attribute on', () => {
    const refs = page('<div id="host"><b></b></div>')
    expect(attrs(refs, '#host b').text).toBe('e1 b\n  (this element carries no attributes)')
  })

  it('withholds a password box\'s value and prints every other attribute', () => {
    const refs = page('<input id="pw" type="password" value="hunter2" name="secret">')
    expect(attrs(refs, '#pw').text).toBe([
      'e1 input',
      '  id="pw"',
      '  type="password"',
      '  value=(password withheld)',
      '  name="secret"',
    ].join('\n'))
  })

  it('withholds the value of a box whose autocomplete says it holds a password', () => {
    const refs = page('<input id="pw" type="text" autocomplete="current-password" value="hunter2">')
    expect(attrs(refs, '#pw').text).toContain('  value=(password withheld)')
  })
})

describe('what a password control holds', () => {
  it('withholds the text a password textarea keeps its value in, and prints the element', () => {
    const refs = page('<form id="box"><textarea autocomplete="new-password">hunter2</textarea></form>')
    expect(tree(refs, '#box').text).toBe('e1 form#box\n  e2 textarea (password withheld)')
  })

  it('withholds it from a whole-text read of the control itself', () => {
    const refs = page('<div id="host"><textarea autocomplete="current-password">hunter2</textarea></div>')
    expect(textOf(refs, '#host textarea').text).toBe('(password withheld)')
  })

  it('withholds it from a whole-text read of everything around it', () => {
    const refs = page(
      '<form id="signin"><textarea autocomplete="current-password">hunter2</textarea><span>Sign in</span></form>',
    )
    expect(textOf(refs, '#signin').text).toBe('Sign in')
  })

  it('prints the text of a box the page declared nothing about', () => {
    const refs = page('<div id="host"><textarea>a note</textarea></div>')
    expect(textOf(refs, '#host textarea').text).toBe('a note')
  })
})

describe('printing one element\'s whole text', () => {
  it('breaks the line where the page breaks it and leaves out what the page hides', () => {
    const refs = page(
      '<div id="card"><p>one</p><span>two</span> <span>three</span><br>four<em data-hidden>secret</em></div>',
    )
    const read = textOf(refs, '#card')
    expect(read.kind).toBe('content')
    expect(read.text).toBe('one\ntwo three\nfour')
    expect(read.shown).toBe(3)
    expect(read.total).toBe(3)
    expect(read.truncated).toBe(false)
  })

  it('prints a long text whole, where a tree line would have cut it', () => {
    const long = 'y'.repeat(500)
    const refs = page(`<p id="note">${long}</p>`)
    expect(textOf(refs, '#note').text).toBe(long)
  })

  it('reads nothing out of a drawing, whose words label the picture', () => {
    const refs = page('<div id="chart">total<svg><title>Fleet</title></svg></div>')
    expect(textOf(refs, '#chart').text).toBe('total')
  })

  it('reads past a node that is neither text nor an element', () => {
    const refs = page('<div id="card">left<!-- a note the page keeps to itself -->right</div>')
    expect(textOf(refs, '#card').text).toBe('leftright')
  })

  it('says so for an element that shows no text at all', () => {
    const refs = page('<div id="empty"><span data-hidden>x</span></div>')
    expect(textOf(refs, '#empty').text).toBe('(this element shows no text)')
  })

  it('never prints what a password box holds', () => {
    const refs = page('<form id="signin"><input type="password" value="hunter2"><span>Sign in</span></form>')
    expect(textOf(refs, '#signin').text).toBe('Sign in')
  })

  it('reads nothing out of an element the page hides, whatever it holds', () => {
    const refs = page('<div id="card" data-hidden><p>one</p><span>two</span></div>')
    expect(textOf(refs, '#card').text).toBe('(this element shows no text)')
  })

  it('reads nothing out of an element marked aria-hidden, though its descendants are drawn', () => {
    const refs = page('<div id="card" aria-hidden="true"><p>one</p><span>two</span></div>')
    expect(textOf(refs, '#card').text).toBe('(this element shows no text)')
  })
})

describe('what every markup read says about the page it ran on', () => {
  it('carries the page\'s address and its title', () => {
    document.title = 'Fleet console'
    const refs = page('<div id="host">x</div>')
    const read = tree(refs, '#host')
    expect(read.header.title).toBe('Fleet console')
    expect(read.header.url).toBe(document.URL)
    expect(read.header.modal).toBeUndefined()
  })
})
