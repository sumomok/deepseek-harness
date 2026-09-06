# Agent Note: 把 server-console 线并进 0.1.2-rc.1 基座

Status: implemented

[English](2026-09-06-console-merge-forward.md) | 中文

## Problem

两条长期分支已经落在不同的上游基座上。`product/server-console` 在一个 rc.1 之前的基座上承载着服务形态外壳——侧栏替换、内容栏的 `component` 类目、部署路径前缀、业务后端读取。眼手线早已迁到 `0.1.2-rc.1`，中间隔着约 1800 个上游提交：console 线改过的整包在那里已经不存在（`packages/host/apiproxy`、`packages/client/runtime`、整棵 `examples/`），浏览器半边被启动令牌把守，输入框也从表单控件变成了 contenteditable 面。

逐文件合并解决不了这件事。上游基座文件里的冲突不是同一个决定的两种写法：一侧是当下的基座，另一侧是对着一个已经消失的基座做出的改动，所以正确的解法是找到那段代码今天住在哪里，再把决定搬过去。若按文本合并了事，产物能编译、能启动，然后在没人看的地方出问题：路径前缀下寻址到 origin 根的 URL、因为被禁用的一行如今是硬依赖而根本画不出来的页面、被仓库当作损坏而拒收的种子会话。

## Decision

**每个冲突按类别解决，类别决定哪一侧是基线。** 上游基座文件取 rc.1 一侧，再把 console 的改动按语义搬上去。生成文档取任一侧并重新生成。`pnpm-lock.yaml` 取我们这侧并重新安装。`packages/experimental/server-sidebar` 取 console 的结构，并重新拿回本线的 rc.1 适配。其余每一个实验包、每一个 `apps/web` 测试都两侧全留。

### 三处搬到已消失的包上的移植

`packages/host/apiproxy` 没了。它的 fetch 客户端那套部署基址行为——基址带尾斜杠，私有的路径拼接先剥掉前导斜杠，好让前缀被延长而不是被顶替——如今分住两处。`packages/client/connection/src/client/rpc.ts:44` 用 `clientUrl(`${channel}/${endpoint}`)` 构造上行，自己不再有 `resolveBase()`；`packages/api/gateway/src/client/stream-client.ts` 承载下行，其 `remoteStreamUrl()` 把 `REMOTE_STREAM_MUX_PATH` 经 `clientUrl` 解析后再把协议换成 `ws:`/`wss:`。于是 Gateway 声明 `@deepseek-ai/dsh-client-connection/client` 为 `dsh.client.external`——它可以这么做，因为它不是 `packages/client/` 下的一行。

`packages/client/runtime` 没了：`ClientContext` 就是 `@deepseek-ai/cordis` 的 `Context`，`SlotRegistry` 来自 `@deepseek-ai/dsh-client-ui-renderer/client`，`SessionId` 来自 `@deepseek-ai/dsh-session/types`。

整棵 `examples/` 没了：可运行配置住在 `apps/cli/config/examples/`，快照泳道住在 `snapshots/`。`examples/content-console/` 原地保留，console 线加在那份已删除的根清单里的五个工作区依赖，移进它自己的 `examples/content-console/package.json`。它在这个基座上处于休眠：不是工作区成员，不在 `vitest.snapshot.config.ts` 里，而且它点名的 `@deepseek-ai/dsh-acp-demo` 已经不存在——把它重新安置到 `snapshots/` 下不属于这次合并。

### 部署前缀在 rc.1 基座上的代价

`packages/client/modules/src/index.ts` 仍以根绝对形式铸造 combo 路由，并只在页面真正读取它的那一个点上投影成页面相对 URL：`pageUrl()` 为图行和批描述符剥掉前导斜杠，而被服务的响应表仍以根绝对路由为键。打进产物的 `sourceMappingURL` 保留路由写法，所以 `packages/client/modules/tests/node-half.client.spec.ts` 用 `routeOf()` 把两者对上。

`packages/host/frontend-static/src/index.ts` 会往它渲染的每一份首页里注入 `<base href="/">`，位置在 `webserver/index-inject` 贡献的各行之前。一份文档只认一个 base，且解析器只认树序里的第一个，所以那个默认值会悄悄顶替掉 `dsh-experimental-server-base` 注入的前缀。现在 dist 服务器只往自己不带 base 的文档里注入默认值，这就是两个包之间耦合的全部。

`packages/client/hmr` 根本不需要部署基址助手。rc.1 不允许 `packages/client/` 下的包对另一个 client 行声明运行期 external，而以相对写法打开的 `EventSource` 由浏览器按文档 base 解析——与 `clientUrl` 所做的解析相同，只是由页面来做。

### console 线新增的四个包

`biz-backend`、`component-kit`、`component-surface`、`server-base` 被搬到 rc.1 的客户端 API 上（`session.snapshotEvents()`、`ToolCallId`、来自 `@deepseek-ai/dsh-client-ui-chat/client` 的 `CommandRowProps`、`contentSurface` 折叠），也搬到它的包规则上：跟随根版本号，且 `./invariant` 只为真正校验自有关系的伴生入口发布。其中三个发布的伴生入口 install 函数是空的，rc.1 直接拒绝，于是伴生入口连同其接线一并删除，每个 README 用一行说明本包为什么不发布伴生入口。`component-kit` 内嵌的 `element-ui.css` 按名字从 `client/ui-theme` 的样式表契约里豁免——那些契约管的是本产品自己的绘制规则。

### 浏览器泳道要学会的事

console 线带来的 `apps/web` 场景，写的时候面对的是没有启动令牌闸、输入框是 `<textarea>`、路由表也不一样的基座。每一处都是适配而不是放宽：场景先经 `scaffold.authenticatedUrl` 建立会话（`base-path.e2e.ts` 经代理进行，好让 cookie 绑定到标签页实际使用的 authority）；输入框是 `[data-composer-input]`，经 `writeComposerDraft` 驱动；RPC 探针问的是 `/api/session/list`；唯一的 WebSocket 下行是 `/api/remote.mux`；导出控制器是抓取而不是探测；应用批次以 preload 链接而不是第二个阻塞解析的脚本进入 head；种子里的 `tool/result` 带上有身份的 message，否则仓库会把整个会话判为损坏；折叠的回合过程在读取其中的上下文行之前先展开。

有四份组合不再禁用 `@deepseek-ai/dsh-client-ui-workspace`：出厂的 `packages/experimental/server-sidebar/overlay/customer.patch.yml`，以及三份测试 overlay `apps/web/tests/server-sidebar.overlay.yml`、`server-sidebar-homepage.overlay.yml`、`server-sidebar-views.overlay.yml`。在 rc.1 上 `dsh-client-ui-conversation` 把 `uiWorkspace` 写在 `inject` 里，并在 `apply()` 中取用该服务，禁用那一行会让整条对话栏一直挂起、页面什么都画不出来。

这改变的不只是测试组合的内容，也包括客户部署实际装载的内容。hero 阶段的工作区 chip 及其选择菜单，从「根本不装载」变成了「装载、挂载、再用 CSS 藏起来」：`ui-workspace` 的 `conversation.hero.workspace` 注册如今真的落地，chip 带着真实的 Workspace 标题，选择菜单也活在 `display: none` 背后。唯一的屏障是 `terminology-guard.ts` 的 `heroWorkspaceRow` 规则——这正是那条规则要用「元素存在且不可见」而不是只用「不可见」来断言的原因，也是出厂 overlay 要在原先那行禁用行的位置留一段注释说明缘由的原因。

## Alternatives considered

**把 console 线 rebase 到 rc.1 而不是合并。** 否决：console 线是一条永不并回 `develop` 的长期分支，它的历史就是这套部署所依赖的产品决策记录。rebase 等于把这些决策逐个提交地改写到它们本不面向的基座上，且中途没有任何一个可测试的树状态。

**保留 `packages/host/apiproxy` 的载体当兼容垫片。** 否决：它被上游删除，正是因为 Gateway 流客户端取代了它。复活它等于在树里留下第二条 RPC 载体，而其唯一消费者的移植已另有归属；发布前的立场是修引用，而不是留被引用者。

**把 `client-connection` 塞进平台模块表，好让 `client/hmr` 拿到部署基址助手。** 否决：那张种子表是外壳的共享平台（React、Cordis、store、槽注册表），开发通道的一个 URL 不值得把一个功能包搬进去。相对解析本就是 base 元素的用途。

**继续禁用 `ui-workspace`，另外提供一个 `uiWorkspace` 替身。** 否决：替身得满足对话栏真正会调用的服务，于是它就是一个出厂包的第二实现，还要长期跟着上游走——而它想省掉的，只是两处 guard 早已藏掉的界面。

**用机器翻译从英文重新生成那几份生成目录的中文侧。** 否决：那些文件是靠配对维护的经评审对侧，它们自己的文件头就写明了流程——先重生成英文，再把中文侧带上。本次合并新增的行由人工镜像，配对记录重新记账。

## Consequences

console 线的浏览器场景现在跑在 rc.1 外壳上，这是让它的部署决策保持可检验的唯一办法：前缀场景证明没有任何请求落到 origin 根，侧栏与组件场景证明 console 组合仍能启动和绘制。代价是其中四个场景开始依赖 rc.1 外壳的细节——输入框的属性、回合过程的折叠、启动令牌交换——上游日后再动一次就会再挪一次。

`examples/content-console` 这棵树处于休眠：带着，但不跑，也没有门禁看着它。它保持为一个待拍的决定，而不是一次无声的删除。

有两类故障现在被覆盖住了。dist 服务器把自己的 `<base>` 注在部署的那一个之前，在前缀下就是一张白页，而 `packages/experimental/server-base/tests/server-base.spec.ts` 会数送出文档里的 base 元素个数。数个数就是全部覆盖：该文件里那几条顺序用例在存在两个 base 时同样会通过——两个都排在资源之前——所以一旦 dist 服务器的让位判断被改回去，只有这一条计数断言会失败。一个组合禁用了另一行所注入服务的提供者，会什么都不画且哪里都不报错，views 场景就是下次抓住它的东西。

有两处根绝对地址维持原样，且都早于这次合并。combo 映射的 `sources[]` 条目是以根绝对形式铸造的（`packages/client/modules/src/index.ts` 里 `comboSource` 的回退名与 `comboSectionMap` 的重定位基址），所以在前缀下调试器会把它们解析到 origin 根——这是展示路径，不是页面真正发出的请求。`apps/web/public/manifest.webmanifest` 把 `id`、`start_url`、`scope` 都写成 `/`，图标是 `/favicon.svg`，而 `apps/pwa/src/index.ts` 注入的是 `<link rel="manifest" href="/manifest.webmanifest">`，渲染出的 `start_url` 也一样，所以在前缀下安装的 PWA 会把作用域圈到 origin 根。

还有两条读本分支 CI 结果时需要知道的门禁事实。`pnpm run verify-client-domain-graph` 退出码 1，三处违规全是 `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` 导入 `../input/editor/…`；`git diff 467f171a9b..HEAD` 对该包与该门禁脚本都为空，所以它在父提交上同样失败。另外，`config-catalog`、`capability-seams`、`event-producer-consumer`、`persistence-catalog` 这四份只有英文侧是生成的——中文侧靠人工镜像，而 `verify-translation-pairing` 比对的是 git blob 哈希而不是内容，因此没有任何门禁能发现一份已经偏离生成器输出的中文侧。

## Testing

`pnpm run test` 留下五个失败文件，全部由环境决定且与本次合并无关（`git diff 467f171a9b..HEAD` 对它们全为空）：Python 代码运行时需要 CPython ≥ 3.10 而本机是 3.9.6，`spill-local` 的边界用例取决于文件系统 mtime 粒度，另有两个 `scripts/` 用例读取 pid 与终端配色警告。`pnpm run duplication` 报告六处克隆，其中四处在眼手侧父提交上已存在、两处在 console 侧父提交上已存在——合并没有新增任何一处，还消掉了一处。
