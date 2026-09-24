---
description: "Three credentialed reads that let the agent find its way around a deployment's own business system — the subject areas it divides its data into, the data models one area holds, and one model in full with the attributes, forms and rights of the person signed in; for the console composition that wires the harness to a business back office and the maintainers of that row."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-system-map

English | [中文](README.zh.md)

## Summary

A console assistant that cannot name this deployment's data models cannot answer a question about them. Asked in a person's own words about 图层配置 it has to guess an English table name, or propose a button that person is not allowed to press. This row closes that with three reads of the deployment's own stored configuration, layered because the catalog is too large to carry around: the subject areas, the data models one subject area holds, and one model in full.

Perception, and nothing else. None of the three writes anything, asks anybody anything, or looks at a screen, so none of them is put to a person first. What they answer with is the deployment's own configuration and the signed-in person's own rights — never the values in a row, and never what is currently in front of somebody.

## Table of Contents

- [The three reads](#the-three-reads)
- [How a listing is written](#how-a-listing-is-written)
- [The ceilings](#the-ceilings)
- [Composing the row](#composing-the-row)
- [What a failed read becomes](#what-a-failed-read-becomes)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="the-three-reads"></a>
## The three reads

| Tool | Parameters | Answers with |
|---|---|---|
| `system_map_domains` | `after` | Every subject area holding a data model the signed-in person may look at, each with the name it shows and how many of those models it holds. |
| `system_map_domain_models` | `domain` (required), `after` | The data models one subject area holds that the signed-in person may look at: the English name, the name shown, the stored table, what the deployment records about the model, and which operations the signed-in person may perform on it. |
| `system_map_model` | `model` (required), `after` | One model in full: every attribute with its stored type and length, whether a row may leave it empty, whether it identifies the row, its default, its group, the fixed values it offers and the model it takes a row of, plus which of the deployment's own forms draw it, which require it and whether they let this person change it — then that person's rights over the model. |

`domain` takes either the code the deployment files models under or the name it shows for that code; `model` takes either the English name or the name shown. A model the deployment files under no subject area is listed under the code `UNFILED`, which `domain` accepts like any other.

Every read goes through [`dsh-experimental-biz-backend`](../biz-backend/README.md) and nothing else. This package holds no credential, opens no socket and knows no address: the whole of what it can reach is that seam's four named reads — the catalog, the signed-in person's rights, one model's attributes and one model's stored schemes.

A model is visible to the signed-in person when the seam's rights judgement allows `metadata_read` on it, which under the default rule table means the rights table holds a row for it. Every read narrows the catalog to the visible models before it groups, resolves or lists anything: `system_map_domains` counts only them and leaves out a subject area holding none, `system_map_domain_models` lists only them, and `system_map_model` reads only them. A model the person may not look at is refused in the words a model this deployment does not have is refused in, so the refusal does not say that it exists. A rights read that fails ends the call with the sentence its failure becomes, and a rights table naming no model lists no subject area at all; neither falls back to the whole catalog. The rules themselves are the seam's, configured once on [`dsh-experimental-auth-gate`](../auth-gate/README.md) as `bizOperationRules`, so this row keeps no copy of them.

<a id="how-a-listing-is-written"></a>
## How a listing is written

Each answer is a heading, then one line per entry. The heading says once what every key on those lines means, and a field the deployment states nothing for is left out rather than carried as a placeholder — which is what makes a catalog of a thousand models affordable to read.

```markdown
Subject area TRANSO (传输专业) holds 1 data models the signed-in person may look at. Each line is a model's English name, then, where this deployment states them, `name=` the name shown and `table=` where its rows are stored, then `may=` the operations the signed-in person may perform on it (from read, metadata_read, create, update, delete, import and export), and, where this deployment records one, `note=` what it records about it.
SpaceLayer name=图层配置 table=SPACE_LAYER may=read,metadata_read,create,update,import,export note=每个图层的配置与归属专题
```

`may=` carries the operations the seam's rights judgement allows on the model, from the seven `read`, `metadata_read`, `create`, `update`, `delete`, `import` and `export`, in that order — the operation codes the deployment's backend plans to enforce, rather than the flag names its rights table spells. Every listed model carries at least `metadata_read`, since that is what lists it, so every line has a `may=`. Which flags each operation needs is the rule table's, so a deployment that changes a rule changes `may=` without a change on this side.

Order is by code unit, never by locale: the same answer reduces to the same listing on every host, which is what makes a cursor safe to follow between two calls. Subject areas sort by code, models by English name, attributes by English name.

A listing longer than the deployment's budget stops at the last entry that fits and ends with the cursor to continue from:

```markdown
Cut after 77 of 400; pass "Model076" as `after` to continue.
```

An entry longer than the whole budget is carried alone and the listing is still marked cut, because a listing that took nothing would hand back the cursor it was given and a caller following it would never move.

<a id="the-ceilings"></a>
## The ceilings

| Field | Default | Bounds |
|---|---|---|
| `listingChars` | `12000` | Characters the lines of one listing may spend between them. |
| `valuesPerAttribute` | `12` | Fixed values one attribute carries before the rest are only counted, as `values=1=在用\|0=停用\|+17 more`. |
| `noteChars` | `80` | Characters one of the deployment's recorded notes carries. |

All three are the deployment's, because what one listing costs is a function of how many data models that deployment keeps, and two deployments differ by an order of magnitude. A composition writing a `listingChars` below 200 fails at load rather than answering every call with a single cut line.

The complete answer is `listingChars` plus its heading. The heading is a sentence of fixed shape plus the names this deployment gives the subject area or the model and at most one note of `noteChars` characters; the measured figures are under [Model Experience](#model-experience).

<a id="composing-the-row"></a>
## Composing the row

```yml
- id: system-map
  name: '@deepseek-ai/dsh-experimental-system-map'
```

The row injects `tools` and `bizBackend`. The second is what a deployment has to arrange: `ctx.bizBackend` is constructed by [`dsh-experimental-auth-gate`](../auth-gate/README.md) and only when that gate was configured with a `bizUpstream`, so a composition without one is offered no read at all rather than three that refuse every call. `overlay/system-map.patch.yml` is the row as an overlay, kept out of the console overlay for the reason that file gives about the rows it leaves out: whether a console lets the agent read its deployment's own configuration is that deployment's decision. No shipped profile composes it.

No approval row is needed and none is asked for. The three reads are also deliberately absent from the review gate's read-only classification: they do leave this machine, and the [classification note](../../../.agents/notes/implemented/architecture/2026-09-06-content-tools-review-gate-classification.md) defers exactly that case until the judge's measured cost is over budget.

<a id="what-a-failed-read-becomes"></a>
## What a failed read becomes

The backend seam answers with a value rather than throwing, and each of its four failures becomes one sentence stating why the call was refused. None of them names a tool to recover with, and each of the two argument refusals names the parameter that would fix the call.

| The read answered | The model reads |
|---|---|
| `unauthenticated` | `Nobody is signed in to this deployment, so nothing about its business system could be read.` |
| `refused` | `This deployment refused the signed-in person's credential (HTTP 401), so nothing about its business system could be read.` |
| `rejected` | `This deployment refused the request (HTTP 200, code 4): 没有权限.` |
| `unreachable` | `This deployment's business system did not answer: the answer listed no resource models.` |

A subject area holding no model the signed-in person may look at — whether or not this deployment has one of that name — is refused with the ones that do hold one, up to twenty-four of them, then a count, so a mistyped code is corrected from the answer already in hand rather than from a second call: ``No subject area the signed-in person may look at is called "TRANSMISSION". Pass `domain` as one of those: …``. A model the person may not look at, or one this deployment does not have, is refused without a listing, because a deployment keeps more data models than a sentence could carry, and in one sentence for both: ``No data model the signed-in person may look at is called "SITE". Pass `model` as either the English name this deployment keys a model by or the name it shows a person for one.``

## Model Experience

### The three offers

#### What the model sees

Three tools and five parameters between them, whenever the row is composed. Each description says what its own tool answers with and when to reach for it, states that what comes back is the deployment's configuration rather than anything on screen, and names no sibling. `system_map_domains` takes an optional `after`; `system_map_domain_models` a required `domain` and an optional `after`; `system_map_model` a required `model` and an optional `after`. Nothing here varies with the deployment, and this package contributes no system-prompt section; the row is in no shipped profile, so the generated tool catalog does not carry these three either.

#### Token effect

Fixed: 2269 characters of description — 686, 731 and 852 — plus five parameter descriptions, on every request where the three are visible. Counted as DeepSeek counts, at 0.6 tokens for a CJK character and 0.3 for anything else, that is about 681 tokens for the descriptions.

#### KV Cache effect

The descriptions are constants and never vary within a deployment, so the tool block stays byte-identical across requests and the prefix holds.

### The three results

#### What the model sees

One text block: the heading, one line per entry, and the cut line where a listing stopped short. The heading names every key its lines use, a field the deployment states nothing for is absent from a line rather than blank, and an answer this deployment would not give is one sentence saying why.

##### The heading of a model listing

```markdown
Subject area TRANSO (传输专业) holds 1 data models the signed-in person may look at. Each line is a model's English name, then, where this deployment states them, `name=` the name shown and `table=` where its rows are stored, then `may=` the operations the signed-in person may perform on it (from read, metadata_read, create, update, delete, import and export), and, where this deployment records one, `note=` what it records about it.
```

##### The line a cut listing ends with

```markdown
Cut after 77 of 400; pass "Model076" as `after` to continue.
```

#### Token effect

Bounded by `listingChars` plus the heading, and measured against the deployment this row was built for — 1219 data models in 103 subject areas, a reference model of 61 attributes of which 27 offer a ten-value dictionary — counted the same way. Listing all 103 subject areas is 3466 characters, about 1163 tokens. Listing a typical subject area of 12 models carrying an 80-character note each is 2332 characters, about 856 tokens; the same listing against a 400-model subject area stops at the `12000` ceiling after 77 models, 12345 characters and about 4698 tokens, and hands back a cursor. Reading the 61-attribute reference model whole is 8047 characters, about 2733 tokens, of which the heading alone is 1023 characters and about 317 tokens. A session that reaches one model through all three therefore costs on the order of four thousand tokens of result, once, against a catalog no request could carry resident.

#### KV Cache effect

Append-only: a result follows the reusable request prefix and invalidates nothing already cached. Reading the same model twice is two results rather than a rewrite of the first — the deployment's configuration can change between them, and nothing here claims otherwise.

## Known Limitations and Deferred Work

- **Nothing is cached, so every call re-reads the catalog.** `system_map_domains` and `system_map_domain_models` each read the whole catalog — one answer of over a thousand models on the deployment measured — and `system_map_model` reads it again to resolve the name before reading the model. A per-process cache would need a staleness rule this package has no way to check, and the deployment's own frontend serves its cached copy and refreshes behind it, so the configuration is not strongly consistent to begin with. The trigger is a measured call cost over budget.
- **The index is not resident, by decision.** Nothing is contributed to the system prompt or appended to a turn, so a model that never calls the first read knows none of this. Making the subject areas resident was left until a session's first call has been measured, and the figures above are that measurement.
- **A listing is a snapshot of configuration, not of a screen.** It says what the deployment's forms are configured to do, which is not the same as what is in front of somebody now, and not the same as what the backend will accept: the deployment's own rights layer opens up rather than closing down where it finds no profile, so `may=` is what the interface would offer, not a guarantee the server enforces it. The listing figures above were measured before `may=` carried the seven operation names and before the catalog was narrowed to what the person may look at; a listed model's line now carries up to 57 characters of `may=`, and a listing leaves out every model the person may not look at.
- **The rights this reports are the process's, not a request's.** The credential is one token held for the whole process, so a listing describes whoever signed in last. That is the deployment shape this fork runs — one process per signed-in person behind a proxy that checks the token — and it stops holding the moment one process serves several people, at which point these answers have to be recomputed per session rather than per process.
- **One shown name may belong to two models.** `model` accepts the name a person is shown, and two models may carry the same one; the read resolves to whichever sorts first by English name. The answer names the model it read, so the mistake is visible, but it is not refused.
- **The cards are English on a Chinese console.** The host presenters title each call in English, as every other host presenter in this repository does. There is no Client plugin, so the browser falls back to the generic row and shows the tool name and the result text.
- **No write, and none is coming through here.** Reading a deployment's configuration and changing it are not two methods of one thing: a write spends a person's credential on a change to their own system and needs its own consent question and its own record, and neither exists in this row.

**Runtime invariant:** No companion is published. This package registers no service, appends no session event, owns no durable data and keeps no mutable state: three tools, three pure reductions and the text they render, all of them functions of one backend answer. There is no owned relation two observers could disagree about, which is the only thing `./invariant` exists to check.

<a id="dev-note"></a>
### Dev Note

`reduce.ts` holds every computation and imports nothing but types; `text.ts` holds every sentence a model reads; `tools.ts` wires the two to the registry. The split is what lets `tests/reduce.spec.ts` assert an order and a cut exactly, and `tests/text.spec.ts` assert two rules about what is absent — that no description names another tool and that no refusal names a tool to recover with — over the whole set at once.

`tests/composition.spec.ts` boots a test-only `cordis.yml` through the vendored Loader and observes the composed application: that all three reads are offered with a backend and none without one, what each description and parameter reaches the model as, and that a budget no listing could be written in fails at load. `snapshots/console/system-map-turn` is the assembled evidence — one turn reading a subject area and then a model, through the shipped `acp` interface against the lane's fake backend. What that fixture also pins is an absence: the same backend answer carries the signed-in person's account name, employee number, telephone and mail, and none of it is anywhere in the transcript.
