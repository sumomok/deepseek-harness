# Agent Note: The agent drives the content column, and its frames outlive session switches

Status: implemented

[English](2026-08-21-agent-driven-content-column.md) | 中文

## Problem

[托管应用那篇 Agent Note](2026-08-21-content-column-hosted-application.zh.md) 把一个静态应用放进了外壳的 content 栏，同时点名了它自己的缺口：agent 无法驱动这个 frame，栏内展示什么对模型不可见，也无法从 session log 重建。这一栏永远只显示由配置选定的那一页。

有两件事必须一起改。agent 需要一条通路把选定的页面推到用户眼前，并且要持久记录下来，使重新打开的会话仍显示它当初展示的内容。而这个 frame 必须挺过会话切换：`session-maybe` 占用者在第一次认领之后每次切换都会被重挂，那会摧毁 iframe 的文档——而用户留在页面里的状态，恰恰是一块工作面存在的意义。

## Decision

`content` 现在是 **`root`** 槽。`content_show` 是 agent 对它的唯一控制权，`content/shown` 是这项控制写下的东西，`content` projection 是浏览器读到的东西。browser 半边为每个会话各保活一个 frame。

`Config` 在 `root` 之外长出三个字段：`pages`（至少一项 `{id, title, description, url}`，每个 `url` 都是同源路径）、可选的 `defaultPage`、以及 `cacheSize`（默认 3）。重复 id、保留 id `none`、带协议或主机名的 URL、指不到任何页面的 `defaultPage`、小于 1 的 `cacheSize`，各自都让该行在加载时失败。

### 一个工具、一条事件、一份 projection

`content_show(page)` 的描述里以 `id — title — description` 行携带完整页面清单，因此部署方的词汇不经 system prompt section 就能抵达模型。配置内的 id 追加 `content/shown` 并回复 `Now showing <title> in the content column.`；`none` 追加 `{ page: null }` 并回复 `Content column cleared.`；其余一律**不追加任何事件**，并把清单再回一遍，于是模型从结果里自纠错，而不是靠重试。

`content/shown` 按 agent 说出的样子记录 id，不作解析。`content` projection 以 last-wins 折叠它，并在 `wire.view` 里对照**当下运行的**页面清单解析成四支判别值：`shown`、`default`（未展示任何页面且配置了默认页）、`empty`、`missing`（该 id 已不指向任何页面）。这一划分让部署方可以改名或下线页面而不必重写历史，同时让浏览器拿到成品 `{url, title}` 直接渲染。

该事件不带 `ignorable` 标记：会话词汇表里没有它的运行时会拒绝整份日志，而不是悄悄丢掉一次状态变更。

### browser 半边收不到任何 cordis 配置

boot manifest 携带的是插件名，不是它们的 `config` 块——`BootPluginRow` 就是 `{id, inject, immediately}`，而 `loader.create({ name })` 就是浏览器侧建立条目的全部调用。因此，browser 必须遵守的 `Config` 字段只能**被提供给**它。node 半边为此认领第二条 exact 路由 `/content-frame/settings`，回复 `cacheSize` 与解析后的 `defaultPage`；browser 半边在认领槽位之前于 `apply` 里读它，读不到或不可用就让该行失败。这既让 `cacheSize` 保持为真正的配置字段而不是常量，也让 per-session 的 projection 不必背负部署级的值。

### 两条浏览器事实决定了整个缓存设计

两者都能在不移除元素的前提下杀死 iframe 的文档，而这一栏存在的意义正是防止这件事：

- **Blink 会把移出布局树的 iframe 摘下并在它回来时重载。** 因此这一栏把各个 frame 绝对定位堆叠，用 `visibility` 隐藏非当前项，绝不用 `display: none`。
- **React 会移动位置发生变化的 keyed 子节点，而移动 iframe 同样会重载它。** 因此渲染列表只追加：各项终生保持挂载序，recency 放在一个永不进入 DOM 的独立 `order` 列表里。逐出只删除一项，幸存者的相对位置分毫不动。

`foldFrames` 就是这个折叠的纯函数形态：再次活跃的会话只在 `order` 里移动；活跃但换了页面的会话只被替换 entry 的 URL，于是它的 frame 原地导航；当前会话永远不是被逐出的那个。无会话状态是保留键 `''` 下的一个普通缓存项，因此默认页也能挺过「途经一个会话再回来」。

组件通过 `useSessions` 读取当前会话与它的 projection 值——那是 root scope 的标准 hook，其 `SessionListState` 本就携带 `current` 与每会话的 `projectionValues`。没有注册方私有的 observable，也没有 hooks compartment：框架 hook 是数据获取阶梯的第一级，而它已经够到了这一栏需要的一切。

## Alternatives considered

**让 `content` 保持 `session-maybe`，每个会话各建一个 frame。** 否决：那正是本步要消除的行为。在 adoption 规则下，托管文档在第一次之后每次切换都会死，包这一侧再怎么小心也留不住页面状态。

**在浏览器侧从页面清单解析 `defaultPage`。** 否决：浏览器没有页面清单——它根本没有任何配置。放在 `wire.view` 里解析还带来一个好处：per-session 与「从未展示」两种状态共用同一个解析点。

**让 `cacheSize` 与默认页搭 projection 值的车。** 否决：它们是部署级常量，而这样做会让每个会话的整值都背上它们。projection 承载的是 per-session 状态。

**把 `page` 做成配置 id 的 schema `enum`。** 否决：参数校验在 `execute` 之前就拒绝，得到的是一条 schema 错误，而不是本工具的清单。一个能自纠错的失败，值得让参数保持普通字符串。

**给工具加一条 `postMessage` 回传通道，让 agent 得知用户在页面里做了什么。** 否决：那是另一项能力，有它自己的协议与版本演进；agent 能把一个页面推到用户眼前，本项主张到此为止。

**把本包拆成 host 半边与 client 半边两个包。** 暂时否决——两个半边围绕共享路由与同一个 types 模块定义，且本包只注册在一个 aggregate 里。代价见下方 Consequences。

## Consequences

这一栏现在是一个模型可见的面：`docs/tool-catalog.md` 不收录 `content_show`（生成器的完备性守卫只扫 `packages/*/tool-*`，本目录不匹配），因此包 README 的 Model Experience 一节与 `content-show-tool.client.spec.ts` 里的逐字 pin 才是钉住这些文本的东西。

`content` 变成 `root` scope，把一份代价转嫁给了此后每一位占用者：框架在会话切换时不清任何东西，因此持有 per-session 组件状态的占用者必须自己按 session id 分键。另外三栏保持各自的 session scope。

本包的 node 半边现在 import `dsh-tools`、`dsh-session`、`dsh-session-projection`，而它的 browser 半边 import client runtime——cordis `Context` merge 的两侧同处一包，之所以能编译，是因为被引用的工程之间经由声明文件相互到达，且 `skipLibCheck` 吃掉了冲突。测试文件会直接感到这一点：那里 `ctx.sessions` 解析成 client 的 `ISessions`，所以需要 host store 的 spec 通过 `ctx.get('sessions')` 加转型拿到它。若本包再长出更多 host 侧代码，正解是仓库里通行的形态——一个 host 包加一个 client 包——而不是抄 `api/remotes` 的双 tsconfig，`docs/development.md` 明令禁止复制那套结构。

## Testing

`content-show-tool.client.spec.ts` 在真实 `ToolRuntime` 上、对着真实 `Session` 跑这个工具：三条执行路径、每条往日志里写了什么（未知 id 什么都不写），以及逐字钉死的名称、描述、参数 schema、结果文本与失败消息。`content-projection.client.spec.ts` 在真实 registry 上折叠：初始态与清空态解析到默认页、跨无关事件的 last-wins、下线 id 读作 `missing`、以及 fiber 卸载后的移除。`frame-cache.client.spec.ts` 直接钉住那两条保住 DOM 的性质——挂载序永不变化、当前 frame 永不被逐出——而 `content-frame.client.spec.tsx` 用假的会话数据流驱动组件，断言切走再切回时元素恒等。

`apps/web/tests/content-show.e2e.ts` 用不同的 `content/shown` 事件种下两个会话，跑真实组合：每个会话各自从日志恢复各自的页面，而回到某个会话时找到的是同一个 iframe 元素、里面仍是它当初加载的那份文档——标记同时打在元素与它的 `contentWindow` 上，因此一次重载表现为标记丢失而不是元素丢失。
