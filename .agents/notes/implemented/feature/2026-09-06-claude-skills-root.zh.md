# Agent Note: The local skill provider reads the `.claude` roots

Status: implemented

[English](2026-09-06-claude-skills-root.md) | 中文

## Problem

为其他 agent 客户端编写的 skill 存放在 `.claude/skills`——仓库里一份，用户的 Claude Code 配置根目录下一份——而多数主流客户端都读取该目录。`dsh-skill-filesystem` 在每一层只扫描 `.dsh/skills` 与 `.agents/skills`，别的都不扫，因此把 skill 放在 `.claude/skills` 的仓库、以及个人 skill 位于 `~/.claude/skills` 的用户，进入 DSH 会话时拿到的都是空目录，而同一份检出下的其他客户端全都看得见它们。

组合层的任何配置都表达不出这两个根目录。`customSkillDirs` 接收在插件加载时解析一次的绝对路径；它能指定一个用户目录，却永远表达不了「本次查找所在的那个项目的 `.claude/skills`」——项目根目录是每次 `list()` 调用时从查找 cwd 现算的。另起一个 `SkillProvider` 能解析它们，但那要自带一份根目录扫描、frontmatter 语法、缺失根探测与 Chokidar 管理器的副本，并且合入注册表时依据的是提供方注册顺序而非根 rank：两个提供方监视相邻目录，同名冲突的结果由挂载顺序而不是优先级表决定。根目录列表是上游提供方内部的一个固定数组，因此这是一个 core patch（内核补丁）。

## Decision

`dsh-skill-filesystem` 以 rank 210、来源 `project-claude` 扫描 `<projectRoot>/.claude/skills`，以 rank 510、来源 `user-claude` 扫描 `<claudeHome>/skills`。两者都是默认根：`includeDefaultRoots: false` 仍会省略全部项目行与用户行，隔离的自定义根提供方不会因此多看到任何东西。`claudeHome` 是新增的 `Config` 字段，默认取 `$DSH_CLAUDE_HOME`，其次 `~/.claude`，解析方式与 `agentsHome` 取 `$DSH_AGENTS_HOME`、其次 `~/.agents` 完全一致。覆盖变量用的是本 harness 自己的名字而非 Claude Code 的：harness 从哪里加载指令，只应由 harness 自己的环境决定，这也正是 `.agents` 根只认 `$DSH_AGENTS_HOME` 的原因。`SkillSource` 相应新增两个字面量。

每个 `.claude` 根都紧排在同一层 `.agents` 根之下，落在现有常量预留的间距里，因此两处同名的 skill 解析为共享的 `.agents` 约定，而两个新根既不会盖过 harness 自己的 `.dsh` 根，也不会掉到 `custom` 与 runtime rank 之后。这种冲突并非假设：本仓库自己的 `.claude/skills` 就是指向 `.agents/skills` 的符号链接，两个根因此以相同名字提供全部仓库 skill，胜者必须是固定的，而不是碰巧的。

watch 管理器无需改动。它按解析后的根路径为 watcher 建键，并从最近的既存祖先起一次跟进一个缺失路径段，对 `.agents` 或 `skills` 没有任何特例，因此两个新根被监视、被探测、被 `watchMaxProjects` 约束的方式与既有根一致。

`roots()` 现在每个目录只返回一个根。符号链接会让两个根落在同一个目录上——本仓库的 `.claude/skills` 正是如此——不去重的列表会把每个 skill 提供两遍：注册表把每个重名解析到优先级更高的根，并为每个 skill 各警告一次，watch 管理器则在同一个目录上打开两个宿主 watcher。每个根都经 `canonicalizeWatchPath`（watcher 本就使用的解析器）解析，规范路径已被前一个根覆盖的根，在发现与监视之前被丢弃。无法规范化的根——祖先不可读，或祖先是普通文件——保留其配置路径作为身份并留在扫描中，由扫描给出自己的诊断。

测试中钉住这些根的动作收敛为一个函数。`dsh-loader-smoke` 的 `isolatedSkillRootEnv(cwd, overrides)` 返回整块变量——`DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_CLAUDE_HOME`，以及启动器提供时的 `DSH_BUNDLED_SKILL_DIR`——所有启动器都展开它：loader 冒烟测试、快照启动器与 harness、SDK 快照运行器、Web 脚手架及其真实冒烟测试、五个 CLI 端到端套件，以及两个构建消费方环境的发布脚本。Python 运行时冒烟测试无法调用 TypeScript，就地钉住同样这些名字。本次收敛所替代的 bug 恰恰就是漏掉一处：`snapshots/sdk/sdk.snapshot.ts` 只钉了 `DSH_AGENTS_HOME`，于是本次改动第一次运行时，开发者自己的 `~/.claude/skills` 进了 11 份录制好的 SDK 转录本。

## Alternatives considered

**在部署方的 cordis.yml 里把 `customSkillDirs` 指向这些目录。** 它只能触及加载时固定的绝对路径。用户根在单台机器上尚可这样表达，项目根则完全无法表达，而且每个部署都要重复携带同样的两行。

**为 `.claude` 根另发一个提供方包。** 它会重复发现、解析与监视逻辑，在既有管理器已经跟踪的目录上把宿主 watcher 翻倍，并把同名解析从 rank 表挪到提供方注册顺序上。

**把 `.claude` 排在 `.agents` 之上。** 那会让一个兼容性根压过 harness 文档中自称的约定；而在本仓库——两者经由链接本就是同一个目录——胜者会以读者无法预判的方式反转。

**读取 Claude Code 自己的 `$CLAUDE_CONFIG_DIR`。** 这样无需任何人配置就能跟随被迁移过的 Claude Code 配置根目录。但它同时让另一个工具的环境决定本 harness 从哪里加载指令，并且把一个 skill 根挂在 `DSH_` 前缀之外的名字上——`app-boot` 拒绝从发现到的 `.env` 中接受的正是带该前缀的名字，于是被克隆的仓库可以靠携带一个 `.env` 改写用户 skill 根。`$DSH_CLAUDE_HOME` 天然继承那条拒绝，也与 `$DSH_AGENTS_HOME` 保持对称；迁移过 Claude Code 根目录的用户把 `claudeHome` 或 `$DSH_CLAUDE_HOME` 指过去即可。

**同一次改动里顺带扫描 `.codex/skills`。** 尚未拍板，且每多一个根就多一个被监视的目录、多一处名字的来源。在有人提出之前它不进来。

## Consequences

每次带 cwd 的查找如今最多解析五个项目根与用户根，而不是三个，每个根多花一次规范路径解析；缺失的根在出现之前要花一次 `fs.watchFile` 探测。当 `.claude` 根链接到同层的 `.agents` 兄弟目录时，去重把这两项开销一起抵消：该根既不扫描也不监视，本仓库的检出因此没有第二次目录列举、没有第二个 watcher，也没有不去重时产生的那 11 条重名警告。

如今宿主 skill 混进 fixture 的唯一途径，是某个启动器漏钉某个根，而可漏的地方只剩一处。没有这层钉住，拥有 `~/.claude/skills` 的开发者录出的转录本会与 CI 不同——这里已被两次证实：先是包测试读到这台机器上真实存在的 skill，随后是 SDK 快照。`apps/web/tests/scaffold-hermetic.e2e.ts` 断言脚手架屏蔽环境中的 `.claude` 根，方式与它屏蔽另外三个一致。

发行的桌面版从此默认读取终端用户的 `~/.claude/skills`。没有运行时开关：不想要它的部署方需设置 `includeDefaultRoots: false` 并列出自己想要的根，或把 `claudeHome` 指向自己掌控的目录。

包测试在装配好的提供方上覆盖这些新根：两层 `.claude` 各自被发现且来源正确、两层中 `.agents` 的同名 skill 都胜过其 `.claude` 孪生、`includeDefaultRoots: false` 同时省略两者、`$DSH_CLAUDE_HOME` 解析、未设置该变量时回退到 `~/.claude`、被链接的重复根只被发现一次且无警告，以及该链接对只产生一个宿主 watcher。

上游自己的 `skill-filesystem` 扫描 `.claude` 根即退役。
