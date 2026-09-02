/**
 * One walk of the page, in document order, turning elements into the items a
 * listing renders. The walk enters open shadow roots and same-origin frames, so
 * a page built as a frame inside a frame reads as one document.
 *
 * Two rules keep the result a structure rather than a data dump: a table is
 * collected as its shape (header, one sample row, a row count) and never as its
 * rows, and an element that carries a name of its own — a control, a heading, a
 * click target with nothing inside it — ends the descent, because its
 * accessible name already says what is inside it. An element that both offers
 * something and holds something — a card the page makes clickable, a tree node
 * over the nodes under it — prints its row and is read into all the same.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/collect
 */
import {
  CHECKED_ROLES, CLICKABLE_ROLE, DIALOG_SELECTOR, FIELD_ROLES, ICON_ROLE, NAME_FROM_CONTENT_ROLES,
  QUANTITY_ROLES, childHost, clip, clipTo, collapse, containerName, drawsNothing, fieldValue,
  frameDocument, headingText, insideOpaque, isChecked, isDisabled, isHiddenAround, isInline, isMarked,
  drawingInside, drawnAround, iconWord, isNameable, isNonContent, isOpaque, isPassword, isReadonly, isSkipped,
  libraryRole, looksClickable, markedSelector, nameOf, quantityValue, queryInOrder, rectsMeet,
  rectsOverlap, roleOf, visibleText,
} from './dom.ts'
import type {
  CellControl, ContainerFace, ContainerItem, ContainerType, ControlFace, ControlState, ElementItem,
  Item, RowCell, SnapshotOptions, TableItem, TableRowItem,
} from './model.ts'

/** How many items a `ul` or `ol` needs before it reads as a list of its own. */
const LIST_MIN = 3

/** How many buttons an element needs to read as a toolbar without saying so. */
const TOOLBAR_MIN = 2

/** How much of its own text names a click target the page has not labelled. */
const CLICK_NAME_LIMIT = 40

/**
 * How much of a cell the one sample row of a table block shows: enough to say
 * what the column holds. The cut is made on the cell's own text, before the
 * controls beside it are added, so a column whose text runs long still says
 * which controls it offers.
 */
const SAMPLE_CELL_LIMIT = 24

/** The one key {@link pickCells} claims the rectangles of one row under. */
const ROW_CELLS = 'cell'

/**
 * Roles that make a table cell worth naming rather than reading as text. A bar
 * is one of them under the condition it prints a row anywhere else: named, it
 * reports something the cell's text does not, and unnamed it says what it holds
 * in the text of the cell around it.
 */
const CELL_CONTROL_ROLES: ReadonlySet<string> = new Set(['button', 'link', ...FIELD_ROLES, ...QUANTITY_ROLES])

/** The roles a table gives the boxes its rows are made of, which name what they hold. */
const CELL_ROLES: ReadonlySet<string> = new Set(['cell', 'gridcell', 'columnheader', 'rowheader'])

/**
 * The roles of the controls a page draws beside a node to act on it: the delete
 * button of a tree row, the tick box that picks it, the command a context menu
 * offers over it. Their text says what they do rather than what the node is, so
 * a node is never named by one — carrying it into the name repeats it on the
 * node and in the suffix of every row under it. What the node holds is read all
 * the same: a node these leave unnamed is a room, and each of them prints a row
 * inside it.
 *
 * A link and a node role are not among them: a node drawn as a link is the page
 * saying what the node is and where it goes, and a node drawn inside another is
 * the tree's own nesting rather than something acting on the node above it.
 */
const ACTS_ON_NODE_ROLES: ReadonlySet<string> = new Set([
  'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', ...FIELD_ROLES,
])

/**
 * The marks a page draws beside the label of a field that must be filled. Both
 * spellings of the star are here because a page written in Chinese draws either
 * one, and neither says anything else where a form draws it.
 */
const REQUIRED_MARKS: readonly string[] = ['*', '＊']

/** How long the words drawn in front of a field may run before they are no label. */
const LABEL_LIMIT = 40

/** The word pages use to mark the strip that pages through a table. */
const PAGINATION_MARKER = 'pagination'

/** Every element that reads as a table. */
const TABLE_SELECTOR = 'table, [role~="table"], [role~="grid"], [role~="treegrid"]'

/**
 * Every element that opens a region of the page, which is how far a table looks
 * for the other half of itself: two tables in two regions are two tables,
 * however they are drawn.
 */
const CONTAINER_SELECTOR = [
  'main', 'nav', 'form', 'section', 'article', 'aside', 'dialog', 'ul', 'ol', 'iframe',
  '[role~="main"]', '[role~="navigation"]', '[role~="form"]', '[role~="search"]', '[role~="dialog"]',
  '[role~="alertdialog"]', '[role~="region"]', '[role~="article"]', '[role~="complementary"]',
  '[role~="tabpanel"]', '[role~="tablist"]', '[role~="menu"]', '[role~="menubar"]', '[role~="tree"]',
  '[role~="radiogroup"]', '[role~="listbox"]', '[role~="toolbar"]', '[role~="list"]', '[role~="feed"]',
].join(', ')

/** The group a tree node or a menu item holds the nodes under it in. */
const GROUP_SELECTOR = '[role~="group"], [role~="menu"], [role~="tree"], [role~="menubar"]'

/** The region each item role opens when it holds a group of nodes under it. */
const ITEM_NODE_TYPES: ReadonlyMap<string, ContainerType> = new Map([
  ['treeitem', 'treeitem'],
  ['menuitem', 'menuitem'],
  ['menuitemcheckbox', 'menuitem'],
  ['menuitemradio', 'menuitem'],
] as const)

/**
 * Every tag that earns a row of its own wherever it appears. A field the page
 * carries but never shows, and an element it marks as not editable, are neither
 * offered nor read: they are how the page stores what it knows.
 */
const ITEM_TAGS = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary', 'iframe',
  'table', 'dialog', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img[alt]:not([alt=""])',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ')

/**
 * Everything that could earn a row of its own, which {@link makesRow} confirms
 * one by one. A click target holding one of these is a wrapper around content
 * as well as a thing to click, so the walk prints it and reads on through it.
 * The regions come by tag as well as by role: HTML gives `nav` and `main` their
 * roles, and the page writes no attribute for the walk to match.
 */
const ITEM_SELECTOR = `${ITEM_TAGS}, [role], main, nav, form, section, article, aside, ul, ol`

/**
 * The tags a page draws something with rather than writes something in. None of
 * them earns a row, and all of them are the page putting a picture between the
 * two things either side of it.
 */
const DRAWN_TAGS = 'hr, img, svg, canvas, video, audio, picture, embed, object'

/**
 * The regions a page is laid out in, rather than the ones it draws inside a
 * card. A run the page makes clickable that reaches one of these is not a thing
 * to click: the cursor was inherited from something above, and the region
 * inside it is the page itself. A form and a dialog are left out because a card
 * holds either one readily — an inline editor, a confirmation over the card —
 * and the card is still the thing the page offers to click.
 *
 * Two of the four are matched by tag as well as by role and two only by role,
 * because that is where HTML puts them: `main` and `nav` are the region they
 * name wherever they are drawn, while `header` and `footer` are a banner and a
 * page footer only at the top level and are the head and foot of a card, an
 * article, or a table cell everywhere else. A page that means one of those two
 * inside a card writes the role, and writing it is what makes it a landmark
 * here.
 */
const LANDMARK_SELECTOR = [
  'main', 'nav',
  '[role~="main"]', '[role~="navigation"]', '[role~="banner"]', '[role~="contentinfo"]',
].join(', ')

/**
 * The roles of the things a page offers to act on. A click target wrapped
 * tightly around exactly one of them is that control's own hit area, not a
 * second thing to click.
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
  ...FIELD_ROLES,
])

/** Everything one walk shares from its first element to its last. */
interface Walk {
  /** The read's options. */
  readonly options: SnapshotOptions
  /** Injected visibility. */
  readonly isVisible: (el: Element) => boolean
  /** Injected clickability, defaulted. */
  readonly isClickable: (el: Element) => boolean
  /** Injected drawn-around text, defaulted. */
  readonly drawnAround: (el: Element) => string
  /** The element the read asked for, which tops whatever the page nests it in. */
  readonly scope: Element | undefined
  /** The items collected so far, in document order. */
  readonly items: Item[]
  /** Rectangles already claimed, keyed by role and name, for dropping repeats. */
  readonly kept: Map<string, DOMRectReadOnly[]>
  /** Each table's rows, sorted once however often the walk asks about them. */
  readonly shapes: Map<Element, TableShape>
}

/** Where the walk currently stands. */
interface Place {
  /** The container the walk is inside. */
  readonly container: ContainerItem | undefined
  /** How many containers enclose this position. */
  readonly depth: number
  /** Text seen since the last row, waiting to become one. */
  readonly buffer: string[]
  /**
   * True where the text around the walk is already printed as a name — inside a
   * `label` that names a control, and over the label half of a tree node or
   * menu item. That text and the click targets in it are not rows of their own.
   */
  readonly labelled: boolean
}

/**
 * True when this element repeats one already collected — same role, same name,
 * and most of the smaller rectangle in common. A pinned table column draws its
 * cells twice; the reader needs them once.
 * @param kept - rectangles already claimed, keyed by role and name.
 * @param rectOf - injected geometry.
 * @param key - the role and name this element would print.
 * @param el - the element to test.
 * @returns whether the element repeats one already collected.
 */
function duplicate(
  kept: Map<string, DOMRectReadOnly[]>,
  rectOf: (el: Element) => DOMRectReadOnly | undefined,
  key: string,
  el: Element,
): boolean {
  const rect = rectOf(el)
  if (rect === undefined) return false
  const seen = kept.get(key)
  if (seen === undefined) {
    kept.set(key, [rect])
    return false
  }
  if (seen.some(other => rectsOverlap(rect, other))) return true
  seen.push(rect)
  return false
}

/**
 * Turn the text seen since the last row into a row of its own.
 * @param walk - the walk in progress.
 * @param place - the position whose buffered text is flushed.
 */
function flush(walk: Walk, place: Place): void {
  if (place.buffer.length === 0) return
  const text = clip(collapse(place.buffer.join(' ')))
  place.buffer.length = 0
  if (text !== '') walk.items.push({ kind: 'text', text, container: place.container, depth: place.depth })
}

/**
 * A list long enough to read as one.
 * @param el - the element to classify.
 * @returns the container face, or undefined for a short or non-list element.
 */
function listFace(el: Element): ContainerFace | undefined {
  const tag = el.localName
  if (tag !== 'ul' && tag !== 'ol') return undefined
  const items = [...el.children].filter(child => child.localName === 'li')
  return items.length >= LIST_MIN ? { type: 'list', name: nameOf(el) } : undefined
}

/**
 * A region the page titled, which is what makes it worth naming.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns the container face, or undefined for an untitled region.
 */
function sectionFace(el: Element, walk: Walk): ContainerFace | undefined {
  const name = containerName(el, walk.isVisible)
  return name === '' ? undefined : { type: 'section', name }
}

/**
 * A row of buttons, which reads as a toolbar whether or not it says so.
 * @param el - the element to classify.
 * @param role - the element's role.
 * @param walk - the walk in progress.
 * @returns the container face, or undefined for anything else.
 */
function buttonRowFace(el: Element, role: string | null, walk: Walk): ContainerFace | undefined {
  if (role !== null) return undefined
  const children = [...el.children].filter(child => !isSkipped(child, walk.isVisible))
  return children.length >= TOOLBAR_MIN && children.every(child => roleOf(child) === 'button')
    ? { type: 'toolbar', name: '' }
    : undefined
}

/**
 * The container an element opens, if it opens one. A composite widget — a strip
 * of tabs, a menu, a group of radios — is a container and not a leaf: what the
 * model needs is inside it.
 * @param el - the element to classify.
 * @param role - the element's role.
 * @param walk - the walk in progress.
 * @returns the container face, or undefined for an element that opens none.
 */
function containerFace(el: Element, role: string | null, walk: Walk): ContainerFace | undefined {
  switch (role) {
    case 'main': return { type: 'main', name: nameOf(el) }
    case 'navigation': return { type: 'nav', name: nameOf(el) }
    case 'form':
    case 'search': return { type: 'form', name: nameOf(el) }
    case 'dialog':
    case 'alertdialog': return { type: 'dialog', name: containerName(el, walk.isVisible) }
    case 'toolbar': return { type: 'toolbar', name: nameOf(el) }
    case 'tablist': return { type: 'tablist', name: nameOf(el) }
    case 'tabpanel': return { type: 'tabpanel', name: nameOf(el) }
    case 'menu':
    case 'menubar': return { type: 'menu', name: nameOf(el) }
    case 'tree': return { type: 'tree', name: nameOf(el) }
    case 'radiogroup': return { type: 'radiogroup', name: nameOf(el) }
    // A select carries this role too, and is a field the model reads and fills
    // rather than a region it looks inside.
    case 'listbox': return el.localName === 'select' ? undefined : { type: 'listbox', name: nameOf(el) }
    case 'list':
    case 'feed': return listFace(el)
    case 'region':
    case 'article':
    case 'complementary':
      return sectionFace(el, walk)
    default: return buttonRowFace(el, role, walk)
  }
}

/**
 * True for an element whose role opens a region of its own, a table included:
 * the walk reads a table as its shape rather than as a run of text, and the
 * cells of one are its contents wherever it is drawn. The judgement is the
 * walk's, so the regions are exactly the ones it reads apart from what is
 * around them rather than a second list of the roles that open one.
 *
 * A region the walk infers from shape rather than from a role is not one of
 * them: {@link buttonRowFace} reads a row of buttons the page wrote no role on
 * as a toolbar, and inside a control that row is the chips the control holds. A
 * table the page marks as layout is not one either, and the text a page draws in
 * one is the text of whatever holds it.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the element's role opens a region.
 */
function opensRegion(el: Element, walk: Walk): boolean {
  const role = roleOf(el)
  if (role === null) return false
  return isTableRole(role) || containerFace(el, role, walk) !== undefined
}

/**
 * The text a control draws for itself, which is what it currently holds where
 * the page keeps that value nowhere else: the words inside a `contenteditable`
 * text box are the text the user typed, and the percentage inside a `div` a
 * page marked as a bar is what the bar reports. An element the browser draws
 * itself shows nothing this way — what is written inside it is a fallback no
 * engine renders.
 *
 * Every word the control draws counts, the words on the things it offers
 * included: a row for a control ends the descent, so the chips of a combobox
 * and the cancel button of an upload reach the model here or nowhere at all. A
 * value that repeats a word the reader can see beside it is a smaller fault
 * than a value that drops one.
 *
 * The regions the control holds are the exception, because their contents are
 * not the control's own text: the list a combobox drops down is what the control
 * offers rather than what it holds, and the rows of a table are its data. What
 * the control holds reaches no read at all, here or anywhere else — the row ends
 * the descent, so the region inside it is never numbered and nothing can name
 * it. Options are read as rows where the page draws the list outside the
 * control: in a cell of a table beside it, or as a sibling in a portal. A
 * control that is itself a region — a `div` a page marks as a `listbox` —
 * reports no drawn value for the same reason.
 * @param el - the control element.
 * @param walk - the walk in progress.
 * @returns the text, or undefined when the control draws none.
 */
function drawnValue(el: Element, walk: Walk): string | undefined {
  if (isOpaque(el) || opensRegion(el, walk)) return undefined
  const text = clip(visibleText(el, walk.isVisible, child => opensRegion(child, walk)))
  return drawsNothing(text) ? undefined : text
}

/**
 * What a control carries: what the user has put in a field, or what a bar
 * reports. A checked state says everything a checkbox holds, so only the fields
 * that carry text report a value. A control the page built out of a `div`
 * carries neither an attribute nor a native value, and reports the text it
 * draws: leaving it out would drop a run of text the reader can see.
 *
 * A bar reports the text it draws before the number the page wrote, which is
 * the one place the two orders disagree. A screen reader announces
 * `aria-valuetext` and would say `25`; this read answers with the page, and the
 * page draws `上传中，请稍候` where the attribute says `25`. The row ends the
 * descent, so those words reach the model as the value or nowhere at all, while
 * the number behind them is what the bar reports when it draws nothing.
 * @param el - the control element.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @returns the value, or undefined for a control that carries none.
 */
function heldValue(el: Element, role: string, walk: Walk): string | undefined {
  if (QUANTITY_ROLES.has(role)) return drawnValue(el, walk) ?? quantityValue(el)
  if (!FIELD_ROLES.has(role) || CHECKED_ROLES.has(role)) return undefined
  return fieldValue(el) ?? drawnValue(el, walk)
}

/**
 * True for a field the page says must be filled: one that says so on the
 * control itself, or one whose label the page draws a star beside. A form draws
 * that star with a stylesheet rather than writing it in the document, so it is
 * on the screen and in no text a read of the document could otherwise reach.
 * @param el - the control element.
 * @param label - the element drawing the words that name the field, if any.
 * @param walk - the walk in progress.
 * @returns whether the field must be filled.
 */
function isRequired(el: Element, label: Element | undefined, walk: Walk): boolean {
  if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') return true
  return labelsOf(el, label).some(one => marksRequired(walk.drawnAround(one)))
}

/**
 * True for text a form draws to say the field beside it must be filled. The
 * mark is looked for inside the text rather than taken as the whole of it,
 * because a form draws the star in front of the label and the colon after it,
 * and both reach this as one run.
 * @param drawn - the text the page draws around the label.
 * @returns whether the text carries the mark.
 */
function marksRequired(drawn: string): boolean {
  return REQUIRED_MARKS.some(mark => drawn.includes(mark))
}

/**
 * Every element that labels one control: the `label` elements HTML resolves for
 * it, the elements ARIA points at, and the words the page merely draws in front
 * of it. The star is drawn on whichever of them the page treats as the label,
 * and a page that ties its label properly is the likeliest of all to draw one.
 * @param el - the control element.
 * @param drawn - the element drawing the words that name the control, if any.
 * @returns the labelling elements, in no particular order.
 */
function labelsOf(el: Element, drawn: Element | undefined): Element[] {
  const labels: Element[] = [...((el as Partial<HTMLInputElement>).labels ?? [])]
  const tree = el.getRootNode() as Document | ShadowRoot
  for (const id of collapse(el.getAttribute('aria-labelledby') ?? '').split(' ')) {
    const ref = tree.getElementById(id)
    if (ref !== null) labels.push(ref)
  }
  if (drawn !== undefined) labels.push(drawn)
  return labels
}

/**
 * What a control holds and how the page has set it, read the same way wherever
 * a row prints it.
 * @param el - the control element.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @param label - the element drawing the words that name the control, if any.
 * @returns the state.
 */
function controlState(el: Element, role: string, walk: Walk, label: Element | undefined): ControlState {
  const secret = isPassword(el)
  return {
    value: secret ? undefined : heldValue(el, role, walk),
    secret,
    checked: CHECKED_ROLES.has(role) ? isChecked(el) : undefined,
    required: isRequired(el, label, walk),
    readonly: isReadonly(el),
    disabled: isDisabled(el),
  }
}

/**
 * Everything a row prints of an element apart from its ref and its name, read
 * the same way whether the element prints one row or opens a room over what it
 * holds: a node reads as a `menuitemcheckbox` the page has ticked either way.
 * @param el - the element.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @param label - the element drawing the words that name the element, if any.
 * @returns the face.
 */
function controlFace(el: Element, role: string, walk: Walk, label: Element | undefined): ControlFace {
  return {
    role,
    ...controlState(el, role, walk, label),
    // A node the page has closed says so: what it holds is not missing from the
    // read, it is folded away until something opens it.
    collapsed: ITEM_NODE_TYPES.has(role) && el.getAttribute('aria-expanded') === 'false',
  }
}

/**
 * Whether a drawing where it stands is one of the page's own commands rather
 * than decoration.
 *
 * A drawing carries no role and no name, so where it sits is the whole of what
 * says it can be operated: a page puts its commands in a toolbar, in a list, or
 * in the cells of a table's rows, and draws the same shapes elsewhere as
 * ornament. The place is read off the element's own ancestors — the first of
 * them that is a cell, or that opens a region — so the pass over the page and a
 * caller holding one element ask the same question and get the same answer.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the page draws a command there.
 */
function namesIcon(el: Element, walk: Walk): boolean {
  if (!isIcon(el, walk)) return false
  for (let at = el.parentElement; at !== null; at = at.parentElement) {
    if (CELL_ROLES.has(roleOf(at) ?? '')) return true
    const face = containerFace(at, roleOf(at), walk)
    if (face !== undefined) return face.type === 'toolbar' || face.type === 'list'
  }
  return false
}

/**
 * The role a cell names an element by rather than reading it as part of the
 * cell's text. The condition is the one a row of the page is printed under, so
 * a bar reaches the sample and the listed row exactly where it would reach a
 * row of its own, and a run the page makes clickable is offered in a cell
 * exactly where it would be offered outside one. The icon a table draws for
 * editing a row carries no role and no name of any kind, and a cell that read
 * it as text would leave the model a column it can see and cannot use.
 * @param el - the element inside the cell.
 * @param walk - the walk in progress.
 * @returns the role, or undefined for an element the cell reads as text.
 */
function cellControlRole(el: Element, walk: Walk): string | undefined {
  const role = roleOf(el)
  if (role !== null && CELL_CONTROL_ROLES.has(role) && rowRole(el, role)) return role
  if (namesIcon(el, walk)) return ICON_ROLE
  if (role !== null) return undefined
  return topClickable(el, walk) ? CLICKABLE_ROLE : undefined
}

/**
 * True for an element a cell names rather than reads as part of its text.
 * @param el - the element inside the cell.
 * @param walk - the walk in progress.
 * @returns whether the cell names the element.
 */
function isCellControl(el: Element, walk: Walk): boolean {
  return cellControlRole(el, walk) !== undefined
}

/**
 * Every control inside one table cell, in document order. Each is named the way
 * a row of its own would name it, so the icon a page makes clickable is
 * answered with what the page wrote on it and a click target holding text with
 * the text it shows.
 * @param el - the cell, or an element inside it.
 * @param walk - the walk in progress.
 * @param found - the controls collected so far, appended in place.
 */
function cellControls(el: Element, walk: Walk, found: CellControl[]): void {
  for (const child of childHost(el).children) {
    if (isSkipped(child, walk.isVisible)) continue
    const role = cellControlRole(child, walk)
    if (role !== undefined) {
      // The same ladder every other row is named by, the `label` the page drew
      // in front of a field included: a cell is where the page draws a row's
      // commands, and a name computed differently there is one no step can use.
      const named = namedAs(child, role, walk)
      found.push({
        el: child,
        role,
        name: named.name,
        ...controlState(child, role, walk, named.label),
      })
    } else cellControls(child, walk, found)
  }
}

/**
 * How one control reads inside the one sample row a table block prints: what it
 * is called, or what it is where the page has named it nothing, and whether it
 * is currently on. The sample says what the column holds, so the controls are
 * named and the values they carry are not.
 *
 * A bar is the exception, because what it reports is the whole of what the
 * column shows: a cell drawn as nothing but a bar has no text of its own, and a
 * sample saying only `[进度]` drops the percentage a reader sees there. The
 * value goes inside the brackets with the name, and the cut the sample makes
 * inside them applies to it like anything else.
 * @param control - the cell's control.
 * @returns the sample text for that control.
 */
function controlSample(control: CellControl): string {
  const named = control.name === '' ? control.role : control.name
  const reported = QUANTITY_ROLES.has(control.role) && control.value !== undefined ? ` ${control.value}` : ''
  return `${named}${reported}${control.checked === true ? ' x' : ''}`
}

/**
 * Read one cell: what it says, and the controls it offers. A cell that holds
 * both says both — a status beside the button that changes it is what the
 * column is for.
 *
 * The sample is cut here rather than where it is printed, because what the
 * sample is for is saying which controls the column offers: cutting the line
 * afterwards would cut those off the end of a cell whose text runs long, and
 * the reader would take the column for one that offers nothing. The text gives
 * way to the controls, and a list of controls longer than the whole allowance
 * is cut inside its brackets rather than printed whole — a row of buttons named
 * a sentence each would otherwise spend the sample line on one column.
 * @param cell - the cell element.
 * @param walk - the walk in progress.
 * @returns the cell.
 */
function readCell(cell: Element, walk: Walk): RowCell {
  const controls: CellControl[] = []
  cellControls(cell, walk, controls)
  const text = clip(visibleText(cell, walk.isVisible, child => isCellControl(child, walk)))
  if (controls.length === 0) return { controls, text, sample: clipTo(text, SAMPLE_CELL_LIMIT) }
  const inside = `[${clipTo(controls.map(controlSample).join(' '), SAMPLE_CELL_LIMIT - 2)}]`
  const room = SAMPLE_CELL_LIMIT - inside.length - 1
  const shown = room > 0 ? clipTo(text, room) : ''
  return { controls, text, sample: shown === '' ? inside : `${shown} ${inside}` }
}

/**
 * The cells of one row a reader can see, without the ones a pinned column draws
 * again over the top of them inside that row. The rectangles are claimed in a
 * map of the row's own: a cell repeats a cell beside it, never one of the row
 * above or of the piece of the table drawn over this one.
 * @param row - the row element.
 * @param walk - the walk in progress.
 * @returns the cell elements, in column order.
 */
function pickCells(row: Element, walk: Walk): Element[] {
  const kept = new Map<string, DOMRectReadOnly[]>()
  const cells: Element[] = []
  for (const cell of row.children) {
    if (isSkipped(cell, walk.isVisible)) continue
    if (!duplicate(kept, walk.options.rectOf, ROW_CELLS, cell)) cells.push(cell)
  }
  return cells
}

/**
 * The cells one piece of a table shows in one of its rows, read as a listing
 * prints them.
 * @param row - the row element.
 * @param walk - the walk in progress.
 * @returns the cells, in column order.
 */
function rowCells(row: Element, walk: Walk): RowCell[] {
  return pickCells(row, walk).map(cell => readCell(cell, walk))
}

/** True for a cell drawing neither a word nor anything a reader can act on. */
function showsNothing(cell: RowCell): boolean {
  return cell.text === '' && cell.controls.length === 0
}

/**
 * The columns of one row across the pieces a table is drawn in: each column
 * from the piece that shows it, and from the first of them where more than one
 * does. A page pins a column by drawing the whole table again with everything
 * but that column's content hidden, so a column that shows nothing in one piece
 * is drawn in another, and the reader needs the one row the pieces make up
 * between them.
 *
 * The columns line up by their position in the row, because that is the one
 * thing every piece agrees on: a pinned copy is drawn over a different column
 * of the table than the one it repeats as soon as the reader scrolls sideways.
 * A piece that draws fewer cells than the table has columns therefore lines up
 * from the left, which is where a page puts the column it leaves out — the
 * placeholder a header draws over the scrollbar.
 * @param pieces - each piece's cells for one row, the piece that prints the
 * table first.
 * @returns the merged cells, in column order.
 */
function mergeCells(pieces: readonly (readonly RowCell[])[]): RowCell[] {
  const merged: RowCell[] = []
  for (const cells of pieces) {
    cells.forEach((cell, at) => {
      const held = merged[at]
      if (held === undefined || (showsNothing(held) && !showsNothing(cell))) merged[at] = cell
    })
  }
  return merged
}

/**
 * True for a cell that heads a column or a row rather than holding data.
 * @param cell - the cell element.
 * @returns whether the cell is a header cell.
 */
function headsCells(cell: Element): boolean {
  const role = roleOf(cell)
  return role === 'columnheader' || role === 'rowheader'
}

/**
 * True for a row that is a header the table did not declare as one: every cell
 * a reader can see heads a column. A row of data cells is data, however the
 * page styles it.
 * @param row - the row element.
 * @param walk - the walk in progress.
 * @returns whether the row heads the table's columns.
 */
function headsColumns(row: Element, walk: Walk): boolean {
  const cells = [...row.children].filter(cell => !isSkipped(cell, walk.isVisible))
  return cells.length > 0 && cells.every(headsCells)
}

/**
 * True for the role of an element the walk reads as a table, which is what
 * {@link TABLE_SELECTOR} matches candidates for and this decides.
 * @param role - the element's role.
 * @returns whether the element is read as a table.
 */
function isTableRole(role: string | null): boolean {
  return role === 'table' || role === 'grid' || role === 'treegrid'
}

/** Which rows of one table head its columns and which hold its data. */
interface TableShape {
  /** The row heading the columns, absent for a table that heads none. */
  readonly headRow: Element | undefined
  /** Every row holding data, without the header, the foot, and the hidden ones. */
  readonly dataRows: readonly Element[]
}

/**
 * Sort one table's rows into its header and its data, once per walk however
 * often the walk asks: a table is asked about by the tables either side of it
 * as well as for itself, and sorting four hundred rows is not free.
 *
 * A `thead` of several rows heads the table by its first row alone, so a table
 * that spreads its column names over a grouping row and a leaf row reports the
 * grouping row as its header; the leaf names reach the reader only in the rows
 * themselves.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @returns the table's shape.
 */
function tableShape(el: Element, walk: Walk): TableShape {
  const known = walk.shapes.get(el)
  if (known !== undefined) return known
  const grouped = new Set(el.querySelectorAll(':scope > thead > tr, :scope > tfoot > tr'))
  const rows = queryInOrder(el, 'tr, [role~="row"]').filter(row => row.closest(TABLE_SELECTOR) === el)
  const declared = el.querySelector(':scope > thead > tr') ?? undefined
  const first = rows[0]
  const headRow = declared ?? (first !== undefined && headsColumns(first, walk) ? first : undefined)
  const shape: TableShape = {
    headRow,
    dataRows: rows.filter(row => row !== headRow && !grouped.has(row) && !isSkipped(row, walk.isVisible)),
  }
  walk.shapes.set(el, shape)
  return shape
}

/**
 * The next node in document order.
 * @param node - where the walk stands.
 * @param inside - whether the node's own children come next.
 * @returns the next node, or null at the end of the document.
 */
function nextInOrder(node: Node, inside: boolean): Node | null {
  if (inside && node.firstChild !== null) return node.firstChild
  let at: Node | null = node
  while (at !== null) {
    if (at.nextSibling !== null) return at.nextSibling
    at = at.parentNode
  }
  return null
}

/**
 * True when an element wraps a picture the reader can see. A wrapper holding
 * nothing but pictures the page hides — the spinner of a table that is not
 * loading, a mask drawn over nothing — draws nothing itself, and separates
 * nothing from anything.
 * @param el - the wrapping element.
 * @param walk - the walk in progress.
 * @returns whether the element holds a picture the reader can see.
 */
function drawsSomething(el: Element, walk: Walk): boolean {
  for (const drawn of el.querySelectorAll(DRAWN_TAGS)) {
    if (!isSkipped(drawn, walk.isVisible)) return true
  }
  return false
}

/**
 * True when the page draws nothing at all between two elements: no text a
 * reader can see, nothing that would earn a row, no picture or rule. A header
 * frozen over a body has only wrappers between the two halves; a table under a
 * paragraph has the paragraph, and a table inside another is not beside it at
 * all. A picture the reader can see counts wherever it sits in the gap, wrapped
 * or bare: the same icon must not separate two tables when the page draws it on
 * its own and join them when the page puts a `div` around it.
 * @param first - the earlier element.
 * @param second - the later element.
 * @param walk - the walk in progress.
 * @returns whether the two are drawn against each other.
 */
function nothingBetween(first: Element, second: Element, walk: Walk): boolean {
  let node: Node | null = nextInOrder(first, false)
  while (node !== null && node !== second) {
    if (node.nodeType === node.ELEMENT_NODE) {
      const el = node as Element
      // What holds the later element is around the gap rather than in it.
      if (el.contains(second)) {
        node = nextInOrder(el, true)
        continue
      }
      const shows = !isSkipped(el, walk.isVisible)
        && (el.matches(DRAWN_TAGS) || drawsSomething(el, walk) || makesRow(el, walk)
          || holdsItems(el, walk) || visibleText(el, walk.isVisible) !== '')
      if (shows) return false
      node = nextInOrder(el, false)
      continue
    }
    if (node.nodeType === node.TEXT_NODE && collapse((node as Text).data) !== '') return false
    node = nextInOrder(node, false)
  }
  return node === second
}

/**
 * The other half of a table drawn in two pieces — a header frozen over a body
 * that scrolls under it. The halves sit in one region of the page with nothing
 * drawn between them; two tables in two regions, or with a paragraph between
 * them, are two tables. Two names the page wrote and meant differently are two
 * tables as well: the halves of one table are one thing to name, and a page
 * that names both halves at all names them the same.
 *
 * The search runs over the whole document rather than the read's scope, so a
 * read scoped to the body half still finds the header above it. It counts only
 * the tables the walk itself reads as one: a table the reader cannot see is not
 * drawn between anything, and an element whose first role is decoration is a
 * table to the selector and a wrapper to the walk. Counting either of them
 * would put a table nobody sees between the two halves, and the header the page
 * drew would reach the reader on neither half.
 * @param el - the table element.
 * @param step - 1 for the table after this one, -1 for the table before it.
 * @param walk - the walk in progress.
 * @returns the neighbouring table, or undefined when the two are not one table.
 */
function splitPartner(el: Element, step: number, walk: Walk): Element | undefined {
  const tables = queryInOrder(el.ownerDocument, TABLE_SELECTOR)
    .filter(table => isTableRole(roleOf(table)) && !isHiddenAround(table, walk.isVisible))
  const other = tables[tables.indexOf(el) + step]
  if (other === undefined || other.closest(CONTAINER_SELECTOR) !== el.closest(CONTAINER_SELECTOR)) return undefined
  const name = nameOf(el)
  const otherName = nameOf(other)
  if (name !== '' && otherName !== '' && name !== otherName) return undefined
  const ahead = step === 1
  return nothingBetween(ahead ? el : other, ahead ? other : el, walk) ? other : undefined
}

/**
 * The piece this table borrows its header from: the table before it that heads
 * columns it has no rows for. The two are one table, so the header reaches the
 * reader whether the read arrives at the whole page or at the body by ref.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param shape - this table's own shape.
 * @returns the header piece, or undefined for a table that heads its own columns.
 */
function headerPiece(el: Element, walk: Walk, shape: TableShape): Element | undefined {
  if (shape.headRow !== undefined) return undefined
  const previous = splitPartner(el, -1, walk)
  if (previous === undefined) return undefined
  const piece = tableShape(previous, walk)
  return piece.headRow !== undefined && piece.dataRows.length === 0 ? previous : undefined
}

/**
 * True for the header half of a table drawn in two pieces, which prints nothing
 * of its own: the body half prints the header it gives away.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @returns whether the table is a header another table prints.
 */
function isHeaderPiece(el: Element, walk: Walk): boolean {
  const shape = tableShape(el, walk)
  if (shape.headRow === undefined || shape.dataRows.length > 0) return false
  const next = splitPartner(el, 1, walk)
  return next !== undefined && tableShape(next, walk).headRow === undefined
}

/**
 * The row heading one piece's columns: the row the piece heads its own columns
 * with, or the one on the header half it is drawn under.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @returns the header row, absent for a piece that heads no columns.
 */
function headRowOf(el: Element, walk: Walk): Element | undefined {
  const shape = tableShape(el, walk)
  const piece = headerPiece(el, walk, shape)
  return shape.headRow ?? (piece === undefined ? undefined : tableShape(piece, walk).headRow)
}

/**
 * The table drawn next to this one that holds rows, stepping over the header
 * halves in between: the pieces of a table pinned column by column follow one
 * another as header, body, header, body, and what one piece repeats is the rows
 * of the piece before it.
 * @param el - the table element.
 * @param step - 1 for the table after this one, -1 for the table before it.
 * @param walk - the walk in progress.
 * @returns the neighbouring table with rows, or undefined when there is none.
 */
function neighbourTable(el: Element, step: number, walk: Walk): Element | undefined {
  let at = splitPartner(el, step, walk)
  while (at !== undefined && tableShape(at, walk).dataRows.length === 0) at = splitPartner(at, step, walk)
  return at
}

/**
 * True when the second table is the first drawn again: a row for each row, and
 * drawn over the same ground. A page pins a column by drawing the whole table a
 * second time with every other column's content hidden, so the copy covers the
 * table it repeats and carries its rows one for one; a table drawn after
 * another covers none of it, and a table with no rows repeats nothing.
 * @param first - the earlier table.
 * @param second - the later table.
 * @param walk - the walk in progress.
 * @returns whether the two are one table drawn twice.
 */
function repeatsTable(first: Element, second: Element, walk: Walk): boolean {
  const rows = tableShape(first, walk).dataRows.length
  if (rows === 0 || rows !== tableShape(second, walk).dataRows.length) return false
  return rectsMeet(walk.options.rectOf(first), walk.options.rectOf(second))
}

/**
 * The table this one is drawn over, for a piece that prints nothing of its own:
 * the table before it prints every piece as one.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @returns the table this one repeats, or undefined for a table of its own.
 */
function repeatedTable(el: Element, walk: Walk): Element | undefined {
  const previous = neighbourTable(el, -1, walk)
  return previous !== undefined && repeatsTable(previous, el, walk) ? previous : undefined
}

/**
 * Every piece one table is drawn in: itself first, then each copy drawn over
 * it, in the order the page draws them. The search runs forward from the piece
 * that prints the table, so a read scoped to that table by ref reads the same
 * pieces as a read of the whole page.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @returns the pieces, this table first.
 */
function tablePieces(el: Element, walk: Walk): [Element, ...Element[]] {
  const pieces: [Element, ...Element[]] = [el]
  let previous = el
  for (let at = neighbourTable(el, 1, walk); at !== undefined; at = neighbourTable(at, 1, walk)) {
    if (!repeatsTable(previous, at, walk)) break
    pieces.push(at)
    previous = at
  }
  return pieces
}

/**
 * The row each piece of a table draws at one index.
 * @param pieces - the table's pieces.
 * @param at - the row's 0-based position among the data rows.
 * @param walk - the walk in progress.
 * @returns the row elements, the piece that prints the table first.
 */
function rowPieces(pieces: readonly Element[], at: number, walk: Walk): Element[] {
  return pieces.map(piece => tableShape(piece, walk).dataRows[at]).filter(row => row !== undefined)
}

/**
 * The whole of a strip a page has marked, which is the landmark around it as
 * well as the list inside: a page marks its pager as a navigation landmark
 * (`<nav aria-label="Pagination">`) or marks the list and wraps it in one
 * (`<nav><ul class="pagination">`), and the two are one widget drawn two ways.
 * Reading the landmark as a region of its own would leave the second kind
 * standing beside no table at all.
 * @param el - the marked element.
 * @returns the outermost navigation landmark around it, or the element itself.
 */
function wholeStrip(el: Element): Element {
  let at = el
  while (at.parentElement !== null && roleOf(at.parentElement) === 'navigation') at = at.parentElement
  return at
}

/**
 * True where a strip is drawn beside what stands in one region: the landmark a
 * page wraps a strip in is part of the pager, and where the page draws the
 * table inside that landmark too, the landmark is the region the two share.
 * Either reading places the strip beside the table.
 * @param el - the marked strip.
 * @param region - the region the table stands in.
 * @returns whether the strip is drawn beside it.
 */
function standsBy(el: Element, region: Element | null): boolean {
  return regionOf(wholeStrip(el)) === region || regionOf(el) === region
}

/**
 * The region an element stands in: the container holding it, never the element
 * itself, because a page draws the strip that pages a table as a `nav` as
 * readily as it draws it as a `div`, and a strip is not a region of its own.
 * @param el - the element to place.
 * @returns the region, or null for an element no region encloses.
 */
function regionOf(el: Element): Element | null {
  const parent = el.parentElement
  return parent === null ? null : parent.closest(CONTAINER_SELECTOR)
}

/**
 * Every table element one table is drawn as: each of its pieces, and the header
 * half drawn over each piece. A page that pins a column draws header, body,
 * header, body, and the strip that pages the table comes after all of them, so
 * a search that stopped at the first of those tables would answer that the
 * table is paged by nothing.
 * @param el - the table element the read prints.
 * @param walk - the walk in progress.
 * @returns the table elements this one table is drawn as.
 */
function tableParts(el: Element, walk: Walk): Set<Element> {
  const parts = new Set<Element>()
  for (const piece of tablePieces(el, walk)) {
    parts.add(piece)
    const header = headerPiece(piece, walk, tableShape(piece, walk))
    if (header !== undefined) parts.add(header)
  }
  return parts
}

/**
 * The text of a pagination strip, when the candidate really is one that shows
 * something.
 * @param el - the candidate element.
 * @param walk - the walk in progress.
 * @returns the strip's text, or undefined when it is not one or shows nothing.
 */
function stripText(el: Element, walk: Walk): string | undefined {
  if (!isMarked(el, PAGINATION_MARKER) || isSkipped(el, walk.isVisible)) return undefined
  const text = clip(visibleText(el, walk.isVisible))
  return text === '' ? undefined : text
}

/**
 * The first pagination strip among the elements between one table and the next,
 * scanning away from the table.
 * @param nodes - the tables and candidates on one side of the table, nearest first.
 * @param walk - the walk in progress.
 * @returns the strip's text, or undefined when another table comes first.
 */
function nearestStrip(nodes: readonly Element[], walk: Walk): string | undefined {
  for (const node of nodes) {
    if (node.matches(TABLE_SELECTOR)) return undefined
    const text = stripText(node, walk)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * The strip drawn above a table, which pages that table only when no table at
 * all sits above the strip: a strip between two tables pages the one it is
 * drawn under, and belongs to no other.
 * @param above - the tables and candidates before the table, in document order.
 * @param walk - the walk in progress.
 * @returns the strip's text, or undefined when a table comes before it.
 */
function stripAbove(above: readonly Element[], walk: Walk): string | undefined {
  if (above.some(node => node.matches(TABLE_SELECTOR))) return undefined
  return nearestStrip([...above].reverse(), walk)
}

/**
 * The pagination strip that belongs to a table: the one under it, or failing
 * that the one over it, never one that belongs to the table next to it. Each
 * strip pages one table, so a strip already under a table is not also over the
 * next one. A strip drawn inside any table belongs to that table's rows, not
 * beside it. The pieces one table is drawn as are that table and stop nothing:
 * the strip paging a table pinned column by column is drawn after every copy of
 * it. Any other table does stop the search, so a strip between two tables pages
 * the one above it alone.
 *
 * The search runs over the region the table stands in, rather than over the
 * read's scope, so a read scoped to one table by ref reports the strip that
 * pages it exactly as a read of the whole page does. A strip pages the table
 * only where the two stand in the same region — a page drawing its table in one
 * region and a strip in another has said they are not beside each other. The
 * navigation landmark a page draws around a strip is part of the strip, so the
 * region that landmark stands in counts as the strip's own — and so does the
 * landmark itself, for a page that draws the table inside it too.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @returns the strip's text, or undefined when the table has none.
 */
function paginationText(el: Element, walk: Walk): string | undefined {
  const parts = tableParts(el, walk)
  const region = regionOf(el)
  const inside = region ?? (el.getRootNode() as ParentNode)
  const nodes = queryInOrder(inside, `${TABLE_SELECTOR}, ${markedSelector(PAGINATION_MARKER)}`)
    .filter(node => node.matches(TABLE_SELECTOR) || (node.closest(TABLE_SELECTOR) === null && standsBy(node, region)))
    .filter(node => node === el || !parts.has(node))
  const at = nodes.indexOf(el)
  return nearestStrip(nodes.slice(at + 1), walk) ?? stripAbove(nodes.slice(0, at), walk)
}

/**
 * One data row, read from the page only as far as a listing asks. A whole page
 * prints one sample row and counts the rest, so the rest are counted and not
 * read; a read scoped to the table or filtered by `find` reads what it prints.
 *
 * The row is read across every piece the table is drawn in, so a column drawn
 * in a pinned copy reaches the reader in the row it belongs to, and the text
 * `find` matches the row by is everything the pieces draw in it.
 * @param drawn - the row as each piece of the table draws it, the piece that
 * prints the table first.
 * @param el - the row element of that first piece, which the row is named by.
 * @param index - the row's 1-based position among the data rows.
 * @param walk - the walk in progress.
 * @param table - the table this row belongs to.
 * @returns the row.
 */
function readRow(
  drawn: readonly Element[],
  el: Element,
  index: number,
  walk: Walk,
  table: ContainerFace,
): TableRowItem {
  let cells: readonly RowCell[] | undefined
  let text: string | undefined
  const read = (): readonly RowCell[] => cells ??= mergeCells(drawn.map(row => rowCells(row, walk)))
  return {
    kind: 'row',
    el,
    index,
    table,
    get width(): number {
      return read().length
    },
    get cells(): readonly RowCell[] {
      return read()
    },
    get text(): string {
      return text ??= clip(drawn.map(row => visibleText(row, walk.isVisible)).join(' '))
    },
  }
}

/**
 * Read a table as its shape: the header, the rows, and what sits beside it,
 * across every piece the page draws the table in. The columns are the wider of
 * the header and the first data row, so a table whose header groups columns the
 * rows spell out never reports fewer columns than the sample row beneath it
 * prints. Only that one row is measured: asking every row how wide it is would
 * read every cell of a table the read is about to report by its shape alone.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param place - the table's position.
 * @param name - the table's accessible name.
 * @returns the collected table.
 */
function readTable(el: Element, walk: Walk, place: Place, name: string): TableItem {
  const pieces = tablePieces(el, walk)
  // Numbered before its contents, so the ref that names the table reads lower
  // than the refs of the controls inside it.
  const ref = walk.options.refs.ref(el)
  const headRows = pieces.map(piece => headRowOf(piece, walk)).filter(row => row !== undefined)
  const header = mergeCells(headRows.map(row => rowCells(row, walk)))
  const face: { readonly type: 'table'; readonly name: string } = { type: 'table', name }
  const rows = tableShape(el, walk).dataRows
    .map((row, index) => readRow(rowPieces(pieces, index, walk), row, index + 1, walk, face))
  return {
    ...face,
    kind: 'table',
    el,
    ref,
    header,
    rows,
    columns: Math.max(header.length, rows[0]?.width ?? 0),
    pagination: paginationText(el, walk),
    container: place.container,
    depth: place.depth,
  }
}

/**
 * What a table is called: its own name, or the name of the header half it is
 * drawn under. The halves of a table drawn in two pieces are one table, so a
 * page that named the header and left the body unnamed named the table.
 * @param el - the table element.
 * @param piece - the header half this table is drawn under, if any.
 * @returns the name, empty when neither half carries one.
 */
function tableName(el: Element, piece: Element | undefined): string {
  const name = nameOf(el)
  if (name !== '') return name
  return piece === undefined ? '' : nameOf(piece)
}

/**
 * Collect a table, unless it is the header half of one already collected or one
 * of the pieces another table prints: a table drawn again over the one before
 * it is that table's pinned copy, and the reader is given one table.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param place - the table's position.
 */
function pushTable(el: Element, walk: Walk, place: Place): void {
  if (isHeaderPiece(el, walk) || repeatedTable(el, walk) !== undefined) return
  const piece = headerPiece(el, walk, tableShape(el, walk))
  const name = tableName(el, piece)
  if (duplicate(walk.kept, walk.options.rectOf, `table|${name}`, el)) return
  flush(walk, place)
  walk.items.push(readTable(el, walk, place, name))
}

/** True for the group a tree node or a menu item holds its nodes in. */
function isGroup(el: Element): boolean {
  return el.matches(GROUP_SELECTOR)
}

/**
 * True inside a tree node or a menu item, whose group of nodes is part of the
 * node rather than a region beside it.
 * @param container - the container the walk currently stands in.
 * @returns whether that container is a node holding other nodes.
 */
function holdsNodes(container: ContainerItem | undefined): boolean {
  return container?.type === 'treeitem' || container?.type === 'menuitem'
}

/**
 * The name the page wrote for an element, which outranks anything it shows: a
 * menu item drawn as an icon says what it is nowhere else. Only what the label
 * itself carries counts — the text of the label attribute, or what each element
 * the page points at is called, in the order it points at them. An empty label,
 * and one pointing at nothing the page has, name nothing at all and leave the
 * element to be named by what it shows.
 *
 * A reference is looked up in the tree the element itself lives in, because
 * that is where the page wrote it: an id inside an open shadow root names the
 * element in that root, and never the one the surrounding page happens to give
 * the same id.
 *
 * A reference to the element itself, to what it holds, or to what holds it, is
 * no label. The page has pointed at the very text the row is being named from,
 * and following it would carry every button hanging off a tree node into that
 * node's name — the reading the ladder below this exists to prevent.
 *
 * An element pointed at is read whether or not the reader can see it: a page
 * that names a node by a run of text it draws nowhere still named it, which is
 * how ARIA defines the reference. What that element is called comes first and
 * its text second, so a page pointing at an icon is answered with the icon's
 * own label rather than with nothing.
 * @param el - the element to name.
 * @returns the written name, empty when the page wrote none.
 */
function declaredName(el: Element): string {
  const label = clip(collapse(el.getAttribute('aria-label') ?? ''))
  if (label !== '') return label
  const ids = collapse(el.getAttribute('aria-labelledby') ?? '')
  if (ids === '') return ''
  const tree = el.getRootNode() as Document | ShadowRoot
  const parts: string[] = []
  for (const id of ids.split(' ')) {
    const ref = tree.getElementById(id)
    if (ref === null || ref.contains(el) || el.contains(ref)) continue
    const name = nameOf(ref)
    parts.push(name === '' ? visibleText(ref, () => true) : name)
  }
  return clip(collapse(parts.join(' ')))
}

/**
 * True for a child whose own row prints its text, so the element around it is
 * not named by that text as well.
 * @param el - the child to classify.
 * @returns whether the child prints a row that names itself.
 */
function namesItself(el: Element): boolean {
  const role = roleOf(el)
  return role !== null && isNameable(role)
}

/**
 * What one row inside a node calls the node around it: the text it shows, or,
 * for a link or a heading showing none, the name the page wrote on it. An icon
 * link is how a framework draws the label of a node that is somewhere to go,
 * and that name is the only place the label is written. A control that acts on
 * the node names it nothing, however much text it shows.
 * @param el - the row inside the node.
 * @param role - that row's role.
 * @param walk - the walk in progress.
 * @returns the name, empty when the row says nothing about the node.
 */
function nodeLabel(el: Element, role: string, walk: Walk): string {
  if (ACTS_ON_NODE_ROLES.has(role)) return ''
  const text = clip(visibleText(el, walk.isVisible))
  if (text !== '') return text
  return role === 'link' || role === 'heading' ? nameOf(el) : ''
}

/**
 * What the first row inside a node calls it, in document order, which is the
 * node's label where the page drew that label as a link or a heading. A row
 * saying nothing about the node is passed over rather than taken as the label:
 * an icon, a checkbox, or a button drawn as a picture comes before the label in
 * every tree a framework draws, and stopping there would name the node by
 * everything hanging off it instead.
 *
 * Neither the group of nodes under this one nor anything the page draws is
 * looked into: what a group holds are nodes of its own, never a label for the
 * node above them, and the words inside a picture label the picture.
 * @param el - the node to look inside.
 * @param walk - the walk in progress.
 * @returns the name, empty when the node holds no row that names it.
 */
function nodeName(el: Element, walk: Walk): string {
  for (const child of childHost(el).children) {
    if (isSkipped(child, walk.isVisible) || isGroup(child) || isOpaque(child)) continue
    const role = roleOf(child)
    if (role === null || !isNameable(role)) {
      const inside = nodeName(child, walk)
      if (inside !== '') return inside
      continue
    }
    const label = nodeLabel(child, role, walk)
    if (label !== '') return label
  }
  return ''
}

/**
 * What a row calls the element it names: what the page wrote, what a tree node
 * or menu item shows of its own, what a click target shows, and the accessible
 * name of everything else.
 *
 * A node is named by its own label and not by what hangs off it: the nodes in
 * the group under it print rows of their own, and so do the buttons that act on
 * it. A node whose label is itself a row — a node drawn as a link, or over a
 * heading — is named by that one alone, and a node holding nothing but the
 * controls that act on it is named nothing at all rather than named by them.
 *
 * A click target holding nothing is named by the whole of what it shows, up to
 * the length of any other row; a target that is a room is named by the start of
 * it, because everything it shows is printed again in the rows under it. See
 * {@link clickableName}, which makes that cut. A target that is itself a
 * picture is named by what the page wrote on it and by nothing else: the words
 * inside a drawing label the picture, and a reader never sees them.
 * @param el - the element to name.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @returns the name.
 */
function ownName(el: Element, role: string, walk: Walk): string {
  const declared = declaredName(el)
  if (declared !== '') return declared
  if (role === CLICKABLE_ROLE) return isOpaque(el) ? '' : clip(visibleText(el, walk.isVisible))
  const own = clip(visibleText(el, walk.isVisible, child => isGroup(child) || namesItself(child)))
  return own === '' ? nodeName(el, walk) : own
}

/**
 * What a row calls the element it names.
 *
 * An icon is named by what the page wrote on it, by the name a title computes,
 * and last by the word its own class names it with, because a page that draws a
 * command as an icon and labels it nowhere has said what it is in that class and
 * in nothing else.
 *
 * The accessible name is computed for the first role the page wrote, and the
 * walk reads the first one ARIA defines; where those differ the computed name
 * is an answer about another role, and an empty one says only that the role the
 * library read is not named by its contents. The text the element shows is the
 * name in that case — for the roles ARIA does name from their contents — so a
 * page falling back from a vocabulary the library does not know keeps the words
 * a reader can see. Where the library agrees with the walk, its answer stands:
 * it implements the whole of the name computation, and this is a fallback for
 * one disagreement rather than a second implementation of it.
 * @param el - the element to name.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @returns the name.
 */
function elementName(el: Element, role: string, walk: Walk): string {
  if (role === ICON_ROLE) return declaredName(el) || nameOf(el) || iconWord(el, walk.isVisible) || ''
  if (role === CLICKABLE_ROLE || ITEM_NODE_TYPES.has(role)) return ownName(el, role, walk)
  const name = nameOf(el)
  const wrote = libraryRole(el)
  if (name !== '' || wrote === '' || wrote === role || !NAME_FROM_CONTENT_ROLES.has(role)) return name
  return clip(visibleText(el, walk.isVisible))
}

/**
 * The `label` drawn immediately in front of a field inside the element holding
 * both, and `null` where something the reader can act on stands between the
 * two: the label further out then says what that other thing is, never what
 * this field is.
 *
 * Only a `label` counts. A page draws its own paragraphs, headings, and notices
 * in front of a field as readily as it draws the field's label, and naming the
 * field by one of those puts a run of the page where the model reads what the
 * field is — and takes that run's own row away. A `label` is the page saying
 * this text labels a field, whether or not it says which.
 *
 * A wrapper drawing no words at all is neither, so the label survives the boxes
 * a form draws around its field, and a control the page draws before it is left
 * behind by the label that follows it.
 * @param host - the element holding both.
 * @param inner - the child of it holding the field.
 * @param walk - the walk in progress.
 * @returns the label, null where something stands between it and the field, and
 * undefined where this element holds none.
 */
function drawnBefore(host: Element, inner: Element, walk: Walk): Element | null | undefined {
  let found: Element | undefined
  let blocked = false
  for (const child of host.children) {
    if (child === inner) break
    if (isSkipped(child, walk.isVisible)) continue
    if (makesRow(child, walk) || holdsItems(child, walk)) {
      found = undefined
      blocked = true
    } else if (child.localName === 'label' && visibleText(child, walk.isVisible) !== '') {
      found = child
      blocked = false
    }
  }
  return found ?? (blocked ? null : undefined)
}

/**
 * The `label` a page draws in front of a field it ties to nothing, which is how
 * a component library draws a form: the label is a `label` element with no
 * `for`, and the box beside it carries no name of any kind. A form that ties
 * the two together is answered by the name computation long before this.
 *
 * The search climbs out of the field as far as the region it stands in, so the
 * label belongs to the field's own group rather than to the form around it, and
 * stops where anything else the reader can act on stands between the two. A
 * label running longer than a label does is a run of the page rather than a
 * name for something beside it, and is left to print as itself.
 * @param el - the field element.
 * @param walk - the walk in progress.
 * @returns the label, or undefined for a field the page draws none in front of.
 */
function labelDrawnBefore(el: Element, walk: Walk): Element | undefined {
  let inner: Element = el
  for (let at = el.parentElement; at !== null && !opensRegion(at, walk); at = at.parentElement) {
    const label = drawnBefore(at, inner, walk)
    if (label === null) return undefined
    if (label !== undefined) {
      return visibleText(label, walk.isVisible).length > LABEL_LIMIT ? undefined : label
    }
    inner = at
  }
  return undefined
}

/**
 * The label that names a field the page named nothing, for the roles a reader
 * fills in: a button says what it is in the words on it, while a field says it
 * in the label drawn beside it.
 * @param el - the element to name.
 * @param role - the role it prints.
 * @param name - the name the element carries of its own.
 * @param walk - the walk in progress.
 * @returns the element drawing the words, or undefined where none names it.
 */
function labelFor(el: Element, role: string, name: string, walk: Walk): Element | undefined {
  return name === '' && FIELD_ROLES.has(role) ? labelDrawnBefore(el, walk) : undefined
}

/**
 * Drop the row the words naming a field would otherwise print of their own,
 * whether this read has them waiting to be printed or has printed them as the
 * row above. The words reach the reader as the field's name instead, the way
 * the text of a `label` the page tied to its control does; a run that says more
 * than the name says stays a run of its own.
 * @param walk - the walk in progress.
 * @param place - the field's position.
 * @param words - the name the field takes from those words.
 */
function takeLabelRow(walk: Walk, place: Place, words: string): void {
  if (clip(collapse(place.buffer.join(' '))) === words) {
    place.buffer.length = 0
    return
  }
  const last = walk.items.at(-1)
  if (last?.kind === 'text' && last.text === words && last.container === place.container) walk.items.pop()
}

/**
 * The field a click target the page named nothing belongs to: the row above it,
 * where the page draws the target inside the element that holds that field.
 * A picker a reader cannot type into is one field drawn in two halves — the box
 * and the arrow that opens it — and two rows for it would have the model
 * choosing which half to click.
 * @param el - the click target.
 * @param role - the role it prints.
 * @param name - the name it carries.
 * @param walk - the walk in progress.
 * @param place - the target's position.
 * @returns the field's row, or undefined for a target of its own.
 */
function opensField(el: Element, role: string, name: string, walk: Walk, place: Place): ElementItem | undefined {
  if (role !== CLICKABLE_ROLE || name !== '') return undefined
  const last = walk.items.at(-1)
  if (last?.kind !== 'element' || !FIELD_ROLES.has(last.role) || last.container !== place.container) return undefined
  return last.el.parentElement?.contains(el) === true ? last : undefined
}

/** One element's name, and the label the page drew in front of it to say so. */
interface NamedItem {
  /** The name a row prints for the element. */
  readonly name: string
  /** The `label` element the name was read off, when it was read off one. */
  readonly label: Element | undefined
}

/**
 * What one element is called under one role.
 *
 * The whole ladder, in one place: what the element declares, what its contents
 * say for the roles ARIA names that way, the word written inside a box the page
 * labelled nowhere else, and failing all of those the `label` the page drew in
 * front of it. Every row the listing prints comes through here, and so does the
 * check a step's target is held to — a name computed two ways is a page the
 * model can read and the seat will not act on.
 * @param el - the element to name.
 * @param role - the role it prints.
 * @param walk - the walk in progress, for the injections and its caches.
 * @returns the name, and the label it came off.
 */
function namedAs(el: Element, role: string, walk: Walk): NamedItem {
  const own = elementName(el, role, walk)
  const label = labelFor(el, role, own, walk)
  return { name: label === undefined ? own : clip(visibleText(label, walk.isVisible)), label }
}

/**
 * Collect one element that carries a name of its own, and stop there.
 * @param el - the element to collect.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 */
function pushElement(el: Element, role: string, walk: Walk, place: Place): void {
  const { name, label } = namedAs(el, role, walk)
  const field = opensField(el, role, name, walk, place)
  if (field !== undefined) {
    walk.items[walk.items.length - 1] = { ...field, opens: walk.options.refs.ref(el) }
    return
  }
  if (duplicate(walk.kept, walk.options.rectOf, `${role}|${name}`, el)) return
  if (label !== undefined) takeLabelRow(walk, place, name)
  flush(walk, place)
  walk.items.push({
    kind: 'element',
    el,
    ref: walk.options.refs.ref(el),
    name,
    ...controlFace(el, role, walk, label),
    opens: undefined,
    container: place.container,
    depth: place.depth,
  })
}

/**
 * Collect a dialog the page has not opened. It is the one hidden thing worth a
 * row: the model cannot ask for a dialog it has never been told exists.
 * @param el - the dialog element.
 * @param walk - the walk in progress.
 * @param place - the dialog's position.
 */
function pushClosedDialog(el: Element, walk: Walk, place: Place): void {
  flush(walk, place)
  walk.items.push({
    kind: 'container',
    el,
    ref: walk.options.refs.ref(el),
    type: 'dialog',
    name: containerName(el, () => true),
    container: place.container,
    depth: place.depth,
    closed: true,
    node: undefined,
  })
}

/**
 * True for a role that earns the element a row of its own: one the reader can
 * name or act on, or a bar the page named. A bar the page left unnamed says
 * what it holds in the text drawn beside it, and a row carrying neither a name
 * nor a number would stand in the way of that text.
 * @param el - the element the role belongs to.
 * @param role - the element's role.
 * @returns whether the role earns a row.
 */
function rowRole(el: Element, role: string): boolean {
  return isNameable(role) || (QUANTITY_ROLES.has(role) && declaredName(el) !== '')
}

/**
 * True for an element that earns a row of its own — a control, a heading, a
 * region, a table. The question is asked before the walk gets there: an element
 * the page draws between two halves of a table has to count for what it will
 * print, and a click target has to know whether it wraps content or only itself.
 *
 * It is the judgement {@link walkElement} makes on the same element, apart from
 * two cases neither caller needs it to cover. A click target is not asked about
 * here — the walk prints a `clickable` row for one, and the callers ask about
 * what a target holds rather than about the target itself. An element the page
 * marks as decoration and does not contradict is counted here by the tag it is
 * written with, where the walk reads through it and prints nothing.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the element would print a row.
 */
function makesRow(el: Element, walk: Walk): boolean {
  // What a page draws inside a picture is a part of the picture, whatever tag
  // it is written with: the walk prints no row for it and neither counts one.
  if (insideOpaque(el)) return false
  if (el.matches(ITEM_TAGS)) return true
  const role = roleOf(el)
  // The order is the walk's own: a row of buttons opens a toolbar whether or
  // not the page gave it a role, and a role reaches a row of its own only where
  // it opens no region.
  if (containerFace(el, role, walk) !== undefined) return true
  if (role === null) return false
  return isTableRole(role) || rowRole(el, role)
}

/**
 * Collect every dialog a subtree the reader cannot see holds, the subtree's own
 * element included. A page that keeps a closed dialog inside a wrapper it hides
 * hides the dialog with it, and the model still needs to know the dialog is
 * there.
 * @param el - the hidden element.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 */
function pushHiddenDialogs(el: Element, walk: Walk, place: Place): void {
  const role = roleOf(el)
  if (role === 'dialog' || role === 'alertdialog') {
    pushClosedDialog(el, walk, place)
    return
  }
  for (const dialog of queryInOrder(el, DIALOG_SELECTOR)) pushClosedDialog(dialog, walk, place)
}

/**
 * Collect a container and everything inside it.
 * @param el - the container element.
 * @param face - what the container prints.
 * @param host - the node holding what the container shows: its own children, an
 * open shadow root's, or a frame document's.
 * @param walk - the walk in progress.
 * @param place - the container's position.
 * @param node - the tree node or menu item this region is opened over, and
 * undefined for every other region. A named node's own text is already printed
 * as the room's name, so the text inside it and the click targets in it print
 * no rows of their own; a region reached from anywhere else starts a name of
 * its own.
 */
function openContainer(
  el: Element,
  face: ContainerFace,
  host: ParentNode,
  walk: Walk,
  place: Place,
  node: ControlFace | undefined,
): void {
  // A room over a node prints the role the page wrote rather than the kind of
  // region, so that is what it claims: a checkable menu item and a plain one
  // drawn over each other are two things the reader is told apart.
  if (duplicate(walk.kept, walk.options.rectOf, `${node?.role ?? face.type}|${face.name}`, el)) return
  flush(walk, place)
  const item: ContainerItem = {
    ...face,
    kind: 'container',
    el,
    ref: walk.options.refs.ref(el),
    container: place.container,
    depth: place.depth,
    closed: false,
    node,
  }
  walk.items.push(item)
  const labelled = node !== undefined && face.name !== ''
  const inside: Place = { container: item, depth: place.depth + 1, buffer: [], labelled }
  walkNodes(host, walk, inside)
  flush(walk, inside)
}

/**
 * Collect a frame's document as a container, or say that it cannot be read. A
 * frame still loading, and one holding a document that is not HTML, have no
 * body; whatever the document does have is what the walk reads.
 * @param el - the frame element.
 * @param walk - the walk in progress.
 * @param place - the frame's position.
 */
function enterFrame(el: Element, walk: Walk, place: Place): void {
  const doc = frameDocument(el)
  const host = doc?.body ?? doc?.documentElement ?? null
  if (host === null) {
    flush(walk, place)
    walk.items.push({ kind: 'frame-error', container: place.container, depth: place.depth })
    return
  }
  openContainer(el, { type: 'frame', name: nameOf(el) }, host, walk, place, undefined)
}

/**
 * True when an element holds something that would earn a row of its own, so it
 * is a wrapper around content as well as whatever else it is. The question is
 * the wide one {@link makesRow} answers: what the page draws in the gap between
 * two halves of a table separates them whether or not this read prints it.
 * @param host - the node holding what the element shows.
 * @param walk - the walk in progress.
 * @returns whether the subtree holds an item.
 */
function holdsItems(host: ParentNode, walk: Walk): boolean {
  for (const candidate of host.querySelectorAll(ITEM_SELECTOR)) {
    if (!isSkipped(candidate, walk.isVisible) && makesRow(candidate, walk)) return true
  }
  return false
}

/**
 * Every row an element holds at the top of what it holds: the rows inside one
 * of these belong to it and not to the element around them.
 * @param host - the node holding what the element shows.
 * @param walk - the walk in progress.
 * @returns the outermost elements that would each print a row, in document order.
 */
function topItems(host: ParentNode, walk: Walk): Element[] {
  const found: Element[] = []
  for (const candidate of host.querySelectorAll(ITEM_SELECTOR)) {
    if (isSkipped(candidate, walk.isVisible) || !makesRow(candidate, walk)) continue
    if (!found.some(other => other.contains(candidate))) found.push(candidate)
  }
  return found
}

/**
 * True for a click target the walk reads straight through, printing no row of
 * its own: one wrapped around a single control and saying exactly what that
 * control says, and one that reaches a region the page is laid out in. The
 * first is the control's own hit area — a list item drawn around a link — and
 * printing it twice would have the model choosing between two rows for one
 * thing. The second is a pointer cursor inherited over half the page.
 *
 * A name the page wrote on the target says it is a thing of its own, so a
 * labelled target reaching a region is read as itself rather than through. The
 * hit area is the exception: a wrapper labelled with what the one control
 * inside it is already called is that control said twice, and reading through
 * it is what keeps the reader from choosing between two rows for one thing. The
 * two names are compared ignoring case, because a reader sees one thing when a
 * page labels the wrapper `Home` around a link reading `home`.
 * @param el - the click target.
 * @param items - the rows it holds, from {@link topItems}.
 * @param walk - the walk in progress.
 * @returns whether the target is the page's own wrapping rather than a thing to click.
 */
function wrapsOnly(el: Element, items: readonly Element[], walk: Walk): boolean {
  if (items.length === 0) return false
  const declared = declaredName(el)
  const only = items.length === 1 ? items[0] : undefined
  if (only !== undefined) {
    const role = roleOf(only)
    if (role !== null && INTERACTIVE_ROLES.has(role)
      && (declared === '' || declared.toLowerCase() === nameOf(only).toLowerCase())
      && visibleText(el, walk.isVisible) === visibleText(only, walk.isVisible)) return true
  }
  if (declared !== '') return false
  for (const landmark of childHost(el).querySelectorAll(LANDMARK_SELECTOR)) {
    if (!isSkipped(landmark, walk.isVisible)) return true
  }
  return false
}

/**
 * True when a tree node or menu item holds a group of nodes the reader can see,
 * which makes it a region to read into rather than one row.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the element holds a group.
 */
function holdsGroup(el: Element, walk: Walk): boolean {
  for (const group of el.querySelectorAll(GROUP_SELECTOR)) {
    if (!isSkipped(group, walk.isVisible)) return true
  }
  return false
}

/**
 * True for the outermost element of a run the page makes clickable. A pointer
 * cursor is inherited, so a wrapper the page marks makes every structural
 * element under it look clickable too; only the top of the run is the thing
 * offered. A read that names an element by ref tops the run at that element:
 * the model asked for it, so it is what this read shows.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the element tops a clickable run.
 */
function topClickable(el: Element, walk: Walk): boolean {
  if (!walk.isClickable(el)) return false
  // An element a shadow root renders has no parent element and tops its run.
  const parent = el.parentElement
  return el === walk.scope || parent === null || !walk.isClickable(parent)
}

/**
 * True for a `label` naming a control the reader can see, whose text that
 * control's row prints. A label for a control the page hides prints nothing of
 * its own, so its text is all the reader has of it.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the element labels a control this read shows.
 */
function namesControl(el: Element, walk: Walk): boolean {
  if (el.localName !== 'label') return false
  const control = (el as HTMLLabelElement).control
  return control !== null && !isSkipped(control, walk.isVisible)
}

/**
 * What a click target holding rows is called: what the page says it is, the
 * title it shows, or the start of the text it shows. Only the start, unlike the
 * name of a target holding nothing: a target with nothing inside it is its own
 * text, while everything a room shows is printed again in the rows under it.
 * @param el - the click target.
 * @param walk - the walk in progress.
 * @returns the name.
 */
function clickableName(el: Element, walk: Walk): string {
  const declared = declaredName(el)
  if (declared !== '') return declared
  const heading = headingText(el, walk.isVisible)
  return heading === '' ? clipTo(visibleText(el, walk.isVisible), CLICK_NAME_LIMIT) : heading
}

/**
 * True for an element a page draws as an icon and says nothing else about: an
 * inline element with no words of its own, marked as an icon by its class.
 *
 * A framework draws the commands of a table row this way — the edit icon of the
 * page this rule was written for is `<i class="el-tooltip operation-modify
 * el-icon-edit">`, with no role, no label, no title, and no pointer cursor of
 * its own — so nothing a specification defines says the element is there at
 * all, and a reader who can see it has no way to ask for it. The rule is a
 * heuristic keyed to a page's own markup, which every rule in this package
 * otherwise refuses; see the Agent Note for what it costs and when it retires.
 *
 * An icon set drawn as inline `svg` reaches this the same way: the drawing
 * itself is one where it names a symbol or carries a title, and the wrapper the
 * page marks as an icon is one where it holds nothing but that drawing — which
 * keeps one icon to one row, since a row ends the descent.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the page draws the element as an icon.
 */
function isIcon(el: Element, walk: Walk): boolean {
  if (iconWord(el, walk.isVisible) === undefined) return false
  // A drawing draws no words of the page wherever it is: what is written inside
  // one labels the picture, which is why the walk stops at one everywhere else.
  if (el.localName === 'svg') return true
  return (isInline(el) || drawingInside(el) !== undefined) && visibleText(el, walk.isVisible) === ''
}

/**
 * True where the walk offers an icon as a thing to act on: inside a table cell,
 * a toolbar, or a list, which is where a page draws icons as the commands it
 * offers rather than as decoration beside its text.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 * @returns whether this read offers the icon.
 */
/**
 * True where the walk offers this element as a thing to click: the top of a
 * clickable run, drawn outside any text a control's own row already prints.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 * @returns whether the element is this read's click target.
 */
function offersClick(el: Element, walk: Walk, place: Place): boolean {
  return !place.labelled && !namesControl(el, walk) && topClickable(el, walk)
}

/**
 * Where the walk stands inside an element, which turns the suppression of text
 * already printed as a name on at a `label` and off again inside the group a
 * tree node holds its nodes in.
 * @param el - the element being descended into.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 * @returns the position to read the element's children at.
 */
function labelPlace(el: Element, walk: Walk, place: Place): Place {
  const labelled = namesControl(el, walk) || (place.labelled && !isGroup(el))
  return labelled === place.labelled ? place : { ...place, labelled }
}

/**
 * Collect one element.
 * @param el - the element to collect.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 */
function walkElement(el: Element, walk: Walk, place: Place): void {
  if (isSkipped(el, walk.isVisible)) {
    if (!isNonContent(el)) pushHiddenDialogs(el, walk, place)
    return
  }
  if (el.localName === 'iframe') {
    enterFrame(el, walk, place)
    return
  }
  if (isOpaque(el)) {
    // A drawing is one thing however many shapes it is built from: reading into
    // it would break the run of text around an icon at every path in it, and
    // print the tooltip it carries as text of the page. A drawing the page named
    // is a picture with a row of its own; an unnamed one is decoration, and
    // decoration ends no run. One the page made clickable keeps a row either
    // way — a framework puts the handler on the icon, and a row is the only way
    // the model can reach it.
    const drawn = roleOf(el)
    if (drawn !== null && rowRole(el, drawn)) pushElement(el, drawn, walk, place)
    else if (namesIcon(el, walk)) pushElement(el, ICON_ROLE, walk, place)
    else if (offersClick(el, walk, place)) pushElement(el, CLICKABLE_ROLE, walk, place)
    return
  }
  const role = roleOf(el)
  if (isTableRole(role)) {
    pushTable(el, walk, place)
    return
  }
  if (isGroup(el) && holdsNodes(place.container)) {
    // The group under a node is the node's own: a room of its own between them
    // would carry no name, and would tell the rows under it they live in it
    // rather than in the node the reader is looking at.
    flush(walk, place)
    walkNodes(childHost(el), walk, { ...place, labelled: false })
    flush(walk, place)
    return
  }
  const host = childHost(el)
  const face = containerFace(el, role, walk)
  if (face !== undefined) {
    openContainer(el, face, host, walk, place, undefined)
    return
  }
  if (role !== null) {
    const node = ITEM_NODE_TYPES.get(role)
    if (node !== undefined) {
      const name = namedAs(el, role, walk).name
      // A node the page named is one row, and the group under it holds the rest:
      // its own text is already the name, and the rows in the group are its
      // children. A node the page named nothing is a room over whatever it does
      // show — the switch that is its whole label, the command a menu offers,
      // the button that acts on it — because a row for it would end the descent
      // and every word in it would reach the reader nowhere. A node showing
      // nothing that prints is one row all the same: the room is opened here,
      // and the listing prints the row it stands in for, because what reaches a
      // listing is known there and nowhere earlier — see `printedItems` in
      // `render.ts`.
      if (holdsGroup(el, walk) || name === '') {
        openContainer(el, { type: node, name }, host, walk, place, controlFace(el, role, walk, undefined))
        return
      }
    }
    if (rowRole(el, role)) {
      pushElement(el, role, walk, place)
      return
    }
  }
  if (namesIcon(el, walk)) {
    pushElement(el, ICON_ROLE, walk, place)
    return
  }
  if (offersClick(el, walk, place)) {
    const items = topItems(host, walk)
    if (!wrapsOnly(el, items, walk)) {
      // A click target holding items is both: the row says what clicking it
      // does, and the rows under it say what it holds.
      if (items.length > 0) openContainer(el, { type: 'clickable', name: clickableName(el, walk) }, host, walk, place, undefined)
      else pushElement(el, CLICKABLE_ROLE, walk, place)
      return
    }
  }
  // Text either side of an element that flows inside a line is one run; text
  // either side of a block is two, whichever side of the block it is on.
  if (!isInline(el)) flush(walk, place)
  walkNodes(host, walk, labelPlace(el, walk, place))
  if (!isInline(el)) flush(walk, place)
}

/**
 * Collect every child node of one host, text included.
 * @param host - the element, shadow root, or document body to read.
 * @param walk - the walk in progress.
 * @param place - the host's position.
 */
function walkNodes(host: ParentNode, walk: Walk, place: Place): void {
  for (const node of host.childNodes) {
    if (node.nodeType === node.TEXT_NODE) {
      if (!place.labelled) place.buffer.push((node as Text).data)
    } else if (node.nodeType === node.ELEMENT_NODE) walkElement(node as Element, walk, place)
  }
}

/**
 * The state a pass over the page carries: the read's own injections, defaulted
 * once, and the caches that make one pass cheaper than the sum of its elements.
 *
 * A single-element caller builds one too. Nothing a name is made of comes out
 * of the caches — they hold what has been collected, which rectangles are
 * claimed, and each table's sorted rows — so a fresh one names an element
 * exactly as the pass that printed it did.
 * @param options - the read's options.
 * @param scope - the element the read asked for, when it asked for one.
 * @returns the walk.
 */
function newWalk(options: SnapshotOptions, scope: Element | undefined): Walk {
  return {
    options,
    isVisible: options.isVisible,
    isClickable: options.isClickable ?? looksClickable,
    drawnAround: options.drawnAround ?? drawnAround,
    scope,
    items: [],
    kept: new Map(),
    shapes: new Map(),
  }
}

/**
 * What a listing calls one element, computed for that element alone.
 *
 * The one name in the package: a listing prints this, and a step's target is
 * checked against this. The model copies a name out of a listing and the seat
 * asks the page whether that element is still called that, so two computations
 * of it would refuse every step naming an element the two disagree about —
 * which is how a console's own query box, printed with the word written inside
 * it, became a target no step could ever hit.
 *
 * What the pass knows and this does not is where the element stands, and
 * position decides whether a row is printed rather than what it says: an
 * element inside a `label` that names a control, one that wraps a single
 * control and nothing else, or one the pass never reaches prints no row and
 * carries no ref, so no step can name it and no answer here is asked for.
 * @param el - the element to name.
 * @param options - the read's own options, for the injections it is computed under.
 * @returns the name, empty for an element a listing would print without one.
 */
export function itemName(el: Element, options: SnapshotOptions): string {
  const walk = newWalk(options, undefined)
  if (isSkipped(el, walk.isVisible)) return ''
  if (isOpaque(el)) {
    const drawn = roleOf(el)
    if (drawn !== null && rowRole(el, drawn)) return namedAs(el, drawn, walk).name
    if (namesIcon(el, walk)) return namedAs(el, ICON_ROLE, walk).name
    // A drawing the page made clickable is a row like any other click target:
    // a chart a click drills into is reachable, and named by what the page
    // wrote on it, because what is inside a drawing labels the picture.
    return topClickable(el, walk) ? namedAs(el, CLICKABLE_ROLE, walk).name : ''
  }
  const role = roleOf(el)
  if (isTableRole(role)) return tableName(el, headerPiece(el, walk, tableShape(el, walk)))
  const face = containerFace(el, role, walk)
  if (face !== undefined) return face.name
  if (role !== null && (ITEM_NODE_TYPES.has(role) || rowRole(el, role))) return namedAs(el, role, walk).name
  if (namesIcon(el, walk)) return namedAs(el, ICON_ROLE, walk).name
  if (!topClickable(el, walk)) return ''
  const items = topItems(childHost(el), walk)
  if (wrapsOnly(el, items, walk)) return ''
  return items.length > 0 ? clickableName(el, walk) : namedAs(el, CLICKABLE_ROLE, walk).name
}

/**
 * Walk the page once.
 * @param root - the root document.
 * @param options - the read's options.
 * @param scope - the element to read, or undefined for the whole page.
 * @returns every collected item, in document order.
 */
export function collect(root: Document, options: SnapshotOptions, scope: Element | undefined): Item[] {
  const walk = newWalk(options, scope)
  const place: Place = { container: undefined, depth: 0, buffer: [], labelled: false }
  if (scope === undefined) walkNodes(root.body, walk, place)
  else walkElement(scope, walk, place)
  flush(walk, place)
  return walk.items
}
