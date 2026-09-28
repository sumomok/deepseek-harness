# Agent Note: 桌面系统提示词让模型不动应用自己的目录

Status: implemented

[English](2026-09-28-desktop-protected-directories-prompt.md) | 中文

## 问题

一位客户让 agent 搬日志文件，它执行的命令把应用的安装目录弄坏了。桌面组合里没有任何内容告诉模型：它运行所在的目录，以及 `DSH_HOME` 下保存会话、设置和 profile 的数据目录，属于应用本身。在完全权限（`danger-full-access`）下文件沙箱什么都不限制；在有围墙的档位下，获批的升级会为那一次调用撤掉围墙；所以模型一旦认定搬动是任务的一部分，就不会遇到阻碍。沙箱对这些目录的保护需要一个核心补丁，之后才落地；在那之前，模型自己的指令是唯一在所有档位都生效的东西。

## 决定

**一行点名目录的全局系统提示词。** `apps/desktop-app/cordis.patch.yml` 里的 `desktop-brand` 行写明两个模板，本包的 Host 半边（`apps/desktop-app/src/index.ts`）在挂载时填好其中一个，再经 `ctx.inject(['systemPrompt'], …)` 注册为段落 `desktop:protected-directories`，按字面文本，位于 `DEPLOYMENT_PERSONA_SUFFIX` 顺位。两个模板是：

- `protectedDirsPrompt`：`Unless the user explicitly asks, do not modify, move, or delete this app's installation directory ({installDir}) or its data directory ({dataDir}), except the skills folder {skillsDir}.`
- `protectedDirsPromptDataOnly`：`Unless the user explicitly asks, do not modify, move, or delete this app's data directory ({dataDir}), except the skills folder {skillsDir}.`

`{installDir}` 是这一行的 `installDir`，这一行从 `DSH_DESKTOP_INSTALL_DIR` 取它，外壳在打包启动时为服务器设置这个变量。开发启动不设置它，得到只含数据目录的模板。`{dataDir}` 是 `resolveDshHome()` 解析出的 harness 主目录，也就是服务器自己的插件所用的解析器；`{skillsDir}` 是其中的 `skills` 目录，即 `@deepseek-ai/dsh-skill-filesystem` 读取用户技能的根目录。每个路径都放在反引号里插入，路径中的空格与中日韩字符因此不会产生歧义。每个模板必须恰好包含自己的占位符；缺失或多出未知占位符都会让这一行拒绝挂载。在使用默认主目录的 Mac 上，这一行是：``Unless the user explicitly asks, do not modify, move, or delete this app's installation directory (`/Applications/北冥.app`) or its data directory (`/Users/<user>/.dsh`), except the skills folder `/Users/<user>/.dsh/skills`.``

**位置。** 同顺位的段落按名字排序，`desktop:…` 排在 `deployment:persona-suffix` 之后，所以这一行是系统提示词的最后一段。预设的 `dsh-persona` 行只在自己的作用域里遮蔽 `deployment:persona-prefix` 与 `deployment:persona-suffix` 两段，进程内委派的子会话只加自己的 prefix，所以这个全局段落留在每个 `standard`、`ptc`、`cordis` 会话及其子会话里。

**技能目录是例外。** 用户 09-27 定：agent 自写的技能继续写进技能目录，因为写技能是 agent 跨会话保留所学的方式。数据目录里的用户级 `AGENTS.md` 没有点名；数据目录下还有哪些路径保持可写，由沙箱保护决定。

**不改核心。** 这一行、这个插件和这两个模板都属于桌面自己的组合层。系统提示词以 `system/message` 进入会话日志（`packages/core/agent-loop/src/agent.ts`），所以带这一行的每份提示词连同其中的具体路径都有记录，重放会话能还原它。

**上下文成本。** 填好后的一行约 40 个词；用上面的 macOS 路径，按词数与字符数估算约 60 个 token，路径更长或含更多中日韩字符时更多。仓库里没有 tokenizer 可以精确测量。每个桌面会话的每次请求都会发送它。路径在一台机器上是稳定的，所以这段文字以及服务商对它的前缀缓存，在请求之间、会话之间都保持不变。已有会话只看到一次新提示词：桌面的 `deepseek-flash` 行声明了 `systemPromptUpdate: in-history`，所以变化后的提示词追加在已缓存的历史之后，而不是改写 0 号系统节点。这个成本值得付，因为这一行在完全权限下也生效，而那里没有任何沙箱规则；并且在有围墙的档位下，把这些目录当作禁区的模型不会为了动它们去申请升级。

## 考虑过的替代方案

**把这一行写进 persona 配置。** `dsh-system-prompt` 的 `personaSuffix` 是部署的位置，但每个预设的 `dsh-persona` 行都用自己的 suffix（`Your working directory is {{cwd}}.`）把它遮住，所以写在那里的一行在每个预设会话里都会消失。

**逐个修改预设的 persona 行。** 四行都要为加一句话而重述各自的 persona，之后新增的预设、或在 Web 预设编辑器里改过的预设，都不会带上它。

**用环境变量指代数据目录。** 较早的草稿写的是 `(the path in the DSH_HOME environment variable)`，约 40 个 token，并且不点名安装目录。模型要先执行命令查到这两个路径，才能判断一条命令是否碰到它们；用户选择改为点名解析后的路径。

**把路径写死在这一行里。** 安装目录在打包的应用与开发启动之间、在不同平台之间都不同，数据目录随 `DSH_HOME` 变化；这一行只写模板，由 Host 半边在挂载时解析路径。

**把模板文字写在代码里。** 随部署而变的句子写在代码里就是硬编码的可调项；两个模板都放在这一行里，所以只含数据目录的措辞也可以配置。

**等沙箱保护。** 它需要一个横跨各平台沙箱后端的核心补丁，而且它仍然不覆盖完全权限。

## 后果

这一行是建议，不是强制：模型仍可能无视它；不经过模型自身判断的事（用户明确要求、在文件沙箱之外运行的工具）不受影响。运行外部 CLI 的子代理（`subagent_codex`、`subagent_claude_code`）不带它。

**已知限制：`minimal` 会话不带这一行。** `minimal` 预设的 persona 是 `complete: true`，按设计替换整个系统提示词，桌面层不修改这个预设。沙箱保护落地后覆盖这些会话。

**路径对模型可见，也进日志。** 每个桌面会话日志的 `system/message` 记录里都有安装目录、数据目录与技能目录。默认主目录下的数据目录含账户名；模型本来就通过会话工作目录看到同一主目录下的路径，所以这一行没有给日志添加新种类的信息。

**数据目录搬家后文字变一次。** 新的 `DSH_HOME` 在下一次服务器启动时生效；之后每个已有会话的第一次请求带一次变化后的提示词，追加在它已缓存的历史之后。更新改变安装目录时也一样。

技能目录例外让 agent 自写的技能无需用户要求即可写入。数据目录下的其他文件，包括用户级的 `AGENTS.md`，在沙箱保护决定它们的状态之前都受这一行约束。

修改措辞只需改 `apps/desktop-app/cordis.patch.yml` 里的两个模板，以及组合测试用来比对它们的常量。

## 测试

`apps/desktop-app/tests/protected-directories.spec.ts` 在真实的提示词注册表上挂载 Host 半边：有安装目录时填完整模板，这一段是最后一段，在 persona suffix 之后，不做插值；没有安装目录时填只含数据目录的模板；含空格与中日韩字符的路径、以及 Windows 路径，都原样放进反引号；释放后这一段被移除；占位符缺失或未知的模板拒绝挂载；缺失、为空或只有空白的模板以及空的 `installDir` 被 schema 拒绝。同一文件经 `@deepseek-ai/dsh-skill-filesystem` 从 `<dataDir>/skills` 加载一个技能，所以列为例外的目录就是技能加载读取的目录。`apps/desktop-shell/tests/desktop-composition-layer.spec.ts` 钉住组合行里的两个模板与 `installDir` 表达式，在设置与不设置 `DSH_DESKTOP_INSTALL_DIR` 两种情况下求值这个表达式，并用组合出的各行渲染提示词：`standard`、`ptc`、`cordis` 会话以填好的这一行结尾；经 `applyChildComposition` 组合的委派子会话在它自己的 persona 下也以这一行结尾；`minimal` 会话只渲染它完整的 persona。没有任何无 key 的录制会话快照运行桌面 profile，所以没有录制会话带这一行。
