---
description: "把组件库惯例做成随包出厂的 SKILL：知识与包版本同行，用户同名技能仍然覆盖它。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-library-skills

[English](README.md) | 中文

## 概述

`dsh-experimental-library-skills` 把可复用的组件库知识——某个控件库的标记怎么读、它的图标与控件惯例是什么意思——以随包出厂的 SKILL 文件承载。它的 patch 以最低 skill rank 挂载一个隔离的 `skill-filesystem` provider，根目录就是本包自己的 `skills/`，因此模型能在目录里找到这些知识，而用户自己写的同名技能会覆盖它。知识与包版本同行：改一句话就要发一次版本，回滚包也就回滚了知识。

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

在本仓库 checkout 中，把本包添加到已初始化的 profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/library-skills
```

该 profile 必须已包含 `@deepseek-ai/dsh-base`，本行注册进去的 `skill` 注册表由它提供。执行 `dsh plugin --profile web remove @deepseek-ai/dsh-experimental-library-skills` 移除本包时，它承载的技能也随之离开目录。

### 获得的功能

`skills/` 下的每份技能都会以 provider 名 `library-skills` 出现在 agent 的技能目录里，模型用 `skill` 工具加载正文。`$DSH_HOME/skills`、`.dsh/skills` 或 `.agents/skills` 下的同名技能会赢过出厂的那份。

### 添加一份技能

新建 `skills/<name>/SKILL.md`。frontmatter 承载 provider 解析的字段：

```yaml
---
name: <kebab-case>
description: <the condition under which the model should load this skill>
user-invocable: false
metadata:
  source: <ruminate|exploration>
  library: <component library>
  libraryVersion: <version or range>
  fromSessions: [<sessionId>, …]
---
```

`name` 与 `description` 都是必填，缺一份文件会被跳过并只记一条日志告警，而不是加载失败，因此新增技能必须配一条断言其名字进入目录的测试。`description` 是唯一常驻模型上下文的文本，触发条件写在这里，知识本身留给正文。`metadata` 不到达任何模型面；它记录知识的来源以及写作时对着的组件库版本。

本包每一份技能都要守两条调用规则。永远不要写 `disable-model-invocation`：它会把技能从模型面目录里摘掉，而那正是库知识唯一有用的地方。永远要写 `user-invocable: false`：出厂库知识是写给模型的，而该键默认为真，因此漏写的技能会变成组合了本包的那个控制台里的一条 `/` 菜单项——把维护者的词汇摆到终端用户的命令列表上。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml) 以及它挂载的 `skills/` 目录。patch 插入一行 `@deepseek-ai/dsh-skill-filesystem`，配置 `providerName: library-skills`、`includeDefaultRoots: false`，`bundledSkillDir` 按包名解析，因此该 provider 只贡献这一个目录，不带任何 project、user 或环境根。

`bundledSkillDir` 把根挂在 `BUNDLED_SKILL_RANK`（600），低于 project（100）、custom（300）与 user（400/500）各根。于是有两条互相独立的机制保证用户同名技能排在出厂那份前面：注册表先合并全局层、再让每个更近的 scope 层覆盖它，而 rank 只在同一层内决胜重名。bundled 根的读取还直接走 Node 而不经过 `ctx.fs`，因此部署的文件系统策略无法遮蔽出厂技能。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 唯一的组合行：一个以 `skills/` 为根的隔离 `skill-filesystem` provider |
| `skills/<name>/SKILL.md` | 一份出厂技能；只有这种两层布局会被发现 |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 与技能文件才是运行时内容 |
| — | 不发布运行时不变式伴生入口；本包不拥有任何可变关系。目录合并归 `skill` 注册表，发现归 `skill-filesystem` provider。 |

`bundledSkillDir` 表达式从该层被安装进的 profile 出发，按包名解析本包：

```js
process.getBuiltinModule('node:path').resolve(
  process.getBuiltinModule('node:module').createRequire(baseUrl)
    .resolve('@deepseek-ai/dsh-experimental-library-skills/package.json'),
  '../skills',
)
```

`baseUrl` 是 profile 目录，`createRequire` 会搜索该目录的 `node_modules` 及其各级祖先——正是 profile 安装会把包放进去的两个位置。两种失败方式并不相同。解析不到本包的 profile 会在该行加载时抛出 `MODULE_NOT_FOUND`，启动随之失败；这一行让本包成为携带它的每个组合的部署依赖。而能解析到本包、但 `skills/` 缺失或为空时，失败是安静的：`listSkillRootEntriesFromNode` 把不存在的目录当作零条目，于是根照常挂上、什么都不列。第二种由两处把关——`apps/web/tests/library-skills.e2e.ts` 的列出用例在目录为空时会红，`scripts/check-workspace-constraints.ts` 的 `packageFileExtras` 条目则强制把 `skills` 写进发布的 `files` 列表。

`skills/<name>/` 更深层的文件不是技能——provider 只发现 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md`——但模型仍能读到它们：加载后的技能会把自己的 bundle 目录报为相对路径的基准。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布排除规则。
- [Skill 注册表](../../skill/skill/README.zh.md)——层合并、rank 与目录 API。
- [本地技能发现](../../skill/skill-filesystem/README.zh.md)——各个根、frontmatter 解析与监听。
- [Skill 工具](../../skill/tool-skill/README.zh.md)——目录与加载后的正文如何到达模型。

-----

<a id="model-experience"></a>
## 模型体验

### 出厂库知识

#### 模型看到什么

会话开头，skill 工具发布一条目录消息，列出每份技能的名字与 description，包含本包这几份。正文只在模型调用 `skill <name>` 之后才到达模型：返回的 `<skill_content>` 里是文件的 Markdown 原文，并附上 bundle 目录作为资源基准。

#### Token 影响

每份出厂技能给会话内每次请求增加一行目录——名字加上截断到 500 字符的 description。正文只在模型加载它时，随那一次工具结果进入上下文一次。

#### KV Cache 影响

只要出厂技能集合与用户自己的技能根不变，目录消息的前缀就是稳定的；发布新的包版本会改变它，用户新增或改名技能同样会。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **占位内容**——出厂的 `library-skills-placeholder` 技能只用于证明组合确实到达目录，不含任何组件库知识。真技能会替换它。
- **只面向模型**——本包每一份技能都带 `user-invocable: false`，因此都不会出现在人用的 `/` 命令菜单里。某个部署若想让其中某份正文出现在用户面菜单上，就在用户根里写一份同名技能，那份同时也会赢下目录。
- **改一句话就是一次发布**——技能是包内静态文件，没有热更新、没有按部署裁剪、没有 A/B。改一句话就要发一次包版本并重新部署。
- **已开会话**——目录每个会话发布一次，之后走目录变更通道更新；不承诺运行中的会话下一轮就拿到新内容。
- **不区分用户可见性**——单进程控制台按 `$DSH_HOME` 与工作区分隔用户技能根，而不是按人，因此本包不承诺一个用户的技能对另一个用户不可见。
- **内容是写出来的，不是推导出来的**——出厂知识由 agent 自写，并在进包前由人复核，删除任何能定位到真实记录、真实的人或真实机器的内容。本包不强制这项复核。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本包通过 `scripts/check-workspace-constraints.ts` 的 `packageFileExtras` 表发布 `skills`；新增资产目录必须在那里登记，否则不会进入 tarball。

</details>
