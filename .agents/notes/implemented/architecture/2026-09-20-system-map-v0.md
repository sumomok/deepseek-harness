# Agent Note: the assistant reads the deployment's own business system

Status: implemented

English | [中文](2026-09-20-system-map-v0.zh.md)

## Problem

The service-line console's assistant cannot name the deployment's data models. Asked in a person's own words about 图层配置 it has to guess an English table name, or propose a button that person is not allowed to press, and nothing in the composition can tell it otherwise.

The chain breaks at the first step. `ctx.bizBackend` already reads one model's attributes, one model's default query scheme and a page of its rows, but every one of those requires the caller to know the model's English name already. There was no read that lists the models at all, and no read of what the signed-in person may do with one.

The catalog is also too large to hand over whole. Measured on the real backend on 2026-09-20: `GET /nrms-schema-manage/api/meta/resclassname?resClassCnName=&resClassType=1` answers with **1219 models in 103 subject areas** in one response, with every model's whole description attached; `GET /nrms-schema-manage/api/meta/resclass/{model}` is about 70 KB for a 61-attribute model; `GET /nrms-schema-manage/api/schema/schema?metaEnName={model}` is about 230 KB for four default schemes, 49 form items on the add and modify forms, 27 of them carrying a dictionary of at most ten values. The same endpoint asked without `metaEnName` answers with 1129 schemes and 34 MB. `GET /nrms-auth/api/auth/userinfo` carries 1403 rights rows — and, beside them, that person's account name, employee number, telephone and mail.

## Decision

**Three tools, layered, and no resident context.** `system_map_domains` lists the 103 subject areas with a model count each; `system_map_domain_models` lists one area's models with the English name, the shown name, the stored table, the deployment's own note and what the signed-in person may do with each; `system_map_model` reads one model whole — every attribute with its stored type, length, nullability, key flag, default, form group, fixed values and the model it takes a row of, merged with which of the four default schemes draw it, which require it and whether they let this person change it, then that person's rights row. Layering is what the measurement forces: a resident index of 103 subject areas is affordable and a resident catalog of 1219 models is not, and which of the two to make resident is a question the measured cost of the first call answers. That measurement is now in the README; the resident block is not built.

**Perception asks nobody.** None of the three writes, asks or looks at a screen, so no approval is declared and no `tools/pre-execute` escalator is registered — the same shape as `content-frame`'s five reads.

**The reads are named, and they reduce at the read.** `biz-backend` gains `listModels()`, `describeSchemes()` and `userRights()`, and `describe()` widens to publish what the model description already states about an attribute. No `Config` for paths: they are the deployment frontend's own external specification. `userRights()` builds its answer out of the rights subtree alone and copies no part of the profile beside it, so no account name, employee number, telephone or mail can reach a model request, a session log or a failure message. A rights row is read key by key rather than against a fixed operation list, because the deployment grows that table by adding a key. What the three reads do with it — list and describe only the models the person may look at, and state `may` under seven operation codes judged by one rule table — is [the rights note](2026-09-24-console-rights-judged-once.md)'s.

**Nothing is cached.** Every call re-reads the catalog. A per-process cache needs a staleness rule this side cannot check, and the deployment's own frontend serves a cached copy and refreshes behind it, so the configuration is not strongly consistent to begin with.

**One character budget per answer, not one item count.** `listingChars` bounds the lines of a listing; `valuesPerAttribute` and `noteChars` bound the two values that can each grow without limit inside one line. Item counts fall out of the budget with a cursor, so there is one ceiling per thing that can grow rather than two for the same thing.

**Order is by code unit.** Subject areas by code, models and attributes by English name; operations in the order the backend lists its operation codes. A locale comparison would order the same answer differently on two hosts and a cursor built out of that order would skip or repeat rows between two calls.

## Decision gate

**0. Which settled principle already says no?**

| Principle | What it says | Result |
|---|---|---|
| `biz-backend`'s "a capability, not a pipe" (`src/index.ts:15-20`) | no general `fetch(path, init)`; the paths are an external specification, not a deployment choice | **cut** "add a `Config` field for the path prefix". Named reads only. |
| The measured rejection of a resident prompt section ([note](../../archived/feature/2026-07-30-current-sandbox-policy-context.md)) | a first-time permission switch cut cache reads to 256 tokens while ~14.7k input tokens missed | **cut** `ctx.systemPrompt.section()`. |
| The review-gate classification note's Temptation row ([note](2026-09-06-content-tools-review-gate-classification.md)) | classifying as read-only a call that really leaves this machine is deferred, each candidate argued on its own | **cut** adding these three to `readOnlyTools` in v0. |
| `gen-cordis-catalog.ts`'s two-way fail-closed `SERVICE_PAGE` (`:56-64`) | a new `ctx.<key>` requires a new subsystem page triplet | **cut** registering a service. |
| "per-user visibility does not exist" (`skill-pack/README.md:260`) | structurally absent, waiting on the multi-user decision | **cut** a per-user knowledge layer. |
| `packages/AGENTS.md:11` "Require a current owner and need" | every abstraction needs a current consumer | **cut** a provider seam for a second backend, and cut the experience-pack merge — neither has a real instance. |

Six principles cut six candidates before the rest of the gate ran.

**1. How many new surfaces? COUNT = 8, all permanent.**

1. One package, `@deepseek-ai/dsh-experimental-system-map`, with its tsconfig, its README triplet and two root registrations.
2. Three model-visible tools: `system_map_domains`, `system_map_domain_models`, `system_map_model`.
3. Five tool parameters: `after`; `domain` and `after`; `model` and `after`.
4. Three `Config` fields: `listingChars`, `valuesPerAttribute`, `noteChars`.
5. Three new public methods on `ctx.bizBackend`: `listModels`, `describeSchemes`, `userRights`, plus seven optional fields widening `BizMetaAttribute`.
6. Three customer endpoints newly reached: the model catalog, the all-schemes read, the sign-on rights read.
7. One overlay file, composed by no shipped profile.
8. One snapshot scenario and its fixtures, and three endpoints added to the console lane's fake backend.

**Not added:** no service key, no session event, no `SessionEventMap` member, no `MessageSourceMap` variant, no approval gate, no route or RPC, no system-prompt section, no `./invariant` companion, no subsystem page, no `agent/pre-step` listener, no cache, no dependency outside the workspace. `SESSION_FORMAT_VERSION` is untouched.

**2. The smallest version that shows the judgement is better.** This is it. The smaller option that was on the table — the index as a tool rather than as resident context — is the one taken, because it turns the only unmeasured question into a measurement: what a session's first call actually costs. It now costs 3466 characters, about 1163 tokens, for all 103 subject areas; a typical subject area of 12 models is 2332 characters, about 856 tokens; the 61-attribute reference model whole is 8047 characters, about 2733 tokens. Whether any of that should be resident is answerable with those three numbers and was not answerable without them.

**3. Seam or hard-wired?**

| Decision | Result | Why |
|---|---|---|
| Where the backend is read | **hard-wired** to `ctx.bizBackend` | one real backend; a provider seam would have one consumer and no second instance. |
| Where the index is delivered | **hard-wired** to a tool result | the alternative was measured and rejected for the prompt section, and the two tail-message seams both need a refresh trigger, which is a second mechanism. |
| The ceilings | **`Config`** | what one listing costs is a function of how many models a deployment keeps, and two deployments differ by an order of magnitude. |
| The subject-area vocabulary | **hard-wired** — `UNFILED`, and `query`/`grid`/`add`/`modify`/`card` | the four scheme kinds are the schema service's own numbering, an external specification; `UNFILED` is a value a model reads out of one answer and passes into the next, so a deployment moving it would move a protocol word. |
| Experience notes from a field engineer | **hard-wired absent** | two shapes are imaginable and neither exists yet; Rule of Three says do not cut the seam. |

**4. Boundaries.**

| Direction | The line | The failure it prevents | Term |
|---|---|---|---|
| Neighbour | This package sends no HTTP and holds no credential; every backend read goes through `ctx.bizBackend` | a second holder of the visitor's token, which would void `auth-gate`'s "two holders and no more" position and put the token in this package's logs, errors and fixtures | permanent |
| Contract | The answer is canonical JSON with named fields and the prose is `output.render` over it; the counts, the cursor and the rights are fields, never something a reader parses back out of a sentence | a sidebar or an audit reader regex-matching the listing a model reads, which is exactly what `SkillCatalogSource` was shaped to avoid | permanent |
| Temptation | Someone will want to wire `ctx.bizBackend.search()` in and hand the model the rows too | overturning `component-surface`'s promise to the user, 「取回来的数据画成表格放在右边，小助手看不到表里的内容」. This row reads configuration and rights, never a row | permanent |
| Red line | ① the profile beside `auth.*` never leaves `userRights()`; ② these three tools do not join the gateway's `readOnlyTools`; ③ no `SessionEventMap` member is added | ① a telephone number reaching a model request and a session log, which signing out does not clean; ② classifying as read-only three calls that do leave this machine; ③ forcing `SESSION_FORMAT_VERSION` and making older builds refuse the log | ① and ③ permanent; ② deferred, trigger: measured judge cost over budget, argued per tool as the classification note requires |
| Ceiling | An answer is the deployment's stored configuration, not the screen and not a guarantee the server enforces it: the deployment's own rights layer opens up rather than closing down when it finds no profile, so `may=` is what the interface would offer | a model asserting from metadata what is in front of a person right now — the conflict with `content-frame`'s reads, whose own text says what any of it means is for a skill to say — or reading `may=` as a server-side guarantee | permanent |
| Assumption | One dsh process is one signed-in person, so the rights reported are the process's and not a request's | serving several people from one process and presenting A's rights as B's | deferred, trigger: the multi-user token architecture landing; these answers then have to be recomputed per session rather than per process |

## Alternatives considered

**Make the subject areas resident, through `agent/pre-step`.** The seam is right — append-only, asynchronous, a named `source` a non-model reader can use — and it is where this goes if the measurement says it should. It was not built because the measurement did not exist: 103 subject areas are about 1163 tokens, which is affordable, but whether a session that never asks about the business system should pay it is a question about real sessions, and the tool version is what produces those sessions. Moving later is cheap; both produce the same text.

**A system-prompt section.** Rejected on this repository's own provider measurement, not on principle.

**Virtual skills, one per model.** `ctx.skills` never touches the filesystem and would take them, but the skill catalog has no entry cap and no body cap, 1219 entries would drown it, a model is taught that a skill is an instruction to follow rather than a table to read, and the `skill` tool has one parameter where this needs three.

**One tool with an `include` parameter.** A narrower projection of one model — attributes only, rights only — would cut what a single read costs. It was dropped to keep the surface count down: the character budget and the cursor already bound the answer, and a parameter whose only effect is to make an already-bounded answer smaller is one more thing for a model to get wrong. The trigger to add it is a measured model read that is mostly discarded.

**Widen `describeScheme` instead of adding `describeSchemes`.** The existing method narrows the request on the wire to one scheme kind and answers in about 60 KB; the new one takes all four and answers in about 230 KB. Widening the existing method would have made `component-surface`'s every data-source call pay the larger read for facts it does not use.

**Cache the catalog per process.** Deferred rather than rejected. It needs a staleness rule, and the honest one — the deployment's own frontend serves its cache and refreshes behind it — says the configuration is not strongly consistent anyway. The trigger is a measured per-call cost over budget.

## Consequences

- A console composing `overlay/system-map.patch.yml` beside the customer overlay offers three reads; every other composition offers none, because the row injects `bizBackend` and stays pending without it. No shipped profile composes it.
- Every call spends the signed-in visitor's credential on the customer backend. A call also costs one judge round trip on a console running the review gate, because these three are deliberately not classified read-only.
- `ctx.bizBackend` grows from three reads to six. `docs/subsystems/biz-backend.md` and both READMEs move with it.
- `describe()` now publishes seven more fields per attribute. `component-surface` reads two of them and is unaffected; the spec that asserted the others were dropped is updated with the behavior.
- The console snapshot lane's pinned `tool-schemas.expected.json` grows by three tools, and its fake backend answers three more endpoints. `snapshots/console/system-map-turn` pins one turn reading a subject area and then a model — and pins an absence: the fixture's rights answer carries an account name, an employee number, a telephone and a mail address, and none of them is anywhere in the transcript.

## Deferred

Four things, each with its trigger: the resident subject-area block, once real sessions say what the first call is worth; a per-process catalog cache, once a call's measured cost is over budget; classification as read-only, once the judge's measured cost is over budget and each tool is argued on its own; and recomputing the answers per session rather than per process, once one process serves more than one signed-in person.

## Testing

`packages/experimental/system-map/tests/` at per-file 100%: the reductions over stated answers, the copy and the rendering — including the two rules about absence, that no description names another tool and that no refusal names a tool to recover with — the three tools through the real registry over a stub backend, and a REAL composition booted through the vendored Loader for what is offered, what the descriptions reach the model as, and a budget that fails at load. Disposal is asserted over the same registry: dispose the fiber, and all three offers are gone from the next request. `packages/experimental/biz-backend/tests/biz-backend.spec.ts` covers the three new reads at per-file 100%, and asserts of the rights read that none of five personal values appears anywhere in what it published. `snapshots/console/system-map-turn` is the assembled keyless evidence.
