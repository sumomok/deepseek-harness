# Agent Note: three reads of the page as it was written

Status: implemented

English | [中文](2026-09-03-content-markup-reads.zh.md)

## Problem

[The reader offers general tools](../simplification/2026-09-03-content-reader-general-tools-only.md) retired every rule keyed to how one component library writes a page, and measured what that costs on a real console: the 操作 column of that console's layer list prints twenty rows with every cell empty. Those commands carry no role, no name, no title and no pointer cursor, so nothing a specification defines is written on them, and the read that states only what the document states has nothing to say about them.

The user sees two icons in that column. The model sees an empty column and no ref to point at. The retirement note accepted that on the ground that what those icons mean is a skill's to know — but a skill can only say what an element is if something reaches it that identifies the element, and `content_read` reaches it with nothing at all: no row, no ref, no tokens. The knowledge has nowhere to attach.

`content_read` also cuts every run of text it prints at 200 characters, so a notice, a message or a cell longer than that reaches the model ending in an ellipsis with no way to ask for the rest.

## Decision

Three more reads, all read-only, all on the channel `content_read` already uses.

- **`content_read_dom`** — `scope` required (a ref from any previous read), `after` optional. Prints that element and every element inside it, one per line and indented by nesting: the ref, the tag, the `#id`, the class tokens as `{class: …}`, and the start of the text the element holds directly. Rendered under `outlineChars` and cut with a cursor, exactly as a listing is.
- **`content_read_attrs`** — `ref` required. Prints every attribute of that element, name and value as the page wrote them, and nothing else.
- **`content_read_dom_content`** — `ref` required. Prints that element's whole visible text with a line break wherever the page breaks the line and nothing the page hides, never cut.

`content_read` is not retired and is repositioned instead: it is the page as HTML and ARIA describe it and stays the read a page starts from. Its description said so and named the two reads that print a row's markup where its class tokens are not enough; [the self-contained-copy note](2026-09-04-self-contained-tool-copy.md) removed both, because a description that positions its siblings misrouted the model on a real console. The two inferences it still makes — a pointer cursor marks a click target, and a `label` drawn in front of a field names it — keep the retirement conditions [the retirement note](../simplification/2026-09-03-content-reader-general-tools-only.md) gave them.

All four answer what a page is written as. What a page *draws* — a QR code, a captcha, a chart in a `canvas` — is answered by a fifth read on the same channel: [one picture as pixels the model looks at](2026-09-04-content-read-image.md).

### The gate

- **New surface.** Three tools, three wire request kinds, one widened `ReadSnapshot.kind`, three output formats, three descriptions. Zero `Config` fields: the budget, the deadlines and the claim window are `content_read`'s and are shared unchanged.
- **Boundary.** Mechanism is this package's — walking a subtree, printing an attribute, breaking a line of text, numbering elements, the budget and the cursor. Knowledge is a skill's: what `el-icon-edit` is, which of a page's tables the user sees as one, what `data-op="edit"` does. The three reads carry raw material to the place a skill can attach to it, and read nothing out of it.
- **Contract.** A ref names the same element for as long as the page holds it, whichever read minted it; the class tokens a tree line prints are the same [`elementMark`](../../../../packages/experimental/content-frame/src/client/access/dom.ts) the listing prints for an unnamed row and the seat recomputes for a step's `mark`, so a row a tree found is a row `content_act` can act on. One home for each: [`markup.ts`](../../../../packages/experimental/content-frame/src/client/access/markup.ts) prints, [`read-value.ts`](../../../../packages/experimental/content-frame/src/access/read-value.ts) holds the waiting and the four endings every read shares, and `snapshot.ts` holds the header, the ref lookup and the assembly all four use.
- **Temptation.** Using `content_read_dom` as the ordinary way to read a page. A whole page of markup is an order of magnitude larger than its listing, and a model shown a way to see the real thing reaches for it first. One thing refuses it: `scope` is required, so a listing has to have run. The description said outright not to, and `content_read`'s said it was the read to start from, until [the self-contained-copy note](2026-09-04-self-contained-tool-copy.md) held every description to its own tool.
- **Red line.** Code never interprets a class name or an attribute. It prints them. There is no mode, no attribute allow-list, no filter and no depth parameter — v0 is the smallest thing that carries the page's own spelling to a skill. What a password control holds is withheld by all three and printed as `(password withheld)`: the attribute read withholds `value`, and the tree and whole-text reads withhold the text a `textarea` declaring a password in `autocomplete` keeps its value in. A control counts as one by its `type` or by that attribute, on any of the three tags HTML gives an autofill field name to; that rule lives in [`isPassword`](../../../../packages/experimental/content-frame/src/client/access/dom.ts) and the listing's own control state reads it too. What the listing does with a `textarea`'s value elsewhere is that read's path and is untouched here. The element a whole-text read names is held to the same rules its descendants are — what the page hides, what carries `aria-hidden`, and what a browser draws itself all read as no text — so the read cannot answer with what its own walk would have passed over.
- **Ceiling.** The tree is bounded by `outlineChars` and continues from a cursor. The other two are answered whole or refused: an element's attributes and an element's text are not truncated, and an answer past what the report route carries — `outlineChars × 4` characters, or the byte bound the envelope leaves — is refused with its size in characters and the budget it ran past; [the self-contained-copy note](2026-09-04-self-contained-tool-copy.md) took the remedy each of those refusals used to name out of them. Where the text read breaks a line is bounded the same way: the break follows this package's inline set — phrasing content less what a browser draws itself and less what a user operates — so `del`, `ins`, `button`, `input`, `output`, `select` and `slot` break a line where a browser would have kept one. The set is the listing's as well and is not re-cut for this read.
- **Assumption.** A skill exists, or a model can write one, that turns `{class: el-tooltip operation-modify el-icon-edit}` into "this is the edit command of this row". Without that the three reads are raw material and nothing more. That is the assumption the [code-vs-skill boundary](../simplification/2026-09-03-content-reader-general-tools-only.md) rests on, and it is why this slice adds no page knowledge of its own.

### What the answers look like

A tree line is `<indent><ref> <tag>[#id][ {class: …}][ "text"]`, with `(text cut)` where the text ran past the line's own 80-character allowance — the marker named the whole-text read until [the self-contained-copy note](2026-09-04-self-contained-tool-copy.md), and the line already opens with the ref. An attribute line is `<name>=<value>` with the value quoted the way JSON quotes a string, so an attribute holding a quote or a line break is still one line and still says what the page wrote. Both open with the shorter header `Page: <title> — the app is at <path>`: what the document calls itself, what dialog it has open and what it marks as still loading are questions about the page, and `content_read` is the read that answers them.

## Alternatives considered

**A `mode` on `content_read`.** The owner's ruling, and the right one: a mode makes the raw read a variant of the semantic one, so every refusal, every parameter line and every header field has to answer for both, and a model choosing `mode` has to be told the same positioning the descriptions now carry anyway. Three tools cost three descriptions and buy three parameter lists that each say exactly what that read takes.

**Truncating a long text instead of refusing it.** A tool that promises the whole text and quietly returns part of it is worse than one that says it cannot: the model has no way to tell a complete answer from a cut one, and the skill it writes from a cut answer is wrong in a way nothing surfaces. The refusal names the size.

**An attribute allow-list, or a filter on the tree.** Both are this package deciding what a page's markup is worth reading, which is the decision the retirement note removed from it. A deployment that finds the answers too large raises `outlineChars`, which is a number it already owns.

**Registering the `content_read` transcript row for the three tools.** The row says "Looked at 「X」", which is true of all four. It was left alone: the row is keyed by tool name in a generated client-slot catalogue, and the tools' own `presentCall`/`presentResult` already give the generic card a title — the first line of what the model was told, which names the page. A raw read's answer is not a page listing, and a row saying it was is worse than a card saying what it is.

## Consequences

**A model can now reach a row nothing a specification defines describes.** `content_read` prints the column empty, `content_read_dom` on the row's ref prints `i {class: op op-a}`, and `content_read_attrs` on that element prints `data-op="edit"`. Nothing in this package turns `op-a` into "edit"; what does is the answer the model writes and the skill it writes afterwards.

**A whole-page markup read is available and is the one way to spend a budget badly.** The three refusals above are what stand against it, and none of them is a mechanism: a model that scopes to `body` gets a tree of the whole page at the deployment's budget with a cursor for the rest. What bounds the damage is that it costs one read and returns a cursor rather than silently returning half a page.

**A tree prints what the listing hides.** Visibility is the listing's filter and deliberately not the tree's, so a page with a large hidden subtree spends budget on it. That is the point — a row the listing dropped for being invisible is what a reader comes to the tree for — and the cursor is the only thing bounding it.

**`content_read_dom_content` breaks lines the way markup reads rather than the way a page is drawn.** The seat answers for documents in a DOM implementation without layout, so a line ends where the element is not an inline one and at a `<br>`. A page that makes a `span` a block, or a `div` inline, is broken by its markup and not by its stylesheet.

**The wire carries five kinds now.** `ReadSnapshot.kind` is `outline | map | dom | attrs | content`, one document for five tools over one route and one claim, and each tool refuses an answer that came back under another read's kind with the sentence a misreport already earned. The `contentAccess` projection's `stateVersion` moves to 3, so a checkpoint written by a build that did not know these calls is refolded rather than trusted.

**A markup read costs what it asked for.** A tree of one table body on the console this line is written against is a line per `tr`, `td` and `i`; an attribute read is one element. Neither is a fixed cost per request — the descriptions are, at three fixed strings and four parameter lines.

## Testing

`tests/markup.client.spec.ts` pins every string the three reads produce — the tree line, the cut marker, the attribute line and its JSON quoting, the withheld password value, the lines of text and the two empty answers — plus the budget cut, the cursor, the continuation, and the refusal of a cursor that is not a row of that tree. `tests/content-markup-tool.client.spec.ts` pins the three descriptions and parameter lists verbatim against the real tool runtime and drives every ending each tool can reach. `tests/content-read-executor.client.spec.tsx` drives all three through the seat against real documents in real frames, including the three "too wide for the wire" refusals. `src/` is covered per file at 100%, and the coupling audit — no code path reading a vendor's class prefix — finds nothing outside one comment naming what is deliberately not recognized.

Four Web scenarios back it, all under `snapshots/web/`: `content-read` and `content-act` move there from `apps/web/tests/snapshots/`, and `content-read-dom` and `content-read-attrs` join them against a new fixture application, `tests/fixtures/markup-app`, whose Operations column is drawn as bare elements with a class and a `data-op` and nothing else — the shape that makes the column read as empty in a real browser, which no jsdom fixture can produce. All four share the corpus composition `web-content` and its one header class, pinned by `content-read`. Record them with a key:

```sh
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read.e2e.ts
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-act.e2e.ts
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-dom.e2e.ts
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-attrs.e2e.ts
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read.e2e.ts \
  apps/web/tests/content-act.e2e.ts apps/web/tests/content-read-dom.e2e.ts apps/web/tests/content-read-attrs.e2e.ts
```

The last one is keyless and is not optional for any of the four: a recording carries what the live provider resolved — the request's `maxTokens` and reasoning effort, and one `request/context` event — which a replayed run never produces, so the refresh normalizes each fixture to what a replay persists and writes the two sidecars the pinned header owns. What the model said is untouched by it: the prompts, the tool calls, the results and the answers are the recording's.

Bringing the four in took one change to the Web scaffold. A manifest beside a `session.jsonl` turns on the persisted-log comparison, and all four seed a round into the session they then drive — which `recordFixture`'s `afterSeed` trim drops from the recording, because a replay fixture carrying a seeded round would answer the live run's first model call with a reply from a turn it never made. `assertReplaySession` now cuts the live log at that same `session/end-seed` boundary before it matches a fixture to a session, compares the two, or reads the header pin, and refresh writes back through the same trim. A scenario that seeds nothing has no boundary to cut at and is compared whole, as it was.

This is what ends the deviation [the fixtures-outside-the-corpus note](../testing/2026-09-03-content-access-fixtures-outside-the-corpus.md) recorded.
