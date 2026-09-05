---
description: "Two credentialed reads of a deployment's own data backend — one page of a resource model's rows and one model's attribute names — performed with the token of the person using that deployment; for the composition that wires the harness to a business console's API and the maintainers of that seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-biz-backend

English | [中文](README.zh.md)

## Summary

`ctx.bizBackend`: two reads of a deployment's own data backend, performed with the access token of the person using that deployment. A deployment that issues tokens usually also serves its own data — a person opening a resource list in its web console sends one request for the model's attribute names and another for a page of its rows, both carrying that person's token — and this package makes those same two requests from inside the harness process.

Host-only, and it holds no credential of its own. Whoever installs the service passes the token in by reference, so the token stays in that package's closure and is never named on the context.

## Table of Contents

- [Installing the service](#installing-the-service)
- [The two reads](#the-two-reads)
- [How the credential is spent](#how-the-credential-is-spent)
- [Nothing throws](#nothing-throws)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="installing-the-service"></a>
## Installing the service

The service is constructed rather than composed: there is no plugin row, because the row that has the visitor's token is the only one that may create it.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { BizBackendService, type HeldCredential } from '@deepseek-ai/dsh-experimental-biz-backend'

declare const ctx: Context
declare const upstream: string
declare const credential: HeldCredential

new BizBackendService(ctx, upstream, credential)
```

In this fork that caller is [`dsh-experimental-auth-gate`](../auth-gate/README.md): its `bizUpstream` configuration is the base, its held token is the credential, and a deployment that configures no base constructs nothing at all — so a consumer's `ctx.inject(['bizBackend'])` stays pending with the missing service named, rather than reading through one whose every call fails.

`upstream` must be an absolute `http(s)` address with no query string, fragment, or credentials of its own, and a path ending in `/`. That path is the deployment's API prefix, which is the frontend's own `VUE_APP_BASE_URL`: a standard install builds `/ini-server/`, and an install built without one publishes at the origin root. Every read is joined onto the base by keeping all of it and appending the service path, never by resolving one address against another — a resolve would drop the API prefix the moment the appended half began with `/`, and the request would land at the server root instead. The caller checks the base at load, because an address refused here would be refused once per read instead of once per composition.

<a id="the-two-reads"></a>
## The two reads

| Method | Reads |
|---|---|
| `search(request, signal)` | One page of one resource model's rows, twice over — `rawValue` as stored, `displayValue` as the deployment shows them — plus the total across every page. |
| `describe(meta, signal)` | One resource model's attributes, under both the name rows are keyed by and the name a person is shown. |

A third method reads nothing: `holdsCredential()` answers whether a token is held at all. It exists for the caller that puts a question to a person before reading, so that a read this process could not perform is not one somebody is asked to allow. It promises nothing about the next call — the backend can refuse the token in between, and every call answers `unauthenticated` on its own regardless.

Two methods rather than a `fetch(path, init)` pipe, because the same prefix also carries `PUT /api/resources/{model}/{id}`, `DELETE /api/resources/{model}/{id}`, and `POST /api/batchresources/delete/{model}`. A general pipe would hand every plugin sharing this process the visitor's credential and those endpoints with it. Nothing here writes, and no caller picks a path: a model name that is not a single bare name is refused before any request goes out, so a name holding `/` or `..` cannot steer a credentialed request at a neighbouring endpoint.

Defaulting happens in one explicit step between the request a caller states and the document that goes on the wire — `matchMode` becomes `AND`, an unstated page becomes the first page of 200 rows, `asc` and `desc` become null, `conditions` becomes empty — so what an unstated field turns into is readable in one place. A caller that names `source` gets those attributes and the backend's own row identifier: the deployment's client puts `int_id` in front of every `source` it sends, and the backend answers with it whether or not the caller asked. A consumer that must not show a column it did not name has to drop the extra key itself.

These reads are the deployment's own two, minus the three its web page adds for itself: no cache-busting query parameter, no expansion of the browser's stored profile into request headers, and no activity record posted afterwards — writing one would put an operation into the deployment's audit trail that its user never performed.

<a id="how-the-credential-is-spent"></a>
## How the credential is spent

Both `Authorization` and `CertificationToken` carry `Bearer <token>`: the same bytes the deployment's own page sends, which stores `"Bearer <jwt>"` and puts the stored value into both headers verbatim, while the caller holds the bare JWT. `CertificationToken` is simply how this backend reads the token; it is not a second credential. Nothing else that identifies the browser goes out — no cookie, and no header derived from anything but the token itself.

<a id="nothing-throws"></a>
## Nothing throws

Every call answers with its result or with one member of a closed failure union: `unauthenticated` (no token is held, and no request was made), `refused` (the backend refused the credential itself), `rejected` (the backend answered, and its answer was no), `unreachable` (no answer this seam could read — the request never went out, never arrived, or came back as something else). A consumer switches on the tag and ends in `assertNever`, so a member added later fails its build rather than falling through.

The result code inside the answer decides, not the status alone: this backend refuses a request with HTTP 200 and a non-zero code, so a consumer trusting the status would read a refusal as data. Two answers additionally make the caller give the token up, through the `drop` the credential was passed in with: HTTP 401, and any failing status carrying result code 2 or 3. That second one follows the deployment's own client, which gives its stored token up on those two codes from its error path only — its success path reports a non-zero code on an HTTP 200 and keeps the token — so the same code means one refused request on a 200 and a refused credential on a failure. HTTP 403 is not one of them: that client reads it as this request being refused access and keeps its stored token, so a 403 is classified from its envelope like any other failing status and gives the credential up only when it carries code 2 or 3.

No failure carries the credential, the full request URL, or the backend's trace identifier — a failure is reported to a model and written into a session log, and none of the three belongs in either. What the backend says is repeated to the caller with the presented credential removed by name and then cut to 120 characters; bounding alone would not keep that promise, since a backend saying the token back inside its first hundred characters would pass.

## Model Experience

None, as this package registers no tool, prompt section, or result: it performs two HTTP reads for whichever row consumes the service, and every model-visible effect of those rows belongs to them.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated.

## Known Limitations and Deferred Work

- **Row-level trimming can only come from the backend, and that is unverified.** The deployment's frontend has a row and column permission layer, but it opens up rather than closing down when it finds no signed-in profile, so it is not a boundary anything here can rely on. If the backend does not narrow rows by the presented token, one read can put rows this person may not see on their screen and into their session log — and signing out does not clean a log already written.
- **A `code 3` on an HTTP 200 is a rejection here, not a refusal.** A failing status carrying that code does give the token up, but a backend reporting an expired token as HTTP 200 with `code 3` keeps being presented that token, and every read answers `rejected`. The 200 path is left alone deliberately: the deployment's own success interceptor keeps its token there too, and guessing otherwise would drop a live credential on an ordinary business refusal.
- **The console's per-model address overrides are not reproduced.** The deployment's frontend keeps a runtime registry that can point one model's query at an address of its own, and there is no registrar on this side. A model configured that way is read at the default address, which may not be where the console reads it. The trigger is the first read whose rows disagree with the page.
- **Every row in the composition can use the service.** `ctx.bizBackend` is named on the context, so any plugin loaded beside the one that constructed it can read this deployment's data as the signed-in visitor. The narrowness of the two methods is the whole of the boundary; who may call them is the composition's decision, and a third-party plugin declares no approval gate by default. The token itself stays out of reach — it is held in the caller's closure and published as no service.
- **Reads are what this seam has.** There is no create, update, or delete, and adding one is not a matter of another method: a write spends a person's credential on a change to their own system, which needs its own consent question and its own record, and neither exists here.
- **Not covered by an assembled snapshot** — the service is exercised by this package's own specs and, end to end, by the Playwright scenario in `apps/web/tests/component-surface-datasource.e2e.ts` against a real composition; the snapshot lanes replay the shipped composition, which does not compose an experimental row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
