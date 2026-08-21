# Agent Note: A self-hosted web application in the shell's content column

Status: implemented

[English](2026-08-21-content-column-hosted-application.md) | 中文

## Problem

[`dsh-experimental-server-layout`](../../../../packages/experimental/server-layout/README.zh.md) 开出了 `content` 槽——一块位于 session 列表与 chat 栏之间的常驻工作面——但交付时是空的。服务形态产品线需要这一栏展示由部署方自己编写、自己部署的应用，与一个活跃的 agent 会话并排，而这个应用不应成为 harness 构建的一部分。

harness 里没有任何东西能提供任意目录。`dsh-host-frontend-static` 占据 webserver 的 fallback 座位，任何未命中都以 HTTP 200 返回 dsh SPA 的 index——这与被托管应用的需求正好相反：那里一个错误的资源路径必须以 404 的形式暴露出来。

## Decision

`@deepseek-ai/dsh-experimental-content-frame` 是围绕单一路径 `/content-app` 定义的双半边包。node 半边校验 `root` 并把该路径注册为具名 webserver prefix 路由；browser 半边把一个覆盖 `/content-app/` 的 iframe 注册进 `content` 槽。两个半边都从本包自己的 `src/route.ts` 导入这个常量，因此二者不可能漂移。

`root` 是必填、无默认值的 `Config` 字段——指向已存在目录的绝对路径，加载时经 `realpath` 解析一次；相对路径、不存在或非目录的值都会让该行在加载时失败。路由只接受 GET/HEAD（否则 405 并带 `Allow`），把目录解析到它的 `index.html`，对词法越界或符号链接越界返回 403，未命中时给出响亮的 404 而不是交回 fallback，携带覆盖字体与位图的 content-type 表，并设置 `cache-control: no-cache`。

### 信任姿态就是同源，而这正是设计本意

iframe 不带 `sandbox` 属性，因此被托管文档与外壳同源，并以外壳自身的权限触达 dsh HTTP API。这一栏里的第一方应用本就应当与 harness 对话，而 opaque origin 做不到：[API 请求信任校验](../../../../packages/client/connection/src/api-request-trust.ts)会拒绝 `null` origin，所以不带 `allow-same-origin` 的 `sandbox` 会让这个 frame 什么都做不了，而带上它则等于什么都没限制。因此本包选择**声明**这条边界，而不是假装在**强制**它：`root` 必须指向一个与 harness 同等可信的目录。不可信内容——agent 生成的页面、第三方产物——需要另一个带沙箱的插件，而不是本包上的一个开关。

### 这一栏的生命周期是外壳的声明，不是本包的选择

`content` 出厂时是 `session-maybe`，其占用者按 `dsh-client-ui-renderer` 中 `SessionMaybeEntry` 的 adoption 规则存活：页面启动时的那一代认领第一个到来的会话，此后每一次会话变化都是新的一代，因此被托管文档在用户第一次点击之后的每次切换都会重新加载。要让文档跨切换存活，需要一个 `root` 作用域的座位，而那是外壳的声明——[agent 驱动内容栏那篇 Agent Note](2026-08-21-agent-driven-content-column.zh.md) 改了它，并带来了这个座位才可能实现的 per-session frame 缓存。

## Alternatives considered

**通过已有的 `dsh-host-frontend-static` fallback 座位提供该目录。** 否决，因为该座位只有一个所有者且已归 dsh SPA，并且它的语义在这里是错的：未命中会变成 HTTP 200 的外壳，而它只有七项的 content-type 表会把字体与图标当作 `application/octet-stream` 送出，浏览器会静默丢弃。

**给 iframe 加沙箱，让应用通过 `postMessage` 向外壳索取所需能力。** 第一版否决：它把成本颠倒了——为部署方本就信任的内容，需要设计、版本化一座桥并让它与 API 同步演进——而 `allow-same-origin` 又会让这层沙箱形同虚设。沙箱档作为具名 non-goal 保留，等不可信内容真正出现时它属于另一个插件。

**在 browser 半边配置 URL，而不是从路由推导。** 否决，因为两个半边必须就同一条路径达成一致，而本包之外没有人寻址它；第二个配置点只可能是错的。

**从外壳的 workspace 读取 `root`，或从 profile 目录推断。** 否决，因为路由授予该目录的信任，使「推断位置」成为错误的便利：哪个目录承载外壳权限，必须被写下来。

**给 frame 固定像素高度或绝对定位。** 否决，因为外壳自己解算该栏的轨道宽度；frame 作为 flex 子项长满它，于是 resize 不需要两个包之间做任何协调。

## Consequences

content 栏在活跃会话旁展示了一个真实应用，部署方只需修改一个目录和一个 `cordis.yml` 值即可改变它展示的内容。dsh origin 现在会提供并非由 harness 构建的字节，其依据是一条被写明的信任边界，而不是被强制的边界。

第一版没有页面切换、没有 `postMessage` 通道、没有面向 agent 的接口——这一栏展示的内容对模型不可见，也无法从 session log 重建。[agent 驱动内容栏那篇 Agent Note](2026-08-21-agent-driven-content-column.zh.md) 就是这第二步：一个工具、一条 session 事件、一份 projection。`postMessage` 通道仍是具名 non-goal。

`overlay/content-column.patch.yml` 把外壳与本包组合在一起，并从 `DSH_CONTENT_APP_ROOT` 读取 `root`，因此同一个文件可以服务任意应用，e2e 也通过这个随包发布的 overlay 提供它的 fixture。

## Testing

`tests/content-app-route.client.spec.ts` 通过 vendored Loader 启动一份仅供测试的 `cordis.yml`，挂载真实 webserver，并全部经 HTTP 断言：裸前缀与子目录的入口文档解析、content type、百分号转义的文件名、HEAD、在 fallback 存活并能应答别处时仍给出响亮 404、路径穿越与符号链接越界的 403、带 `Allow` 的 405，以及 fiber 释放时的路由回收。`browser-plugin.client.spec.ts` 覆盖等待槽声明、注册及其注入的 URL、teardown 移除与字典；`content-frame.client.spec.tsx` 钉住渲染出的 `src`、locale 标题与缺席的 `sandbox` 属性。

`apps/web/tests/content-frame.e2e.ts` 让随包发布的 overlay 跑在真实组合上：frame 在 content 轨道内的几何、被托管文档及其自带样式表（浏览器对路由 content type 的裁决）、旁边打开一个会话时已缓存的 frame 仍保有它的文档，以及干净的控制台。
