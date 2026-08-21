# @deepseek-ai/dsh-experimental-content-frame

[English](README.md) | 中文

服务形态外壳 content 栏的第一位占用者：宿主机上的一个静态文件目录，通过一条 dsh 路由对外提供，并由一个铺满该栏的 iframe 呈现。里面的应用由运行 harness 的人自己编写和部署——本包既不构建它，也不关心它用什么框架。

两个半边围绕同一条路径 `/content-app` 定义：node 半边把它注册为指向配置目录的 webserver prefix 路由；browser 半边把一个指向 `/content-app/` 的 iframe 注册进 [`server-layout`](../server-layout/README.zh.md) 的 `content` 槽。`content` 是 `single` + `session-maybe` 槽，因此这个 frame 是该栏唯一的占用者；而一个 frame 能活多久由渲染器的 adoption 规则决定：页面启动时的那一代会**认领**用户打开的第一个会话，因此应用能挺过这一次点击，此后每一次会话变化都会挂载新的 frame，并让应用重新加载。

## 信任边界

**被托管的应用拥有与外壳相同的权限。** 它由 dsh 同源提供，且 iframe 不带 `sandbox` 属性，这使文档与外壳同源：它可以直接调用 dsh HTTP API——会话、工具、设置，浏览器能触及的一切——无需任何额外授权。因此 `root` 必须指向一个「与 harness 本身同等可信」的目录。

这是设计本意而非疏漏。content 栏里的第一方应用本就应当与 harness 对话，而 opaque origin 做不到：API 的 Origin 校验会拒绝 `null`，所以不带 `allow-same-origin` 的 `sandbox` 会让这个 frame 什么都做不了，带上它则等于什么都没限制。要托管**不该**拥有这份权限的内容——agent 生成的页面、第三方产物、用户随手投放的东西——需要另一个带沙箱的插件，而不是本包上的一个开关。

## 提供文件

`root` 必填且无默认值：部署方托管哪个应用，正是本插件承担的全部决策。它必须是指向已存在目录的绝对路径；否则该行在加载时就失败，而不是提供一个空 frame。该路径经 `realpath` 解析一次，之后每个请求都对照这个解析结果校验。

这条路由刻意不同于占据 webserver fallback 座位的 dsh SPA dist 服务：

- **未命中即 404，绝不回落到 index。** 回落会让一个错误的资源路径拿到 HTTP 200 的 dsh 外壳，故障只会在 iframe 里表现为空白页，而网络日志里读不出任何线索。
- **content type 覆盖真实的静态构建产物**——四种字体格式、位图与图标，以及 HTML/JS/CSS/JSON。未知扩展名为 `application/octet-stream`。
- **路径穿越与符号链接越界均为 403。** 词法路径必须落在 root 内，文件的真实路径同样必须落在 root 内，因此目录里被植入的符号链接读不到外面。
- **目录解析到自身的 `index.html`**，裸前缀也一样；没有 index 的目录是 404。
- **只接受 GET 与 HEAD**；其余为 405，并带 `Allow: GET, HEAD`。
- **`cache-control: no-cache`**，因为该目录在固定 URL 下就地更新，缓存住的入口文档会持续提供上一次构建的结果。

## 组合方式

本包与外壳都不属于任何出厂 bundle。`overlay/content-column.patch.yml` 把两者一并叠加到 Web 形态上——外壳替换 `ui-layout`，本行占据它开出的那一栏：

```yaml
- id: ui-layout
  name: '@deepseek-ai/dsh-client-ui-layout'
  disabled: true

- insert:
    - id: server-layout
      name: '@deepseek-ai/dsh-experimental-server-layout'
    - id: content-frame
      name: '@deepseek-ai/dsh-experimental-content-frame'
      config:
        root: !!js process.env.DSH_CONTENT_APP_ROOT
```

用 `dsh --profile web --patch <path>` 应用。overlay 从环境变量读取目录，使同一个文件可以服务任意应用；托管固定应用的部署把字面绝对路径写在那里即可。两个包都必须能从 profile 目录解析到——对树外插件而言即 `dsh plugin --profile web add <path>` 或等价的链接；发布 bundle 不得声明实验性包。

## Model Experience

无，因为本包只是把一个由部署方配置的目录提供给一个浏览器 iframe，这里没有任何东西抵达模型请求。

#### KV Cache effect

无；本包既不组装也不发送模型请求。

## Known Limitations and Deferred Work

- **会话变化会让应用重新加载** —— 第一次认领之后，`session-maybe` 的行为与严格 session 作用域一致：此后每一次切换渲染器都会挂载一个新的 frame，被托管应用此前持有的状态随之消失。需要跨切换存活的东西属于应用自己那一侧（它自己的服务端、`localStorage`、dsh API），而不属于它的页面。要让这一栏活得比会话更久，需要一个 `root` 作用域的座位——那是外壳的声明，不归本包改动。
- **一个应用、一个页面** —— 路由只提供单个配置目录，栏内展示它的入口文档。没有页面切换、没有第二个应用，也无法从外壳寻址被托管应用的子路径。
- **frame 与外壳之间没有通道** —— 没有 `postMessage` 协议、没有共享状态，被托管的应用无法请求外壳打开某个会话，外壳也无法告知它当前选中了什么。该应用回到 harness 的唯一通路是它自行调用的 dsh HTTP API。
- **agent 无法驱动这个 frame** —— 没有工具、没有 session 事件、没有 projection。栏内呈现的内容对模型不可见，也无法从 session log 重建。
- **没有面向不可信内容的沙箱档** —— 见上文信任边界。托管不应携带外壳权限的内容属于另一个插件，本包不为此提供开关。
- **未被 assembled snapshot 覆盖** —— 浏览器侧证据是针对真实组合运行的 Playwright 场景，而非录制的 transcript；snapshot 各条投影的是模型可见与会话输出，而本包两者皆无。
