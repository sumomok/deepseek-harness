# @deepseek-ai/dsh-experimental-server-layout

[English](README.md) | 中文

服务形态 web 产品线的外壳框架：四条常驻栅格轨道——session 列表、content 内容区、chat 会话区、details 详情带——按固定的 24 份比例 3:16:5 切分。它在组合里**替换** [`dsh-client-ui-layout`](../../client/ui-layout/README.zh.md) 而不是与之并存，因为 `root` 是 single 槽，它的子槽也只能被声明一次。

content 栏是这条产品线的立身之本，也是本包存在的理由：一块位于导航与会话之间的常驻工作面，而出厂三栏外壳没有这个座位。本版本交付的是这一栏本身，而不是它的内容——`content` 槽无人认领时，外壳渲染自己的空态。

## 替换出厂外壳

只有把出厂外壳对外发布过的东西全部兑现，替换才算原位替换，因此本包复刻了 ui-layout 的三个对外面：

- **四个子槽** —— `sidebar`、`conversation`、`details`、`shell.overlay` 保持各自的 kind、scope 与 owner 份额。这些声明以类型 import 复用 ui-layout 的，而不是重写一遍，因此无论组合里装的是哪个外壳，注册方都编译在同一份有文档的约定上。
- **`ctx.layout`** —— 同一个 `ILayout` 面（`toggleSidebar`、`openDetails`、`closeDetails`），在注册 root 条目的同一个同步 effect 里提供，且**先于**注册。这个顺序正是 ui-sidebar 与 ui-conversation 零改动可用的原因：两者都 inject `layout`，也都不等声明就直接往这些子槽注册，因此当服务解开它们的 fiber 时，槽已经存在了。
- **文档级主题投影** —— `ctx.theme` 解析当前主题但从不碰 DOM；写 root `color-scheme`、body 调色板属性和主题 alias token 的是外壳。少了这一段，组合只会保留宿主 boot 脚本给的基础调色板，并静默地不再响应 Appearance 偏好。

几何是有意不同的。这里没有拖拽把手、没有让步链、没有宽度偏好：轨道宽度是「测得的框架宽度 + 三个布尔」的纯函数（`tracks.ts`），因此任何一次 resize 都复现同一比例，也没有什么需要恢复。折叠后的 session 栏渲染 56px 控制条，并把自己的比例份额让给 content 与 chat，后两者继续按各自的 16:5 瓜分剩余空间。details 带打开时从总宽里取走固定 360px，关闭时取 0，且其子树在零宽下保持挂载。

content 栏在自己无内容可展示时也走同样的折叠：宽度归零，chat 吃下让出的份额，子树仍保持挂载在下面。外壳通过标准的 `useSessions` 列表投喂读取当前 session 的 content surface 来判断这一点，而不是引入 [`content-surface`](../content-surface/README.zh.md) 依赖——这份软耦合的代价见 Known Limitations。

宽度以像素而非 `fr` 下发到 CSS，是因为 session 栏的占位组件要用 `width` owner prop 给自己写内联宽度——`fr` 轨道会让这个数字无从得知，两者就会漂移。

## 组合方式

该插件不属于任何已发布 bundle。用 overlay 叠在 Web 组合之上：

```yaml
- id: ui-layout
  name: '@deepseek-ai/dsh-client-ui-layout'
  disabled: true

- insert:
    - id: server-layout
      name: '@deepseek-ai/dsh-experimental-server-layout'
```

`overlay/three-column.patch.yml` 就是这个文件；`dsh --profile web --patch <路径>` 应用它。被 disabled 的行不会进入浏览器 boot manifest，因此浏览器抓取的是本包的产物而不是 ui-layout 的。该包必须能从 profile 目录解析到，对树外插件而言意味着 `dsh plugin --profile web add <路径>` 或等价的链接——release bundle 不得声明实验包。

## 往 content 栏注册

`content` 是 `single`、`root` 槽，owner 份额为空。它不接收 owner props，并且在页面的整个生命周期里只挂载一次：任何 session 切换都不会让它重挂。这正是这一栏能够持有「切换不得摧毁的 DOM 状态」的原因——活着的 iframe 文档就是它为之而建的场景——同时也把 session 问题交给了占用者：占用者通过 root scope 的标准 hook `useSessions` 读取当前 session，自行决定一次切换意味着什么。

```ts ignore-check
ctx.slots.inject('content', () => ctx.slots.register({ name: 'content' }, MySurface))
```

第一次注册就整栏认领，外壳的占位随之消失。

## Model Experience

无，因为外壳管理的是浏览器观看状态，这里没有任何东西抵达模型请求。

#### KV Cache effect

无；本包既不组装也不发送模型请求。

## Known Limitations and Deferred Work

- **没有响应式行为** —— 比例在任何宽度下都照用，因此窄视口会把四栏一起挤扁，而不是折叠 session 栏或改为堆叠。出厂外壳的自动折叠断点与让步链在这里没有对应物；需要它们的部署应当改用 ui-layout。
- **没有调宽手段** —— 栏宽既不可由用户调整，也不持久化。比例与控制条宽度是约定冻结的常量，不是配置项。
- **content 栏只是壳** —— 本包交付座位、空态与几何。里面渲染什么归占用者所有；[`content-frame`](../content-frame/README.zh.md) 是第一位。
- **root scope 的一栏会漏出跨 session 状态，除非占用者自己按 session 分键** —— 框架在 session 切换时不清任何东西，因此持有 per-session 组件状态的占用者必须自己以 session id 分键。这份代价换来的正是这一栏的全部意义：框架不得摧毁的 DOM。另外三栏保持各自的 session scope。
- **没有浏览器 theme-color 元数据** —— 出厂外壳还维护一个 `<meta name="theme-color">`，其内容跟随计算出的 body 背景色，用于给移动端浏览器 UI 上色。本外壳省略了它，这与「没有响应式行为」是一致的取舍。
- **未被组装态快照覆盖** —— 浏览器证据是跑在真实组合上的 Playwright 场景，而不是录制的 transcript；快照通道投影的是模型可见与会话输出，而本包两者皆无。
- **content-empty 的读取是一次无 DOM 但耦合形状的越包读取** —— `ShellFrame.tsx` 从 `useSessions` 每个 session 的 `projectionValues` 里读 `contentSurface.entries`，全程按 `unknown` 处理，而不是引入 [`content-surface`](../content-surface/README.zh.md) 的类型（本包对它零依赖，没组合它的部署会一直读到空列表，这恰好也是正确答案）。这个键的形状或名字将来一变，读取会静默失效——这一栏会停止折叠（或该折叠时不折叠），没有任何编译期信号，只会看到一个不对劲的版面。
- **内容折叠可能在首屏闪一下** —— 会话列表投影值是异步到达的，因此一个本来有内容的 session 可能先渲染成折叠版面（16:5 塌成纯 chat），等第一份快照到达后 content 栏才展开。`grid-template-columns` 的过渡（`ShellFrame.module.css`）让这次展开是动画而不是硬切，但首次加载那一下闪烁并未被抑制。
