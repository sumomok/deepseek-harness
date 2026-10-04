---
description: "Six credentialed reads of a deployment's own data backend — one page of a resource model's rows, one model's attributes, the columns its own resource list opens that model with, that model's stored default forms, the deployment's whole catalog of models, and the signed-in person's own rights — performed with the token of the person using that deployment; for the composition that wires the harness to a business console's API and the maintainers of that seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-biz-backend

English | [中文](README.zh.md)

## Summary

`ctx.bizBackend`: six reads of a deployment's own data backend, performed with the access token of the person using that deployment. A person opening a resource list in the deployment's web console sends one request for the model's attributes, one for the columns that list opens with, and one for a page of its rows, all carrying that person's token. This package makes those same requests from inside the harness process, plus three more its pages make: the whole catalog of models, one model's stored forms, and what that person is allowed to do.

## Table of Contents

- [Installing the service](#installing-the-service)
- [Whom a read is for](#whom-a-read-is-for)
- [The six reads](#the-six-reads)
- [How the credential is spent](#how-the-credential-is-spent)
- [Nothing throws](#nothing-throws)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="installing-the-service"></a>
## Installing the service

Host-only, and it holds no credential of its own. Whoever installs the service passes in, by reference, a `CredentialResolver`: for the subject each read names, it hands back the slot — a `HeldCredential` — holding that person's token, so every token stays in that package's closure and none is named on the context.

The service is constructed rather than composed: there is no plugin row, because the row that holds the visitors' tokens is the only one that may create it.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { BizBackendService, BizOperationRules, type CredentialResolver } from '@deepseek-ai/dsh-experimental-biz-backend'

declare const ctx: Context
declare const upstream: string
declare const credentials: CredentialResolver

new BizBackendService(ctx, upstream, credentials, BizOperationRules({}))
```

In this fork that caller is [`dsh-experimental-auth-gate`](../auth-gate/README.md): its `bizUpstream` configuration is the base, a resolver over the token it holds is the credential source, its `bizOperationRules` configuration is the rule table, and a deployment that configures no base constructs nothing at all — so a consumer's `ctx.inject(['bizBackend'])` stays pending with the missing service named, rather than reading through one whose every call fails.

`upstream` must be an absolute `http(s)` address with no query string, fragment, or credentials of its own, and a path ending in `/`. That path is the deployment's API prefix, which is the frontend's own `VUE_APP_BASE_URL`: a standard install builds `/ini-server/`, and an install built without one publishes at the origin root. Every read is joined onto the base by keeping all of it and appending the service path, never by resolving one address against another — a resolve would drop the API prefix the moment the appended half began with `/`, and the request would land at the server root instead. The caller checks the base at load, because an address refused here would be refused once per read instead of once per composition.

<a id="whom-a-read-is-for"></a>
## Whom a read is for

Every read and `holdsCredential` take a required first argument, `subject: BizSubject`, naming the person whose token the read spends. A tool call names `{ kind: 'session', sessionId }` with the `exec.agent.id` it runs under; a call with no `exec.agent` has no subject and reads nothing, which each consumer refuses in its own words. A webserver route names `{ kind: 'principal', principal }`, taken from `subjectOfRequest(req)`; where that answers `undefined` the request names nobody the resolver admits, and the route reads nothing and answers 401.

```ts
import type { IncomingMessage } from 'node:http'
import type { BizBackendService, BizSubject } from '@deepseek-ai/dsh-experimental-biz-backend'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare const backend: BizBackendService
declare const sessionId: SessionId
declare const req: IncomingMessage

const forToolCall: BizSubject = { kind: 'session', sessionId }
const forRequest: BizSubject | undefined = backend.subjectOfRequest(req)
```

`PrincipalKey` is `Branded<'PrincipalKey'>` from `@deepseek-ai/dsh-brand`: an opaque key that reaches no model, log line or upload. Its owner is the console member directory, `@deepseek-ai/dsh-experimental-console-members`, which declares it as that brand with the person's `login_uid` as its value (that package is not on this line yet); the export here is the same type, since `dsh-brand` brands every key through one symbol, so a key the directory hands out is one this service takes with no conversion.

Which slot a subject spends is the resolver's answer alone. `resolve(subject)` answers that subject's own slot or `undefined`; `undefined`, and a slot holding no token, both answer `unauthenticated` with no request made, and no other slot's token is presented in its place. Each read resolves its subject once, and the slot it resolved to is the one a refusal by the backend drops; no other slot is touched. `principalOfRequest(req)` is the resolver's answer to who one browser request was admitted as, and `subjectOfRequest` wraps it into a principal subject. auth-gate's resolver holds one slot per process, so every subject resolves to it and every request names the one person that process serves. A resolver holding one slot per console member must answer `principalOfRequest` by delegating to `consoleMembers.principalOfRequest(req)`, so the member directory stays the only source of whom a request names: a route reads no identity header and calls no `connection.admit` of its own, and reaches the member only through `subjectOfRequest`.

<a id="the-six-reads"></a>
## The six reads

| Method | Reads |
|---|---|
| `search(subject, request, signal)` | One page of one resource model's rows, twice over — `rawValue` as stored, `displayValue` as the deployment shows them — plus the total across every page. |
| `describe(subject, meta, signal)` | One resource model's attributes, under both the name rows are keyed by and the name a person is shown, with the stored type, the length, whether a row may leave it empty, whether it identifies the row, its default, its form group and what the deployment records about it. |
| `describeScheme(subject, meta, signal)` | One resource model's default query scheme: the columns this deployment's own resource list opens that model with, each as an attribute name plus the header, the drawn flag and the sortable flag the scheme carries. |
| `describeSchemes(subject, meta, signal)` | The same model's stored default schemes, all of them: each one's kind, every attribute its forms draw — with the label, the required, editable and drawn flags, the fixed values it offers and the model it takes a row of — and the columns its table lists. |
| `listModels(subject, signal)` | This deployment's whole catalog of resource models: each one's English name, the name a person is shown, the subject area it is filed under, the stored table, the model it extends, and what the deployment records about it. |
| `userRights(subject, signal)` | What the subject's signed-in person may do: one row per model naming the operations granted and the attributes editing is narrowed to, plus every value narrowing the rights table states. |

`describeScheme` narrows the schema service to one scheme — the resource-list kind, marked default — and reads the columns out of that scheme's grid. Its flags arrive either as the characters `'0'` and `'1'` or as JSON booleans depending on how the scheme was saved, and both readings are accepted; a flag written any other way is published as unstated, so a caller distinguishes "the scheme hid this column" from "the scheme said nothing about it". A column naming no attribute is left out, and an answer carrying no scheme — or one whose every column names no attribute — is the failure `unreachable` with the detail `the model has no default query scheme`.

`listModels` is one request and one answer: that endpoint lists the whole catalog rather than a page of it, so no caller is left holding part of a catalog and believing it has all of it. Every model's description arrives attached to every entry and none of it is kept — what a caller receives is the eight fields above and nothing else, which is what keeps a catalog of over a thousand models from being carried around as the megabytes it arrives as. A catalog of no models is an answer rather than a failure: the endpoint answers that way for the resource kinds a deployment stores no rows of.

`describeSchemes` always names the model. The same endpoint answers with every scheme this deployment stores when it is asked without one, which is tens of megabytes and no caller's question. A model with no stored scheme of a kind is an ordinary state of this deployment — its own frontend turns its buttons off over it — so an empty scheme list is an answer too.

`userRights` reaches the rights subtree and nothing else. The same answer carries the signed-in person's profile — account name, employee number, telephone, mail — and this read never copies any of it into a published value, so nothing downstream has it to put in front of a model, write into a session log, or repeat in a failure. A rights row is read key by key rather than against a fixed list of operations, because this deployment grows that table by adding a key and a fixed list would drop a later operation without saying so; the operations come back in code-unit order.

A seventh method reads nothing: `holdsCredential(subject)` answers whether a token is held in the slot that subject resolves to. It exists for the caller that puts a question to a person before reading, so that a read this process could not perform is not one somebody is asked to allow. It promises nothing about the next call — the backend can refuse the token in between, and every call answers `unauthenticated` on its own regardless.

An eighth reads nothing either: `judge(rights)` turns what one `userRights` call answered into `may(model, operation)`, for the seven operations `read`, `metadata_read`, `create`, `update`, `delete`, `import` and `export` — the operation codes this deployment's backend plans to enforce. It judges by the rule table the service was constructed with, one rule per operation: `row`, meaning the rights table holds a row for the model at all, or a list of the rights table's own flags, at least one of which that row must grant. The default table, exported as the `BizOperationRules` schema, is what this backend enforces today: it writes `null` for `search`, `imp`, `exp` and `gridexp` on every account, administrators included, and checks only `add`, `update` and `delete`, so `read`, `metadata_read` and `export` are `row`, the three writes are `[add]`, `[update]` and `[delete]`, and `import` is `[add, update]`. A deployment whose backend starts checking a flag changes that one rule — `export: [exp]` — and nothing else. It fails closed: a failed read, including the HTTP 400 code 1 an account with no grant at all is answered with, and a rights table naming no model permit nothing, and neither does a model the table holds no row for. Every consumer that hides or refuses something on the signed-in person's behalf judges with this one method, so none of them keeps its own copy of the rules.

Named methods rather than a `fetch(path, init)` pipe, because the same prefix also carries `PUT /api/resources/{model}/{id}`, `DELETE /api/resources/{model}/{id}`, and `POST /api/batchresources/delete/{model}`. A general pipe would hand every plugin sharing this process the visitor's credential and those endpoints with it. Nothing here writes, and no caller picks a path: a model name that is not a single bare name is refused before any request goes out, so a name holding `/` or `..` cannot steer a credentialed request at a neighbouring endpoint.

Defaulting happens in one explicit step between the request a caller states and the document that goes on the wire — `matchMode` becomes `AND`, an unstated page becomes the first page of 200 rows, `asc` and `desc` become null, `conditions` becomes empty — so what an unstated field turns into is readable in one place. A caller that names `source` gets those attributes and the backend's own row identifier: the deployment's client puts `int_id` in front of every `source` it sends, and the backend answers with it whether or not the caller asked. A consumer that must not show a column it did not name has to drop the extra key itself.

A read whose conditions matched nothing is zero rows, not an unreadable answer. This backend was measured reporting it with both row lists as an explicit null and a null total beside them rather than with two empty lists, so `search` answers `{ rawValue: [], displayValue: [], total: 0 }` for that envelope and for that envelope only. A payload that is not an object, one whose row lists are present and are not lists of row objects, and one carrying neither row list all answer `unreachable`: an envelope this seam has never been measured receiving is not one to report a row count out of.

These reads are the deployment's own three, minus the three its web page adds for itself: no cache-busting query parameter, no expansion of the browser's stored profile into request headers, and no activity record posted afterwards — writing one would put an operation into the deployment's audit trail that its user never performed.

<a id="how-the-credential-is-spent"></a>
## How the credential is spent

Both `Authorization` and `CertificationToken` carry `Bearer <token>`: the same bytes the deployment's own page sends, which stores `"Bearer <jwt>"` and puts the stored value into both headers verbatim, while the caller holds the bare JWT. `CertificationToken` is simply how this backend reads the token; it is not a second credential. Nothing else that identifies the browser goes out — no cookie, and no header derived from anything but the token itself.

<a id="nothing-throws"></a>
## Nothing throws

Every call answers with its result or with one member of a closed failure union: `unauthenticated` (no token is held for the call's subject, and no request was made), `refused` (the backend refused the credential itself), `rejected` (the backend answered, and its answer was no), `unreachable` (no answer this seam could read — the request never went out, never arrived, or came back as something else). A consumer switches on the tag and ends in `assertNever`, so a member added later fails its build rather than falling through.

The result code inside the answer decides, not the status alone: this backend refuses a request with HTTP 200 and a non-zero code, so a consumer trusting the status would read a refusal as data. Two answers additionally make the caller give the token up, through the `drop` of the slot the call's subject resolved to: HTTP 401, and any failing status carrying result code 2 or 3. That second one follows the deployment's own client, which gives its stored token up on those two codes from its error path only — its success path reports a non-zero code on an HTTP 200 and keeps the token — so the same code means one refused request on a 200 and a refused credential on a failure. HTTP 403 is not one of them: that client reads it as this request being refused access and keeps its stored token, so a 403 is classified from its envelope like any other failing status and gives the credential up only when it carries code 2 or 3.

No failure carries the credential, the full request URL, or the backend's trace identifier — a failure is reported to a model and written into a session log, and none of the three belongs in either. What the backend says is repeated to the caller with the presented credential removed by name and then cut to 120 characters; bounding alone would not keep that promise, since a backend saying the token back inside its first hundred characters would pass.

## Model Experience

None, as this package registers no tool, prompt section, or result: it performs six HTTP reads and one judgement for whichever row consumes the service, and every model-visible effect of those rows belongs to them.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated.

## Known Limitations and Deferred Work

- **Row-level trimming can only come from the backend, and that is unverified.** The deployment's frontend has a row and column permission layer, but it opens up rather than closing down when it finds no signed-in profile, so it is not a boundary anything here can rely on. If the backend does not narrow rows by the presented token, one read can put rows this person may not see on their screen and into their session log — and signing out does not clean a log already written.
- **A `code 3` on an HTTP 200 is a rejection here, not a refusal.** A failing status carrying that code does give the token up, but a backend reporting an expired token as HTTP 200 with `code 3` keeps being presented that token, and every read answers `rejected`. The 200 path is left alone deliberately: the deployment's own success interceptor keeps its token there too, and guessing otherwise would drop a live credential on an ordinary business refusal.
- **The console's per-model address overrides are not reproduced.** The deployment's frontend keeps a runtime registry that can point one model's query at an address of its own, and there is no registrar on this side. A model configured that way is read at the default address, which may not be where the console reads it. The trigger is the first read whose rows disagree with the page.
- **Every row in the composition can use the service.** `ctx.bizBackend` is named on the context, so any plugin loaded beside the one that constructed it can read this deployment's data as the signed-in visitor. The narrowness of the named methods is the whole of the boundary; who may call them is the composition's decision, and a third-party plugin declares no approval gate by default. The subject is the caller's to name, and nothing here checks that a caller acts for the subject it names: a plugin holding another session's id or another person's key reads as that person wherever the resolver holds a slot for them. The token itself stays out of reach — it is held in the caller's closure and published as no service.
- **Reads are what this seam has.** There is no create, update, or delete, and adding one is not a matter of another method: a write spends a person's credential on a change to their own system, which needs its own consent question and its own record, and neither exists here.
- **The assembled snapshot holds one slot.** The [`snapshots/console`](../../../snapshots/console/README.md) lane composes auth-gate with `bizUpstream` pointed at a fake data backend the suite starts, so its data-source and `system_map` scenarios read through this service end to end, every subject resolving to auth-gate's single slot; no snapshot composes a resolver holding one slot per person. Beyond the snapshots, the service is exercised by this package's own specs and by the Playwright scenario in `apps/web/tests/component-surface-datasource.e2e.ts` against a real composition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
