# Deployment Data Backend

English | [中文](biz-backend.zh.md)

`ctx.bizBackend` reads the data a deployment serves for itself — one page of one resource model's rows, one model's attribute names, and the columns its own resource list opens that model with — with the access token of the person using that deployment. It exists for the fork's service-console line, where the harness runs behind the same sign-on as the deployment's own web console and a panel is drawn from the same rows that console shows. The [package README](../../packages/experimental/biz-backend/README.md) owns the callable API, the request and result declarations, and the limits; this page records where the service comes from and the two rules a consumer cannot get from a signature.

Source: [`packages/experimental/biz-backend/src/index.ts`](../../packages/experimental/biz-backend/src/index.ts).

## The service is constructed, not composed

There is no plugin row for it. The service is created by whichever row holds the visitor's access token — in this fork, [`dsh-experimental-auth-gate`](../../packages/experimental/auth-gate/README.md) — and that row passes the token in by reference rather than publishing it. The credential therefore stays in one closure while the three reads that spend it are named on the context, which is the whole of the split: a plugin beside this one can read the deployment's data, and none can read the token.

A deployment that configures no base for the backend constructs nothing, so a consumer's `ctx.inject(['bizBackend'])` stays pending with the missing service named. That is the intended way to say "this deployment offers no data backend" — an installed service whose every call failed would say it once per call instead of once at load.

## The answer's own code decides, not the status

This backend refuses a request with HTTP 200 and a non-zero code in its envelope, so status alone reads a refusal as data. Every call therefore classifies the envelope, and answers with its result or with one member of a closed failure union — `unauthenticated`, `refused`, `rejected`, `unreachable` — which a consumer switches on and ends in `assertNever`. Nothing throws.

Two answers additionally make the holder give the token up, through the `drop` the credential was passed in with: HTTP 401, and any failing status carrying result code 2 or 3 — a 403 among them, though a 403 on its own is a refused request and keeps the token. That is the same terminal state a sign-out reaches, so one refused read is process-wide rather than local to the read that met it.

## Nothing a failure carries reaches a log

A failure is reported to a model and written into a session log, so no member of the union carries the credential, the full request URL, or the backend's trace identifier. What the backend says about a refusal is repeated with the presented credential removed by name and then cut to a bound — removal first, because bounding alone would let a backend that says the token back early pass it on.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbizbackend--bizbackendservice"></a>

### `ctx.bizBackend` — `BizBackendService`

`ctx.bizBackend`: the three reads this deployment's data backend serves, performed with the access token its caller holds for the signed-in visitor.

Nothing here registers the service: it is constructed by the row that holds the visitor's token, and only when that row was configured with a backend to read. A deployment that configures none installs no such service at all, so a consumer's `ctx.inject(['bizBackend'])` stays pending and Cordis names the missing service, rather than a service that exists and fails every call.

```ts cordis-catalog
/**
 * Whether a token is held for the signed-in visitor at all.
 *
 * Reading the slot spends nothing and reaches no network, so a consumer that
 * asks a person for permission before reading can find out beforehand that
 * the answer could not be honoured. It promises nothing about the next call:
 * the backend can refuse the token in between, and every call answers
 * `unauthenticated` on its own whether or not anyone asked here.
 * @returns true while a token is held.
 */
holdsCredential(): boolean

/**
 * Read one page of one resource model's rows.
 * @param request - the model to read and how to narrow it.
 * @param signal - aborts the request in flight; an abort answers `unreachable`.
 * @returns the rows, or why there are none.
 */
async search(request: BizSearchRequest, signal: AbortSignal): Promise<BizSearchResult | BizBackendFailure>

/**
 * Read one resource model's attribute names, under both of the names the
 * deployment keeps for each.
 * @param meta - the resource model, by its English name.
 * @param signal - aborts the request in flight; an abort answers `unreachable`.
 * @returns the model's attributes, or why they could not be read.
 */
async describe(meta: string, signal: AbortSignal): Promise<BizMetaResult | BizBackendFailure>

/**
 * Read one resource model's default query scheme — the columns this
 * deployment's own resource list opens that model with.
 *
 * The same request the deployment's frontend makes before it draws a resource
 * list: the model's stored schemes, narrowed to the resource-list kind and to
 * the one marked default. A caller that has no column list of its own gets
 * the deployment's own choice of columns and their headers, rather than
 * guessing attribute names.
 * @param meta - the resource model, by its English name.
 * @param signal - aborts the request in flight; an abort answers `unreachable`.
 * @returns the scheme's columns in its own order, or why they could not be read.
 */
async describeScheme(meta: string, signal: AbortSignal): Promise<BizSchemeResult | BizBackendFailure>
```

Source: [`packages/experimental/biz-backend/src/index.ts`](../../packages/experimental/biz-backend/src/index.ts)
<!-- END GENERATED cordis-surface -->
