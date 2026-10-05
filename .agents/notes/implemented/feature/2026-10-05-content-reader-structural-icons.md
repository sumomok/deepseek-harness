# Agent Note: the page reader reads an icon a cell or an item draws by its structure

Status: implemented

English | [中文](2026-10-05-content-reader-structural-icons.zh.md)

## Problem

[The general-tools note](../simplification/2026-09-03-content-reader-general-tools-only.md) retired the icon rule that read the word `icon` out of a class token, and left the reader of `packages/experimental/content-frame/src/client/access/` printing nothing for an element that carries no role, no name, no text and no pointer cursor. That is how a console's operation column draws its row commands: measured on 2026-10-05, the edit, warning and delete commands of one list are three such `<i>` elements, so every row's command cell read as empty. The model had no ref to act on them with, and a tool that names what a user points at by copying this walk got the same key line for all three.

## Decision

Inside a table cell or a repeated item, an element drawn the way an icon is, is a control with the role `icon`. `isIconShape` in `dom.ts` is the whole test, and it reads structure alone: the element has no role, holds no element (an `svg` is one drawing, so what it holds counts as neither children nor text), holds no text once whitespace is taken out, and has a non-empty `rowMark`. The listing prints it as `e3 icon {class: el-icon-edit operation-modify}` with a ref of its own, and `content_act` reaches it through the same mark check and the same approval request as every other row the page names nothing.

### Where it counts

A table cell asks the test in `cellControlRole`, and the walk asks it through `marksIcon` wherever `heldByItem` finds a repeated item around the element: a `<tr>` whatever its role, an element whose role is `listitem`, `row`, `treeitem` or `option`, and an `article` inside a `feed` (`isRepeatedItem`). The search climbs through shadow roots and same-origin frames up to the document the read started from, so a read scoped inside an item agrees with the whole-page read. Anywhere else nothing changes: an icon in a toolbar prints no row unless the page makes it clickable.

The test runs before the cursor is asked about, so an icon under a pointer cursor is an `icon` rather than a `clickable`, and one column never prints two kinds of row for one kind of command. Three exceptions keep it from standing in front of something the page already says: what a `label` naming a control holds, and what a named tree node's label area holds, is part of that name; a drawing in a cell that holds a control offers that control instead; and a nameless icon inside the element holding a field prints on the field's row as `[eN opens]`.

### The mark of a sprite drawing

`rowMark` is `elementMark`, except that an `svg` carrying no class is marked by the symbol id its first `use` points at — what follows the `#` in its `href`, or in its `xlink:href` where it has no `href`. A sprite icon set writes its identity there and nowhere else. The listing prints `rowMark` and the seat checks a step's `mark` against it; the markup reads keep printing `elementMark`, because a line of markup says what the `class` attribute holds.

### Why this does not reopen the retired rule

The retired rule read the word `icon` inside a token and named the row after what followed it, which is the reader interpreting a vendor's spelling. This one reads no token for what it says: whether a class is present is a condition, as whether a cursor is a pointer is, and the tokens are printed whole and verbatim as the mark. The red line the general-tools note draws holds, and the class of rule it refuses permanently — one a page's markup earns rather than a specification — is not what this is: the conditions are the same on every page.

## Alternatives considered

**Leave the cell empty and send the model to the markup reads.** That costs a second read on every page that draws its commands this way, and the walk is what a pointing tool names elements by: an element the walk prints no row for cannot be told apart from its neighbours however the model finds it.

**Match a list of icon class prefixes** (`el-icon-`, `anticon`, `bi-`). The general-tools note rejected this as a catalogue of component libraries this package cannot keep current, and nothing about it has changed.

**Let the cursor decide**, printing `clickable` under a pointer and `icon` without one. The pointer moves with state — the disabled command, the selected tab — so the same command would print two kinds of row on two records, and a key line copied from one would not match the other.

**Accept only inline elements** (`i`, `span`, `svg`), which would leave out the empty `<div class="cell">` a library draws for an empty value. Not taken: the three conditions are the ones the anchors this walk feeds were specified with, and a list of tags is a guess of the same kind as a list of classes. The cost is recorded below.

**Take no mark from a sprite reference.** A sprite icon set writes its identity only in `use href`, so a class-less sprite icon would have no mark and be no icon. The symbol id is the page's own word, printed unread, which is what a class is.

**Read icons everywhere, not just in cells and items.** Every glyph a page header draws as decoration would print a row and spend the budget this read exists to protect; cells and items are where a page draws the commands that act on a record.

## Consequences

An operation column reads as its commands: three icons print three rows with three marks, the sample row says `[icon icon icon]`, a map counts them among the buttons, and a step can name each one by its ref and mark.

The rule reads structure, so it reads some decoration too. A library that wraps every cell in `<div class="cell">` draws an empty value as that wrapper holding nothing, which prints `icon {class: cell}`, and whether that cell prints an icon then depends on the record; the ini-web2 fixture in `tests/snapshot.client.spec.ts` shows it on the tick-box column. A tree table's indent and placeholder spans read the same way. A state icon whose class the page swaps by record carries a different mark on each row. A `title` names no icon, as it names no click target, and a sprite `svg` marked `aria-hidden="true"` is hidden like any other hidden subtree.

Every copy of this walk has to follow it, since the copy is held to name an element as the reader does.

## Testing

`tests/snapshot.client.spec.ts` pins the operation column, the cases outside a cell or an item, the elements holding words or an element, the elements carrying no class, the sprite marks, every kind of repeated item, the cursor, the `label` exemption, the drawing holding a link, the field opener, the scoped reads through a shadow root and a frame, and the empty wrapper. `tests/content-act-executor.client.spec.tsx` reads an operation column and clicks two of its icons by the refs and marks the read printed, and holds the one-name invariant over a named icon; `tests/content-act-tool.client.spec.ts` pins the approval request a step naming an icon by its mark raises. `apps/web/tests/content-read.e2e.ts` replays a recorded session whose fixture page draws an icon in its operation column, and the listed row carries it.
