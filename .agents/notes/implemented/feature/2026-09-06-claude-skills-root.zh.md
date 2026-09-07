# Agent Note: 本地 skill 提供方读取 `.claude` 根目录

Status: implemented

[English](2026-09-06-claude-skills-root.md) | 中文

## Problem

为其他 agent 客户端编写的 skill 存放在 `.claude/skills`——仓库里一份，用户的 Claude Code 配置根目录下一份——而多数主流客户端都读取该目录。`dsh-skill-filesystem` 在每一层只扫描 `.dsh/skills` 与 `.agents/skills`，别的都不扫，因此把 skill 放在 `.claude/skills` 的仓库、以及个人 skill 位于 `~/.claude/skills` 的用户，进入 DSH 会话时拿到的都是空目录，而同一份检出下的其他客户端全都看得见它们。

组合层的任何配置都表达不出这两个根目录。`customSkillDirs` 接收在插件加载时解析一次的绝对路径；它能指定一个用户目录，却永远表达不了「本次查找所在的那个项目的 `.claude/skills`」——项目根目录是每次 `list()` 调用时从查找 cwd 现算的。另起一个 `SkillProvider` 能解析它们，但那要自带一份根目录扫描、frontmatter 语法、缺失根探测与 Chokidar 管理器的副本，并且合入注册表时依据的是提供方注册顺序而非根 rank：两个提供方监视相邻目录，同名冲突的结果由挂载顺序而不是优先级表决定。根目录列表是上游提供方内部的一个固定数组，因此这是一个 core patch（内核补丁）。

## Decision

`dsh-skill-filesystem` 以 rank 210、来源 `project-claude` 扫描 `<projectRoot>/.claude/skills`，以 rank 510、来源 `user-claude` 扫描 `<claudeHome>/skills`。两者都是默认根：`includeDefaultRoots: false` 仍会省略全部项目行与用户行，隔离的自定义根提供方不会因此多看到任何东西。`claudeHome` 是新增的 `Config` 字段，默认取 `$DSH_CLAUDE_HOME`，其次 `~/.claude`，解析方式与 `agentsHome` 取 `$DSH_AGENTS_HOME`、其次 `~/.agents` 完全一致。覆盖变量用的是本 harness 自己的名字而非 Claude Code 的：harness 从哪里加载指令，只应由 harness 自己的环境决定，这也正是 `.agents` 根只认 `$DSH_AGENTS_HOME` 的原因。`SkillSource` 相应新增两个字面量。

每个 `.claude` 根都紧排在同一层 `.agents` 根之下，落在现有常量预留的间距里，因此两处同名的 skill 解析为共享的 `.agents` 约定，而两个新根既不会盖过 harness 自己的 `.dsh` 根，也不会掉到 `custom` 与 runtime rank 之后。这种冲突并非假设：本仓库自己的 `.claude/skills` 就是指向 `.agents/skills` 的符号链接，两个根因此以相同名字提供全部仓库 skill，胜者必须是固定的，而不是碰巧的。

watch 管理器无需改动。它按解析后的根路径为 watcher 建键，并从最近的既存祖先起一次跟进一个缺失路径段，对 `.agents` 或 `skills` 没有任何特例，因此两个新根被监视、被探测、被 `watchMaxProjects` 约束的方式与既有根一致。

`roots()` 现在每个目录只返回一个根。符号链接会让两个根落在同一个目录上——本仓库的 `.claude/skills` 正是如此——不去重的列表会把每个 skill 提供两遍：注册表把每个重名解析到优先级更高的根，并为每个 skill 各警告一次，watch 管理器则在同一个目录上打开两个宿主 watcher。每个根都经 `canonicalizeWatchPath`（watcher 本就使用的解析器）解析，规范路径已被前一个根覆盖的根，在发现与监视之前被丢弃。无法规范化的根——祖先不可读，或祖先是普通文件——保留其配置路径作为身份并留在扫描中。扫描随后的行为按错误码分岔：祖先是普通文件报 `ENOTDIR`，被 `isAbsentSkillPathError` 算作不存在，该根列举为空且不给任何诊断；祖先不可读报 `EACCES`，只把该根单独丢弃。

一个根扫描失败，丢的是这个根，不是整个提供方。除“不存在”以外的任何失败——根或其祖先上的 `EACCES`、解析到自身而报 `ELOOP` 的 `.claude/skills` 符号链接、发生故障的设备——都在 `packages/skill/skill-filesystem/src/index.ts:212` 按根捕获，以一条警告点名该目录及其错误类别，其余根则以 `{ candidates, complete: false }` 返回。若不捕获，该拒绝就会离开 `list()`，而 `dsh-skill` 是整个跳过一个拒绝的提供方而非按根跳过，于是模式 `000` 的 `~/.claude/skills` 会清空整份目录，并把 `~/.dsh/skills` 一起带走。watch 管理器不需要相应改动：它本就会为附加不上的根记日志，并在下一次查找时重试，因此变回可读的根无需重启即可回来。

只有 `complete: false` 时模型什么也收不到。`dsh-tool-skill` 只在快照完整时发布目录，因此按根降级只修好了 `ctx.skills.list()`、`get()` 与客户端选择器，而每一次 `agent/pre-step` 仍然什么都不发：`~/.claude/skills` 不可读时，模型连一个 `<available_skills>` 块都拿不到。现在 `packages/skill/tool-skill/src/index.ts:231` 的条件更窄——不完整的快照照常发布，除非它同时为空。不完整且非空，说明提供方只是报出了自己发现工作的一部分，它确实读到的那些 skill 是真实且可直接加载的；不完整且为空则分不清“没有 skill”与“什么都读不到”，把它发布出去等于从模型视图里删掉一份好目录。两种情况都不缓存，因此每一步都会重新观测。

测试中钉住这些根的动作收敛为一个函数。`dsh-loader-smoke` 的 `isolatedSkillRootEnv(cwd, overrides)` 返回整块变量——`DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_CLAUDE_HOME`，以及启动器提供时的 `DSH_BUNDLED_SKILL_DIR`——录制 fixture 与期望输出背后的启动器都展开它：`runLoaderSmoke`、session-snapshot 的启动器与 harness、SDK 快照运行器、`apps/web/tests/scaffold.ts`、五个 CLI 端到端套件，以及两个构建消费方环境的发布脚本。两个无法调用它的程序就地重复这套键名，且没有任何东西把它们绑到该函数上：`apps/web/tests/smoke-real.e2e.ts` 的五处 spawn（它属于客户端面程序，导不进宿主面函数），以及 `scripts/smoke-python-runtime.py` 的两处（Python 无法调用 TypeScript）。另有一批启动 harness 的站点仍只钉 `DSH_HOME`——`apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts`、`apps/cli/tests/lazy-search-startup.compat.spec.ts`、`apps/cli/tests/web-agent-presets.e2e.ts`、`apps/cli/tests/built-bin.e2e.ts` 与 `apps/web/tests/hmr-live.e2e.ts`——它们都不断言模型可见文本：断言的是 JSON 行生命周期事件、启动与 HMR 行为、agent preset 名册，以及 CLI profile 与插件输出，环境中的 skill 目录动不了其中任何一项。本次收敛所替代的 bug 恰恰就是漏掉一处：`snapshots/sdk/sdk.snapshot.ts` 只钉了 `DSH_AGENTS_HOME`，于是本次改动第一次运行时，开发者自己的 `~/.claude/skills` 进了 11 份录制好的 SDK 转录本。

## Alternatives considered

**在部署方的 cordis.yml 里把 `customSkillDirs` 指向这些目录。** 它只能触及加载时固定的绝对路径。用户根在单台机器上尚可这样表达，项目根则完全无法表达，而且每个部署都要重复携带同样的两行。

**为 `.claude` 根另发一个提供方包。** 它会重复发现、解析与监视逻辑，在既有管理器已经跟踪的目录上把宿主 watcher 翻倍，并把同名解析从 rank 表挪到提供方注册顺序上。

**把 `.claude` 排在 `.agents` 之上。** 那会让一个兼容性根压过 harness 文档中自称的约定；而在本仓库——两者经由链接本就是同一个目录——胜者会以读者无法预判的方式反转。

**读取 Claude Code 自己的 `$CLAUDE_CONFIG_DIR`。** 这样无需任何人配置就能跟随被迁移过的 Claude Code 配置根目录。但它同时让另一个工具的环境决定本 harness 从哪里加载指令，并且把一个 skill 根挂在 `DSH_` 前缀之外的名字上——`app-boot` 拒绝从发现到的 `.env` 中接受的正是带该前缀的名字，于是被克隆的仓库可以靠携带一个 `.env` 改写用户 skill 根。`$DSH_CLAUDE_HOME` 天然继承那条拒绝，也与 `$DSH_AGENTS_HOME` 保持对称；迁移过 Claude Code 根目录的用户把 `claudeHome` 或 `$DSH_CLAUDE_HOME` 指过去即可。

**同一次改动里顺带扫描 `.codex/skills`。** 尚未拍板，且每多一个根就多一个被监视的目录、多一处名字的来源。在有人提出之前它不进来。

## Consequences

每次带 cwd 的查找如今装配六个项目根与用户根，而不是四个；`deduplicateRoots` 为列表中的每一个根各解析一次规范路径——自定义目录与 bundled 根也在内，而未改动的代码一次都不解析：带一个自定义目录与一个 bundled 根的部署，每次查找付出八次解析。缺失的根仍在出现之前要花一次 `fs.watchFile` 探测。当 `.claude` 根链接到同层的 `.agents` 兄弟目录时，去重把这两项开销一起抵消：该根既不扫描也不监视，本仓库的检出因此没有第二次目录列举、没有第二个 watcher，也没有不去重时产生的那 11 条重名警告。

宿主 skill 混进 fixture 的途径依旧是某个启动器漏钉某个根。`isolatedSkillRootEnv` 让调用它的那些启动器只剩一处可漏；就地重复其键集的七处——Web 真实冒烟测试的五处 spawn 与 Python 运行时冒烟测试的两处——仍是可漏的地方，且没有任何门禁把它们约束到该函数的键名列表上。没有这层钉住，拥有 `~/.claude/skills` 的开发者录出的转录本会与 CI 不同——这里已被两次证实：先是包测试读到这台机器上真实存在的 skill，随后是 SDK 快照。`apps/web/tests/scaffold-hermetic.e2e.ts` 断言脚手架屏蔽环境中的 `.claude` 根，方式与它屏蔽另外三个一致。

发行的桌面版从此读取终端用户的 `~/.claude/skills`。挂载该提供方的宿主面行 `packages/bundle/base/cordis.patch.yml:288` 被 `packages/bundle/web-app/cordis.patch.yml:362` 关掉，真正生效的是三条 preset 行：`presets/standard/agent.cordis.yml:83`、`presets/ptc/agent.cordis.yml:90` 与 `presets/cordis/agent.cordis.yml:255`。三者都不设 `claudeHome`，其中唯一带 `config:` 的那条只带 `customSkillDirs`。桌面版要关掉这个根，只能给三条行都加上 `config: { claudeHome: <没有 skills 子目录的路径> }`，或在服务器进程环境里设 `DSH_CLAUDE_HOME`。`includeDefaultRoots: false` 不是这个开关：它会把 `.dsh` 与 `.agents` 一起关掉。

一个根不可读，代价是重扫，不是整份目录。`~/.claude/skills` 为模式 `000` 时，提供方丢掉该根并把其余部分报为不完整，`dsh-tool-skill` 照常发布，模型的 `<available_skills>` 块里带着其余每个根的 skill；被拒目录自己的 skill 则缺席，且没有逐 skill 的诊断。观测永不缓存，因此每一次查找都会重扫全部根——那条警告本会每个模型步骤重复一次，所以每个根在一段故障期内只报一次，只有错误类别改变、或该根中途成功过之后再次失败时才重报（`packages/skill/skill-filesystem/src/index.ts:215`，watch 管理器自身的启动失败在 `:500`）。粒度止于根：某个原本可读的目录里有一个读不了的 `SKILL.md`，会把整个目录一起移出本次观测，因为一次扫描只有一个结果；而本补丁新增的两个目录名都由本仓库之外维护——`~/.claude/skills` 属于另一个工具，被克隆仓库带来的 `.claude/skills` 可能是自指链接。本 fork 要求技能根不可读时绝不能让整份目录归零，因此这层容错落在这里而不是等上游，并在上游覆盖同一处时随本补丁一同退役。

空串 `$DSH_CLAUDE_HOME` 会把用户根解析成 `<cwd>/skills`，因为回退链只把未设置视为未设置。`$DSH_AGENTS_HOME` 行为相同，只有 `$DSH_HOME` 守卫空串；这里 `.agents` 与 `.claude` 两行保持对称，给两者都加守卫属于上游的事。

包测试在装配好的提供方上覆盖这些新根：两层 `.claude` 各自被发现且来源正确、两层中 `.agents` 的同名 skill 都胜过其 `.claude` 孪生、`includeDefaultRoots: false` 同时省略两者、`$DSH_CLAUDE_HOME` 解析、未设置该变量时回退到 `~/.claude`、被链接的重复根只被发现一次且无警告，以及该链接对只产生一个宿主 watcher。另有四项覆盖降级。模式 `000` 的用户根与指向自身的项目根，都让其余每个根的 skill 照常列出、快照标为不完整，并有一条带着该目录与宿主 errno 文本的警告，而它们旁边缺失的根保持静默，第二次查找也不再新增。经 `ctx.fs` 失败的根——即装配后的真实路径，`dsh-fs-local` 会把被拒的列举翻译成 `FS_PERMISSION_DENIED`——钉住宿主消息不会重复的那段错误码前缀，并在错误码改变时重报。`watch: true` 下，一个被拒的根加上失败的 watcher 启动，在两次查找中共产生三条警告而不是六条。在 `dsh-tool-skill` 中，一个被拒的根与一个可读的根并存时，`agent/pre-step` 产出一条含该可读 skill 的目录消息。`chmod` 与符号链接两例在 Windows 上跳过——该系统既不通过 POSIX 目录模式拒绝访问，也不报 `ELOOP`。

上游自己的 `skill-filesystem` 扫描 `.claude` 根即退役。上游改为按根降级而非按提供方降级时——无论是在 `skill-filesystem`、其上的 `dsh-skill` 聚合层，还是改为从部分观测中发布目录——按根降级这一层，以及 `dsh-tool-skill` 中“不完整但非空也发布”的那条判断，一并退役。
