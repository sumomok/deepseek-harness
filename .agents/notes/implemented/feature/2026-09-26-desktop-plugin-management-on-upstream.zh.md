# Agent Note: The desktop manages plugins through upstream's plugin manager

Status: implemented

[English](2026-09-26-desktop-plugin-management-on-upstream.md) | 中文

## 问题

到 0.1.0-rc.33 为止，桌面上并排组合着两套插件安装器。`@haoran/dsh-plugin-updates` 在壳的本机插件管理服务之上画出「更新」标签页，那个服务用随包 Node 跑随包的 pnpm。它只更新 profile 已经装过的包，一次一个，每次先弹原生确认框。上游的 `plugin-manager` Host 行与 `ui-plugin-manager` 侧栏页能安装、启用、停用、移除任意 bundle，在安装前后都做插件兼容检查，并对 profile 加文件锁。桌面层一直把上游这一对关着，所以上游在插件管理器上发的每一处修复都绕过了桌面，而 fork 还得维护一套自己的安装器。

打开上游这一对又带出三个问题。`pnpmCommand` 只指一个可执行文件，在 pnpm 子命令之前不给它任何参数。随包的 `resources/runtime/pnpm/bin/pnpm.mjs` 以 `#!/usr/bin/env node` 开头，而客户机的 `PATH` 上没有 Node。插件页能从注册表装上 `@deepseek-ai/dsh-experimental-auto-review`，尽管载荷有意不带它；它的层会在 `@haoran/dsh-llm-permission-gateway` 旁边挂上上游的 Auto，两者读的是同一对旋钮，同一次调用会被审两遍。`pluginManager` 服务一出现，web 应用的 cordis 预设就挂上 `plugin_manager` 这个 agent 工具；一次调用就能装上 Host 代码，或停用网关自己那一行，而在「自动审查」档下替这次调用拿主意的会是审查模型。

## 决策

**上游的插件管理器是桌面唯一的安装器。**`apps/desktop-app/cordis.patch.yml` 让 `plugin-manager` 与 `ui-plugin-manager` 保持开启。它的 `plugin-manager` 行只带 `config`，所以 dsh-base 那条按 profile 判定的 `disabled` 表达式照旧生效。

**pnpm 经随包 Node 旁边的一个启动脚本运行。**macOS 载荷带 `resources/runtime/dsh-pnpm`（POSIX sh 脚本），Windows 载荷带 `resources/runtime/dsh-pnpm.cmd`。两者都用同一目录下的 Node 运行 `pnpm/bin/pnpm.mjs`，原样传递每个参数，并把这个目录放到 pnpm 启动的一切进程的 `PATH` 最前面。两个脚本都在 `apps/desktop-shell/src/pnpm-launcher.ts` 里。`scripts/package.ts` 每次运行都暂存两者，`verifyStaging` 要求两者都在、且 macOS 那个带可执行位。`scripts/after-pack.cjs` 把目标平台的那个复制进 `runtime/`。打包后的启动给服务端子进程设 `DSH_DESKTOP_PNPM=<脚本路径>`，`plugin-manager` 行把它读成 `pnpmCommand: !!js process.env.DSH_DESKTOP_PNPM ?? 'pnpm'`。开发启动什么都不设，用 `PATH` 上的 `pnpm`。

**`@haoran/dsh-plugin-updates` 与插件管理服务离开载荷。**这个插件列在 `WITHDRAWN_WEB_BUNDLES` 里，所以本构建第一次启动时，会从 rc.33 构建播种过的 profile 里去掉它的名字，并删掉 flat-fallback 链接。本机服务、它的原生确认框、它的环境变量，以及只为它的修复路由服务的导出都已删除。[插件管理服务那份 Note](../../archived/feature/2026-08-25-desktop-plugin-admin-service.md) 已归档。

**`web-migration.json` 里的 `defective` 与 `removed` 两张名单照旧写入，只有启动日志显示它们。**每条记录名字的路径都往 `dsh-server.log` 写一行，内容是 `disabled migrated <name>: …`、`removed <name>: …` 或 `disabled migrated <name> after it failed to load`。没有任何界面列出这两张名单。从标记文件里删掉某个名字的条目，下一次启动就会再次接纳它，`tests/profile-seed.spec.ts` 覆盖了这一点。

**到 0.1.0-rc.37 为止，每次启动都在 profile 层让上游的 auto-review 保持关闭；[占位包 note](2026-10-04-desktop-withheld-bundle-placeholders.zh.md)取代了这一行。**`src/profile-seed.ts` 的 `seedAutoReviewGuard` 曾在 `$DSH_HOME/profiles/desktop-shell/cordis.patch.yml` 里保留 `- id: auto-review` / `disabled: true`，上方有一段注释写明用途。profile 层在所有 bundle 层之后生效，包括插件页后来加进的 bundle，所以装上的 auto-review 组合出来是关的。这一行的认法与 `SEEDED_PERMISSION_ROWS` 相同。恰好就是这一行的条目不动。其他任何声明这个 id 的条目也不动，并记一行日志；例如插件页的启用会在这一行写上 `disabled: false`。否则这一行替换模板或被清空的层里的 `[]`，或者接在最后一个块条目之后。写成非空流式序列的层只记日志、不动。web profile 同步把带着这一行的模板视为未编辑，所以它对 web 补丁层的一次性复制照样发生。

**网关把每次 `plugin_manager` 调用都交给人。**桌面层的 `llm-permission-gateway` 行设了 `alwaysAsk`，里面有 `plugin_manager` 和一句说明这次调用能改动什么的话。这个字段整体替换网关的默认表，所以这一行逐字重述 0.5.0 `DEFAULT_ALWAYS_ASK` 里的 `browser_auth`。在「自动审查」与两个有围墙的档位下，网关在任何审查模型看到调用之前先问人。在「完全权限」下网关让开，工具自己的规则让 `danger-full-access` 会话不经询问就能调用它。

## 备选方案

**保留 `@haoran/dsh-plugin-updates`，上游那一对继续关着。**这是 0.1.0-rc.34 原定的默认方案。fork 要维护第二套安装器，并把它改成用上游的兼容判定。不采纳：它只更新 fork 自己的插件，上游管理器之后的每一处改进都到不了桌面。

**两套安装器都留着。**不采纳：壳的进程内更新锁与上游的 profile 文件锁互相看不见，两边可能同时写 `package.json` 与 `pnpm-lock.yaml`。插件页也照样会把 auto-review 摆出来。

**让 `pnpmCommand` 直接指向随包 Node 或 `pnpm.mjs`。**不采纳：这个字段只收一个可执行文件、不收前置参数，所以 Node 拿不到脚本路径。`pnpm.mjs` 自己要经 `PATH` 找 `node`，而机器上没有。上游自己的 Electron 应用经 `ProfileContext.packageManager` 传入包管理器调用，那只有它自己的宿主启动器会设。本壳启动的是公开的 `bin.js`，不得为此加一个 argv 逃逸口。

**把 auto-review 那一行放进 desktop-app bundle 层。**不采纳：插件页把新装的 bundle 追加在 `@deepseek-ai/dsh-desktop-app` 之后，所以那里一条按 id 的行会在 auto-review 的 `insert` 之前执行，什么也匹配不到。profile 层是第一个在所有 bundle 之后生效的层。

**每次启动都把 auto-review 那一行改回 `disabled: true`，不管它写着什么。**不采纳：插件页的启用就写在这同一行上，一个打开了 Auto 的人每次重启都会发现它又被关掉，而且没有任何解释。

**关掉 cordis 预设里的 `tool-plugin-manager` 行，而不是去问人。**不采纳：那一行在 `preset-cordis` 的 `config.plugins` 里，按 id 的 patch 够不到。去问人也让这个工具在有人想用时仍然可用。

**整体关掉 `preset-cordis`。**一条按 id 的 `disabled: true` 行就够得到它，`plugin_manager` 也随之消失。不采纳：它把 cordis 预设也一起拿掉了，而这个预设在桌面上要保持可用。

**让网关在上游 Auto 挂载时自己让路（Q-G5）。**没有采用：桌面让 Auto 挂不上，所以网关里没有这样的检查。到 0.1.0-rc.37 为止，把两个审查者隔开的只有 profile 层里播种的 `auto-review` 关闭行，有人把它改成 `disabled: false`（插件页的启用写的正是这个）后，Auto 就挂在网关旁边，之后每次调用都被审两遍，没有任何提示。从 0.1.0-rc.38 起，载荷里的占位包让 Auto 根本加载不了（[占位包 note](2026-10-04-desktop-withheld-bundle-placeholders.zh.md)）。

## 后果

桌面得到上游的安装、启用、停用、移除操作和兼容拒绝，以及上游插件管理器以后新增的一切。它失去了「更新」标签页：上游页面没有逐包「更新到最新」的操作，也没有一步撤回，安装也不再经过原生模态框确认。用过旧标签页的机器上会留着 `$DSH_HOME/dsh-plugin-updates/last-update.json`，没有任何东西读它。

被停用或打了墓碑的迁移插件，只在 `dsh-server.log` 里看得到。

到 0.1.0-rc.37 为止，在没装 auto-review 的 profile 上，`--dump-config` 往 stderr 写一行 `patch: entry "auto-review" not found`，`web` 不为它写任何东西。在 `mkdtemp` 出来的 home 上实测，这两处都不含 `LOAD_FAILURE_MARKERS` 的任何片段，也不匹配 `quarantineLoadFailureFromOutput`。

`alwaysAsk` 只在网关组合出来的 `config` 带着本层这张表时才到得了一台机器。网关在设置页、`/review` 或一次性 `settings.yaml` 导入里保存时，会把整行组合后的 config 写进 profile 层，所以在本构建上保存的会保留 `plugin_manager`。`settings-migration.ts` 把同一张表补给它从留下来的 `insert` 改写出来的那条按 id 的行，以及 `config` 里没有 `alwaysAsk` 的任何按 id 的网关行。profile 层里 `config` 自带 `alwaysAsk` 的行会替换这张表。

插件页停用一个 bundle 的做法，是把它的名字从 `dsh.profile.bundles` 里删掉。对内置插件来说这只维持到下一次启动：播种会把名字重新插回去，插在 `@deepseek-ai/dsh-desktop-app` 之前，让那一层的行仍然找得到这个插件插入的行。要一直关掉某个内置插件，得在 profile 层写一条 `disabled: true` 行。

Windows 启动脚本还没有在真实安装上跑过。Execa 10 以 `cmd.exe /d /s /c` 运行 `.cmd`，每个参数都按批处理文件的 `%*` 转义；取消运行或运行静默超时时，`killDescendants` 要穿过这个 `cmd.exe` 才能杀到 `node.exe`。两者都要在真实的 Windows 机器上确认。

## 相关

[0.1.7-rc.2 基座上的桌面载荷](../process/2026-09-26-desktop-payload-on-the-rc2-base.zh.md)拥有扣包与启动闸；[占位包 note](2026-10-04-desktop-withheld-bundle-placeholders.zh.md)拥有顶替 auto-review 与检查器组合包的占位包，并取代 auto-review 守护行；[web profile 迁移](2026-08-25-desktop-web-profile-migration.zh.md)拥有 `defective` 与 `removed` 两张名单；[撤回播种的权限行](../bug-fix/2026-09-17-retire-seeded-permission-patch-rows.zh.md)拥有这道守卫复用的行识别器。
