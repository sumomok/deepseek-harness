# Agent Note: private 应用不是发布成员

Status: implemented

[English](2026-08-20-private-apps-are-not-release-members.md) | 中文

## 问题

`scripts/check-workspace-constraints.ts` 只按目录判定谁要发布。`releaseMemberDirectory` 匹配每一个 `apps/*` 包，于是它们都必须非 private、把 `publishConfig.access` 设为 `public`、让 `repository` 带着自己的目录指向已发布的源码，并在 `appPackageFiles` 发布策略里占一条。

`apps/` 下同时还放着永远不上 npm 的产品装配件：一个 Electron 外壳、它内嵌闭包所依据的纯依赖部署根，以及一个补进运行中 `dsh web` 的组合层 bundle。三者都随客户端构建一起发货，都声明了 `"private": true`，因此四条发布成员约束一次性全挂。

脚本之外没有任何地方能改变这个判定。该门禁直接读 manifest，把发布成员的判定写成硬编码正则，前面既没有插件缝，也没有配置文件或白名单，所以这个类别只能教给门禁本身。

## 决策

`apps/*` 承载两类包，`private` 把它们分开。`isPrivateApp` 把声明了 `"private": true` 的 `apps/*` manifest 归为随构建发货的应用，`checkWorkspace` 于是对它跳过发布成员元数据那一段，也跳过已发布应用的文件策略。这沿用 `packages/experimental/*` 已有的形态：一个仍然参与全部共享工作区检查、但落在 `releaseMemberDirectory` 之外的类别。

判别式选 `private` 而不是嵌一层目录或列一份名字白名单，是因为它同时也是阻止 `npm publish` 上传该包的那个字段。一份 manifest 无法既在这里声称自己随构建发货，又能抵达 registry。

`checkPrivateAppManifest` 说明这个类别用什么取代发布元数据。private 应用必须不带 `publishConfig`，与 experimental 的规则对应；也必须不出现在 `appPackageFiles` 里，从而让那张表继续对"哪些应用要发布"保持权威：没有第二条规则，给 `apps/cli` 加上 `"private": true` 会让 `dsh` CLI 悄悄退出发布，而不是让门禁失败。

`checkExperimentalDependencyIsolation` 仍把 private 应用纳入检查范围。桌面构建一旦要求某个 experimental 包，坏掉的就是真实用户装下来的运行时，与 npm 是否见过这份 manifest 无关。

## 测试

`scripts/check-workspace-constraints.spec.ts` 钉住通过的随构建发货 manifest、两条被拒的发布声明，以及该判别式必须放过的两种形态——`apps/` 下已发布的应用，和 `apps/` 之外的 private 包。

## 曾考虑的替代方案

**把随构建发货的应用挪进新目录，例如 `apps/private/*`。** 否决，因为目录层级同时在好几处承重——`pnpm-workspace.yaml`、本脚本自己的 `workspaceGlobs`、knip 的工作区表都假定 `apps/` 下只有一层——也因为这些装配件是 `apps/cli` 的同级，而非低一等的分层。挪目录还会改写打包配置与一个部署根按名字引用的路径。

**在门禁里列一份包含这三个包名的白名单常量。** 否决，因为每新增一个随构建发货的应用都要把这份列表加长，而每次加长都是对一个本仓库已经打了补丁的上游文件再动一刀。`private` 是 manifest 关于自身陈述的事实，不需要第二份登记表与它保持一致。

**在门禁的工作区遍历里跳过这三个目录。** 否决，因为那样它们会连本该适用的检查一起丢掉：被禁止的发布载荷、每一处工作区引用都要用的 `workspace:` 协议，以及遍历其余部分强制的版本与依赖规则。免于发布元数据不等于免于工作区卫生。

**给它们配上用不上的发布元数据，靠 `private` 拦住上传。** 否决，因为这会让每份 manifest 同时陈述两件互相矛盾的事，也因为 `appPackageFiles` 将不得不为一个永不打包的包写出发布载荷。

## 后果

`apps/` 现在靠一个布尔量分成已发布成员与随构建发货的应用，三个 fork 自有的装配件因此过闸，而门禁对 `apps/cli` 与 `apps/web` 的要求一点没有放松。

代价是 `apps/*` manifest 里的 `"private": true` 会悄悄改变适用哪套规则。`appPackageFiles` 的交叉检查只能兜住已经有文件策略的应用；一个生下来就是 private 的应用，在有人试图发布它之前与随构建发货的应用无从区分。接受这份残留，是因为门禁真正要防的那类发布还要经过同样读取 manifest 的打包与发布步骤。

这是本仓库为数不多的、打在上游门禁上的补丁之一。它止于一个判别式、一个导出的检查函数和两处加了条件的分支，好让上游同步后的重新落地始终是一份小而可评审的 diff。
