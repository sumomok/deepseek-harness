# Agent Note: 引用点击的 referent/open 拦截缝隙

Status: implemented

[English](2026-09-05-referent-open-seam-port.md) | 中文

## 问题

浏览器会话 UI 里每一处「打开该引用」的可点元素都各自执行自己的打开动作：`packages/client/ui-chat/src/client/apply.ts` 交给 chat view 的 `openFile` 闭包（工具行、产出文件卡片、mention）经 `ctx.remote.session.openWorkspacePath` 解析工作区路径，上方几行的 chat 正文 `referents.open(span)` 路径以同样方式解析模型撰写的正文 span，URL 则另走 `window.open`。想接管其中某一次点击的功能——比如一个要用自己的查看器而不是 Host 桌面打开路径的插件——只能逐个派发点去改，各自长出一个专用拦截口，而之后新增的每一处可点元素都会静默漏掉它。

上游没有任何面向引用点击的拦截口：`referent/open`、`dispatchReferentOpen`、`ReferentRef`、`ReferentKindMap` 在 `upstream/master` 上各自零命中。这条缝隙只存在于本 fork，它的监听者也一样：本仓库除各自的测试之外没有任何包注册 `referent/open`，因此它服务的监听者都是仓库之外、对着已发布的 `session-controller` 客户端面编译的插件。

## 决策

**一个 ROOT 作用域的 cordis waterfall 事件 `referent/open` 是所有引用点击共同经过的唯一拦截点。** 它声明在 `packages/api/session-controller/src/client/referent.ts`，并从该包的 `client` 出口导出。派发点先跑这条 waterfall，再回落到自己既有的打开动作，因此树中任何位置的监听者都能拦下一次点击而可点元素本身无须知道监听者存在，之后新增的可点元素只要派发就自动可拦截，不必再造自己的缝隙。当前两处派发点都在 `ui-chat` 的 `apply.ts`——`openFile` 闭包（`source: 'chat-view.openFile'`，`provenance: 'structured'`）与[chat 正文 referents 缝隙](2026-09-01-chat-prose-referents-seam-port.zh.md)的 span 打开器（`source: 'chat-prose'`，`provenance: 'model-text'`）——`ui-chat` 在其 `apply.ts` 的 `inject` 列表里声明了 `'referent'`。

**`ReferentKindMap` 经声明合并可扩展，预置 `file`、`dir`、`url` 三种。** 要打开新类型目标的包通过声明合并往这张表里加键，而不是去加宽 `referent.ts`，与 `ContentBlockMap` 的词表增长方式一致。因此监听者对 `kind` 做 switch 时必须带一个有文档说明的 `default` 分支，绝不用 `assertNever`：这个联合类型是跨包边界增长的，对着比运行时构建更窄的 `ReferentKindMap` 编译出来的监听者会收到叫不出名字的 kind，此时经 `next()` 转交这次点击才是正确答案。

**`ReferentRef` 只携带身份，绝不携带内容。** 它的字段是 `kind`、解析后的 `target`（`file`／`dir` 是绝对路径，`url` 是 URL 字符串）、引用出处原样的 `raw` 文本、可选的 `sessionId`、点名派发点的自由格式 `source`，以及 `provenance`（`'structured' | 'model-text' | 'tool-output' | 'user-text'`）。需要被引用字节的监听者自己从目标读取，与默认打开动作的做法相同。大多数监听者对大多数点击都会放行，携带内容的载荷等于为一个几乎总被丢弃的值给每次点击都付一次读取代价。

**监听者不调用 `next()` 直接返回即认领该次点击；所有失败路径仍会落到某个打开动作上。** 调用 `next()` 会转交给下一个已注册的监听者，最终转交给派发点自己的默认动作，即这条 waterfall 的终点。抛出异常或返回的 promise 被拒绝的监听者会被捕获、记入 `console.error`，并按放行处理，因为这次点击来自用户，无论第三方监听者处于什么状态都必须可预期地落地。`dispatchReferentOpen` 会记忆默认动作的 promise，因此在转交*之后*才抛出的监听者既不会让默认动作重跑，也不会掩盖它的真实失败：默认动作一旦跑过，它自己的结果——成功，或既有打开动作抛出的真实错误——就是本次调用的结果，调用方看到的与这条缝隙包裹该动作之前完全一致。只有在从未转交之前就失败的监听者，才会走到那条首次执行默认动作的补救路径。

**派发只发生在直接的用户手势处理函数里，绝不出现在程序化或后台路径上。** 这是这条缝隙的安全不变式，不是风格约定：认领的监听者被信任去执行一次用户授权的动作，因此一条自动投递路径若派发了 `ReferentRef`，就等于让脚本在无人点击的情况下静默触发该动作。

**`packages/client/*` 特性包经 `ctx.referent` 触达这套派发；自由函数仍是其他所有场景的入口。** `ClientReferent extends Service` 把 `open(ref, onDefault)` 挂成一行转发给 `dispatchReferentOpen(this.ctx, ref, onDefault)`，由 `packages/api/session-controller/src/client/index.ts` 在 `apply` 中构造。cordis 会把 `Service` 子类的 `this.ctx` 重新绑定到调用方实际触达该服务时所在的 context——`ctx.conversation` 与 `ctx.workspaces` 早已依赖的同一机制——因此 `ctx.referent.open(...)` 派发时用的是调用方插件自己的 context，与直接调用自由函数完全一致。`dispatchReferentOpen` 本身未改动且仍然导出：`packages/client/*` 之外的消费方，包括没有 `dsh.client` 清单行的仓库外插件，直接调用它。

**做出这个判定的门禁是客户端 bundle purity 而不是 `verify-client-packages`，而本 fork 早先在 `core-patches-v6` 上对这条缝隙的记录得出了相反结论。** 那份记录认为客户端侧值导入 `session-controller` 的运行时导出不受限制，理由是 `scripts/verify-client-packages.ts` 只枚举 `packages/client/*/package.json`，因此从不把 `packages/api/session-controller` 当作被检查对象。这条理由对那个脚本的描述是准确的，结论却依然是错的，因为另有一道门禁独立地执行着同一条设计意图：`packages/client/tsdown.client.ts` 的 `dsh-client-bundle-purity` 插件会在 `resolveId` 阶段对任何既不是平台模块、又不在导入方自己 `dsh.client.external` 里、也不是可内联的 wire 层或生成的 `/remote` 贡献的 `@deepseek-ai/` 值导入抛错。`PRELOADED_CLIENT_EXTERNALS` 为空且 `ui-chat` 未请求任何 external，因此在 `ui-chat` 里裸导入 `dispatchReferentOpen` 是一个构建错误——它是一次真正的跨插件运行时调用，不是会被擦除的类型——而 `verify-client-packages.ts` 会放它过关，只有真正跑一次 `ui-chat/client` 的 tsdown 构建才会报出来。

## 考虑过的替代方案

**不做共享事件，改为在每处可点元素上各长一个专用拦截口。** 已否决：这会把认领、转交、失败补救三套规则按派发点数量翻倍，逼一个关心所有引用点击的监听者按站点数逐个注册，并让之后新增的每一处可点元素在有人想起来接线之前都是一个静默缺口。

**在 `ui-chat` 的 `dsh.client.external` 里声明 `@deepseek-ai/dsh-api-session-controller/client`，保留裸函数导入。** 已否决：`verify-client-packages.ts` 会拒收任何 `packages/client/` 之下、请求由另一个动态行提供的运行时 external 的清单，其报错文本直接点出两条合规出路（"import shared types only or call an injected Cordis service"）。`packages/api/session-controller/package.json` 与 `packages/api/workspace-controller/package.json` 确实声明了 `external`，但两者的清单路径都不以 `packages/client/` 开头，因此都走不到那条检查；而且根本不存在任何 `packages/client/*` 行向另一行声明 external 的先例。

**把 `ReferentKind` 收成封闭联合，让监听者的 switch 以 `assertNever` 收尾。** 已否决：这套词表是经声明合并跨包边界增长的，也包括仓库外插件，因此穷尽式 switch 会让每一个新增 kind 在早于它的构建上变成点击处理函数里的一次抛错。带文档说明的 `default` 转交，则让未知 kind 对该监听者只是空操作，点击照样落到默认动作上。

**让 `ReferentRef` 在身份之外一并携带被引用的内容。** 已否决：这会让每一次派发都付出一次读取，而其结果对绝大多数监听者都是丢弃；同时把一条持久化读取路径塞进一条只负责路由点击的缝隙里。

**不记忆默认动作的 promise，直接让 `ctx.waterfall` 的异常向外传播。** 已否决：那样一来，在 `next()` 成功之后于自身清理阶段抛错的监听者，要么让默认动作重跑一次——一次点击开出第二个打开器——要么用监听者的错误顶替默认动作的真实失败，把调用方需要分类的那个失败藏起来。

## 后果

`packages/api/session-controller/tests/referent.client.spec.ts` 钉住这条缝隙：无监听者时的默认动作、认领的监听者压住默认动作、经 `next()` 的转交、由外向内的注册顺序与 `prepend`、经 `ctx.effect` 的 disposer 摘除监听者、同步抛出与 promise 拒绝两条回落路径及其日志、转交之后才抛错时默认动作不重跑的保证，以及未识别的 `kind` 走转交而不是抛错。其 `ClientReferent` 代码块覆盖注册为 `ctx.referent`、默认与认领两条路径上与自由函数的一致性、派发用的是调用方 context 而非构造时的 context，以及所属 fiber 卸载时的注销。`packages/client/ui-chat/tests/apply-inject.client.spec.tsx` 钉住派发点：各自产出的确切 `ReferentRef`、工作区根目录以 `kind: 'dir'` 到达而其余路径一律 `kind: 'file'`，以及未被认领时回落到 `openWorkspacePath`、回落到 `window.open`、回落到 composer 的 not-found 提示。

`packages/test-support/client-runtime` 的 `SlotTestRuntime` 挂载的是生产实现 `ClientReferent` 而不是测试替身：它是一个无状态的派发薄封装，因此每个测试台都能获得真实的 `referent/open` waterfall 行为，也不必再维护一个需要同步跟进的桩件。

`packages/api/session-controller/README.md` 及其中文对照本拥有这套 API 的正文。`scripts/gen-cordis-catalog.ts` 把 `referent`（在 `SERVICE_WALK_EXEMPTIONS`）与 `referent/open`（在 `EVENT_WALK_EXEMPTIONS`）都登记为由该 README 拥有文档，因此两者都不会渲染进生成的目录：该服务是客户端面，而 host 面的投影从不接触浏览器 Context；该事件的契约写在 README 里，而不是在渲染投影能走到的逐事件位置上。

这条缝隙不携带任何文件附件界面，且这份缺席是决策而非遗漏：在当前基座上，文件附件归上游自己的通用文件上传（PR #2984）所有，因此本 fork 自己的文件族——`FileCard.tsx` 与 `FileCard.module.css`、用户气泡与 Assistant markdown 流里 `{kind: 'file'}` 内容分片的内联渲染、`loadFile`、`ISession.readFile`、会话事件投影的 file 分支、`attachment-labels.ts` 及其文件文案，以及唯一消费者就是文件卡的 `OpenReferent` 插槽属性——都不属于这条线。想找一个文件气泡卡片或一处客户端文件读取来挂监听者的维护者，在这里找不到。

`ReferentRef` 没有 `attachment` 字段。文件气泡卡片是该字段唯一的产出方，因此它在当前基座上什么都承载不了；需要持久化附件引用的监听者从 `target` 与 `sessionId` 自行解析。

一旦上游落地它自己的引用点击拦截口，`referent/open` 即退役：届时本 fork 把派发点适配到上游的形态并删除这条缝隙，而不是两套并行。核查方式是在 `upstream/master` 上 `git grep` `referent/open`、`dispatchReferentOpen`、`ReferentRef`、`ReferentKindMap` 四个名字；目前四者均为零。
