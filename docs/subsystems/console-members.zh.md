# 控制台成员

[English](console-members.md) | 中文

`ctx.consoleMembers` 是控制台成员目录。一个控制台进程服务多位已登录成员时，每个替其中一位成员办事的插件——替请求背后的成员作答的 webServer 路由、替调用方作答的 Remote 方法、花会话所属者数据的工具、按成员各持一个 token 槽位的凭据解析器——都需要对「自己替哪位成员办事」得到同一个答案；这个目录就是这个答案唯一的出处。这个包声明这个键，它的插件行提供这个键，并把每个请求准入为其签名断言所点名的成员；这一版里目录的 `principalOfSession` 会抛错。[包 README](../../packages/experimental/console-members/README.zh.md) 拥有类型声明和各项限制，下面的生成段落写着每个方法的契约；这一页记的是消费者从签名上读不出来的三个决定。

来源：[`packages/experimental/console-members/src/types.ts`](../../packages/experimental/console-members/src/types.ts)。

## 请求的成员只有一个出处

每个按成员办事的消费者都经 `principalOfRequest` 取得浏览器请求的成员，所以两条路由之间、或一条路由与一个凭据解析器之间，不会给同一个请求说出两位不同的成员。按成员各持一个槽位的凭据解析器，必须把自己的 `principalOfRequest` 委托给这个方法来作答（[biz-backend](../../packages/experimental/biz-backend/README.zh.md#whom-a-read-is-for)）；一条自己读身份头或自己调 `connection.admit` 的路由，就成了第二个出处。这个方法能自己跑 `/api` 路由的那道准入，是因为 `admit()` 是同步的，对同一组请求头给出同一个结果，所以不必把 Peer 交给任何路由。

## 子会话跟着父会话，不跟自己的 cwd

子代理或 fork 可能在父会话根目录之外的工作目录里运行，按它自己的 cwd 定归属，它要么不属于任何成员，要么归了登记那个目录的人。目录因此经 `parentSession` 给子会话定归属——这个字段只有宿主写——只拿子会话的 cwd 来查矛盾：cwd 落在另一位成员的根目录下，或落在登记给「无人」的根目录下，答案就是不属于任何成员，而不是两个候选里的任何一个。继承在 `session/created` 时同步发生，所以子会话的第一帧发出时已经有归属。

## 目录不是通往客户 token 的路

进程里任何插件都能注入 `ctx.consoleMembers`，所以目录不把客户 token 交给其中任何一个：token 持有方挂上一个只读读取器，目录没有方法返回这个读取器或 token；目录同一时刻只持有一个读取器，持有方的读取器挂着时，别的插件挂不上。控制台线的凭据来源经本包的 `/credential-access` 入口读取 token，这个入口以目录为参数；导入这个入口的任何插件都能同样读取，所以由组合决定哪些插件握有这个入口。持有方撤下读取器时（它的插件重启），每位成员的 token 都算已丢弃，之后可以挂上新的读取器；别的插件趁这个间隙挂上的读取器，只能提供它自己已有的 token，读不到持有方的。握有目录的任何插件都能用任何单元名打开任何成员的存储，所以按成员的存储只放非秘密数据；成员的目录 id 不含主体键，所以存储路径里没有成员的 `login_uid`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconsolemembers--consolememberdirectory"></a>

### `ctx.consoleMembers` — `ConsoleMemberDirectory`

The console member directory, `ctx.consoleMembers`.

Every method is synchronous; a MemberStore it returns reads and writes asynchronously. No method returns, enumerates, or exposes a customer token or the attached CustomerCredentialReader.

```ts cordis-catalog
/**
 * The member one browser request was admitted as, for a webServer route.
 *
 * Admits the request through `connection.admit(req)`, the check the `/api`
 * route applies, and looks up the member of the admitted Peer. This is the
 * only way a fork webServer route obtains the member of a request: such a
 * route reads no identity header and calls no `connection.admit` of its own.
 * @param req - the request the route is answering.
 * @returns that member's key, or `undefined` when admission refuses the request or the admitted Peer belongs to no member.
 */
principalOfRequest(req: IncomingMessage): PrincipalKey | undefined

/**
 * The member a Remote method's caller acts for. A member Peer that is
 * released, which `ctx.connection.peers.get(peer.id) === peer` decides,
 * acts for no member. The operator is recognised only by
 * `peer === ctx.connection.operator`: an `undefined` answer never means the
 * operator.
 * @param peer - the caller's Peer, `this.ctx.invocation.peer` inside a Remote method.
 * @returns that member's key, or `undefined` for the operator Peer, for a Peer this directory did not open for a member,
 *   and for a released member Peer.
 */
principalOfCaller(peer: PeerScope): PrincipalKey | undefined

/**
 * The member one Session belongs to.
 *
 * A Session without `parentSession` belongs to the member whose registered
 * root contains its `header.cwd`; a cwd under a root registered to no one, or
 * under no registered root, belongs to no member. A Session with
 * `parentSession` belongs to whoever its parent belongs to, followed up to the
 * topmost Session; when any Session on that chain is unknown or belongs to no
 * member, the answer is `undefined`. A child Session whose own `header.cwd`
 * lies under a root registered to another member or to no one answers
 * `undefined` and logs one warning that carries no principal key; a child
 * cwd under no registered root is not a conflict and leaves the parent-chain
 * answer in force. A child Session takes its parent's member synchronously
 * on `session/created`, and a Session not loaded since startup is resolved
 * through its parent chain. The Host alone writes `parentSession`, at fork
 * and at subagent creation; no RPC caller can set it.
 * @param sessionId - the Session to look up.
 * @returns that member's key, or `undefined` when the Session is unknown or belongs to no member.
 */
principalOfSession(sessionId: SessionId): PrincipalKey | undefined

/**
 * The member's default root, `<membersRoot>/<directory id>`. The member's
 * default workspace is its `workspace` subdirectory. The directory id does
 * not contain the principal key.
 * @param principal - the member.
 * @returns the absolute path of that member's default root.
 */
memberRoot(principal: PrincipalKey): string

/**
 * Every root registered to the member: the default root plus each root a
 * migration seed registers to them.
 * @param principal - the member.
 * @returns those roots' absolute paths.
 */
rootsOf(principal: PrincipalKey): readonly string[]

/**
 * The members that currently have an open Peer.
 * @returns their keys.
 */
principals(): readonly PrincipalKey[]

/**
 * Observe members opening and closing Peers: `opened` when a member's Peer
 * opens and `closed` when it closes, the changes {@link ConsoleMemberDirectory.principals}
 * reports.
 * @param listener - called with the member and the kind of change.
 * @returns the disposer that stops the notifications.
 */
onChange(listener: (event: { principal: PrincipalKey; kind: 'opened' | 'closed' }) => void): () => void

/**
 * Per-member storage for one caller-named unit, kept at
 * `dshHomePath('console-members', <directory id>, '<unit>.json')`. It holds
 * non-secret data only.
 * @param principal - the member the data belongs to.
 * @param unit - the caller's own name for its data, for example `'server-sidebar'`.
 * @returns the store for that member and unit.
 */
memberStore(principal: PrincipalKey, unit: string): MemberStore

/**
 * Attach the reader of members' customer tokens. The directory holds one
 * reader at a time: attaching while a reader is attached throws, and once
 * the returned disposer has run a new reader may be attached, as the token
 * holder's plugin does when it restarts. The holder calls this inside its
 * own `ctx.effect` and runs the disposer from that effect's cleanup.
 * Running the disposer counts as every member's token being dropped: the
 * directory stops reading and forwarding the reader, calls every detach
 * listener synchronously, and only then accepts another reader; the reader
 * emits no `dropped` for it. The disposer acts once, and a late call leaves
 * a reader attached since in place.
 * @param reader - the read-only customer-token reader.
 * @returns the disposer that detaches the reader.
 * @throws Error when a reader is already attached, including while its disposer calls the detach listeners.
 */
attachCustomerCredentials(reader: CustomerCredentialReader): () => void
```

Types: [SessionId](core.zh.md)

Source: [`packages/experimental/console-members/src/types.ts`](../../packages/experimental/console-members/src/types.ts)
<!-- END GENERATED cordis-surface -->
