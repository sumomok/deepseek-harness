# @deepseek-ai/dsh-experimental-content-frame

[English](README.md) | 中文

服务形态外壳 content 栏的 `page` 类型，也是控制这一栏的两条通路：宿主机上的一个静态文件目录，通过一条 dsh 路由对外提供，由一个铺满该栏的 iframe 呈现——栏里放部署方配置的哪一个页面，既可以由 agent 通过 `content_show` 工具决定，也可以由用户直接在侧边栏的页面导航菜单（`@deepseek-ai/dsh-experimental-server-sidebar`）里点选，后者会执行 `show-content-page` 命令。里面的应用由运行 harness 的人自己编写和部署；本包既不构建它，也不关心它用什么框架。

六块拼图，各承担一项决策。node 半边把配置目录挂在 `/content-app` 下提供。`content_show` 把部署方的页面清单交给模型选择，并在它选定时追加 `content/shown`。`show-content-page` 把同一份页面清单交给执行命令的 UI，并在用户选定时追加同一个事件。`page` extractor 把每个被展示的 id 变成 [`content-surface`](../content-surface/README.zh.md) 那条流里的一条 entry，对照当下运行的页面清单解析。`content` projection 以同样方式解析最后记录的那个 id，供想要「这一栏当前的页面」而非其历史的消费者使用。browser 半边认领这一栏 kind 槽的 `page` key，并为每个（会话，页面）组合各保活一个 frame。

## 信任边界

**被托管的页面拥有与外壳相同的权限。** 它们由 dsh 同源提供，且 iframe 不带 `sandbox` 属性，这使每个文档都与外壳同源：它可以直接调用 dsh HTTP API——会话、工具、设置，浏览器能触及的一切——无需任何额外授权。因此 `root` 必须指向一个「与 harness 本身同等可信」的目录。

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

第二条 exact 路由 `/content-frame/settings` 把 browser 半边必须遵守的配置值——`cacheSize` 与整份 `pages` 清单——提供给它。它之所以存在，是因为 browser 半边根本收不到任何 cordis 配置：boot manifest 携带的是插件名，不是它们的 `config` 块。settings 文档不可达或不可用时，browser 那一行直接失败，而不是让这一栏跑在一个没人选过的上限上。页面清单也走这同一条路由而不是新开一条——侧边栏的页面导航菜单是这条路由的第二个读取方，它按约定（写死路由路径与 JSON 形状）而非导入本包来匹配这份数据，因为跨包直接导入符号并非本仓库为两个客户端相邻插件设计的耦合方式。

## 谁把页面放上台面

`content/shown` 携带一个 `by: 'agent' | 'user'` 字段：`content_show`（模型的工具）写 `'agent'`，`show-content-page`（侧边栏菜单的命令）写 `'user'`。这个字段出现之前写下的日志两者都没有，任何读取方都把这种情况默认成 `'agent'`——那时候工具是唯一的写入者。两个写入者追加的是同一类型下完全相同的事件，因此用户点开的页面与模型选定的页面，在 `content-surface` 的流里占据同一条 entry（按页面 id 去重），在 `content` projection 里也是同一个值；用哪个既有 kind、哪个既有 projection 都不因写入者而变。

`content` projection 刻意丢弃了 `by`——它回答的是「这一栏当前展示什么」，不需要区分写入者——而 `page` extractor 在其存储值与解析后的 payload 里都保留了它，留给以后想要展示这一区别的渲染器；目前的 frame 渲染器还没有这么做（见「已知限制」）。

## agent 可展示的页面

`pages` 是这一栏在部署里的全部词汇，且至少要有一项——`content_show` 存在的意义就是在其中挑选。每个页面声明 agent 传入的 `id`、用户读到的 `title`、以 agent 的语汇写成的 `description`（它会成为工具描述里的清单行），以及同源的 `url`。带协议或主机名的 URL 会让该行在加载时失败：这个 frame 携带外壳权限，因此只能寻址 dsh 同源地址。

`defaultPage` 指定 `content` projection 在 agent 尚未选择任何页面时、以及它清空这一栏之后所报告的页面。**这一栏本身不展示它**——它列出的是某个会话产生了什么，而默认页面并非任何会话产生的东西，因此什么都没展示过的会话得到的是这一栏的空状态提示。`id` 不得为 `none`，那是工具保留给「清空」的。

`homePage` 指定 `@deepseek-ai/dsh-experimental-server-sidebar` 的工作台第一次落到空稿时自动展示的页面。与 `defaultPage` 不同，这不是一个被动读取的 projection 值——侧栏会真的发起一次 `/show-content-page` 调用，因此这一栏确实会展示该页面，并留下通常那条 `content/shown` 日志记录。确切差异见本包 `Config` 类型的说明；侧栏包是这个字段唯一的消费者。

## 每个（会话，页面）各一个活着的 frame

这一栏的 kind 槽是 `root` 作用域，且别的 kind 上台时这一栏仍保持本座位挂载，因此 browser 半边把每个被缓存的 frame 全部挂着，只显示当前那一个。用户回到某个页面时，它还是被离开时的样子——滚动位置、表单状态、文档持有的一切——因为那个元素从未被销毁；换页面、换成图表、换会话都一样。`cacheSize` 限定能存活多少个，按（会话，页面）组合计；超出后最久未展示的那个被丢弃，再次回来时重新加载。正在展示的 frame 永远不会是被丢弃的那个。

## 在聊天记录里隐藏 `show-content-page` 命令

用户点一次页面就是一次命令调用，每条命令都会在日志上留下一对 `command/run`/`command/done`——侧栏菜单和一切回放都依赖这条持久记录。放任不管的话，`dsh-client-ui-conversation` 的聊天视图会把这一对渲染成一条普通的命令行（"Now showing `<title>` in the content column."）：对 agent 自己发出的命令这条信息有意义，对用户刚点出来的这次点击却是多余的。browser 半边在 `conversation.chat.commandview` 这个每条命令行都要经过的 keyed 槽的 `show-content-page` 键位上注册一个空组件，让这一行的业务内容永不出现。

一个空组件仍然会在聊天列里留下一个零高度的 flex 项，而列的 `gap: 16px` 不管高度多少都会为它留一份间距。browser 半边因此还注入了一条 CSS 规则，把这一整行折叠掉（`[data-chat-flow-kind="command"]:has([data-slot="conversation.chat.commandview"]:empty)`），它耦合了两个本包并不拥有的 DOM 结构——`dsh-client-ui-conversation` 的 `data-chat-flow-kind` 属性和 `dsh-client-ui-renderer` 的 `data-slot` 锚点包装——见 Known Limitations。

## 组合方式

本包与外壳都不属于任何出厂 bundle。`overlay/content-column.patch.yml` 把四者一并叠加到 Web 形态上——外壳替换 `ui-layout`，`content-surface` 把该会话已记录的事件折叠成 entry 流，`content-column` 占据外壳开出的那一栏，本行贡献 `page` 类型：

```yaml
- id: ui-layout
  name: '@deepseek-ai/dsh-client-ui-layout'
  disabled: true

- insert:
    - id: server-layout
      name: '@deepseek-ai/dsh-experimental-server-layout'
    - id: content-surface
      name: '@deepseek-ai/dsh-experimental-content-surface'
    - id: content-column
      name: '@deepseek-ai/dsh-experimental-content-column'
    - id: content-frame
      name: '@deepseek-ai/dsh-experimental-content-frame'
      config:
        root: !!js process.env.DSH_CONTENT_APP_ROOT
        pages:
          - id: home
            title: Home
            description: The hosted application's entry page.
            url: /content-app/
        defaultPage: home
        homePage: home
```

用 `dsh --profile web --patch <path>` 应用。overlay 从环境变量读取目录，使同一个文件可以服务任意应用；托管固定应用的部署把字面绝对路径写在那里即可。所有包都必须能从 profile 目录解析到——对树外插件而言即 `dsh plugin --profile web add <path>` 或等价的链接；发布 bundle 不得声明实验性包。

工具、命令、projection 与 page extractor 都是可选子节点：没有 `ctx.tools`、`ctx.commands`、`ctx.sessionProjections` 或 `ctx.contentSurface` 的组合仍保留路由，只是这一栏里什么都不显示；任何一项缺席都不会让该行失败。

## Model Experience

### The `content_show` offer

#### What the model sees

一个工具 `content_show`，一个必填的 `string` 参数 `page`。它的描述以 `id — title — description` 行携带部署方的完整页面清单，因此不需要别的东西告诉模型可以展示什么——本包不贡献任何 system prompt section。

#### Token effect

一段固定描述，加每个配置页面一行清单，出现在工具可见的每一次请求里。十个页面约合十行短文本。

#### KV Cache effect

描述在该行加载时装配一次，在一个部署内不会变化，因此工具块在各次请求间逐字节一致，前缀得以保持。编辑 `pages` 会改变这个块并使其之后的复用失效——那是一次配置改动，不是会话能触发的事情。

### Tool-call result and column state

#### What the model sees

调用成功时回复恰好是 `Now showing <title> in the content column.` 或 `Content column cleared.`。部署未配置的 id 回复 `Error: unknown page "<id>". Available pages:` 后接完整清单，因此模型从结果里自纠错，而不是靠猜测重试；这次调用不改变任何东西。没有归属会话的调用回复 `Error: content_show requires an owning agent session`。每次成功调用追加的 `content/shown` 事件属于 UI 与重放状态，不是第二条模型消息。

#### Token effect

成功路径小而定形。被拒绝时多付一份清单，这正是让它可自纠错的代价。

#### KV Cache effect

只追加；结果跟在可复用的请求前缀之后，不会使任何已缓存内容失效。

## Known Limitations and Deferred Work

- **`content/shown` 是读取时必需的** —— 该事件不带 `ignorable` 标记，因此会话词汇表里没有它的运行时会拒绝整份日志，而不是跳过这条事件。本仓库的任何构建都认识这个类型；单独构建、且排除了本包的运行时则不认识。
- **on-display 规则不区分写入者** —— [`content-surface`](../content-surface/README.zh.md) 那条与 kind 无关的 prompt 规则告诉模型，要在原地更新「你已经产出并放上台面的东西」。用户通过侧边栏菜单打开的页面，与 agent 选定的页面在「放上台面」这件事上完全一样，因此这条规则的措辞仍然读起来像是 agent 产出的。`by` 字段的存在是为了让以后的 prompt 或渲染器能够区分这一点；规则本身的措辞刻意保持不变（它是一段钉死、经过测量的文本——见其自身的模块文档），不为这一种情况单独打补丁。
- **`page` extractor 解析出的 `by` 尚未被渲染** —— 浏览器这一栏的 frame 渲染器不论谁展示的都画同一个 iframe。这个字段被一路带到 payload 里，是为了让以后的改动不用再一次提升 `dataVersion` 就能展示它。
- **一个目录、一个源** —— 路由只提供单个配置目录，且每个页面都必须是 dsh 同源内的路径。没有第二个应用、没有外部 URL，agent 也无法指名部署未配置的页面。
- **frame 与外壳之间没有通道** —— 没有 `postMessage` 协议、没有共享状态，被托管的页面也无法回报用户在里面做了什么。agent 能把一个页面推到用户眼前，却无法得知之后发生了什么，除非有人告诉它。该页面回到 harness 的唯一通路是它自行调用的 dsh HTTP API。
- **`content` projection 在树内没有消费者** —— 这一栏改读 entry 流，`content` 只作为「已解析的当前页面」值（`shown`/`default`/`empty`/`missing`）留给其他读取 wire 的一方。它也是 `defaultPage` 唯一还会出现的地方。
- **frame 缓存按浏览器标签页计，且在时间上无上限** —— `cacheSize` 限定的是同时存活多少个 frame，不是存活多久。一个长期打开的标签页会让被缓存的文档持续运行，包括它们持有的轮询与套接字。
- **settings 路由假定存在 HTTP 载体** —— browser 半边以页面 origin 为基准请求 `/content-frame/settings`。如果某种传输提供了外壳却没有把 harness 暴露在 HTTP 上，该行会失败——与 iframe 自己那条路由的处境相同。
- **没有面向不可信内容的沙箱档** —— 见上文信任边界。托管不应携带外壳权限的内容属于另一个插件，本包不为此提供开关。
- **未被 assembled snapshot 覆盖** —— 浏览器侧证据是针对真实组合运行的 Playwright 场景，模型可见文本则由单测逐字钉住；snapshot 各条重放的是出厂组合，而出厂组合不会组合实验性行。
- **空命令行的 CSS 折叠是 DOM 结构耦合，不是契约** —— 它依赖 `dsh-client-ui-conversation` 的 `data-chat-flow-kind` 属性和 `dsh-client-ui-renderer` 的 `data-slot` 锚点包装，两者都不是本包拥有、也不是对方承诺维持的结构。任一形状将来发生变化都会悄悄解除这次折叠（该行连同它的 16px 间距一起重新出现），而不是显式报错；`server-sidebar.e2e.ts` 里断言该行始终不可见的场景是这个耦合唯一的绊线。
