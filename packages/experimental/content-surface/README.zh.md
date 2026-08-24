# @deepseek-ai/dsh-experimental-content-surface

[English](README.md) | 中文

服务形态外壳只开出一栏 content，而想要它的包不止一个。本行把这个独占座位变成一个路由器：宿主插件注册 **extractor**，各自认领自己早已记入日志的事件，本行再把它们折叠成每会话一条按类型分列的 **entry** 流。把它们画出来是 [`content-column`](../content-column/README.zh.md) 的事——两半之所以是两个包，是因为一个 Cordis 服务与一个浏览器插件无法共用同一个 Typert face。

这里没有任何新事实。每条 entry 都派生自别的包已经写进会话日志的东西——页面来自 `content/shown`，图表来自一次 `show_chart` 调用——因此这一栏仅凭日志即可重建，本包自己不追加任何会话事件。

## entry 流

一条 entry 是 `{ kind, entryId, seq, title, payload }`。`kind` 既指出产生它的 extractor，也指出画出它的客户端槽 key；`entryId` 是它**在该 kind 内**的身份，后来的记录若指名同一组合，就替换掉先前那条而不是再添一行。这正是「重绘的图表」和「重新展示的页面」各自只占一条 entry 的原因。发布出来的值把存活的 entry 按最新在前排列，因此在用户另选之前，这一栏展示的就是 `entries[0]`。

[子系统页](../../../docs/subsystems/content-surface.zh.md)载有 `ContentSurfaceExtractor`、`ContentSurfaceRecord` 与 `ContentSurfaceEntry` 的字面声明。

## `ContentSurfaceRegistry`（ctx key：`contentSurface`）

`ctx.contentSurface.register(extractor): () => void` 接收某个 kind 的全部贡献并返回 disposer（挂在调用方 fiber 上的 effect，因此某一行卸载时会带走它的 kind）：

- `kind` —— entry 的类型，也是其渲染器认领的 `content.surface.kind` key。
- `dataVersion` —— 所存 `data` 的失效锚点；存储形状或读取规则改变时递增它。
- `read(event)` —— 这条已提交事件所记录的草稿（`{ entryId, data }`），或 `undefined`。同步且纯粹：它运行在会话 projection 的 fold 里。
- `resolve(data)` —— 浏览器收到的 `{ title, payload }`，对照该 kind 宿主行**当下**所知计算得出。同步且纯粹：它运行在 projection 的 view 里，输出必须是纯 JSON。

事件按注册顺序抵达各个 extractor，第一份草稿胜出，因此两个 kind 不得认领同一条事件。registry 持有一个会话 projection `contentSurface`；某个 kind 的宿主行在这里要做的全部事情，就是注册它的 extractor。

### 注册时机自由，以及它的代价

projection registry 在注册那一刻固定一个 unit 的 fold 与 `stateVersion`，随后为每个会话缓存一份折叠单元，且永不回头重算。于是，若路由器在一个长期存在的 unit 内读取「活的」extractor 表，任何已经有缓存单元的会话都会**永久**丢失后来加入的那个 kind 的历史。

因此本 registry 在表每次变化时都注册一个**新的** unit。projection registry 会连同旧 unit 一起丢弃它的缓存单元，每个会话下一次被触及时便以新表从 `init` 重新折叠它完整的内存日志。`stateVersion` 从表派生——把排序后的 `kind@dataVersion` 列表求哈希——是为了在持久侧解决同一件事：在另一组 kind 下写出的 checkpoint 会被丢弃，而不是被向前套用成一条缺失了新 kind 全部发现的流。

唯一的代价是推送延迟。registry 只在驱动事件时发布变更值，因此在某个 kind 行被热加载时已经连着的浏览器，会一直读到旧的流，直到该会话的下一条事件。启动期的组合不会遇到这一点，HMR 会。

## 组合方式

本包与外壳都不属于任何出厂 bundle。[`overlay/full-surface.patch.yml`](overlay/full-surface.patch.yml) 组合出「全都要」的演示——外壳、这条 surface 的两半、[`content-frame`](../content-frame/README.zh.md) 基于托管应用提供的 `page` kind，以及 [`vue2-echarts-tool-poc`](../vue2-echarts-tool-poc/README.zh.md) 提供的 `chart` kind：

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
        pages: [...]
    - id: vue2-echarts-poc
      name: '@deepseek-ai/dsh-experimental-vue2-echarts-poc'
    - id: show-chart
      name: '@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc'
```

用 `dsh --profile web --patch <path>` 应用，由 `DSH_CONTENT_APP_ROOT` 指出被托管的应用。所有包都必须能从 profile 目录解析到——对树外插件而言即 `dsh plugin --profile web add <path>` 或等价的链接；发布 bundle 不得声明实验性包。

两个子节点都是可选的。没有 `ctx.sessionProjections` 的装配保留 extractor 表、不发布任何内容，这一栏显示空状态；没有 `ctx.systemPrompt` 的装配保留该表、不贡献任何指引。两者互不为前提，本行的组合方式在哪种情况下都一样。

## Model Experience

### System prompt: working with content already on display

#### What the model sees

一个 section `content:on-display`：只要组合中有系统提示词注册表就会注册，且与注册了哪些 kind 无关——这条规则说的是**用户**指着什么，因此 extractor 表为空并不构成把它扣下的理由。文本不指名任何 kind、任何工具、任何参数，因此日后新增的 kind 无需改动此处即可继承它，而各工具的 schema 继续各自交代自己的身份字段怎么写。它的 order 是 `200`，位于 `100–199` 工具指引区间之后，因此它是对照各工具刚说过的话被读到的；[Agent Note](../../../.agents/notes/implemented/feature/2026-08-24-content-on-display-rule.zh.md) 载有让措辞与位置都成为有意选择的那次实测。

##### The section, verbatim

```markdown
# Working with content already on display

When the user refers to something you have already produced and put on display — quoting it, naming its title, or otherwise pointing at it — and asks for a change, update that same piece of content in place through the tool that produced it, reusing its identity, rather than producing a new one beside it.
```

#### Token effect

约 70 个词的静态文本，随组合中每个 agent 的每一轮的每次请求携带，无论该会话是否曾展示过任何东西。这里没有任何依赖数据的内容，因此开销不随 entry 流增长。

#### KV Cache effect

前缀稳定：文本是静态的，且排在今天注册的所有 section 之后，因此组装出的提示词只是多了一段恒定的尾巴，它前面的前缀不受影响。加载或卸载本行会改变提示词并从那段尾巴起失效重用；任何 order 高于 `200` 的 section 会把这一段往前挤，并从它落到的位置起失效重用。

## Known Limitations and Deferred Work

- **一个 kind 可能存下整份文档** —— fold 为每条存活 entry 保留一条记录，但那条记录装着 extractor 放进 `data` 的任何东西，而 `chart` kind 放进去的是 option。一个存有大量图表的会话会把它们全部带在 projection 状态、wire 值和持久化 checkpoint 里。
- **派生的 `stateVersion` 可能碰撞** —— 表的签名被哈希进 31 位，因此两种不同组合原则上可能共用同一个版本、进而共用 checkpoint。真发生时的补救是给涉及的任一 kind 递增 `dataVersion`。
- **热加载的 kind 不会主动推送** —— projection registry 没有重新发布的调用，因此在该行加载前就连上的浏览器会一直读到旧的流，直到该会话的下一条事件。
- **无法控制顺序** —— entry 按最后记录它的 seq 排列，kind 无法要求排在最前或最后。
- **这条规则的位置只是约定** —— order `200` 位于文档记载的 `100–199` 工具指引区间之后，但没有任何机制为它预留：日后某个 section 取更高的 order，就会无声地把这条规则挤离提示词末尾，而它正是在末尾被实测的。`apps/web/tests/content-surface.e2e.ts` 会对着真实组合断言这条尾巴，因此至少 Web 形态会响亮地失败。
- **一条事件只归一个 kind** —— 第一个认得某条事件的 extractor 赢走它，而没有任何机制能发现两个 kind 在读同一条事件。派生自不同工具调用或不同事件类型的 kind 不会相撞。
- **被工具链拆离了它的浏览器半边** —— 一个包若宿主入口声明了 Cordis 服务、`src/client` 又触及客户端运行时，两个 face 的 Context 合并会落进同一个 Typert 程序，使生成器因重复 key 而失败。把服务留在这里、把这一栏放进 [`content-column`](../content-column/README.zh.md)，正是为了避开这一点；两者总是一起组合，单独一个都不成事。
- **未被 assembled snapshot 覆盖** —— 浏览器侧证据是针对真实组合运行的 Playwright 场景；snapshot 各条重放的是出厂组合，而出厂组合不会组合实验性行。
