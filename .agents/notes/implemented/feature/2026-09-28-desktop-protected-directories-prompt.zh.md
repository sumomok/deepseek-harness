# Agent Note: 桌面系统提示词让模型不动应用自己的目录

Status: implemented

[English](2026-09-28-desktop-protected-directories-prompt.md) | 中文

## 问题

一位客户让 agent 搬日志文件，它执行的命令把应用的安装目录弄坏了。桌面组合里没有任何内容告诉模型：它运行所在的目录，以及 `DSH_HOME` 下保存会话、设置和 profile 的数据目录，属于应用本身。在完全权限（`danger-full-access`）下文件沙箱什么都不限制；在有围墙的档位下，获批的升级会为那一次调用撤掉围墙；所以模型一旦认定搬动是任务的一部分，就不会遇到阻碍。沙箱对这些目录的保护需要一个核心补丁，之后才落地；在那之前，模型自己的指令是唯一在所有档位都生效的东西。

## 决定

**一行全局系统提示词。** `apps/desktop-app/cordis.patch.yml` 里的 `desktop-brand` 行写明 `protectedDirsPrompt`，本包的 Host 半边（`apps/desktop-app/src/index.ts`）经 `ctx.inject(['systemPrompt'], …)` 把它注册为段落 `desktop:protected-directories`，按字面文本，位于 `DEPLOYMENT_PERSONA_SUFFIX` 顺位。文字是：

`Unless the user explicitly asks, do not modify, move, or delete this app's installation directory or its data directory (the path in the DSH_HOME environment variable).`

**位置。** 同顺位的段落按名字排序，`desktop:…` 排在 `deployment:persona-suffix` 之后，所以这一行是系统提示词的最后一段。预设的 `dsh-persona` 行只在自己的作用域里遮蔽 `deployment:persona-prefix` 与 `deployment:persona-suffix` 两段，进程内委派的子会话只加自己的 prefix，所以这个全局段落留在每个 `standard`、`ptc`、`cordis` 会话及其子会话里。`complete: true` 的 persona 替换整个提示词；`minimal` 预设用的就是它，它的会话不带这一行。

**不改核心。** 这一行、这个插件和这段文字都属于桌面自己的组合层。系统提示词以 `system/message` 进入会话日志（`packages/core/agent-loop/src/agent.ts`），所以带这一行的每份提示词都有记录，重放会话能还原它。

**上下文成本。** 这一行 26 个词，按词数估算约 35 个 token；仓库里没有 tokenizer 可以精确测量。每个桌面会话的每次请求都会发送它。已有会话只看到一次新提示词：桌面的 `deepseek-flash` 行声明了 `systemPromptUpdate: in-history`，所以变化后的提示词追加在已缓存的历史之后，而不是改写 0 号系统节点。这个成本值得付，因为这一行在完全权限下也生效，而那里没有任何沙箱规则；并且在有围墙的档位下，把这些目录当作禁区的模型不会为了动它们去申请升级。

## 考虑过的替代方案

**把这一行写进 persona 配置。** `dsh-system-prompt` 的 `personaSuffix` 是部署的位置，但每个预设的 `dsh-persona` 行都用自己的 suffix（`Your working directory is {{cwd}}.`）把它遮住，所以写在那里的一行在每个预设会话里都会消失。

**逐个修改预设的 persona 行。** 四行都要为加一句话而重述各自的 persona，之后新增的预设、或在 Web 预设编辑器里改过的预设，都不会带上它。

**在文字里写 `$DSH_HOME`。** 较短的草稿用 `$DSH_HOME` 指数据目录，约 25 个 token。`$VAR` 是 bash 语法；Windows 上的 PowerShell 工具把同一组变量描述为 `$env:DSH_*`（`packages/shell/tool-pwsh/src/index.ts`）。用文字点名环境变量，在两种 shell 下读起来一样。

**写出具体路径。** 安装目录在打包的应用与开发启动之间、在不同平台之间都不同；写死在这一行里的路径会对某些启动方式出错。这一行点名两个目录但不写路径。

**等沙箱保护。** 它需要一个横跨各平台沙箱后端的核心补丁，而且它仍然不覆盖完全权限。

## 后果

这一行是建议，不是强制：模型仍可能无视它；不经过模型自身判断的事（用户明确要求、在文件沙箱之外运行的工具）不受影响。`minimal` 会话，以及运行外部 CLI 的子代理（`subagent_codex`、`subagent_claude_code`），都不带它。安装目录没有对应的环境变量，所以模型只能从自己所在的进程得知它。

数据目录包含写入 agent 自写技能的 `$DSH_HOME/skills`，以及用户级的 `$DSH_HOME/AGENTS.md`。按现在的写法，这一行会让模型除非用户要求，否则不往那里写。这一行是否为技能目录开例外，尚未决定。

修改文字只需改 `apps/desktop-app/cordis.patch.yml` 里的一行，以及组合测试用来比对它的那个常量。

## 测试

`apps/desktop-app/tests/protected-directories.spec.ts` 在真实的提示词注册表上挂载 Host 半边：这一段是最后一段，在 persona suffix 之后，不做插值；释放后它被移除；缺失、为空或只有空白的 `protectedDirsPrompt` 会被拒绝。`apps/desktop-shell/tests/desktop-composition-layer.spec.ts` 组合真实的各层，用组合出的各行渲染提示词：`standard`、`ptc`、`cordis` 会话以这一行结尾；经 `applyChildComposition` 组合的委派子会话在它自己的 persona 下也以这一行结尾；`minimal` 会话只渲染它完整的 persona。没有任何无 key 的录制会话快照运行桌面 profile，所以没有录制会话带这一行。
