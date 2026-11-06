# Agent Note: The desktop shell records a migrated plugin the running server did not load

Status: implemented

[English](2026-09-26-desktop-load-failure-from-running-output.md) | 中文

## Problem

[web profile 同步](2026-08-25-desktop-web-profile-migration.zh.md)会禁用服务端 loader 在 import 时拒绝的迁移插件。它的做法是捕获 `ServerExitedBeforeUrl`,在那次启动的输出里找 loader 的 `failed to import loader entry <id> (<module>)` 一行,然后不带这个插件再启动一次。

在 0.1.7 基座上,这两半都不会发生。那一行已经不存在:上游回退了打印它的事务式 Cordis loader,可选条目 import 失败现在是 `ctx.logger.error`,再加启动审计块里的一行 `<id> (<name>): failed to import`。服务端也不会退出:审计块对一组写死的上游必需 id 之外的条目都只是警告,迁移插件从来不在这组里,所以 URL 行照常打印,`startServer` 照常 resolve,catch 永远不执行。同一基座新增的兼容检查也一样:它往 stderr 写 `skipping profile bundle "<name>"` 或 `disabling profile plugin row "<id>"`,启动照常继续。于是坏掉的或被拒绝的迁移插件每次启动都缺席,屏幕上什么都没有,这正是同步功能要防止的悄无声息的消失。

## Decision

`startServer` 接受一个可选的逐行回调,把 stdout 和 stderr 的每一行(两个流各自分行)都交给它,只要进程还在写就一直交,包括 URL 行之后的行。URL 行来自 web app 自己的续延、写到 stdout,审计块来自 app-boot 的续延、写到 stderr,两者的先后都不能假定。

`startServerWithQuarantine` 把每一行交给 `quarantineLoadFailureFromOutput`,它认三种行:

- 审计块里的一行 `<id> (<name>): failed to import`,其中 `<name>` 是包名;对插入的相对路径则是 `file:` URL,包名取最后一个 `node_modules` 之后的目录;
- `<bin>: skipping profile bundle "<package>": <reason>`;
- `<bin>: disabling profile plugin row "<id>": <reason>`,按 id 到每个迁移包自己的 bundle 层里反查;没有 id 的行则是 `<bin>: disabling profile plugin <module URL>: <reason>`。

marker 的 `migrated` 里列着的包会带着 kind `load-failed` 挪进 `defective`,并移出 `dsh.profile.bundles`。服务端不会重启:这次启动已经不带这个插件在运行,下一次启动也不会加载它。记下来的名字就不在 `migrated` 里了,所以同一个名字只记一次。import 失败的 detail 只有 `failed to import`,因为真正的 import 错误只到服务端的 logger,而它不写到任何壳读得到的地方;另外两种行带着各自的原因。

`ServerExitedBeforeUrl` 之后的重试保留下来,用于在打印 URL 行之前退出、而此前有一行(或整段输出)点了某个迁移插件名的启动。在 0.1.7 基座上没有迁移插件会导致这种退出,所以这条路是为将来某个基座在可选条目 import 失败时重新退出而留的;它不再认那句已删除的 loader 行,也不读必需条目的多行诊断,因为隔离一个迁移插件修不好必需条目的失败。

## Alternatives considered

**仍然只扫描在 URL 行之前退出的那次启动的输出。**在这个基座上它从不执行,这正是问题所在。

**只扫描到 URL 行为止。**审计块和 URL 行由两条互不等待的续延写出,走两根管道,审计块可能在 URL 行之后才到。

**记下名字之后重启服务端。**服务端不带这个插件已经在正常运行;重启要多付一次启动,用户看到的东西也没有变化,因为下次启动本来就会跳过这个名字。

**把被拒绝的插件列为已知限制。**一个消失了、设置页里又没有任何说明的插件,正是 `defective` 列表要防止的结果。

## Consequences

import 失败的迁移插件,或被兼容检查拒绝的迁移插件,从发现它的那次启动起记进标记文件的 `defective` 列表,并在启动日志里点名;没有任何界面列出它,删掉它的标记条目才是把它带回来的办法([插件管理交给上游](../feature/2026-09-26-desktop-plugin-management-on-upstream.zh.md))。

壳依赖三行上游文字的确切写法。某个基座改写了其中一行,那种情况就会回到悄无声息的缺席;`tests/profile-seed.spec.ts` 固定了壳读取的这三种写法。

`defective` 说不出 import 为什么失败;用户或修复路径要到服务端日志里找。

## Testing

`apps/desktop-shell/tests/profile-seed.spec.ts` 给 `quarantineLoadFailureFromOutput` 喂了点名包名的审计块、点名 `file:` URL 的审计块、被跳过的 bundle、按 id 禁用的行、按模块 URL 禁用的行、一段点了两个包且其中一个点了两次的完整输出,以及没点到任何迁移包的行。`apps/desktop-shell/tests/server.spec.ts` 跑一个脚本化子进程,先打印 URL 行,再往 stderr 写审计块,检查名字进了 `defective`、子进程只 spawn 了一次。打包后的检查(在真实的 `web` profile 里放一个坏插件)是冒烟的 F8。

## Related

- [The web profile's plugins stay synced to the desktop, and a defective one stays visible](2026-08-25-desktop-web-profile-migration.zh.md) — 负责同步和 `defective` 列表;它关于隔离与重试的那一段描述的是 0.1.7 之前的基座,由本 Note 取代。
