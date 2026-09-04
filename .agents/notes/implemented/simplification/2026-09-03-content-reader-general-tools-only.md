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
- **Kept.** Three readings no specification defines survive, each with what retires it and each with one home, so that retiring one is one edit. A pointer cursor marks a click target ([`looksClickable`](../../../../packages/experimental/content-frame/src/client/access/dom.ts), which the seat injects into every read and `collect` also falls back to): CSS is how a page tells a user this is a thing to press, and it retires when a seat can hear a framework's own click listeners. The `label` a page draws in front of a field it ties to nothing names that field (`drawnBefore`): HTML says a `label` labels a field and leaves which one unsaid, and it retires the first time it is measured naming a field after words that are not its label, a wrong name being worse than none. A visible password box with a visible text, email, or untyped box beside it — inside the same form, or failing that the same region, or anywhere in a document that has neither — makes the page a sign-in page and the whole page unreadable ([`asksToSignIn`](../../../../packages/experimental/content-frame/src/client/access/snapshot.ts)): no specification lets a page say it is asking for credentials, and this reading fills nothing in — it refuses and stops — it stood as fail-closed credential protection until the seat could read the declarations a page does have for it, `autocomplete="username"` on the partner box and `current-password` on the password box. That reading is retired, and not by that condition: [the sign-in pages note](../feature/2026-09-04-sign-in-pages-are-read.md) supersedes it, deletes the page verdict outright, and leaves one credential rule — a password box's value never reaches the model.
- **Ceiling.** A page drawn by a component library costs more characters, up to about twice as many. Measured below, and accepted.
- **Assumption.** A page states what it means in HTML and ARIA. Where it does not, the listing is thinner and says only what the document says — fail-closed, never filled in.

### What retires

1. **The pinned-column table subsystem.** Every `<table>`, `grid`, and `treegrid` prints as the table the page wrote. Nothing is merged into a table the document does not have, no table is dropped as a copy of another, and no element is dropped for being drawn over another: `splitPartner`, `neighbourTable`, `repeatsTable`, `tablePieces`, `mergeCells`, `pickCells`, `duplicate`, `rectsMeet`, `rectsOverlap`, and the injected geometry (`rectOf`) are gone.
2. **Icon naming, and the idea that a drawing's place makes it a command.** `ICON_TOKEN`, `classIconWord`, `iconPart`, the `<use href>` symbol id, `isIcon`, `namesIcon`, and the `icon` role are gone. A drawing is read through the accessible name like anything else — a role the page wrote, `aria-label`, an `svg`'s own `title` — and an element the page marks clickable and names nowhere is a `clickable` row.
3. **The pager and the trail.** `PAGINATION_MARKER`, `BREADCRUMB_MARKER`, the separator regexp, the `pagination:` line, the `rows on this page` wording, and the read header's `breadcrumb` field are gone. Both widgets print as the runs of text the page drew them as. `role="navigation"` is a container like any other.
4. **The drawn required star.** `(required)` follows `required` and `aria-required` and nothing else; `REQUIRED_MARKS` and the injected `drawnAround` reading of `::before`/`::after` are gone.
5. **The message observer.** The `MutationObserver` that watched for text becoming readable, and the `message` event kind with it. What an act reports is what the browser did on the page's own account — dialogs, navigations, attempted windows — which no read can recover. What the page drew is in the closing read.
6. **The inferred containers.** `TOOLBAR_MIN` and `LIST_MIN` are gone: a toolbar is `role="toolbar"`, and a `ul`, an `ol`, or anything marked `list` or `feed` is a list however few items it holds.

7. **The length past which a label stopped naming a field.** `LABEL_LIMIT = 40` is gone. A `label` is the page naming that field, however long it runs; the number was this reader deciding what a name may say, and the field it dropped one for printed with no name at all.

### The one thing added

A row for something the page offers to act on and names nowhere prints the element's class tokens where the name would go: `e17 clickable {class: el-tooltip operation-modify el-icon-edit}` — every token, in the order the element carries them, nothing at all where the element carries no class, and only for the roles in `OFFERED_ROLES`: a click target, a button, a link, a box to fill. Nothing is read out of them and the row is still named nothing. What `el-icon-edit` means is a skill's to say.

That string is also how a step names the row. It is the row's **mark**: `label: ""` beside `mark` set to the tokens the read printed, computed by one function ([`elementMark`](../../../../packages/experimental/content-frame/src/client/access/dom.ts)) that the listing prints from and the seat recomputes and compares character for character — the one-name invariant in the shape a row with no name can hold. A step naming an unnamed row without a mark is refused, and so is a named row carrying one: a row has one identity, and checking it against whichever field the seat preferred would be two. Nothing is cut for the same reason a name is not: a shortened mark matches nothing. One brace on each side, because two is how the frameworks these consoles are written in spell an interpolation, and a row printing `{{class: ...}}` reads as a template nobody rendered.

## Alternatives considered

**Keep the icon rule until an adapter can hear a framework's click listeners.** That was the retirement condition the earlier note wrote, and it never arrives on its own: no adapter is planned, and the rule meanwhile taught the model a vocabulary (`icon "edit"`) that exists on one console. Retiring it now costs the 操作 column of that console and buys a reader whose every statement is one the document makes.

**Print the class tokens as the element's name.** Then the model could copy the hint into a step's `label` and the seat would check it — but the name would be markup rather than a name, `find` would match on it, and the one-name invariant would have the seat computing class tokens too. The hint is printed and never named.

**Keep a narrow list of vendor prefixes** (`el-`, `ant-`, `bi-`) so the reader could name icons for the libraries a deployment actually uses. That is the same guess with a longer table, and it makes this package the owner of a component-library catalogue it cannot keep current.

**Leave the numbers configurable** rather than retiring `LIST_MIN` and `TOOLBAR_MIN`. A `Config` field would satisfy the no-hardcoded-tunables rule and leave the deployment to answer "how many items make a list", which is not a deployment's question: HTML already answers it.

## Consequences

**A page drawn by a component library costs about twice as many characters.** Measured on the ini-web2 console itself on 2026-09-03, driving the build that retired those rules — before a mark printed every token and in one brace: a whole-page read of the layer list is 2507 characters, and the list reaches the model as six tables — `e28` through `e33`, a header half and a body half for the main piece and for each pinned copy. On the jsdom fixture that records that page's markup in `tests/snapshot.client.spec.ts`, the same change took a whole-page read from 524 characters over 6 lines to 1020 over 16. The rows and the columns are the same; what grew is that six tables print where one did.

**That console's command column reads as empty.** Measured in the same read: `e33`, the body pinned to the right, is where the 操作 column is drawn, and its twenty rows print with every cell empty. Those commands carry no role, no name, no title, and no pointer cursor, so no row is printed for them and a reader who can see them has no ref to ask for. What the page does mark reaches the model: the same read prints `e3 button {class: el-button el-tooltip head-btn el-button--text …}` for a command drawn as a button, which is a row a step can name. That read cut the tokens at four and spelled the mark in two braces, which is the whole of the difference from what this build prints.

**What a user sees as one table reaches the model as the tables the page built it from** — a frozen header, a body, and one copy per pinned column, each with the columns that piece draws and the others empty. Which pieces make up the table is a thing to know about the application.

**A pager's words print as text.** `20 rows` is the rows the page has drawn rather than the rows there are; `共 89 条` prints where the page draws it, and reading the total out of it is the model's work rather than the reader's.

**A form that marks its required fields with a drawn star reads as a form of optional fields**, and a control that draws its chips as a `ul` holds a region rather than a value — the row ends the descent, so those words print nowhere.

**A toast that came and went is in nothing.** An application that reports success only in a message that disappears reports it to nobody; the closing read shows what is still on the screen.

**A row the read named nothing is checked by its mark, and a mark is not an identity.** The seat holds such a row to carrying the same class tokens the read printed, which catches the page redrawing that position with something else — but a framework that reuses its DOM nodes leaves two rows of one column carrying the same tokens, and a re-render that swapped them passes this check exactly as two buttons both called `编辑` pass the name check. It is accepted while an act on such a row is a command the user approved by its mark: the trigger for checking the row's context as well is the first per-row action that destroys something.

## Testing

`tests/snapshot.client.spec.ts` pins every string the model can see, including the console table as six tables and the marks verbatim; `tests/content-act-executor.client.spec.tsx` drives a step at an unnamed row through the seat, refuses one whose mark the page changed under it, and holds the one-name invariant over a page carrying every way the reader names something. `src/client/access/**` is covered per file at 100%.

`apps/web/tests/content-read.e2e.ts` replays green against its committed recording, which this change does not invalidate. `apps/web/tests/content-act.e2e.ts` had no recording and is recorded in this PR: its fixture application draws one command as a bare class, and the test redraws that command while the user is deciding, so the recording carries the whole path — a step naming a row by its mark, the refusal of a mark the page changed, and the approval sentence that names an unnamed row by the mark rather than as 点「」. Record it with `DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-act.e2e.ts`.
