# Agent Note: the table decides its own columns, and an empty answer says so

Status: implemented

English | [中文](2026-09-07-data-source-default-columns.zh.md)

## Problem

The [data-source seam](../architecture/2026-09-06-content-component-library-v2c-data-source.md) let a model fill a `toy.table` block from the deployment's own backend. Driving it against the real deployment produced two failures that lane could not have shown, because both need a live model and a live backend at once.

**A model asked to draw a table guesses attribute names, and one kind of guess never fails.** The first call names attributes the table does not have and is refused, and the refusal lists the real ones, so the second call succeeds — that loop works. What the loop cannot correct is the other guess: on `SpaceLayer` the model picked `layer_en_name` and `layer_type`, which exist and are empty in every row. The read succeeds, the table draws one column of data and two of blanks, and the model tells the user it drew three columns of data. Nothing anywhere says otherwise: the refusal path never fires, the result line counts rows and names attributes, and neither the model nor the user is told that two of the three columns came back empty.

**A read whose conditions matched nothing was reported as a broken data source.** Measured against the real deployment: a `_search` that matches no row answers HTTP 200 with `{ code: 0, msg: 'success', data: { rawValue: null, displayValue: null, page: { total: null, … } } }` — both row lists null, not two empty lists. `readSearchData` required both to be arrays, so the seam classified that answer as `unreachable` with the detail `the answer carried no rows to read`, and the model read "the data source could not be reached" for what was an ordinary empty result. The model's next move is to retry or to tell the user the system is down; neither is the truth, which is that its filter matched nothing.

A third gap sits behind the first: `page` named a size and not a number, so a model that wanted rows a first page did not reach had only "narrow the conditions" and no way to page.

## Decision

**Leaving `tableConfig.gridItems` out is how a call says "use this table's own columns".** `tableConfig` itself may go with it. The columns then come from the table's default query scheme — the stored scheme this deployment's own resource list opens that model with — read through the new `bizBackend.describeScheme(meta, signal)`. Columns the scheme hides are dropped, an attribute the scheme lists twice keeps its first entry, and the rest keep the scheme's order, its headers, and its sortable flag. Everything downstream is unchanged: the same dictionary check, the same read, the same `content-component/resolved`.

**It is a tool default rather than a step a skill teaches, because the failure it removes is one the model cannot see.** A guessed attribute name that does not exist costs one refusal and is then corrected by the refusal's own list — a loop that already works and that a skill would only shorten. A guessed attribute that exists and is empty produces a successful call, a drawn table, and a confident sentence to the user; there is no signal for a skill to hang a correction on. The only party that knows which columns that table is worth drawing is the deployment, in the scheme it already stores for exactly that purpose. A default reaches every model on every call, including the calls where nobody thought to load a skill.

**Nothing is requested of the backend before the user answers, the scheme included.** The card therefore says that the read takes the table's own default columns and names none of them — `取这张表默认显示的列` — because which columns those are is what the unread scheme decides. Which side chose them is the part of this read the model did not choose, and it is what a person is entitled to know before answering; the names themselves cost a credentialed request, and the credential is the thing being asked for. The scheme is read where the dictionary is read: after the answer, before the rows.

**A scheme that leaves this table undrawable refuses the call and names the parameter to send instead**, in this tool's own vocabulary: `Send tableConfig.gridItems on that block, naming the attributes to read.` It names no other tool, because which tool would help is the model's judgement and not this refusal's. Four things end a call there — the table has no default scheme, the scheme request itself failed, the scheme draws a column from an attribute the table's dictionary does not list, and the scheme shows more columns than a table draws — and each sentence says which one happened, in words naming the scheme. None of them says the call named anything, because the call named no column: a sentence about a wrong column would be about something the model never wrote. The last two are refused before a row is asked for, since rows nobody could draw are a person's data spent for nothing. A failure that is about the credential rather than about the table (`unauthenticated`, `refused`, `rejected`) keeps its own sentence.

**Both row lists explicitly null is zero rows.** `search` answers `{ rawValue: [], displayValue: [], total: 0 }` for that envelope, the one this backend was measured giving a read that matched nothing. `unreachable` is kept for a payload that is not an object, for one whose row lists are present and are not lists of row objects, and for one carrying neither row list at all — the cases that really are answers this seam cannot read, an envelope nobody has seen this backend send included. The tool's behaviour above it is untouched: zero rows is still `"<table>" returned no rows for those conditions, so there is nothing to draw`, which is the sentence a model can act on.

**The result line adds the page read and the attributes that came back empty.** The page is a sentence of its own after the attribute list — ` Page 3 of 5.` where the backend reported a total, ` Page 3.` where it did not — because inside that list it reads as one more attribute. Then ` No value in any read row: layer_en_name, layer_type.` where any attribute the read asked for carried no value in any row that arrived. Where every attribute had a value somewhere, nothing extra is said — a clause that appears every time is a clause a model stops reading. The empty columns are named rather than dropped from the table: dropping them would change what the user approved, after they approved it.

**`page` gains `currentPage`**, a whole number of 1 or more, defaulting to 1 beside the existing `pageSize`. The result line naming the page is what makes it usable — a model that cannot tell which page it read cannot ask for the next one.

**The session-log payload is unchanged.** `content-component/resolved`'s `fetched` entries still carry `nodeId`, `meta`, `rows`, `total` and `columns`. The page and the empty attributes are read back out of what is already recorded — the spec carries the rows, the block carries the columns — so recording them would be a second copy of a derived fact in a durable format, and `SESSION_FORMAT_VERSION` stays where it is.

### Gate table — the table's own columns, and an empty answer

| Cell | Content |
|---|---|
| **0 — which settled principle already said no** | "A tool's UI render intent is part of its design" is why the scheme's `isSortable` reaches the drawn column rather than being discarded. "Explicit > implicit at package boundaries" kept the scheme's normalization inside `biz-backend` — `'0'`/`'1'` and booleans both become a `boolean | undefined` there — instead of leaving each consumer to read the flags its own way. "Model-visible ⟺ logged" is why the page and the empty attributes are derived from the recorded spec rather than added to it. "Trust TypeScript at typed same-process boundaries" is why `settleDefaultColumns` validates the scheme's own strings — that is a network boundary, and an attribute name written into a drawn table. |
| **1 — new things touched: 3** = 1 + 0 + 1 + 0 + 0 + 0 + 0 + 0 | data source **1** (`bizBackend.describeScheme`); UI surface **0**; tool or parameter **1** (`gridItems` becomes optional; `page.currentPage`); route or RPC **0**; `Config` field **0**; event type **0**; approval gate **0** (the same one question per call); dependency **0**. |
| **2 — smallest version that proves it** | A model places a table with no `tableConfig` at all. The card tells the user the read takes the table's own default columns and names none of them, and the backend has been asked for nothing when it is drawn. The deployment's scheme then decides which two of its three columns are drawn, under its own headers, with its own sortable flag. In a real browser, against the shipped bundles. |
| **3 — seam or hard-coded** | **Seam for the read, hard-coded for the choice.** `describeScheme` is a third method on the existing Service Definition, so a deployment on another backend writes it in its own provider. That the default columns are the query scheme's — rather than, say, the first N attributes of the dictionary — is hard-coded, because the scheme is what this deployment's own page opens the table with and a second rule would need a second deployment to justify it. The review trigger is a backend whose resource lists are not driven by a stored scheme. |
| **4 — one line per direction** | *Neighbours*: one more named read, still no write and still no path a caller picks. *Contract*: nothing is requested before the answer, the scheme included; what a card can say about columns it does not know yet is which side chose them. *Temptation*: no column list cached between calls, and no scheme read for a call that named its own columns. *Red line*: the question comes before every request, and only `allowed-once` proceeds. *Ceiling*: the card says the page size and not the page number, so a read of page three is described to the user in the words a read of page one gets. |

## Alternatives considered

**Teaching the default columns in a skill instead.** Rejected on which failure each fixes. A skill can tell a model to look a table's columns up first, and a model that loaded the skill would; the failure is a model that did not, whose call succeeds, draws blanks, and reports three columns of data. There is no error for the skill to catch and no refusal to correct. A tool default applies to the call that was actually made.

**Reading the scheme before asking, so the card could name the columns it is about to take.** Rejected on three counts. The credential is not spent before the question, and reading a scheme spends it. A call names up to twelve blocks, so a model could send twelve credentialed requests per call, against tables of its own choosing, with nobody having agreed to any of them — every turn, for as long as it kept calling. And the scheme request's own failure carries the backend's status, code and message, which would reach the model as the answer to a request no one approved.

**Refusing a call that leaves `gridItems` out, and telling the model to fetch the columns itself.** Rejected: that is the same round trip the model already loses to a guessed attribute name, with an extra refusal in front of it, and it leaves the empty-column failure exactly where it was.

**Dropping the columns that came back empty before drawing.** Rejected. The user approved a read of named columns; a table quietly missing two of them is a different read from the one the card described. The model is told instead, and decides.

**Adding the page and the empty attributes to `content-component/resolved`.** Rejected: both are derivable from what that event already carries, and a durable format is the wrong place for a second copy of a derived fact.

**Reading `isShow` as "hidden unless the scheme says otherwise".** Rejected — it is the table component's own field, which hides a column only on an explicit `false`, and two readings of one field name in one package would be a defect waiting for a scheme that omits it.

## Consequences

**Bought.** A model that does not know a table can draw it, with the columns the deployment itself shows for it, and is told when a column it asked for came back empty in every row. A filter that matched nothing reads as a filter that matched nothing.

**Paid.** One more request per call that leaves its columns out, made after the answer and with the credential that answer released. The card on those calls names no column at all, so a person who wanted to check from it what was about to be read learns only which side chose the columns. A scheme this table cannot be drawn from is found after the user has answered, and the dictionary read and the scheme read are spent before it refuses.

**Evidence.**

| Claim | Evidence |
|---|---|
| A call with no `tableConfig` is asked about without naming a column, and drawn in the table's own, with the scheme's hidden column left out | `snapshots/console/show-default-columns-turn/session.jsonl`; `apps/web/tests/component-surface-datasource.e2e.ts` and `.artifacts/web-e2e-component-datasource-default-{card,table}.png` |
| The backend is asked for nothing before the user answers, on a call that named no columns | `apps/web/tests/component-surface-datasource.e2e.ts`, where the fake backend has seen no request at all while the card is on screen; `packages/experimental/component-surface/tests/data-source.client.spec.ts`, where the seam is touched in the order `ask`, `describe`, `scheme`, `search` |
| A filter matching nothing reaches the model as zero rows, not as an unreachable source | `snapshots/console/empty-datasource-turn/session.jsonl`; the same web scenario, whose scripted closing line can only be written from the tool's own zero-rows sentence in the live request |
| The model is told `gridItems` may be omitted, and what `currentPage` is | `packages/experimental/component-surface/tests/data-source.client.spec.ts`, which pins both sentences of the offer; `snapshots/console/show-chart-turn/tool-schemas.expected.json` carries the whole description |
| Every normalization of a stored scheme, and the envelope that means zero rows | `packages/experimental/biz-backend/tests/biz-backend.spec.ts` |
| Every branch of the default-column path, the card wording, the refusals, and the result line | `packages/experimental/component-surface/tests/data-source.client.spec.ts` |

The `snapshots/console` fixtures above are executed on this root: the lane sits under `snapshots/`, which `vitest.snapshot.config.ts` includes, so `show-default-columns-turn`, `empty-datasource-turn` and `show-datasource-turn` replay under `pnpm run test:snapshot` — [the re-homing note](../process/2026-09-07-console-snapshot-lane.md) owns what moved and [that lane's README](../../../../snapshots/console/README.md) how to run it. The web scenario beside them stays the evidence for what an ACP transcript cannot carry: a real browser, a real approval panel, and the order the backend is touched in.

`pnpm run build` and `pnpm run typecheck` green; `pnpm run doc-sync` green at 33 of 33 gates. `pnpm vitest run --coverage` over `packages/experimental/biz-backend` and `packages/experimental/component-surface`: 28 files, 687 tests, and 100% of lines, statements, functions and branches on every file. `pnpm vitest run --config vitest.web.config.ts apps/web/tests/component-surface-datasource.e2e.ts` against the built bundles: five cases, all passing. `pnpm run lint` is green: the lane's adapter sits under `snapshots/`, which carries no type-aware oxlint override, so its imports no longer resolve to `error` the way they did while the tree was outside every workspace glob.

## Known Limitations and Deferred Work

- **The card says the page size, never the page number.** A read of page three is described as `取最多 200 条`, the same words page one gets. What the model asked for and what the user is told differ on which rows and only on which rows; the identifier line and the column list are unaffected. Saying it needs a card sentence in the user's own language for a concept the console shows nowhere else.
- **"Empty in every read row" is about the rows that arrived, not the table.** A column with values on page two is reported empty by a read of page one that found none. The sentence says `in any read row` for that reason.
- **A scheme is read once per call and cached nowhere.** Two calls naming the same table read it twice.
- **`describeScheme` is unproven against the real deployment**, like the two reads beside it: the response fields it reads — `grid.gridItems[].{relatedMetaAttr, alias, isShow, isSortable}` — were taken from the deployment's own frontend source, and every backend in these tests is a fake.
