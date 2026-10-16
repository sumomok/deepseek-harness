# Agent Note: private 应用不是发布成员

Status: implemented

[English](2026-08-20-private-apps-are-not-release-members.md) | 中文

## 问题

`scripts/check-workspace-constraints.ts` 把发布成员表达式没有排除的每个 `apps/*` 目录都当作本仓库发布的包。这样的包不能是 private，要把 `publishConfig.access` 设为 `public`，要让 `repository` 指向它自己的目录，要在 app 发布文件策略里占一条，要带工作区版本号，也不能依赖实验包。

本线的 `apps/` 下还有四个永远不上 npm 的产品应用：Electron 外壳 `apps/desktop-shell`，外壳内嵌其闭包的纯依赖部署根 `apps/desktop-server`，组合层 bundle `apps/desktop-app`，以及可安装的手机客户端 `apps/pwa`。四者都声明 `"private": true`，各带自己的产品版本号，因此上面每一条都挂。

## 决定

门禁用 `privateProductAppDirectories` 点名这四个目录，并在它排除上游自己的私有仓库工具 `apps/plugin-market-generator`（上游 Merge pull request #5633）的三处同样排除它们：`standardReleaseMemberDirectory` 的否定前瞻、app 发布文件策略的条件，以及 `checkWorkspaceManifest` 里的共享版本检查。其余每一项工作区检查仍然作用于它们。

这项排除只在 `develop` 上。补丁线和 `product/server-console` 上没有私有应用，`.claude/core-patches.md` 把这项改动列在只活在 `develop` 的核心路径改动里。本线新增一个私有应用，就要把它的目录加进 `privateProductAppDirectories`。

## 测试

`scripts/check-workspace-constraints.spec.ts` 逐个读这四份清单，在各自目录下判为通过，并断言同一份清单放在别的 `apps/*` 目录下会挂发布成员、发布文件策略与根版本三条规则。

## 考虑过的替代方案

**按 `"private": true` 给 `apps/*` 包分类。** 这是这项决定的早期形态，作为补丁线的族 `workspace-gate-private-apps` 携带。上游自己的用例断言未知的 `apps/*` 包即使是 private 也仍是发布成员，所以这个判定与上游规则相反，每次同步门禁都要重新移植；该族在 `dsh-v0.2.1-alpha.4` 退役。

**把四个应用排除出发布成员规则，但仍留在实验包依赖隔离检查里。** `checkExperimentalDependencyIsolation` 只读发布成员，要留在检查范围内就得对门禁再改第四处。`apps/desktop-app` 依赖 `@deepseek-ai/dsh-tool-session-query`，`apps/desktop-server` 依赖 `@deepseek-ai/dsh-hook-protocol`，两者自 `dsh-v0.2.1-alpha.4` 起都在 `packages/experimental/` 下。

## 影响

四个应用以上游给自己私有工具的同一种形态通过门禁，本线上门禁相对上游的差异是一个具名集合加三个条件。

实验包依赖隔离不覆盖这四个应用。桌面载荷丢了它需要的实验包，会在桌面打包时暴露：打包的 staged boot 用暂存的服务端闭包组合出发货的 profile。
