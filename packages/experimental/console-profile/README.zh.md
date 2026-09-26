---
description: "把客户控制台作为一个 bundle 层组合到 Web profile 上，并附带一份由部署叠在 profile 补丁之上的权限锁。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-console-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-console-profile` 把一个 `web` profile 变成客户控制台。它的 bundle 层换上服务外壳与产品侧栏，禁用那些会显示内部术语或开发者工具的出厂界面，挂载随包出厂的库技能，声明 `console` Agent 预设，并禁用 `cordis` Agent 预设。它的第二个文件 `permission-lock.patch.yml` 在 profile 补丁之上的层里钉住控制台的访问预设，并把 `console` 定为默认 Agent 预设。拆成两份依据一条规则：侧栏菜单必须能由 settings 服务保存，而钉住的预设不能被保存。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

在本仓库检出目录里，把 bundle 加进 `web` profile，再带着锁 overlay 启动这个 profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/console-profile
pnpm dsh --profile web --patch ./packages/experimental/console-profile/permission-lock.patch.yml
```

`dsh plugin add` 链接本包，并把它追加到 `dsh.profile.bundles` 里 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之后。锁也可以作为 home 补丁 `$DSH_HOME/cordis.patch.yml`；这两层都组合在 profile 补丁之上。

### 加上部署自己的行

本 bundle 不组合页面目录（`content-frame`）、视图目录（`component-surface`）和登录门（`auth-gate`）；它们各自带着部署专属的配置。把这些行放进部署自己的本地 bundle——一个目录，里面有 `cordis.patch.yml`，以及一份声明 `"dsh": { "bundle": { "patch": "cordis.patch.yml" } }`、并在 `dependencies` 里列出每个被插入包的 `package.json`——再用 `dsh plugin --profile web add <dir>` 加入，让它叠在本 bundle 之后。设置页会保存的行不得由 `--patch` 或 home 补丁插入或配置；任何人都不能改的行才放在那里。

### 获得的功能

控制台 bundle 在出厂 Web profile 之上组合这些改动：

| 行 | 改动 |
|---|---|
| `server-layout`、`content-surface`、`content-column` | 插入：四轨服务外壳及其内容栏 |
| `server-sidebar` | 带 `displayNameClaim: login_uname` 插入；它的菜单保存进 profile 补丁 |
| `library-skills` | 插入：一个以 `@deepseek-ai/dsh-experimental-library-skills` 为根的隔离 `skill-filesystem` provider |
| `ui-layout`、`ui-sidebar` | 禁用：它们的单一槽位由外壳与侧栏占用 |
| `ui-agent-preset`、`ui-brand-official`、`ui-cordis`、`ui-trajectory`、`ui-model-selection`、`session-log-download`、`ui-settings-models`、`ui-permission` | 禁用：内部术语、官方品牌与开发者界面 |
| `preset-console` | 插入：`console` Agent 预设——persona、`tool-fs`、`skill-filesystem`、`tool-skill`、压缩组、`tool-ask-user` 与 `tool-todo`；没有 shell、搜索、后台任务、目标、计划、委派、web 与 `present` 行 |
| `preset-cordis` | 禁用：该预设挂载 `tool-cordis` 以及一份列出全部工作区包的技能，而 `session.create` 经 RPC 接受 `agentPreset`，只隐藏选择器不够 |

锁 overlay 重述两行。`permission` 行带三个面向客户名字的预设、`defaultPreset: workspace-write`，以及 `isolate: { commands: true }`——正是它让 `/permission` 保持未注册。`agent-preset-registry` 行带 `default: console`、不带 `selectedDefault`，所以每个新会话都跑 `console` 预设。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

层的顺序决定每一行放进哪个文件。bundle 层组合在 profile 补丁之下，而 `dsh-config-editor` 只有在写入后的有效配置等于它写入的值时，才把一行的配置写进那份 profile 补丁。由 `--patch` overlay 或 home 补丁插入或配置的行会压过这次写入，编辑器因此拒绝它。侧栏的 `workflows`、`groups` 与 `workbenchSessionId` 是侧栏要保存的 volatile Config，所以这一行必须位于 bundle 层。`permission.defaultPreset` 与 `agent-preset-registry.selectedDefault` 同样是 volatile Config，而 `remote.settings` 方法会回应部署放行的任何浏览器，所以这两行必须位于 profile 补丁之上。存下的 `selectedDefault` 若指向控制台没有声明的预设，每个新会话都会以 `agent-preset/not-found` 失败。

禁用行只按 id 指向出厂条目。bundle 的插件行通过 bundle 自己的 `dependencies` 解析，这一点由 `scripts/verify-cordis-config.ts` 强制；禁用行不加载任何东西。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | bundle 层：外壳、侧栏、库技能、`console` Agent 预设，以及全部禁用行 |
| [`permission-lock.patch.yml`](permission-lock.patch.yml) | `permission` 行与 `agent-preset-registry` 行，叠在 profile 补丁之上应用 |
| [`src/index.ts`](src/index.ts) | 空模块入口；两个补丁文件才是运行时内容 |
| — | 不发布运行时 invariant 伴生插件；本包不拥有任何可变关系。组合由 Loader 与 profile 的补丁文件拥有。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布排除规则。
- [产品控制台侧栏](../server-sidebar/README.zh.md)——本 bundle 插入的侧栏、它的菜单字段与去术语化规则。
- [Profile bundle](../../bundle/README.zh.md)——`dsh --profile` 如何叠放可安装的层。
- [Config editor](../../boot/config-editor/README.zh.md)——一次设置写入落在哪一层，以及何时被拒绝。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由它组合的行。`console` Agent 预设决定会话自己的工具：`read`、`write`、`edit`、`read_image`、`skill`、`ask_user_question` 与 `todo_write`，另有 host 平面的内容栏工具，它的 persona 前缀是客户助手的指令。`library-skills` 行把随包出厂的技能加入技能目录，禁用 `preset-cordis` 去掉了一个会话本可以运行在其下的预设，其余每个被组合的插件各自拥有自己对模型可见的内容。

#### KV Cache 影响

除被组合插件自身的影响外没有别的；只要出厂技能集合不变，技能目录的前缀就是稳定的。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **锁是一个启动参数。** 启动 profile 时既没带 `--patch permission-lock.patch.yml`、也没有 home 补丁的部署，会得到出厂的预设名字、斜杠菜单里的 `/permission`，以及一个任何设置写入都能改的 `defaultPreset`。
- **`console` 预设保留文件工具。** `tool-fs` 让 agent 能把它提炼的技能写进 `<workspace>/.dsh/skills`，也让它能写 `permission` 预设沙箱放行的任何其他文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`permission-lock.patch.yml` 通过 `scripts/check-workspace-constraints.ts` 里的 `packageFileExtras` 表发布。

</details>
