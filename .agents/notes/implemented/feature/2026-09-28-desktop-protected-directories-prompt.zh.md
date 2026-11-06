# Agent Note: 桌面系统提示词让模型不动应用自己的目录

Status: implemented

[English](2026-09-28-desktop-protected-directories-prompt.md) | 中文

## 问题

一位客户让 agent 搬动应用的日志文件，它执行的命令把应用的安装目录弄坏了。桌面组合里没有任何内容告诉模型哪些目录属于应用本身：它运行所在的安装目录、`DSH_HOME` 下保存会话、设置和 profile 的 harness 数据目录，以及桌面外壳自己存放偏好设置、日志和已下载更新的目录。在 macOS 上，日志甚至不在外壳的 `userData` 目录里，而在 `~/Library/Logs` 下。在完全权限（`danger-full-access`）下文件沙箱什么都不限制；在有围墙的档位下，获批的升级会为那一次调用撤掉围墙；所以模型一旦认定搬动是任务的一部分，就不会遇到阻碍。沙箱对这些目录的保护需要一个核心补丁，之后才落地；在那之前，模型自己的指令是唯一在所有档位都生效的东西。

## 决定

**一行点名目录的全局系统提示词。** `apps/desktop-app/cordis.patch.yml` 里的 `desktop-brand` 行写明这一行、每个目录一个分句以及列表分隔符；本包的 Host 半边（`apps/desktop-app/src/index.ts`）在挂载时把它们填好，再经 `ctx.inject(['systemPrompt'], …)` 注册为段落 `desktop:protected-directories`，按字面文本，位于 `DEPLOYMENT_PERSONA_SUFFIX` 顺位。这一行写明：

- `protectedDirsPrompt`：`Unless the user explicitly asks, do not modify, move, or delete this app's own directories: {directories}. The skills folder {skillsDir} is exempt.`
- `directoryClauses`：`the installation directory ({installDir})`、`the data directory ({dataDir})`、`the settings folder ({appDataDir})`、`the logs folder ({logDir})`、`the update download folder ({updateCacheDir})`。
- `directorySeparator` 为 `, `，`directoryLastSeparator` 为 ` and `。

**每个路径的来源。** `{dataDir}` 是 `resolveDshHome()` 解析出的 harness 主目录，也就是服务器自己的插件所用的解析器，始终列出；`{skillsDir}` 是其中的 `skills` 目录，即 `@deepseek-ai/dsh-skill-filesystem` 读取用户技能的根目录。其余四个来自桌面外壳只为服务器子进程设置的变量，这一行用 `!!js process.env…` 读取：打包启动时的 `DSH_DESKTOP_INSTALL_DIR`（`apps/desktop-shell/src/install-dir.ts`），以及每次外壳启动都设置的 `DSH_DESKTOP_USER_DATA_DIR`（Electron 的 `userData`）、`DSH_DESKTOP_LOG_DIR`（写入 `dsh-server.log` 的目录）与 `DSH_DESKTOP_UPDATE_CACHE_DIR`（electron-updater 的缓存），后三个来自 `apps/desktop-shell/src/app-dirs.ts`。只有设置了路径的分句才会列出，所以外壳的开发启动不列安装目录，手动启动的 `dsh --profile desktop-shell` 只列数据目录，不需要为每种组合各写一个模板。每个路径都放在反引号里插入，路径中的空格与中日韩字符因此不会产生歧义，插入的路径也不会再被当作占位符扫描。这一行必须恰好包含 `{directories}` 与 `{skillsDir}`，每个分句必须恰好包含它自己的占位符；否则这一行拒绝挂载。在使用默认主目录的 Mac 上，打包启动时这一行是：``Unless the user explicitly asks, do not modify, move, or delete this app's own directories: the installation directory (`/Applications/北冥.app`), the data directory (`/Users/<user>/.dsh`), the settings folder (`/Users/<user>/Library/Application Support/@deepseek-ai/dsh-desktop`), the logs folder (`/Users/<user>/Library/Logs/@deepseek-ai/dsh-desktop`) and the update download folder (`/Users/<user>/Library/Caches/@deepseek-aidsh-desktop-updater`). The skills folder `/Users/<user>/.dsh/skills` is exempt.``

**位置。** 同顺位的段落按名字排序，`desktop:…` 排在 `deployment:persona-suffix` 之后，所以这一行是系统提示词的最后一段。预设的 `dsh-persona` 行只在自己的作用域里遮蔽 `deployment:persona-prefix` 与 `deployment:persona-suffix` 两段，进程内委派的子会话只加自己的 prefix，所以这个全局段落留在每个 `standard`、`ptc`、`cordis` 会话及其子会话里。

**技能目录是例外。** 用户 09-27 定：agent 自写的技能继续写进技能目录，因为写技能是 agent 跨会话保留所学的方式。数据目录里的用户级 `AGENTS.md` 没有点名；数据目录下还有哪些路径保持可写，由沙箱保护决定。

**不改核心。** 这一行、这个插件、这些模板和外壳的变量都属于桌面自己的代码与组合。系统提示词以 `system/message` 进入会话日志（`packages/core/agent-loop/src/agent.ts`），所以带这一行的每份提示词连同其中的具体路径都有记录，重放会话能还原它。

**上下文成本。** 上面的 macOS 这一行约 60 个词、约 505 个字符；长路径会被切成很多 token，按词数与字符数估算约 120 到 150 个 token，路径更长或含更多中日韩字符时更多。仓库里没有 tokenizer 可以精确测量。每个桌面会话的每次请求都会发送它。路径在一台机器上是稳定的，所以这段文字以及服务商对它的前缀缓存，在请求之间、会话之间都保持不变。已有会话只看到一次新提示词：桌面的 `deepseek-flash` 行声明了 `systemPromptUpdate: in-history`，所以变化后的提示词追加在已缓存的历史之后，而不是改写 0 号系统节点。这个成本值得付，因为这一行在完全权限下也生效，而那里没有任何沙箱规则；因为它针对的事故正是搬动日志；并且在有围墙的档位下，把这些目录当作禁区的模型不会为了动它们去申请升级。

## 考虑过的替代方案

**把这一行写进 persona 配置。** `dsh-system-prompt` 的 `personaSuffix` 是部署的位置，但每个预设的 `dsh-persona` 行都用自己的 suffix（`Your working directory is {{cwd}}.`）把它遮住，所以写在那里的一行在每个预设会话里都会消失。

**逐个修改预设的 persona 行。** 四行都要为加一句话而重述各自的 persona，之后新增的预设、或在 Web 预设编辑器里改过的预设，都不会带上它。

**用环境变量指代数据目录。** 较早的草稿写的是 `(the path in the DSH_HOME environment variable)`，约 40 个 token，不写任何路径。模型要先执行命令查到路径，才能判断一条命令是否碰到它；用户选择改为点名解析后的路径。

**只把 `userData` 点名为设置与日志目录。** macOS 上日志在 `~/Library/Logs` 下，不在 `userData` 里，所以那样的一行点不到事故里被搬动的目录。

**为已知目录的每种组合各写一个模板。** 仅安装目录、外壳目录、两者都没有就已经是三个模板，每多一个目录数量翻倍；一个整句模板加每个目录一个分句，就覆盖所有启动方式。

**把路径写死在这一行里，或把文字留在代码里。** 路径随平台、启动方式和 `DSH_HOME` 变化，所以这一行只写模板，由 Host 半边在挂载时解析路径。随部署而变的句子写在代码里就是硬编码的可调项，所以每个分句与分隔符都放在这一行里。

**等沙箱保护。** 它需要一个横跨各平台沙箱后端的核心补丁，而且它仍然不覆盖完全权限。

## 后果

这一行是建议，不是强制：模型仍可能无视它；不经过模型自身判断的事（用户明确要求、在文件沙箱之外运行的工具）不受影响。运行外部 CLI 的子代理（`subagent_codex`、`subagent_claude_code`）不带它。

**已知限制：`minimal` 会话不带这一行。** `minimal` 预设的 persona 是 `complete: true`，按设计替换整个系统提示词，桌面层不修改这个预设。沙箱保护落地后覆盖这些会话。

**路径对模型可见，也进日志。** 每个桌面会话日志的 `system/message` 记录里都有列出的目录。默认主目录下的路径含账户名；模型本来就通过会话工作目录看到同一主目录下的路径，所以这一行没有给日志添加新种类的信息。

**目录搬家后文字变一次。** 新的 `DSH_HOME`，或改变了安装目录的更新，在下一次服务器启动时生效；之后每个已有会话的第一次请求带一次变化后的提示词，追加在它已缓存的历史之后。

**Windows 与 Linux 上日志目录作为设置目录的子目录被列出。** 那里外壳的日志位于 `userData` 之下，所以这一行会点名一个目录和它的一个子目录；这个分句保留，因为在 macOS 上它点名的是另一个目录，而且事故动的正是日志目录。

技能目录例外让 agent 自写的技能无需用户要求即可写入。数据目录下的其他文件，包括用户级的 `AGENTS.md`，在沙箱保护决定它们的状态之前都受这一行约束。

按 id 修改 `desktop-brand` 行的层会替换它的整个 `config`，必须重述每个键，否则这一行拒绝挂载，提示词里也就没有这一句。修改措辞只需改 `apps/desktop-app/cordis.patch.yml` 里的模板，以及组合测试用来比对它们的常量。

## 测试

`apps/desktop-app/tests/protected-directories.spec.ts` 在真实的提示词注册表上挂载 Host 半边：打包启动在 persona suffix 之后列出全部五个目录，不做插值；外壳的开发启动不列安装目录；没有外壳变量时只列数据目录；两个分句之间只用最后的分隔符；含空格与中日韩字符的路径、以及 Windows 路径，都原样放进反引号，含占位符的路径不会被再次扫描；释放后这一段被移除；占位符缺失或未知的整句或分句拒绝挂载；缺失或空白的模板、缺失的分句以及空路径被 schema 拒绝。同一文件经 `@deepseek-ai/dsh-skill-filesystem` 从 `<dataDir>/skills` 加载一个技能，所以列为例外的目录就是技能加载读取的目录。`apps/desktop-shell/tests/app-dirs.spec.ts` 钉住外壳的三个变量、空路径不设变量，以及 `main.ts` 从 Electron 的 `userData`、日志目录与 `updaterCacheDir()` 取值、逐个记日志并加进服务器环境。`apps/desktop-shell/tests/desktop-composition-layer.spec.ts` 钉住组合行里的每个模板与每个 `!!js` 表达式，在设置与不设置对应变量两种情况下求值每个表达式，并用组合出的各行渲染提示词：`standard`、`ptc`、`cordis` 会话以填好的这一行结尾；经 `applyChildComposition` 组合的委派子会话在它自己的 persona 下也以这一行结尾；`minimal` 会话只渲染它完整的 persona。没有任何无 key 的录制会话快照运行桌面 profile，所以没有录制会话带这一行。
