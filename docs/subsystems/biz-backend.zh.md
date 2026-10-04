# Deployment Data Backend

[English](biz-backend.md) | 中文

`ctx.bizBackend` 读的是一套部署自己供给的数据——某个资源模型的一页行、某个模型的属性名，以及它自己的资源清单打开这个模型时用的那几列——用的是正在使用这套部署的那个人的访问令牌。它是为本 fork 的服务控制台线而存在的：harness 跑在与部署自己的 Web 控制台相同的单点登录后面，而面板画的是那个控制台展示的同一批行。[包 README](../../packages/experimental/biz-backend/README.zh.md) 拥有可调用的 API、请求与结果的声明，以及各项限制；本页记录这个服务从哪里来，以及消费方从签名里读不出来的那两条规则。

来源：[`packages/experimental/biz-backend/src/index.ts`](../../packages/experimental/biz-backend/src/index.ts)。

## 这个服务是被构造出来的，不是被组合进来的

它没有插件行。服务由握着访客访问令牌的那一行创建——在本 fork 里是 [`dsh-experimental-auth-gate`](../../packages/experimental/auth-gate/README.zh.md)——而那一行按引用传进来的是一个解析器：每次读取点名的主体，由它答出握着那个人令牌的槽；任何令牌都不发布出去。于是凭据留在那一行的闭包里，而花它们的读取在上下文上具名，这就是这道分割的全部：与它相邻的插件能读本部署的数据，谁都读不到令牌。

没有为这个后端配置基址的部署什么都不构造，于是消费方的 `ctx.inject(['bizBackend'])` 会明确挂起并点出缺失的服务名。那正是「这套部署不提供数据后端」的表达方式——一个装上了却次次调用都失败的服务，等于把这句话每调用一次说一遍，而不是在加载时说一次。

## 拿主意的是答复自己的结果码，不是状态

这个后端拒绝一次请求时给的是 HTTP 200 加一个非零码，所以只看状态会把一次拒绝读成数据。因此每次调用都要归类信封，答的要么是结果，要么是闭合失败联合里的一个成员——`unauthenticated`、`refused`、`rejected`、`unreachable`——消费方按它 `switch` 并以 `assertNever` 收口。什么都不抛。

另有两种答复会让持有方交出令牌，走的是这次读取的主体解析到的那个槽的 `drop`：HTTP 401，以及任何带结果码 2 或 3 的失败状态——403 带上这两个码也算，但单独一个 403 是一次请求被拒，令牌保留。那个槽随之抵达与一次登出相同的终态：之后主体解析到它的每次读取都答 `unauthenticated`，直到有新令牌提交进这个槽；别的槽一个都不丢。

## 失败携带的任何东西都不该进日志

失败会被报告给模型并写进会话日志，所以这个联合的任何成员都不携带凭据、完整请求 URL 或后端的排障标识。后端对一次拒绝所说的话，会先按名字把出示过的凭据抠掉、再截到一个上限之后才转述——先抠后截，因为只截长度会让一个早早就把令牌说回来的后端把它带过去。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbizbackend--bizbackendservice"></a>

### `ctx.bizBackend` — `BizBackendService`

`ctx.bizBackend`: the three reads this deployment's data backend serves, performed with the access token its caller holds for the signed-in person each read is performed for.

Nothing here registers the service: it is constructed by the row that holds the visitor's token, and only when that row was configured with a backend to read. A deployment that configures none installs no such service at all, so a consumer's `ctx.inject(['bizBackend'])` stays pending and Cordis names the missing service, rather than a service that exists and fails every call.

```ts cordis-catalog
/**
 * Judge one rights read by this deployment's rules.
 *
 * Reaches no network: a caller reads {@link BizBackendService.userRights}
 * once and asks about as many models as it holds. A failed read, and a rights
 * table naming no model, permit nothing.
 * @param rights - what one {@link BizBackendService.userRights} call answered.
 * @returns the permissions that read grants.
 */
judge(rights: BizUserRights | BizBackendFailure): BizPermissions

/**
 * Whether a token is held for one subject at all.
 *
 * Reading the slot spends nothing and reaches no network, so a consumer that
 * asks a person for permission before reading can find out beforehand that
 * the answer could not be honoured. It promises nothing about the next call:
 * the backend can refuse the token in between, and every call answers
 * `unauthenticated` on its own whether or not anyone asked here.
 * @param subject - whom the reads would be for.
 * @returns true while a token is held in the slot that subject resolves to.
 */
holdsCredential(subject: BizSubject): boolean

/**
 * Whom one browser request reads for: the person the request was admitted
 * as, by the same resolver every read finds its slot through.
 *
 * Reaches no network and spends nothing. A route answering a request for
 * which this is `undefined` reads nothing and answers 401.
 * @param req - the request a webserver route is answering.
 * @returns the request's subject, or `undefined` when it names nobody the resolver admits.
 */
subjectOfRequest(req: IncomingMessage): BizSubject | undefined

/**
 * Read one page of one resource model's rows.
 * @param subject - whom the read is for; its slot's token is the one spent.
 * @param request - the model to read and how to narrow it.
 * @param signal - aborts the request in flight; an abort answers `unreachable`.
 * @returns the rows, or why there are none.
 */
async search(subject: BizSubject, request: BizSearchRequest, signal: AbortSignal): Promise<BizSearchResult | BizBackendFailure>

/**
 * Read one resource model's attribute names, under both of the names the
 * deployment keeps for each.
 * @param subject - whom the read is for; its slot's token is the one spent.
 * @param meta - the resource model, by its English name.
 * @param signal - aborts the request in flight; an abort answers `unreachable`.
 * @returns the model's attributes, or why they could not be read.
 */
async describe(subject: BizSubject, meta: string, signal: AbortSignal): Promise<BizMetaResult | BizBackendFailure>

/**
 * Read one resource model's default query scheme — the columns this
 * deployment's own resource list opens that model with.
 *
 * The same request the deployment's frontend makes before it draws a resource
 * list: the model's stored schemes, narrowed to the resource-list kind and to
 * the one marked default. A caller that has no column list of its own gets
 * the deployment's own choice of columns and their headers, rather than
 * guessing attribute names.
 * @param subject - whom the read is for; its slot's token is the one spent.
 * @param meta - the resource model, by its English name.
 * @param signal - aborts the request in flight; an abort answers `unreachable`.
 * @returns the scheme's columns in its own order, or why they could not be read.
 */
async describeScheme(subject: BizSubject, meta: string, signal: AbortSignal): Promise<BizSchemeResult | BizBackendFailure>

/**
 * Read this deployment's own catalog of resource models.
 *
 * One request and one answer: this endpoint lists the whole catalog rather
 * than a page of it, so a caller is never left holding part of it and
 * believing it has all of it. Every model's description arrives attached and
 * none of it is kept — {@link BizModelSummary} is the whole of what a caller
 * receives.
 * @param subject - whom the read is for; its slot's token is the one spent.
 * @param signal - aborts the request in flight; an abort answers `unreachable`.
 * @returns the catalog, or why it could not be read.
 */
async listModels(subject: BizSubject, signal: AbortSignal): Promise<BizModelListResult | BizBackendFailure>

/**
 * Read one resource model's stored default schemes — the forms and the table
 * this deployment's own pages open that model with.
 *
 * The request always names the model. The same endpoint answers with every
 * scheme this deployment stores when it is asked without one, which is tens
 * of megabytes and no caller's question.
 * @param subject - whom the read is for; its slot's token is the one spent.
 * @param meta - the resource model, by its English name.
 * @param signal - aborts the request in flight; an abort answers `unreachable`.
 * @returns the model's default schemes, or why they could not be read.
 */
async describeSchemes(subject: BizSubject, meta: string, signal: AbortSignal): Promise<BizModelSchemes | BizBackendFailure>

/**
 * Read what the signed-in person may do in this deployment.
 *
 * The endpoint also answers with that person's profile. This read never
 * copies it: {@link BizUserRights} is built out of the rights subtree alone,
 * so no account name, employee number, telephone or mail address leaves this
 * seam for a caller to put in front of a model or into a session log.
 * @param subject - whom the read is for, and so whose rights are read; its slot's token is the one spent.
 * @param signal - aborts the request in flight; an abort answers `unreachable`.
 * @returns the rights, or why they could not be read.
 */
async userRights(subject: BizSubject, signal: AbortSignal): Promise<BizUserRights | BizBackendFailure>
```

Source: [`packages/experimental/biz-backend/src/index.ts`](../../packages/experimental/biz-backend/src/index.ts)
<!-- END GENERATED cordis-surface -->
