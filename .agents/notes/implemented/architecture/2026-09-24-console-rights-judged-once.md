# Agent Note: the console judges the signed-in person's rights once, by one rule table

Status: implemented

English | [中文](2026-09-24-console-rights-judged-once.zh.md)

## Problem

The console read the signed-in person's rights table and acted on none of it. `system_map_domains` and `system_map_domain_models` listed every model in the catalog, including models the person has no row for, and `system_map_model` described them; the data page drew 新增, the modify icon and both exports for every visitor whose view opened it for writing, and a press the backend refused was refused only after it was pressed.

The rights table cannot be read literally. An audit of the customer backend's source established that `GET /nrms-auth/api/auth/userinfo` answers `auth.resclass[]` rows keyed by `resclassenname` whose booleans the generator only ever writes `true`, with `null` meaning not granted; that `search`, `imp`, `exp` and `gridexp` are `null` on every account, administrators included; that the backend itself enforces only `add`, `update` and `delete`; that a restricted account's table holds only its granted models; and that an account with no grant at all is answered HTTP 400 code 1. The customer page's own `useCloudPermission` reads those booleans directly, which is why it hides even the query button on this backend.

## Decision

**One judgement, on the seam that reads the rights.** `ctx.bizBackend.judge(rights)` turns what one `userRights()` call answered into `may(model, operation)`. It reaches no network, so a caller reads the rights once and asks about as many models as it holds. Every consumer that hides or refuses something on the person's behalf — the three `system_map_*` reads and the data page's ability route — calls it, so none keeps a copy of the rules.

**Seven operations, under the backend's planned operation codes.** `read`, `metadata_read`, `create`, `update`, `delete`, `import`, `export` are `BIZ_OPERATIONS`, fixed as an external specification. Which rights flags each needs is deployment data: `BizOperationRules`, one rule per operation, each `row` (the table holds a row for the model) or a non-empty list of rights flags of which the row must grant at least one. The defaults are what the backend enforces today — `row` for `read`, `metadata_read` and `export`; `[add]`, `[update]`, `[delete]`; `[add, update]` for `import` — and a deployment whose backend starts checking a flag writes that one rule, such as `export: [exp]`. The table is configured as `bizOperationRules` on `auth-gate`, the row that constructs the service; its schema lives in `biz-backend`, and `requireBizOperationRules` fails the row at load on a key naming no operation, because the schema keeps undeclared keys and a misspelling would otherwise leave the intended rule at its default.

**Fail closed.** A failed rights read — including the HTTP 400 code 1 of an account with no grant — and a rights table naming no model permit nothing, and a model with no row permits nothing.

**system-map shows only what the person may look at.** Each read narrows the catalog to the models `may(model, 'metadata_read')` allows before it groups, resolves or lists. `system_map_domains` now reads the rights too, counts only visible models and leaves out a subject area holding none; a failed rights read ends every read with its refusal rather than falling back to the whole catalog. A hidden model and a model the deployment does not have are refused in one sentence, `No data model the signed-in person may look at is called "…"`, and a subject area in the same form, so a refusal does not reveal that a hidden model exists. `may=` and the `may` field carry the permitted operations under the seven neutral names instead of the rights table's flag names.

**The data page receives a verdict, never the rules.** Kit 0.4.5 adds the host-only `abilities` prop, `{ create, update, delete, import, export }`, which can only remove entrances. `component-kit`'s node half claims `GET /component-kit/abilities?meta=<table>` wherever both a webserver and `ctx.bizBackend` are composed; the handler reads the rights once and answers the five booleans `judge` gives. `DataPageRenderer` fetches it per table, passes every ability `false` until the answer arrives and whenever none can be obtained, and spreads the verdict after the block's own props; the bridge updates the same Vue instance, so the page neither remounts nor queries again. The placement catalog declares no `abilities` property, so a call or a written view carrying one is refused as undeclared, and `readDataPage` never reads it.

This supersedes the part of [the data-page note](2026-09-19-data-page-replaces-toy-crud.md) that held no check of what a visitor may do on the host: which entrances exist is still the arrangement's, whether a press succeeds is still the backend's, and between them the host now removes what the rights table does not allow.

## Alternatives considered

**`may(model, operation, signal)` reading the rights per call.** It matches the phrase literally, and it costs one request per model: a subject-area listing on the measured deployment would spend hundreds of credentialed reads. The judgement over one read is the same answer for one request.

**Ship the rule table to the browser and judge there.** It would put a second evaluator of the same rules in the page, which can drift from the host's, and hand the page the whole rights table for a question about one model. The verdict is five booleans.

**Read `exp`, `imp`, `search` and `gridexp` as written.** Every account would lose export, import and query, including administrators, because the backend never writes those flags. The rule table keeps them usable the day the backend does.

**Put the rule table in a `biz-backend` plugin row of its own.** The service has no row: `auth-gate` constructs it with the credential it holds, so a second row would split one service's construction across two configurations.

**Hide an unlisted model behind a refusal naming the reason.** "You may not look at this model" tells a model, and whoever reads its transcript, that the model exists. One sentence for both keeps the catalog of a restricted account indistinguishable from a smaller deployment.

## Consequences

- `ctx.bizBackend` gains `judge()`; `BizBackendService`'s constructor takes the rule table as a fourth argument, and `auth-gate`'s `Config` gains `bizOperationRules`, defaulted field by field.
- The three `system_map_*` descriptions, the model-listing heading, both unknown-name refusals and the `may` vocabulary changed, so `snapshots/console/show-chart-turn/tool-schemas.expected.json` and `snapshots/console/system-map-turn` were refreshed keylessly: the fixture's `SITE` has no rights row and drops out of 传输专业, and `SpaceLayer` lists `may=read,metadata_read,create,update,import,export`.
- `component-kit` depends on `biz-backend` and claims one more route; a composition without a data backend draws every data page with its removable entrances removed.
- The measured listing sizes in the `system-map` README predate the neutral `may=` field; each listed line now carries up to 57 characters of it.
- Bought: one rule table, configured once, decides what the assistant is told exists and what the page offers, and the day the backend enforces an operation code is a one-line configuration change.

## Deferred

Rights are the process's, not a request's: the credential is one token for the process, so both the listing and the ability route describe whoever signed in last, as the system-map note already records for one-process-per-person deployments; the trigger is one process serving several people. Nothing caches the rights read, so a page open while rights change keeps its verdict until it is drawn again; the trigger is a measured rights-read cost over budget.

## Testing

`biz-backend` covers every rule row, each write flag on its own, the unenforced flags, a missing row, an empty table, all four failure kinds, a changed rule and malformed rules at per-file 100%. `system-map` covers the narrowing, the refusals that do not reveal a hidden model, the empty and failed rights reads and a configured rule through the real tool registry, and a REAL composition booted through the Loader over the real `judge`. `component-kit` covers the route through a Loader-booted composition of the webserver, the real `auth-gate` with a data backend and a written `bizOperationRules`, and this row, over a stand-in backend answering the rights read; and against the real webserver alone — judged answers, fail-closed answers, 400 and 405, the route absent without a backend and released with either the backend's or the row's fiber — the browser reader's fail-closed paths, the pin of the five keys against the kit's `DATA_PAGE_ABILITY_KEYS`, and the renderer drawing no removable entrance before the verdict and changing them in place on the same instance with no second query. `component-surface` refuses a call and a view carrying `abilities`.
