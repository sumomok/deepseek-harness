# Agent Note: the rules a structural page read is written by

Status: implemented

English | [中文](2026-09-02-content-snapshot-engine.zh.md)

## Problem

The page reader in `packages/experimental/content-frame/src/client/access/` walks a real application — drawn by a component library, in a browser, in front of a user — and answers with a few thousand characters the model reads instead of a screenshot. Two things make that hard, and neither of them shows in the code. Pages state what they mean in HTML and ARIA inconsistently: the same tree node is a link, an icon, a tick box, and a row of buttons depending on which library drew it. And every rule that leaves something out of a read is a rule that can leave out the one thing the model needed, with no way for the model to tell that it happened.

This note records the reading rules and why each one is the way round it is. Each of them decides against a defensible opposite, and most were found by pointing adversarial review at real component-library markup rather than by reasoning about the specifications.

## Decision

The walk knows HTML and ARIA, and nothing else: no library's class name, component name, or DOM shape appears anywhere in `src/client/access/`. A rule written in terms of one framework's markup is a rule that fails on the next one, and the framework a deployment renders in its content column is not this package's business. Every rule below is stated in terms a specification defines.

### Model-visible means readable

The invariant the rest bend to: a run of text a reader can see reaches the model. The rules that classify — this is a picture, this is decoration, this is the page's own wrapping — may move text from one row to another, may fold it into a name, and may drop what the browser never draws. None of them may drop what it does draw. Every round of review that found a rule dropping visible text treated it as a defect however defensible the classification was, because the model cannot ask about a run it was never shown.

### Only what the page wrote counts as a label

`declaredName` reads `aria-label` and `aria-labelledby` and stops there. It is deliberately not the accessible-name computation: that falls back to the element's own contents, which for a tree node means every button hanging off it. A label the page wrote is worth more than anything the element shows, because a menu item drawn as an icon says what it is nowhere else; an empty label, and one pointing at nothing, name nothing at all and leave the element to the ladder below.

A reference is resolved in the tree the element itself lives in, so an id inside an open shadow root names the element in that root rather than whatever the surrounding page gave the same id. A reference to the element itself, to what it holds, or to what holds it, is not a label: a browser degrades that to naming from content, and naming a node from its content is the reading the ladder exists to prevent. What each referenced element is *called* comes before what it *shows*, so a page pointing at an icon is answered with the icon's own label.

### The node-name ladder

A tree node or a menu item is named by its own label, and never by what hangs off it: the group under it prints rows of its own, and so do the buttons that act on it. The ladder is the page's own label, then the node's own text outside anything that prints a row, then the first row inside it that shows some text, and last everything but the group.

The third step passes over rows showing no text at all. Every tree a framework draws puts something wordless in front of the label — a folder icon, a tick box, an icon button — and stopping at the first row would fall through to the last step, which carries `删除` from the delete button into the node's name and then repeats it in the suffix of every row underneath. That single step is what makes real antd and element trees read correctly.

### A picture is one thing, and so is everything else a browser draws itself

`isOpaque` covers `svg`, `canvas`, `video`, `audio`, `object`, `progress`, `meter`, and `noscript`. What is written inside one of these is a part of the drawing or a fallback for an engine that cannot draw it, and no engine in use renders either. The walk does not descend into one, does not read its text, and counts no row inside it: a path is not a paragraph, the `title` a drawing carries is a tooltip the page never shows, and the words in a `progress` element are for a browser that has not existed for a decade.

A drawing the page named is a picture with a row of its own; an unnamed one is decoration, and decoration ends no run of text. A drawing the page itself made clickable keeps a row either way, because frameworks put the handler on the icon rather than around it, and a drawing with no row is a thing the model cannot reach at all. That row is named by what the page wrote on the drawing and by nothing else.

A bar reporting a quantity is the one opaque element that can still print a row: named, it prints its name and its value, because `aria-valuenow` on an empty `div` is the whole of what the page says about the upload. Unnamed, it reads as structure, because the percentage is drawn in the text beside it and a row carrying neither a name nor a number would stand in front of that text.

### Landmarks stop at the page, and roles stop at what ARIA defines

A run the page makes clickable that reaches a region the page is laid out in is not a thing to click: the pointer cursor was inherited from something above it. Only `main` and `nav` are matched by tag, because HTML gives those two their role wherever they are drawn, while `header` and `footer` are a banner and a page footer only at the top level and are the head and foot of a card everywhere else. A page that means one of those two inside a card writes the role, and writing it is what makes it a landmark here. A form and a dialog are left out altogether: a card holds an inline editor or a confirmation readily, and is still the thing the page offers to click.

A role the page wrote is a role only when ARIA defines it, and the tokens are read in order so a document written against a newer vocabulary falls back to an older one. Printing an undefined word would put text the page controls where the model reads the kind of a row. Every selector in the package matches a token, `[role~="x"]`, for the same reason: a selector that missed the fallback would let one part of the read see a table where another part saw a paragraph.

Two consequences follow from reading the attribute differently from `dom-accessibility-api`, which reads the first word alone. Where the walk resolves a role the library did not, an empty computed name says only that the library's role is not named by its contents, so the row is named by the text the element shows — for the roles ARIA names from their contents, and only those. And the presentational conflict resolution stays the library's: an element the page marks as decoration while still labelling it is read as what it offers, because the page has written two things that contradict each other and ARIA settles it in favour of the control.

### A control's state is what the page said, and no more

A box the browser keeps the state of is read from the browser, and what ARIA says over the top of a native checkbox is ignored, as a browser ignores it. Anything else the page draws as one has the state it wrote — and no state at all until it writes one, since ARIA requires the attribute on these roles. A reader told "off" clicks to turn on what is already on. A box reported as half checked has no state of the two either: that is the box at the head of a table with some of its rows picked, and a reader told it is off clicks it and picks every row of the page.

### Structure reaches the model, data does not

A table is collected as its shape — header, one sample row, a row count — and its rows arrive only when a read asks for that table by ref or finds a row by its text. The sample says which controls a column offers rather than what it says, so each cell is cut to the room the sample line gives it: the text gives way to the controls first, and the list of controls is itself cut inside its brackets, because a row of buttons each named a sentence would otherwise spend the whole line on one column. A password box reports that it is there and never what it holds.

### Never a blind cut

A whole page too large for the budget comes back as a skeleton of its regions and where to read next; a listing too large comes back with a cursor to continue from. A read never answers with half a list and no way to reach the rest, and a listing cut short backs off the trailing rows the model cannot name so a continuation covers the listing exactly once.

### Layout is injected

jsdom lays nothing out, and a frame's layout belongs to the frame, so visibility and geometry arrive as `isVisible` and `rectOf` and reach the DOM only through the caller. Every conclusion this package's tests reach about what a reader can see is therefore conditional on the implementation the page seat injects.

## Alternatives considered

**Naming every row with the accessible-name computation.** It is the specification, it is implemented for us, and it is what a screen reader would say. Rejected for the rows where "what a screen reader says" is the wrong answer: a tree node's computed name is its whole subtree, which puts the delete button's text in the node's name and then in the suffix of every row under it. The computation still names everything else, and the ladder is confined to the roles where content-naming is wrong.

**Reading a drawing's `title` and `text` as page text.** It is text, and a chart legend genuinely says something. Rejected because a `title` is a tooltip the page never draws and the words in a chart are labels of a picture: reading them broke the run of text around every icon and printed tooltips as if a reader could see them. The cost is recorded under the limits below.

**Keeping `role="presentation"` as written, without the conflict resolution.** Simpler, and one fewer call into the library. Rejected because it deleted labelled buttons and text boxes from the read entirely — an element carrying a name is an element the page contradicted itself about, and ARIA, every browser, and the library all resolve it the same way.

**Printing `mixed` as a third state.** Honest, and it costs one more token in the row. Rejected for now because every reader of the row would have to be taught the third word, while saying nothing already means "look at it": the model asks about the box rather than acting on a state it was told wrongly.

**Cutting the sample line after assembling it.** One cut instead of two, at the place where the line is printed. Rejected because it cuts the controls off the end of a cell whose text runs long, and the column then reads as one offering nothing to do.

**Letting any labelled click target print its own row.** The rule that a name the page wrote makes the target a thing of its own is what keeps a labelled card from being read through. Rejected in the one case where the label repeats what the single control inside says: that is one thing said twice, and two rows for it would have the model choosing which of them to click.

**Teaching the walk about component libraries.** Every defect in six rounds of review was found in antd, element, or bootstrap markup, and matching their class names would have fixed each one in a line. Rejected because the reader runs against whatever a deployment renders, and a rule keyed to a class name is a rule that silently stops working when the page ships a new version of its own dependency.

## Consequences

The reader answers with the structure of a page rather than its contents, under a budget it never spends blindly, and stays correct against the markup four component libraries actually emit. What it gives up is recorded here rather than discovered in the field.

Nothing inside a drawing is readable: a chart's slices, its legend, and the links it draws are unreachable, and a page whose data lives only in an SVG reads as a heading and nothing else. A control drawn as an icon needs `aria-label` to be named at all, which is what accessibility requires of the page anyway. An element pointed at by `aria-labelledby` that carries no name of its own and no text — a `span` wrapping an `img` — contributes nothing to the name. `role="none"` does not get the presentational conflict resolution its synonym `presentation` gets, because the library implements it for one spelling. And `meter` carries a tag-to-role mapping of this package's own, because the library maps every other bar and not that one.

## Testing

`tests/snapshot.client.spec.ts` pins every string the model can see, word for word, over fixtures written as the four libraries draw them; `src/client/access/**` is covered per file at 100%. Conclusions that depend on what a reader can see hold in jsdom with an injected `isVisible`, and are conditional on the browser implementation until a real page is read in one.
