# Agent Note: the projection reads a call with the tool's own parser

Status: implemented

English | [中文](2026-09-03-content-access-projection-parses-with-the-tool.zh.md)

## Problem

Four attempts to record the `content_act` web scenario failed the same way, and the session log carries the whole of it. The model sent `{"action":"click","ref":"e7","label":"","mark":"{class: el-icon-delete}"}`; the wire took it, the approval request was composed from it, the user allowed it — and the tool answered `Error: [ … {"code":"unrecognized_keys","keys":["mark"],"path":["args","steps",2]} … ]`.

Three defects met there.

**The projection declared the steps a second time.** `requests-projection.ts` carried its own zod reading of a step — `{ ref, label }` and `.strict()` — beside the wire's `readActStep`, which had gained `mark`. Two readings of one call drift the first time either gains a field, and they drift silently: the tool takes the call, the fold takes it, and the projection then refuses the value it has just built. The registry parses every view before publishing it, so the refusal reached the model as its own tool result.

**The model was handed the validator's issue list.** `unrecognized_keys` about a field the tool's own schema documents reads as an argument to change, and there is nothing the model can change: the call was correct and the host refused itself.

**`mark` had no example, so its form was guessed.** The listing prints `e7 clickable {class: el-icon-delete}`; the description said "its class tokens exactly as the read printed them inside `{class: ...}`", and the model copied the printed row — braces, `class:` and all — three times over, and tried it as a `label` once. The approval text then read 点标为「class: {class: el-icon-delete}」的无名控件.

## Decision

**One parser is the schema.** `parsedBy(read)` turns the function that already reads a call's arguments into the schema the projection validates and publishes with, for both tools: `readArgs` for a read and the wire's `parseActArgs` for a set of steps. A second declaration cannot drift from the first when there is no second declaration.

**A view this unit refuses is one sentence and one log line.** The unit checks the value it is about to publish, records the issues through a logger it is built with, and throws `UNPUBLISHABLE_CALL_REFUSAL`: nothing ran, the call can be sent again, and the defect is the host's.

**A mark has one written form, shown everywhere it is named.** `MARK_EXAMPLE` — "where the read printed e7 clickable {class: row-action danger}, pass ref "e7", label "" and mark "row-action danger" — the tokens alone, without the braces and without the "class:" printed in front of them" — is the parameter's description and both refusals about it. The wire refuses a mark carrying a brace or a leading `class:`: those are what the listing puts around the tokens, so either one is the printed row copied whole. The cost is exact — an element whose own class attribute holds a brace is unactable for good, since its printed mark is the only thing a step can carry and every step carrying it is refused, with a remedy the model cannot apply. Nothing that draws a page writes such a class, and the rule catches a mistake a model makes on rows it meets constantly, so the trade stands. What the wire does absorb is spacing: a mark is read as its tokens joined by single spaces, the way the seat computes one, so the same tokens written with a leading or doubled space are the same mark rather than a failure on the page a round trip later.

## Alternatives considered

**Add `mark` to the projection's schema and stop there.** It fixes this call and leaves the mechanism: the next field added to a step breaks the same way, after the approval, in a recording nobody can explain from the tool's own tests.

**Keep the hand-written schema and gate it with a test that compares both readings.** A test that has to enumerate the fields is the third declaration.

**Take the printed form and strip it.** Accepting `{class: el-icon-delete}` teaches two spellings for one field and leaves the seat comparing a string the read never printed. A refusal that carries the example costs one turn and teaches one form.

## Consequences

- The projection now accepts exactly what the tool accepts. Unknown keys inside `args` are dropped by the parser rather than refusing the whole view, which is the better failure for a value the host built itself; the envelope around them (`callId`, `tool`, `args`) is still strict.
- A checkpoint restored from the persisted cache still parses through the same schemas, so a stored call is read by the tool's parser too.
- `contentAccessProjection` now takes a logger. It is the only dependency the unit has, and it exists so the issues behind the model's one sentence are recoverable.
- A refused view still throws where the registry commits the event, so the call fails. What changed is what the model is told about it.

## Testing

`tests/content-read-projection.client.spec.ts` folds a step naming a row by its mark and reads it back through the wire schema, and drives a view the unit refuses — the sentence to the caller, the issues to the logger. `tests/content-read-wire.client.spec.ts` refuses the three printed forms (`{class: …}`, `class: …`, a trailing brace), and `tests/content-act-tool.client.spec.ts` pins the whole sentence the model reads for each, the tool's schema included.
