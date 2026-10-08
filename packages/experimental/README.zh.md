---
description: "实验组地图：可公开安装的预稳定原型。"
kind: "package-group"
---

# packages/experimental

[English](README.md) | 中文

## 概述

实验性原型的约定可能变更，且不提供支持承诺。新包默认发布；私有包还必须列入[私有例外列表](../../scripts/experimental-package-policy.ts)。所有当前包都以 `@deepseek-ai/dsh-experimental-*` 名称发布，包括显式启用的 Agent Teams 组合、Auto review、Cua Driver 提供方、浏览器操作后端、跨 realm Inspector、CPython PTC 后端与浏览器 worker 预览库。组外已发布产品不得依赖实验性包。dsh 安装将 Agent Teams、语音输入与 Auto review 包作为可选 bundle 一起发布，可从 Web 侧边栏“插件”页启用（[决策](../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)）；其余包是库或显式组合。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`speech-to-text`](speech-to-text/README.zh.md) | 具名语音识别 Provider | `ctx.speechToText` |
| [`speech-to-text-sensevoice`](speech-to-text-sensevoice/README.zh.md) | 托管本地 SenseVoice 推理 | — |
| [`api-speech-to-text`](api-speech-to-text/README.zh.md) | 带认证的临时转写 Remote | `ctx.speechController` |
| [`client-ui-voice-input`](client-ui-voice-input/README.zh.md) | 麦克风录音与版本检查后的草稿插入 | — |
| [`voice-input-bundle`](voice-input-bundle/README.zh.md) | 默认禁用的可选语音输入组合 | — |
| [`agent-team-profile`](agent-team-profile/README.zh.md) | Agent Teams 协作、工具与 Web UI 组合包 | — |
| [`agent-team`](agent-team/README.zh.md) | 具名 teammate，成员之间持久消息与共享任务板 | `ctx.agentTeams` |
| [`client-ui-agent-team`](client-ui-agent-team/README.zh.md) | Web Team roster、任务板与 teammate 导航 | — |
| [`auto-review`](auto-review/README.zh.md) | 显式 Web 层，在每个原生或 PTC inner 工具调用前使用同一模型审查 | — |
| [`claude-code-mods`](claude-code-mods/README.zh.md) | 把 Claude Code 模组作为插件运行：钩子链落在 harness 扩展点上，并在提示框上方绘制横幅 | `ctx.claudeCodeMods` |
| [`client-ui-claude-code-mods`](client-ui-claude-code-mods/README.zh.md) | 在提示框上方绘制模组树并把按钮点击发回的 Web 横幅 | — |
| [`ptc-runtime-python`](ptc-runtime-python/README.zh.md) | PTC 执行 seam 的 CPython 子进程后端 | `ctx.ptcRuntime` |
| [`computer-use-cua-driver-mcp`](computer-use-cua-driver-mcp/README.zh.md) | 通过 MCP 使用已安装的 Cua Driver | `ctx.computerUse` |
| [`computer-use-cua-driver-native`](computer-use-cua-driver-native/README.zh.md) | 嵌入 Cua Driver 原生 npm 运行时 | `ctx.computerUse` |
| [`browser-use-playwright-mcp`](browser-use-playwright-mcp/README.zh.md) | 通过 MCP 提供 Playwright 浏览器工具 | `ctx.browserUse` |
| [`browser-use-chrome-devtools-mcp`](browser-use-chrome-devtools-mcp/README.zh.md) | 通过 MCP 提供 Chrome DevTools 检查与浏览器控制 | `ctx.browserUse` |
| [`browser-use-stagehand-native`](browser-use-stagehand-native/README.zh.md) | Stagehand 浏览器操作与显式配置的原生模型 | `ctx.browserUse` |
| [`browser-use-runtime`](browser-use-runtime/README.zh.md) | 实验性提供方共享的 Session 浏览器资源 | — |
| [`auth-gate`](auth-gate/README.zh.md) | 把没有 access token 的浏览器送去部署方的登录页，把带回来的那一枚镜像进 cookie，并注入到转发出去的 MCP 请求里 | — |
| [`biz-backend`](biz-backend/README.zh.md) | 对本部署自己的数据后端的三次读取，用的是访客自己的访问令牌 | `ctx.bizBackend` |
| [`component-kit`](component-kit/README.zh.md) | 组件行：它注册进落位包目录的六个组件，每个都由一份主机侧定义和画它的 React 渲染器组成 | — |
| [`component-surface`](component-surface/README.zh.md) | `show_component` 工具与 content 栏的 `component` 类型：来自固定目录的内容块，在画出来之前先判定 | — |
| [`console-mcp`](console-mcp/README.zh.md) | 控制台的 MCP 能力，作为一行组合：由部署持有的 Streamable HTTP 服务器清单，按具名凭据接入，清单为空时不做任何事 | — |
| [`console-members`](console-members/README.zh.md) | 控制台成员目录的类型：一个请求、一个 Remote 调用方或一个会话属于哪位已登录成员，每位成员的根目录，以及按成员的存储；插件行提供这个目录，并把每个请求准入为其签名断言所点名的成员 | `ctx.consoleMembers` |
| [`console-profile`](console-profile/README.zh.md) | 客户控制台：叠在 Web profile 上的一个 bundle 层，外加一份叠在 profile 补丁之上的权限锁 | — |
| [`content-column`](content-column/README.zh.md) | content surface 的浏览器半边：认领外壳的 content 栏，列出该会话的 entry，并按 kind 派发选中的那一条 | — |
| [`content-frame`](content-frame/README.zh.md) | 托管一份由部署方配置的静态 web 应用，并把它作为 content 栏的 `page` 类型贡献进去 | — |
| [`content-surface`](content-surface/README.zh.md) | content surface 的宿主半边：extractor 把已记录事件折叠成每会话一条按类型分列的内容 entry 流 | `ctx.contentSurface` |
| [`inspector`](inspector/README.zh.md) | 用于 Host 调试、Client Runtime 检查、网络采集与 Cordis 树的跨 realm CDP hub | `ctx.inspector` |
| [`session-inspector`](session-inspector/README.zh.md) | 展示原始 Session 日志与 Chat 节点的 Sidebar 表格 | — |
| [`inspector-profile`](inspector-profile/README.zh.md) | 用于 Session 日志与 Chat 节点检查的可选 Web 组合包 | — |
| [`library-skills`](library-skills/README.zh.md) | 把组件库惯例做成随包出厂的 SKILL，以最低 skill rank 挂载 | — |
| [`page-refresh`](page-refresh/README.zh.md) | 服务端带着另一个构建回来时让已打开的页面刷新一次，并用一条横幅显示页面的连接状态 | — |
| [`server-base`](server-base/README.zh.md) | 告诉浏览器：够得着这个被服务出去的页面是否意味着拥有背后的宿主，并携带前缀控制台的 nginx 样例 | — |
| [`server-layout`](server-layout/README.zh.md) | 服务形态外壳：常驻四轨框架（session、content、chat、details），替换出厂外壳 | `ctx.layout` |
| [`server-sidebar`](server-sidebar/README.zh.md) | 产品控制台侧边栏：用固定的工作台/导航/工作流控制台替换出厂侧边栏，并承载客户表单页所需的去术语层 | — |
| [`skill-pack`](skill-pack/README.zh.md) | 技能包根目录的技能提供方：只有某个技能包的视图所摆放的每个组件插件部件都已注册，它才会被交出去 | `ctx.skillPacks` |
| [`skill-pack-components`](skill-pack-components/README.zh.md) | 一套部署组合在两者之间的适配器：它把这套部署交出去的组件发布成技能包所要求的部件 | — |
| [`system-map`](system-map/README.zh.md) | 对本部署自有数据模型配置的三个读，按登录者的权限过滤 | 注册工具到 `ctx.tools` |
| [`tool-agent-team`](tool-agent-team/README.zh.md) | 让模型创建、发消息与协调 teammate 的九个工具 | 按作用域注册工具到 `ctx.tools` |
| [`vue-ui-poc`](vue-ui-poc/README.zh.md) | 可行性验证：通过一座薄桥把 Vue 3 组件挂进 React slot | — |
| [`vue2-echarts-poc`](vue2-echarts-poc/README.zh.md) | 组件库：以 Vue 2.7 组件写成、经桥接入 React 的 ECharts 柱状图 | — |
| [`vue2-echarts-tool-poc`](vue2-echarts-tool-poc/README.zh.md) | `show_chart` 工具：模型交出一份 ECharts option，浏览器的渲染判定回到工具结果里 | 注册 `show_chart` 到 `ctx.tools` |
| [`webworker-packer`](webworker-packer/README.zh.md) | 构建浏览器 worker 预览所消费的 gzip 压缩虚拟文件系统（VFS）镜像 | 库与 CLI（命令行界面），不使用 ctx key |
| [`webworker-runtime`](webworker-runtime/README.zh.md) | 在专用浏览器 worker 中运行 harness 插件树 | 库与 worker 入口，不使用 ctx key |

-----

<a id="related-documentation"></a>
## 相关文档

- [实验包发布说明](../../scripts/experimental-package-policy.ts)——默认公开与私有例外。
- [计算机操作](../../docs/subsystems/computer-use.zh.md)——桌面提供方选择。
- [浏览器操作](../../docs/subsystems/browser-use.zh.md)——浏览器提供方选择与 Session 所有权。
- [Agent Teams 子系统](../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [实验子树规则](AGENTS.md)——实验状态放宽了什么、不放宽什么。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
