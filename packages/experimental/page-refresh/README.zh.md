---
description: "服务端带着另一个构建回来时，让已打开的浏览器页面刷新一次——构建由所服务首页的启动图与外壳脚本比出——并用一条横幅显示页面的连接状态和刷新按钮；可配置何时检查构建、刷新延迟和连接提示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-page-refresh

[English](README.md) | 中文

## 概述

让已打开的控制台页面跟上服务端正在运行的构建。服务端升级并重启后，已打开的页面在重连时自己刷新一次，而不是用旧的客户端去配新的服务端；重启后仍是同一个构建时，什么都不变。一条横幅告诉访客连接断了、连接回来了、服务一直连不上，并提供刷新按钮。一个标签页对同一个构建最多自动刷新一次；那次刷新没能让它用上所服务的构建时，横幅改为提供刷新按钮。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

客户控制台通过 [`dsh-experimental-console-profile`](../console-profile/README.zh.md) 组合它，同时用一行把 `client-hmr` 关掉。

### 何时选用

部署需要已打开的页面在服务端升级后不靠访客手动刷新就能继续用时，选用它。组合它时要像控制台那样把 `client-hmr` 行禁用：那一行启用时，已打开的页面还会把新的插件包换进它已在运行的外壳，可能在构建检查刷新它之前就画不出来。开发时想要插件热替换的组合保留 `client-hmr`，不组合本包。这项决定及其证据见 [Agent Note](../../../.agents/notes/implemented/architecture/2026-10-02-console-reloads-on-a-new-build.zh.md)。

### 最小配置

```yaml
- insert:
    - id: page-refresh
      name: '@deepseek-ai/dsh-experimental-page-refresh'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `checkOnVisible` | `true` | 页面在连接状态下每次回到前台时也检查构建 |
| `reloadDelayMs` | `0` | 决定刷新到真正刷新之间的毫秒数；为正数时先显示「正在刷新」提示 |
| `disconnectNotice` | `true` | 显示连接断开、已重新连接、连不上服务三种提示 |
| `stuckAfterSeconds` | `60` | 浏览器在线时连接断开持续多少秒后，改为显示连不上服务的提示和刷新按钮 |

整个插件没有开关；不想要它的部署禁用这一行。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-page-refresh)是每个可接受字段的完整来源。

### 何时检查构建

页面与服务端的连接每建立一次——即 `connection/reset` 事件，第一次连接也算——检查一次；`checkOnVisible` 开启时，页面在连接状态下每次重新可见也检查一次。未连接的页面把检查留给下一次连接：宿主还在组合插件时已经在服务首页，那时的启动图只列出部分插件，而它要组合完全部插件之后才接受连接。同一时刻最多只有一次检查在进行：检查进行中又来一次触发时，会中止正在进行的请求并重新开始一次检查，所以结论反映最近一次触发时的服务端，一个永远不回应的请求也不会挡住下一次检查。

### 什么算一个构建

一个构建，是所服务首页赋给 `__DSH_BOOT__` 的启动图——每个客户端插件的 id 及其修订号，按集合比较，图里列出的顺序不起作用——再加上首页基准目录下各模块脚本的 URL，它们以构建哈希命名 web 外壳的主包。来自别处的模块脚本，例如浏览器扩展加进页面的脚本，不属于任何构建。页面在插件启动时记下自己的构建，只记一次。插件修订号由其包文件的大小和时间戳得出，所以重启后仍服务同样的文件，就是同一个构建；重新构建或升级之后则不是。

每次检查都请求文档被服务时的地址——导航条目的 URL 去掉片段——并带上 `cache: 'no-store'`、`redirect: 'manual'` 和页面自己的 cookie。只有类型为 `text/html` 的 `200` 应答、里面带着宿主渲染出的那段启动图标记、且条目列表有效并包含本插件，才算一个构建。其余任何应答——拒绝（例如浏览器会话过期时的 `401`）、重定向、网络失败、别的内容类型、缺失或损坏的启动图、不含本插件的启动图——都不能说明任何事：页面不刷新、不显示提示，原因只写进调试日志。

### 构建不同时会做什么

页面把它要为之刷新的那个构建记在本标签页的会话存储里，键为 `dsh-page-refresh:reloaded-for`，然后刷新；`reloadDelayMs` 为正数时等那么久再刷新。之后某次检查又遇到它记下的那个构建——说明那次刷新没让页面用上它——就改为在横幅里提供刷新，而不再自动刷新；不能读写会话存储的标签页也一样。检查遇到页面启动时的那个构建时，会清掉这条记录并撤回提供的刷新。输入框里的文字草稿在刷新后仍在：它在每次编辑时写入本地存储，并随所选对话一起恢复。

### 横幅

shell 的整框 `shell.overlay` 槽位里的一个条目，画在页面顶部居中，不挡输入框。它一次只显示一条提示，构建提示排在连接提示前面：

| 提示 | 中文 | 英文 |
|---|---|---|
| 构建不同，提供刷新 | 页面有新版本，请刷新后继续使用 + 刷新页面 | A new version is available. Reload the page to continue. + Reload page |
| 因 `reloadDelayMs` 延迟刷新 | 正在刷新页面… | Reloading… |
| 连接断开超过 800 毫秒 | 连接已断开，正在重新连接… | Connection lost, reconnecting… |
| 显示过断开提示后重新连上，持续 2 秒 | 已重新连接 | Reconnected |
| 浏览器在线而断开达到 `stuckAfterSeconds` | 暂时连不上服务 + 刷新页面 | Can't reach the service + Reload page |

只有页面连上过之后的断开才算。浏览器报告自己离线时，提示停留在正在重新连接。构建检查和连接提示只依赖连接服务；横幅另外等待槽位与 locale 服务，所以 React 树没画出来的页面照样检查构建、照样刷新。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

node 半边校验这四个字段，并通过 `webserver/index-inject` 把它们作为 `__DSH_PAGE_REFRESH_CONFIG__` 全局变量推进每一份渲染出的首页，因为浏览器半边拿不到 cordis 配置。它不注册路由：控制台前面的反向代理可能只把外壳自己的精确路径转给本进程，而构建检查自己读取首页。浏览器半边做任何事之前先校验这个全局变量；它缺失或越界时，失败的是整个页面的启动，而不只是这一行（见 [Known Limitations](#known-limitations-and-deferred-work)）。

浏览器半边的每一项不纯的操作——导航条目、启动全局变量、首页请求、会话存储、刷新、计时器、可见性和网络事件——都经过一个接口，它的生产实现绑定在 `window` 上，所以检查和提示可以在测试拼出来的页面上运行。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | node 半边：`Config` 与设置全局变量 |
| [`src/config.ts`](src/config.ts) | 两个半边共用的全局变量名与计时器上限 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器插件主体 |
| [`src/client/install.ts`](src/client/install.ts) | 把检查、提示与横幅接进同一个上下文 |
| [`src/client/identity.ts`](src/client/identity.ts) | 什么是一个构建，以及如何从所服务的首页里读出它 |
| [`src/client/check.ts`](src/client/check.ts) | 构建检查及其刷新防护 |
| [`src/client/notice.ts`](src/client/notice.ts) | 连接提示 |
| [`src/client/browser.ts`](src/client/browser.ts) | 页面操作 |
| [`src/client/PageRefreshBanner.tsx`](src/client/PageRefreshBanner.tsx) | 横幅 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Note](../../../.agents/notes/implemented/architecture/2026-10-02-console-reloads-on-a-new-build.zh.md)——控制台为什么刷新页面而不是热替换插件。
- [`dsh-experimental-console-profile`](../console-profile/README.zh.md)——挂载这一行的组合。
- [`dsh-client-hmr`](../../client/hmr/README.zh.md)——控制台关掉的插件热替换。
- [`dsh-client-modules`](../../client/modules/README.zh.md)——构建从中读出的启动图。
- [`dsh-experimental-server-layout`](../server-layout/README.zh.md)——画出横幅的那层浮层所在的控制台外壳。

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, prompt section, or result: its node half adds one settings global to the HTML a browser is served, and its browser half reloads the page and draws a banner, all outside any model request.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

以下约束对这一行的每一种组合都成立。

- **组合这一行之前就打开的页面不带它。** 这样的页面在升级后继续运行它的客户端，需要手动刷新一次；此后加载的每个页面都带着检查。
- **未发送的附件会在自动刷新时丢失。** 文字草稿会保留，但附在未发送消息上的图片和文件是浏览器对象，没有存储会保存它们，而检查不会为它们推迟刷新。
- **被拒绝或被重定向的首页会让页面停在旧客户端上。** 因浏览器会话 cookie 过期而答 `401` 的首页，或被进程前面的东西重定向的首页，都不能说明构建，所以页面既不刷新也不提供刷新；访客下一次手动刷新才能恢复。
- **内容不变的重新构建也会让已打开的页面刷新。** 插件修订号由包文件的大小和时间戳得出，而不是由内容得出，所以任何一次重新构建之后的重启都算不同的构建。
- **在运行中的目录树里构建，会让页面提前刷新到一个混合构建上。** 关掉 `client-hmr` 后，运行中的宿主一直服务它启动时加载的插件包，而外壳的首页每次请求都从磁盘读取。所以在运行中服务器所服务的目录树里构建，会让下一次检查把页面刷新到新外壳加旧插件包上，重启到新构建时又会再刷新一次。应在单独的目录树里构建，重启时再切换过去，镜像部署就是这样做的。
- **去掉这一行或给本包改名，需要手动刷新一次。** 检查在所服务的启动图里找的是页面客户端构建时的那个包名。不含它的启动图不能说明构建，因为仍在组合插件的宿主也会服务这样的图；所以部署去掉这一行、或某个构建用另一个包名列出本插件时，已打开的页面既不刷新也不提供刷新。
- **宿主拒绝的配置让每个页面启动失败，而宿主照常启动。** node 半边在宿主启动时校验这一行的配置。被拒绝的值让这一半处于未激活状态；宿主启动并不需要这一行，所以它只在 stderr 上输出一条启动警告，警告里带着校验错误。启动图仍列出浏览器半边，而首页里没有设置全局变量，于是浏览器半边激活失败，宿主服务的每个页面随之启动失败；浏览器的报错写明缺失的全局变量，以及发布它的 node 半边。
- **提供刷新要靠横幅。** React 树没画出来的页面上，自动刷新照样执行，但取代它的那个刷新提议——同一个构建第二次，或没有会话存储时——看不见。
- **没有装配级快照覆盖**——证据是本包的单元测试、针对 web 服务器首页渲染的真实组合测试、`page-refresh` web 场景，以及 `server-sidebar` web 场景里的控制台用例；快照泳道回放的是发布组合，而发布组合不包含实验性行。

**运行时不变式：** 不发布伴生入口。浏览器半边的状态是一个页面的横幅和一条会话存储记录，二者都由本包自己的测试检查；node 半边依据校验过的配置贡献一行首页注入，既不拥有会话事件，也不拥有持久数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
