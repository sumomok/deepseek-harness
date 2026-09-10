# Agent Note: 壳的 profile 让开上游保留的那个名字

Status: implemented

[English](2026-09-11-desktop-shell-profile-rename.md) | 中文

## Problem

上游 0.1.5-rc.1 把 profile 名 `desktop` 保留给了它自己的 Electron 应用。`apps/cli/src/args.ts` 里的 `rejectElectronProfile` 会对每一个 `--profile desktop` 与每一个 `plugin --profile desktop`(大小写不敏感)以 `error: profile "desktop" is managed exclusively by the Electron application` 终止进程,`apps/cli/tests/args.spec.ts` 钉住了全部六种写法。上游的应用把 `$DSH_HOME/profiles/desktop` 当作一个事务式 npm 项目独占:`apps/desktop/src/paths.ts` 拼的正是这个路径,`apps/desktop/src/project-manager.ts` 则围绕内置 pnpm 对整个目录做暂存、健康检查、移动与回滚,并拒绝任何 `name` 不是 `@deepseek-ai/dsh-desktop-runtime` 的清单、以及任何不以它自己的内置名单开头的 bundle 列表。

本 fork 的壳启动的就是同一个名字。`apps/desktop-shell/src/server.ts` 以 `--profile desktop` 拉起内嵌服务端,`apps/desktop-shell/src/profile-seed.ts` 在那之前创建并维护 `$DSH_HOME/profiles/desktop`。在 rc.32 的基座上,这次拉起在参数解析阶段就被拒绝,服务端在打印 URL 行之前退出,壳停在一个过不去的启动失败页上。rc.32 的集成复核没有发现它,因为那次复核的任何一个阶段都没有真的把壳启动到合并后的基座上。

名字冲突不只是这一道检查。一台同时装了两个应用的机器会给一个目录留下两个所有者:本壳往 `dsh.profile.bundles` 追加名字、往 `node_modules` 里建链接,而上游的管理器拒绝任何不是它写的清单,并在每次更新时整体搬走这个目录。

## Decision

**fork 的 profile 叫 `desktop-shell`。**`apps/desktop-shell/src/profile-seed.ts` 里的 `DESKTOP_PROFILE` 持有这个名字,模板清单据它得出 `dsh-profile-desktop-shell`,`plugin-admin-service.ts` 里的 `ADMIN_PROFILES` 读这个常量而不是再写一遍字面量。`resolveProfileDir` 只拒绝空名、分隔符、`.`、`..` 与 `node_modules`,所以带连字符的名字不需要上游做任何事;`desktop-shell` 同样不在 `PROFILE_TEMPLATES` 里,所以播种仍然和从前一样是启动的前置条件。

**已装客户端的 profile 会在本次构建的首次启动时被改名一次。**`adoptLegacyProfile` 在 `seedBuiltinBundles` 里先于其他一切运行,把 `$DSH_HOME/profiles/desktop` 改名到 `$DSH_HOME/profiles/desktop-shell`。同一个卷上的一次 `renameSync` 就把清单、用户的 `cordis.patch.yml`、`pnpm-workspace.yaml`、`web-migration.json`、每一个迁移插件的链接,以及这个 profile 自己装过的每一个包一并带走。链接照样解析得到,因为 `ensureLink` 写的是绝对目标;而内置插件的链接住在 `$DSH_HOME/profiles/node_modules`,那里根本没有被移动。

**清单的 `name` 是判定的全部依据,而改写它是播种自身规则的唯一例外。**改名只在新 profile 还没有 `package.json` 时进行——正是 `initDesktopProfile` 用来回答 `created` 的同一个判据——并且只在旧目录的清单读出 `dsh-profile-desktop` 时进行,那是本壳写下的名字,而上游的 `@deepseek-ai/dsh-desktop-runtime` 永远不是。此后清单的 `name` 会被改写为 `dsh-profile-desktop-shell`:播种在别处一律不动已存在的文件,而这一个字段说明清单属于哪个目录,pnpm 在那里跑每一条 `dsh plugin --profile desktop-shell` 命令时都会读它。一次启动若发现 `desktop-shell` 上已经有清单,读的仍是这同一个字段:那里读出 `dsh-profile-desktop` 就是一次改名的改写没有落地,而此后机器上没有任何东西再陈述这件事;改写在那时被补完,其他任何名字一律不动。

**改名失败会留下完整的旧目录和一次能用的启动。**失败记进 `SeedReport.skipped` 而不是 `SeedReport.failed`,因为 `failed` 指的是启动唯一绕不过去的那件事——服务端没有 profile 可启动——而这不是那件事:播种继续进行并写出一个全新的 `desktop-shell`,它的第一次同步会把用户在 `web` 里的插件重新搬进来。改名发生过时 `SeedReport.renamedFrom` 带上旧名字,`describeSeed` 会把 `renamed the desktop profile into place` 写进 `dsh-server.log`。

## Alternatives considered

**以一条核心补丁把 `rejectElectronProfile` 从 `apps/cli` 里去掉。**只有一行,而且能让 rc.32 继续用每个已装客户端本就有的那个名字。否决,因为这道检查不是问题所在:上游的应用以事务方式独占那个目录,所以一台同时装了两者的机器上,本壳会往一份上游管理器拒绝的清单里追加内容,而上游会把那个目录从它脚下搬走。这条补丁还会在上游下一次改动同一处代码时退役,对一个本 fork 并不需要的名字来说,那是一份反复付出的成本。

**保留 `desktop`,换别的办法够到它。**没有别的办法:这道检查在 `resolveBoot` 之前读解析出来的 `--profile` 值,既没有环境变量、也没有开关、更没有绕过它的 API,而壳除了 CLI 之外没有任何受支持的启动方式。

**复制旧 profile 而不是改名。**复制要走一棵用户可能已经装进去几百 MB 的目录树,而复制到一半被打断会留下两个半成品 profile。同一个卷上的 `renameSync` 是原子的,整个目录要么全过去、要么全不过去。

**挑一个与包名无关的名字,比如 `dsh-desktop` 或 `client`。**任何避开 `desktop` 的名字都能过这道检查。`desktop-shell` 与 `apps/desktop-shell` 和 `@deepseek-ai/dsh-desktop-shell` 对得上,而这正是一个人翻 `~/.dsh/profiles/` 时分辨哪个应用拥有它所需要的,尤其在第二个应用也装上之后。

**惰性迁移,等到第一次加载 profile 失败再说。**那需要壳去读服务端自己的诊断再重试,等于为一个在拉起之前就有确定答案的情形,把崩溃隔离那道梯子重新造一遍。

## Consequences

**设置里的更新页随改名一起走,早先构建写下的回滚记录仍然打得开。**`@haoran/dsh-plugin-updates` 0.2.1——`apps/desktop-server/vendor/` 下随包分发的那个 tarball——把 `DESKTOP_PROFILE = "desktop-shell"` 编进了它的 host 半边,读 `$DSH_HOME/profiles/desktop-shell/package.json` 与 `web-migration.json`,并向插件管理服务发送 `profile: "desktop-shell"`,那正是服务接受的两个名字之一。它的回滚台账是它唯一落在所有 profile 之外的状态——`$DSH_HOME/dsh-plugin-updates/last-update.json`——所以改名不会移动它,本次构建之前写下的记录里仍读出 `profile: "desktop"`;插件在读取时把这个值映射为 `desktop-shell`、写入时只写新名,于是撤销那一步跨过升级仍然在。内置插件从来不在此列,因为它们是播种进去的、不是装进去的,载荷里也没有别的东西点这个 profile 的名。0.2.1 只为这一个名字构建:仍然启动 `desktop` 的壳要配 0.2.0。

**两个应用可以装在同一台机器上。**上游自己的壳会在它首次运行时创建并拥有 `$DSH_HOME/profiles/desktop`,本壳拥有 `$DSH_HOME/profiles/desktop-shell`。它们仍然共享 `$DSH_HOME` 的其余部分——会话、凭据、设置——那也是它们此前就共享的,fork 的壳一直把这件事写在文档里。

**用户对着这个 profile 跑的每一条命令都变了。**`dsh plugin --profile desktop add <包>` 变成 `dsh plugin --profile desktop-shell add <包>`,而要关掉某个内置插件该编辑的文件是 `$DSH_HOME/profiles/desktop-shell/cordis.patch.yml`。`apps/desktop-shell/README.md`、它的中文对照,以及带着这些命令的 implemented Agent Note 都已更新;那些 note 里讲述 rc.17 做了什么的叙述,保留那一版当时用的名字。

**rc.32 的集成门禁多了一条启动要求。**rc.32 复核的任何一个阶段都没有把壳启动到合并后的基座上,这正是一道会直接终止启动的上游检查能走到集成阶段的原因。`.claude/core-patches.md` 记下了这一条:一次集成合并在真实跑过一遍壳到服务端的启动冒烟之前,不算复核过。

## Testing

`apps/desktop-shell/tests/profile-seed.spec.ts` 用六个用例覆盖改名:一个带着迁移插件、改过的 patch 层与迁移记录的旧 profile 被整体改名、清单 `name` 被改写、每一个 bundle 仍然解析得到;一个带着上游 `@deepseek-ai/dsh-desktop-runtime` 清单的 `desktop` 目录被逐字节留下,一个全新的 `desktop-shell` 在它旁边被播种出来;第二次启动什么都不改名,因为它要启动的那个 profile 已经在那儿了;`rename(2)` 拒绝的改名——新路径上已经站着一个非空目录——记进 `skipped`,旧目录保持完整,而这次启动仍然播种出一个能启动的 profile;新路径上是一个普通文件时,仍然产生播种一直以来产生的那份 `failed` 报告;目录先于名字挪过去时——`desktop-shell` 上的清单仍读出 `dsh-profile-desktop`——下一次启动补完这次改写,再下一次启动则把它逐字节留下。

`apps/desktop-shell/tests/server.spec.ts` 是这次回归本身被钉住的地方:一个脚本化的服务端子进程记下 `startServer` 拉起它时用的参数,用例断言那就是 `--profile desktop-shell --port 0 --no-open`,再把同一个数组喂给 `apps/cli` 自己的 `parseDshArgs`,得到的是一次 profile 启动而不是退出。一个启动器会拒绝的 profile 会在这里失败,而不是在用户的下一次启动时。

真实启动也实测过:用本壳自己的 `seedBuiltinBundles` 往一个临时 `DSH_HOME` 播种,并让同一次运行把手工摆好的 `profiles/desktop` 改名到位,然后以 `--profile desktop-shell --port 0 --no-open` 启动构建产物 `apps/cli/lib/bin.js`。服务端打印了它的 URL 行,并以 `200` 回答了首页。
