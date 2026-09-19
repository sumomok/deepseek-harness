# Deployment Data Backend

[English](biz-backend.md) | 中文

`ctx.bizBackend` 读的是一套部署自己供给的数据——某个资源模型的一页行、某个模型的属性名，以及它自己的资源清单打开这个模型时用的那几列——用的是正在使用这套部署的那个人的访问令牌。它是为本 fork 的服务控制台线而存在的：harness 跑在与部署自己的 Web 控制台相同的单点登录后面，而面板画的是那个控制台展示的同一批行。[包 README](../../packages/experimental/biz-backend/README.zh.md) 拥有可调用的 API、请求与结果的声明，以及各项限制；本页记录这个服务从哪里来，以及消费方从签名里读不出来的那两条规则。

来源：[`packages/experimental/biz-backend/src/index.ts`](../../packages/experimental/biz-backend/src/index.ts)。

## 这个服务是被构造出来的，不是被组合进来的

它没有插件行。服务由握着访客访问令牌的那一行创建——在本 fork 里是 [`dsh-experimental-auth-gate`](../../packages/experimental/auth-gate/README.zh.md)——而那一行是按引用把令牌传进来的，并不把它发布出去。于是凭据留在一个闭包里，而花它的那三次读取在上下文上具名，这就是这道分割的全部：与它相邻的插件能读本部署的数据，谁都读不到那枚令牌。

没有为这个后端配置基址的部署什么都不构造，于是消费方的 `ctx.inject(['bizBackend'])` 会明确挂起并点出缺失的服务名。那正是「这套部署不提供数据后端」的表达方式——一个装上了却次次调用都失败的服务，等于把这句话每调用一次说一遍，而不是在加载时说一次。

## 拿主意的是答复自己的结果码，不是状态

这个后端拒绝一次请求时给的是 HTTP 200 加一个非零码，所以只看状态会把一次拒绝读成数据。因此每次调用都要归类信封，答的要么是结果，要么是闭合失败联合里的一个成员——`unauthenticated`、`refused`、`rejected`、`unreachable`——消费方按它 `switch` 并以 `assertNever` 收口。什么都不抛。

另有两种答复会让持有方交出令牌，走的是凭据传进来时自带的那个 `drop`：HTTP 401，以及任何带结果码 2 或 3 的失败状态——403 带上这两个码也算，但单独一个 403 是一次请求被拒，令牌保留。那与一次登出抵达的是同一个终态，所以一次被拒的读是进程范围的，而不是只属于撞上它的那一次读。

## 失败携带的任何东西都不该进日志

失败会被报告给模型并写进会话日志，所以这个联合的任何成员都不携带凭据、完整请求 URL 或后端的排障标识。后端对一次拒绝所说的话，会先按名字把出示过的凭据抠掉、再截到一个上限之后才转述——先抠后截，因为只截长度会让一个早早就把令牌说回来的后端把它带过去。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
