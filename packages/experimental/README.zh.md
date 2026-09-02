---
description: "实验组地图：不进入正式发布的私有原型与内部专用插件，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/experimental

[English](README.md) | 中文

## 概述

实验组包含不属于任何正式发布的原型能力：它们运行在真实 harness 上，但约定可能变更，也不提供支持承诺。本组包含 Agent Teams、跨 realm Inspector、代码执行 seam 的 CPython 子进程后端，以及预览部署使用的浏览器 worker 运行时与镜像打包器。用这些包来尝试未发布的能力；它们没有稳定性承诺，已发布产品不得依赖它们。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`agent-team-profile`](agent-team-profile/README.zh.md) | Agent Teams 的显式源码 checkout profile 层 | — |
| [`agent-team`](agent-team/README.zh.md) | 具名 teammate，成员之间持久消息与共享任务板 | `ctx.agentTeams` |
| [`agent-team-web-profile`](agent-team-web-profile/README.zh.md) | Agent Teams 的显式源码 checkout Web 层 | — |
| [`auth-gate`](auth-gate/README.zh.md) | 把没有 access token 的浏览器送去部署方的登录页，把带回来的那一枚镜像进 cookie，并注入到转发出去的 MCP 请求里 | — |
| [`client-ui-agent-team`](client-ui-agent-team/README.zh.md) | Web Team roster、任务板与 teammate 导航 | — |
| [`code-runtime-python`](code-runtime-python/README.zh.md) | 代码执行 seam 的 CPython 子进程后端 | `ctx.codeRuntime` |
| [`content-column`](content-column/README.zh.md) | content surface 的浏览器半边：认领外壳的 content 栏，列出该会话的 entry，并按 kind 派发选中的那一条 | — |
| [`content-frame`](content-frame/README.zh.md) | 托管一份由部署方配置的静态 web 应用，并把它作为 content 栏的 `page` 类型贡献进去 | — |
| [`content-surface`](content-surface/README.zh.md) | content surface 的宿主半边：extractor 把已记录事件折叠成每会话一条按类型分列的内容 entry 流 | `ctx.contentSurface` |
| [`inspector`](inspector/README.zh.md) | 用于 Host 调试、Client Runtime 检查、网络采集与 Cordis 树的跨 realm CDP hub | `ctx.inspector` |
| [`server-layout`](server-layout/README.zh.md) | 服务形态外壳：常驻四轨框架（session、content、chat、details），替换出厂外壳 | `ctx.layout` |
| [`tool-agent-team`](tool-agent-team/README.zh.md) | 让模型创建、发消息与协调 teammate 的十个工具 | 按作用域注册工具到 `ctx.tools` |
| [`vue-ui-poc`](vue-ui-poc/README.zh.md) | 可行性验证：通过一座薄桥把 Vue 3 组件挂进 React slot | — |
| [`vue2-echarts-poc`](vue2-echarts-poc/README.zh.md) | 组件库：以 Vue 2.7 组件写成、经桥接入 React 的 ECharts 柱状图 | — |
| [`webworker-packer`](webworker-packer/README.zh.md) | 构建浏览器 worker 预览所消费的 gzip 压缩 VFS 镜像 | 库与 CLI，不使用 ctx key |
| [`webworker-runtime`](webworker-runtime/README.zh.md) | 在专用浏览器 worker 中运行 harness 插件树 | 库与 worker 入口，不使用 ctx key |

-----

<a id="related-documentation"></a>
## 相关文档

- [实验包决策](../../.agents/notes/implemented/architecture/2026-08-18-experimental-agent-teams-packages.zh.md)——位置、发布排除与依赖隔离。
- [Agent Teams 子系统](../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [实验子树规则](AGENTS.md)——实验状态放宽了什么、不放宽什么。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
