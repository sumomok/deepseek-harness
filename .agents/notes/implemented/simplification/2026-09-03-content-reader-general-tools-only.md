# Agent Note: the page reader offers general tools and knows no application

Status: implemented

English | [中文](2026-09-03-content-reader-general-tools-only.zh.md)

## Problem

The reader in `packages/experimental/content-frame/src/client/access/` grew one rule for each shape a real console drew, and every one of them fixed a real failure on that console: a table pinned column by column read as six tables with the names dropped, a column of commands read as empty, a form of forty-nine boxes read as `textbox = ""` forty-nine times, a paged table read as twenty rows out of eighty-nine. The rules are recorded with those failures in [the reading rules note](../feature/2026-09-02-content-snapshot-engine.md).

Each of them is keyed to how one component library writes a page rather than to anything a specification defines: the word `icon` inside a class token, the word `pagination` inside a class or a label, a star a stylesheet draws in front of a label, tables drawn on top of each other with a row for each row, a `div` whose children are all buttons, a `ul` of three items or more. Each works on the console it was written against, and each is a guess everywhere else — and a wrong guess is silent, because the model cannot tell a column the page left empty from a column the reader dropped.

Three standing decisions answer what to do about that, and all three answer the same way. dsh offers general tools: a read, an act, and the semantics HTML and ARIA define, with business knowledge carried by the skills a user's own work produces. The code-vs-skill boundary puts mechanism in code and knowledge — how this application is built, what its icons mean, which of its tables the user sees as one — in a skill. And the repository forbids hardcoded tunables: `LIST_MIN = 3` and `TOOLBAR_MIN = 2` are numbers with no answer to "why three".

## Decision

Every rule keyed to a page's own spelling is retired. What the reader states is what HTML and ARIA state, and a listing that gets thinner because an application exposes no semantics stays thin: it prints what the document says and never fills the gap with a guess.

### The gate

- **Boundary.** Mechanism is this package's: walking documents and frames, numbering elements, budgets, the claim channel, approvals, the settle wait. Knowledge is a skill's: what a page's regions are for, which drawings are its commands, which of the tables it draws is the one a user sees.
- **Contract.** The name a listing prints for an element is the name the seat checks a step's `label` against, computed by one function ([`itemName`](../../../../packages/experimental/content-frame/src/client/access/collect.ts)); a ref names the same element for as long as the page holds it. Neither moves here.
- **Temptation.** "Add one rule for page X" is refused permanently. A rule that a page's markup rather than a specification has to earn is the class of rule this note retires.
- **Red line.** Code never interprets a vendor's class name. It may print one verbatim — see the hint below — and reads nothing out of it, forever.
- **Ceiling.** A page drawn by a component library costs more characters, up to about twice as many. Measured below, and accepted.
- **Assumption.** A page states what it means in HTML and ARIA. Where it does not, the listing is thinner and says only what the document says — fail-closed, never filled in.

### What retires

1. **The pinned-column table subsystem.** Every `<table>`, `grid`, and `treegrid` prints as the table the page wrote. Nothing is merged into a table the document does not have, no table is dropped as a copy of another, and no element is dropped for being drawn over another: `splitPartner`, `neighbourTable`, `repeatsTable`, `tablePieces`, `mergeCells`, `pickCells`, `duplicate`, `rectsMeet`, `rectsOverlap`, and the injected geometry (`rectOf`) are gone.
2. **Icon naming, and the idea that a drawing's place makes it a command.** `ICON_TOKEN`, `classIconWord`, `iconPart`, the `<use href>` symbol id, `isIcon`, `namesIcon`, and the `icon` role are gone. A drawing is read through the accessible name like anything else — a role the page wrote, `aria-label`, an `svg`'s own `title` — and an element the page marks clickable and names nowhere is a `clickable` row.
3. **The pager and the trail.** `PAGINATION_MARKER`, `BREADCRUMB_MARKER`, the separator regexp, the `pagination:` line, the `rows on this page` wording, and the read header's `breadcrumb` field are gone. Both widgets print as the runs of text the page drew them as. `role="navigation"` is a container like any other.
4. **The drawn required star.** `(required)` follows `required` and `aria-required` and nothing else; `REQUIRED_MARKS` and the injected `drawnAround` reading of `::before`/`::after` are gone.
5. **The message observer.** The `MutationObserver` that watched for text becoming readable, and the `message` event kind with it. What an act reports is what the browser did on the page's own account — dialogs, navigations, attempted windows — which no read can recover. What the page drew is in the closing read.
6. **The inferred containers.** `TOOLBAR_MIN` and `LIST_MIN` are gone: a toolbar is `role="toolbar"`, and a `ul`, an `ol`, or anything marked `list` or `feed` is a list however few items it holds.

### The one thing added

A row for something the page offers to act on and names nowhere prints the element's class tokens where the name would go: `e17 clickable {class: el-tooltip operation-modify el-icon-edit}`. At most four tokens, in the order the element carries them, an ellipsis where there are more, nothing at all where the element carries no class, and only for the roles in `OFFERED_ROLES` — a click target, a button, a link, a box to fill. Nothing is read out of them and the row is still named nothing: a step naming it passes `label: ""`, which the act wire now takes, and the seat holds the row to being named nothing still. What `el-icon-edit` means is a skill's to say.

## Alternatives considered

**Keep the icon rule until an adapter can hear a framework's click listeners.** That was the retirement condition the earlier note wrote, and it never arrives on its own: no adapter is planned, and the rule meanwhile taught the model a vocabulary (`icon "edit"`) that exists on one console. Retiring it now costs the 操作 column of that console and buys a reader whose every statement is one the document makes.

**Print the class tokens as the element's name.** Then the model could copy the hint into a step's `label` and the seat would check it — but the name would be markup rather than a name, `find` would match on it, and the one-name invariant would have the seat computing class tokens too. The hint is printed and never named.

**Keep a narrow list of vendor prefixes** (`el-`, `ant-`, `bi-`) so the reader could name icons for the libraries a deployment actually uses. That is the same guess with a longer table, and it makes this package the owner of a component-library catalogue it cannot keep current.

**Leave the numbers configurable** rather than retiring `LIST_MIN` and `TOOLBAR_MIN`. A `Config` field would satisfy the no-hardcoded-tunables rule and leave the deployment to answer "how many items make a list", which is not a deployment's question: HTML already answers it.

## Consequences

**A page drawn by a component library costs about twice as many characters.** Measured on the ini-web2 layer list as its markup is recorded in `tests/snapshot.client.spec.ts` — the real console's six tables, their pinned copies, and the strip under them — a whole-page read went from 524 characters over 6 lines to 1020 characters over 16. The rows and the columns are the same; what grew is that six tables print where one did.

**That console's command column reads as empty.** Its row commands carry no role, no name, no title, and no pointer cursor, so no row is printed for them: a reader who can see them has no ref to ask for. Where a page does mark such an element as something to click, the row carries the class tokens instead of a name and the model can act on it with an empty label.

**What a user sees as one table reaches the model as the tables the page built it from** — a frozen header, a body, and one copy per pinned column, each with the columns that piece draws and the others empty. Which pieces make up the table is a thing to know about the application.

**A pager's words print as text.** `20 rows` is the rows the page has drawn rather than the rows there are; `共 89 条` prints where the page draws it, and reading the total out of it is the model's work rather than the reader's.

**A form that marks its required fields with a drawn star reads as a form of optional fields**, and a control that draws its chips as a `ul` holds a region rather than a value — the row ends the descent, so those words print nowhere.

**A toast that came and went is in nothing.** An application that reports success only in a message that disappears reports it to nobody; the closing read shows what is still on the screen.

**An empty `label` is a label.** The act wire refuses a step with no label and takes `""`, which weakens the stale-read check for exactly the rows that carry no name: the seat can only hold them to being unnamed still.

## Testing

`tests/snapshot.client.spec.ts` pins every string the model can see, including the console table as six tables and the class hints verbatim; `tests/content-act-executor.client.spec.tsx` drives a step at a hinted row with an empty label through the seat, and holds the one-name invariant over a page carrying every way the reader names something. `src/client/access/**` is covered per file at 100%. The `content-read` and `content-act` snapshot recordings are stale against this change and are re-recorded outside it.
