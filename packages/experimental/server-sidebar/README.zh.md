# @deepseek-ai/dsh-experimental-server-sidebar

[English](README.md) | 中文

对出厂的 [`dsh-client-ui-sidebar`](../../client/ui-sidebar/README.zh.md) 的直接替换，在会话列表上方新增一块「改造」菜单区：**页面路由**——`@deepseek-ai/dsh-experimental-content-frame` 配置的每一个页面，一键切到中间的 content 栏——以及**业务流程**（收藏）——用户自己命名的、返回特定会话的快捷方式。它在组合里替换 ui-sidebar，而不是与之并存，因为 `sidebar` 是单一槽，其五个子槽只能被声明一次。

## 替换出厂侧边栏

一次侧边栏替换只有在兑现出厂那份对外承诺的全部内容时才算得上「即插即用」。出厂的 `dsh-client-ui-sidebar` 行除了 client 半边之外没有别的 host 侧行为——它自己的 node 半边就是 `export function apply(): void {}`——因此没有别的东西需要迁移过来；本包自己的 node 半边只为下文的收藏功能而存在，出厂侧边栏对此没有对应物。本包对其余部分的兑现如下：

- **五个子槽**——`sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.workspaces`、`sidebar.settings`、`sidebar.footer.action` 保留各自的 kind 与 scope，因此 ui-workspace 与 ui-settings 既有的注册、以及任何填充这两个身份槽的品牌包，都无需改动即可继续工作。这些声明按类型从 ui-sidebar 导入复用，而非重新写一遍，因此不论组合了哪个侧边栏，注册方都针对同一份文档化契约编译。
- **新会话按钮与侧边栏折叠开关**——同样两个触发点，分别接到 `ctx.workspaces.startSession()` 与 `ctx.layout.toggleSidebar()`。
- **折叠几何**——56px 的折叠态窄栏、宽内容在窄栏落定前 150ms 的淡出、以及 `.railIn` 滑入动画只在一次「活的」折叠上生效，冷启动直接进入折叠态时不生效。
- **随指针显隐的滚动条**——指针停留在这一栏内时滚动条常驻，离开后再保留两秒；指针在此期间回到栏内会取消挂起的隐藏。指针穿过一个作为该栏 DOM 后代渲染的浮层（ui-settings 的面板就是这样渲染的）时，按几何坐标而非 DOM 包含关系判断，而不会被误判为「离开」。

本外壳在这份契约之上唯一添加的东西，就是新会话按钮与工作区浏览器之间的菜单区，见下文。

## 页面路由

菜单的第一组列出 `@deepseek-ai/dsh-experimental-content-frame` 配置的页面，在本条目注册之前一次性从它的 `/content-frame/settings` 路由读取（写死的路由路径与本地校验的 JSON 形状，不是导入的值或类型——跨包直接导入符号并非本仓库为两个客户端相邻插件设计的耦合方式）。点击一个页面会针对当前会话执行 content-frame 的 `show-content-page` 命令，通过 `ctx.remote.commands.execute`——这是会话日志能够重放的命令通路，而非直接的服务调用。该命令的处理函数追加 `by: 'user'` 的 `content/shown`，content-frame 的 `page` extractor 与其自己的 README 记录了这一点。

**没有当前会话时**，点击会先解析出一个可执行命令的会话：优先用当前抽象层面已选中的工作区，否则用最近使用的工作区，其连接方式与新会话按钮自身的解析逻辑完全一致（复刻 `WorkspaceRuntime.startSession` 的目标解析，而非直接调用它——`startSession` 是即发即弃的，从不把新会话 id 交还给这里需要拿在手上的调用方）。完全没有工作区时——一次从未连接过工作区的全新安装——没有地方可以创建会话，点击会成为一次被吸收的空操作（见「已知限制」）。

## 收藏

菜单的第二组是用户自己命名的、指向会话的快捷方式，按账号持久化。这里的「按账号」即「按 `$DSH_HOME`」，对应这一部署形态「一个用户一个进程」的形状：这份持久列表存在 `settings` 能力的文件后端文档里，因此在一个浏览器标签页里收藏一个会话，会出现在读取同一账号的所有其他浏览器标签页里，也会像任何其他设置一样在进程重启后留存。

浏览器无法直接调用 `settings.*` RPC——这是一组反向代理会以 403 拒绝的 loopback 特权方法——因此本包的 node 半边是一个可选子节点：当 `ctx.settings` 与 `ctx.webServer` 同时被组合时，它注册 `server-sidebar` settings 命名空间，并在一条同源路由上对外提供：

- `GET /server-menu/favorites`——当前列表，`cache-control: no-store`。
- `POST /server-menu/favorites`——整体替换列表。限定为同站、JSON 请求（与 [`auth-gate`](../auth-gate/README.zh.md) 的 `rejectCrossSite`/`rejectNonJson` 同一套模式，出于与上文页面路由同样的跨包原因，复制而非导入）并限制大小；提交的列表里出现重复的 session id 会在提交前被拒绝，路由的 `validate` 钩子与本包的 invariant 各自把关一次。

一条收藏记录以 id 指名一个会话，并携带用户自己输入的标签，与会话自身的标题相互独立。**一条收藏是弱引用**：本包从不监听会话删除，因此一条收藏所指名的会话已不在工作区域可见列表中，是预期情况而非数据损坏。菜单在每次渲染时都用当下的 `useSessions` 快照过滤存活会话，把失效的收藏渲染成一行灰显、不可跳转但仍可移除的记录——绝不从列表里悄悄丢弃它。

## 组合方式

本插件不属于任何出厂 bundle。以 overlay 的形式叠加到 Web 形态上：

```yaml
- id: ui-sidebar
  name: '@deepseek-ai/dsh-client-ui-sidebar'
  disabled: true

- insert:
    - id: server-sidebar
      name: '@deepseek-ai/dsh-experimental-server-sidebar'
```

`overlay/sidebar-menu.patch.yml` 就是这份文件；用 `dsh --profile web --patch <path>` 应用，通常与 content-frame 自己的 overlay 一并应用，让页面路由组有东西可列。被禁用的行不会进入浏览器 boot manifest，因此浏览器会去取本 bundle 而不是 ui-sidebar 的。该包必须能从 profile 目录解析到——对树外插件而言即 `dsh plugin --profile web add <path>` 或等价的链接；发布 bundle 不得声明实验性包。

## Model Experience

无，本包管理的是浏览器侧的查看状态与用户驱动的收藏文档；它执行的命令本身运行在任何模型轮次之外，不会进入模型请求。

#### KV Cache effect

无；本包既不装配也不发送任何 provider 请求。

## Known Limitations and Deferred Work

- **on-display 规则不区分写入者**——这个菜单打开的页面与 agent 的 `content_show` 工具选定的页面，落地为完全相同的 `content/shown` 事件，只有 `by` 不同。[`content-surface`](../content-surface/README.zh.md) 那条与 kind 无关的 prompt 规则仍然告诉模型，要更新「你已经产出并放上台面的东西」，这在用户手动打开一个页面时读起来仍像是 agent 产出的。那段 prompt 文本是一段钉死、经过测量的字符串，这里刻意保持不变——这一张力的完整说明，以及那个用于让以后的 prompt 或渲染器区分这一点的字段，见 content-frame 自己的 README。
- **点击页面时自动创建会话是一个刻意保留可修订余地的默认行为**——没有会话打开时点击一个已配置页面会静默创建一个（见上文「页面路由」），而不是先询问或什么都不做。命令通路与 settings 模型都不依赖这个选择；以后的版本完全可以改成先询问，或者把页面开进一个未绑定会话的预览里。
- **完全没有工作区的全新安装会让页面点击成为空操作**——没有地方可以创建会话，点击会被静默吸收（唯一的痕迹是一条控制台警告）。这在当前的部署里是一个真正意义上的空状态（生产环境里的每个部署，到用户打开侧边栏时都至少有一个工作区），而不是 UI 里被认真处理过的一种状态。
- **收藏除了插入顺序之外没有重新排序的操作入口**——`order` 存在于持久 schema 里，菜单也按它排序，但本包的 UI 里没有任何东西能让用户拖拽或重新编号一条收藏；今天的 `order` 只在新增时赋值一次，取当前最大值加一。
- **没有收藏的导入/导出或跨账号共享**——这份文档就是这个账号自己的列表，通过这个账号自己的 settings scope 读写；没有任何通路可以把一份收藏列表在账号或部署之间复制。
- **settings 路由假定存在 HTTP 载体**——browser 半边以页面 origin 为基准请求 `/server-menu/favorites`。如果某种传输提供了外壳却没有把 harness 暴露在 HTTP 上，该行会失败——与 content-frame 自己那条 settings 路由的处境相同。
- **未被 assembled snapshot 覆盖**——浏览器侧证据是针对真实组合运行的 Playwright 场景；snapshot 各条重放的是出厂组合，而出厂组合不会组合实验性行。
