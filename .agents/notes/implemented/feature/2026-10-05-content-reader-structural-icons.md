# Agent Note: the page reader reads an icon a cell or an item draws by its structure

Status: implemented

English | [中文](2026-10-05-content-reader-structural-icons.zh.md)

## Problem

[The general-tools note](../simplification/2026-09-03-content-reader-general-tools-only.md) retired the icon rule that read the word `icon` out of a class token, and left the reader of `packages/experimental/content-frame/src/client/access/` printing nothing for an element that carries no role, no name, no text and no pointer cursor. That is how a console's operation column draws its row commands: measured on 2026-10-05, the edit, warning and delete commands of one list are three such `<i>` elements, so every row's command cell read as empty. The model had no ref to act on them with, and a tool that names what a user points at by copying this walk got the same key line for all three.

## Decision

Inside a table cell or a repeated item, an element drawn the way an icon is, is a control with the role `icon`. `isIconShape` in `dom.ts` is the whole test, and it reads structure and rendering: the element has no role, holds no element (an `svg` is one drawing, so what it holds counts as neither children nor text), holds no text once whitespace is taken out, has a non-empty `rowMark`, and draws a picture (below). The listing prints it as `e3 icon {class: el-icon-edit operation-modify}` with a ref of its own, and `content_act` reaches it through the same mark check and the same approval request as every other row the page names nothing.

### Where it counts

A table cell asks the test in `cellControlRole`, and the walk asks it through `marksIcon` wherever `heldByItem` finds a repeated item around the element: a `<tr>` whatever its role, an element whose role is `listitem`, `row`, `treeitem` or `option`, and an `article` inside a `feed` (`isRepeatedItem`). The search climbs through shadow roots and same-origin frames up to the document the read started from, so a read scoped inside an item agrees with the whole-page read. Anywhere else nothing changes: an icon in a toolbar prints no row unless the page makes it clickable, and `itemName`, the one name a step is held to, calls it nothing, so a step reaching it through a markup read passes an empty label. `itemName` takes the document the read started from for the same search, which a single-element caller has to pass in.

The test runs before the cursor is asked about, so an icon under a pointer cursor is an `icon` rather than a `clickable`, and one column never prints two kinds of row for one kind of command. Three exceptions keep it from standing in front of something the page already says: what a `label` naming a control holds, and what a named tree node's label area holds, is part of that name; a drawing in a cell that holds a control offers that control instead; and a nameless icon inside the element holding a field prints on the field's row as `[eN opens]`.

### Drawing a picture

A leaf draws a picture when it is an `svg` or an `img`, when its `::before` or `::after` generates content — a computed `content` other than `none`, `normal` and `""` — or when its own `background-image`, `mask-image` or `-webkit-mask-image` is something other than `none`. That covers the three ways a component library draws an icon: a glyph an icon font writes into a pseudo-element, an image painted as a background or through a mask, and a drawing. The empty value a library draws as `<div class="cell"></div>`, the indent and placeholder spans a tree table puts in front of a row's text, and a leaf painting a colour alone draw none of these. The element's own properties are read before its two pseudo-elements, and an engine that computes no value for a property answers the empty string, which counts as nothing drawn.

The computed style comes through the read's `computedStyle` injection, defaulted beside `isClickable` to the `getComputedStyle` of the window the element is drawn in, so a test runner without pseudo-element styles injects them and a copy of this walk injects the same reader. The walk looks for the repeated item around an element before it asks the element's style, so a leaf outside every cell and item is never asked. The test keeps the no-role condition first: HTML gives every `img` the role `img`, or `presentation` for an empty `alt`, and it is read by that role, so an `img` reaches the test only where the page wrote a role ARIA does not define, and then it draws a picture by being an `img`.

### The mark of a sprite drawing

`rowMark` is `elementMark`, except that an `svg` whose first `use` points at a symbol is marked by its class tokens followed by that symbol id, one space between them — the id is what follows the `#` in the `use`'s `href`, or in its `xlink:href` where it has no `href`, whatever path or host stands in front of it. An id the class already holds as a whole token is not added again, so an `svg` carrying no class is marked by the id alone. A sprite icon set draws every command with the same class and writes which command it is only in the reference: `<svg class="svg-icon"><use href="#icon-edit">` is marked `svg-icon icon-edit`, and its neighbour pointing at `#icon-delete` is marked `svg-icon icon-delete`. The listing prints `rowMark` and the seat checks a step's `mark` against it; the markup reads keep printing `elementMark`, because a line of markup says what the `class` attribute holds.

### Why this does not reopen the retired rule

The retired rule read the word `icon` inside a token and named the row after what followed it, which is the reader interpreting a vendor's spelling. This one reads no token for what it says: whether a class is present is a condition, as whether a cursor is a pointer is, whether a leaf draws a picture is read from its computed style, as whether it is visible is, and the tokens are printed whole and verbatim as the mark. The red line the general-tools note draws holds, and the class of rule it refuses permanently — one a page's markup earns rather than a specification — is not what this is: the conditions are the same on every page.

## Alternatives considered

**Leave the cell empty and send the model to the markup reads.** That costs a second read on every page that draws its commands this way, and the walk is what a pointing tool names elements by: an element the walk prints no row for cannot be told apart from its neighbours however the model finds it.

**Match a list of icon class prefixes** (`el-icon-`, `anticon`, `bi-`). The general-tools note rejected this as a catalogue of component libraries this package cannot keep current, and nothing about it has changed.

**Let the cursor decide**, printing `clickable` under a pointer and `icon` without one. The pointer moves with state — the disabled command, the selected tab — so the same command would print two kinds of row on two records, and a key line copied from one would not match the other.

**Accept only inline elements** (`i`, `span`, `svg`), which would leave out the empty `<div class="cell">` a library draws for an empty value. Not taken: a list of tags is a guess of the same kind as a list of classes, and a tree table's indent is a `span` all the same. Whether the leaf draws a picture leaves out both.

**Read structure alone**, with no drawing condition. The empty value cell and a tree table's indent and placeholder have the structure of an icon, so a cell printed an icon or nothing depending on the record, and the key line a pointing tool copies from this walk changed with it. The product's first review of the anchors found it on 2026-10-05; reading the rendering is what tells a glyph from an empty wrapper without a class list.

**Take no mark from a sprite reference.** A sprite icon set writes its identity only in `use href`, so a class-less sprite icon would have no mark and be no icon. The symbol id is the page's own word, printed unread, which is what a class is.

**Mark a sprite drawing that carries a class by its class alone.** Every command a sprite sheet draws carries the same class, so the edit and the delete icon of one cell would print one mark and a step could not tell them apart.

**Read icons everywhere, not just in cells and items.** Every glyph a page header draws as decoration would print a row and spend the budget this read exists to protect; cells and items are where a page draws the commands that act on a record.

## Consequences

An operation column reads as its commands: three icons print three rows with three marks, the sample row says `[icon icon icon]`, a map counts them among the buttons, and a step can name each one by its ref and mark.

The rule reads rendering, so a leaf that paints only a colour is no icon: the empty value a library draws as `<div class="cell">` reads as nothing on every record, as the ini-web2 fixture in `tests/snapshot.client.spec.ts` shows on the tick-box column, and so do a tree table's indent and placeholder spans and a command drawn as a coloured square with no glyph or image. Two icons are not read: one whose glyph the page writes into the pseudo-element of the element around the leaf, which holds an element while the leaf draws nothing, and one whose stylesheet has not applied when the read runs. A state icon whose class the page swaps by record carries a different mark on each row. A `title` names no icon, as it names no click target, and a sprite `svg` marked `aria-hidden="true"` is hidden like any other hidden subtree. A `content_read_dom` line prints a sprite drawing's class without its symbol id, so a step carrying that line's tokens for the drawing is refused as naming a page that changed.

Every copy of this walk has to follow it, the computed-style injection included, since the copy is held to name an element as the reader does.

## Testing

`tests/snapshot.client.spec.ts` pins the operation column, the cases outside a cell or an item, the elements holding words or an element, the elements carrying no class, the sprite marks with and without a class, every kind of repeated item — a layout table's row and a read scoped inside an option included — the cursor, the `label` exemption, the drawing holding a link, the field opener, the scoped reads through a shadow root and a frame, the name a step is held to outside a cell or an item and across a frame, and what a leaf is read to draw: a glyph in `::before` or `::after`, a background image or a mask, a colour alone, generated content that is `none`, `normal` or empty, the empty value cell and a tree table's indent beside an icon, an `svg` and an `img` read without their style, and the window's own computed style where the read injects none. `tests/content-act-executor.client.spec.tsx` reads an operation column and clicks two of its icons by the refs and marks the read printed, clicks one of two sprite icons sharing a class by the mark that carries its symbol, clicks a toolbar icon by an empty label and its class tokens and an icon an item holds across a frame by its name, and holds the one-name invariant over a named icon; `tests/content-act-tool.client.spec.ts` pins the approval request a step naming an icon by its mark raises. `apps/web/tests/content-read.e2e.ts` replays a recorded session whose fixture page draws an icon in its operation column, and the listed row carries it.
