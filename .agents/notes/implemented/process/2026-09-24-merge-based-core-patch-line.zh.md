# Agent Note: 核心补丁线用 merge 并入上游发布，并按与基座 tag 的差异认领路径

Status: implemented

[English](2026-09-24-merge-based-core-patch-line.md) | 中文

## 问题

[slug 加 trailer 的补丁身份](2026-09-17-core-patch-identity-trailers.zh.md)是为一条每轮变基到新上游基座的线设计的。`scripts/verify-core-patches.ts` 从登记的 `**基座合并**：#<号>` 声明取基座，枚举 `<base>..HEAD` 里的全部提交，要求这个范围线性，且每个提交恰有一条 `Patch:` trailer。

fork 现在把这条线保留为长期分支 `feature/core-patches`，用 `git merge` 并入上游。本线由 `core-patches-v11` 接续，接续方式是 `-s ours` 合并 tag `core-patches-z`；该 tag 把 `core-patches-v9` 与旧的 `core-patches` 线接在一起，使 `develop` 与补丁线只有一个合并基。对计划中的历史做探针，测出旧门禁的表现：声明仍为 #4469 时，`<base>..HEAD` 有 1725 个提交，其中 453 个合并；声明改为上游发布之后，范围里仍有 264 个提交、3 个合并，其中约 130 个来自被接入的历史，全都不带 trailer。加上 `--first-parent` 后剩 134 个提交：131 个补丁提交，加上新历史的三个提交，其中 `-s ours` 接续与发布合并这两个是合并提交，线性规则拒绝它们。

## 决定

**本线只合并，不变基。** 上游发布 tag 经 `git merge` 进入 `feature/core-patches`；`core-patches` 只快进到它，`develop` 只通过合并 `core-patches` 取得核心改动。登记 `.claude/core-patches.md` 声明 `**当前补丁线**：\`feature/core-patches\`` 与 `**基座 tag**：\`<tag>\``，取代基座合并号。

**门禁拿本线的差异而不是提交清单与登记比对。** 基座是 `refs/tags/<tag>^{commit}`，且 `git merge-base HEAD <tag>` 必须等于它（tag 不存在报 `base-tag-missing` 并提示 `git fetch upstream --tags`，未并入报 `base-tag-not-merged`）。差异集是 `git diff --no-renames --name-only <base> HEAD` 减去一份固定的生成物清单。每条 `在役` 或 `局部退役` 记录带一行 `- **路径**：`，列出反引号包住的 pathspec，按 `:(glob)` 匹配：

- `unclaimed-path`：某个差异路径没有任何在役记录认领。
- `unused-active-slug`：某条在役记录一个差异路径都没认领到；它的改动已经消失，应当退役。
- `unused-pathspec`：某条 pathspec 没有命中任何差异路径。
- `missing-paths`：在役记录缺 路径 行。
- `retired-record-claims-paths`：`退役` 记录带了 路径 行；退役的族不拥有任何改动，它留下的东西会以未认领的形式报出来。

因此退役就是该族的改动从差异里消失。它的旧提交可以留在线上，原来的 `retired-slug-in-use` 检查已删除。

**提交沿 first-parent 链读取。** `git log --first-parent <base>..HEAD` 上的每个非合并提交恰有一条 `Patch:` trailer，值是登记过的 slug，任何状态都算（`trailer-count`、`malformed-trailer`、`unregistered-slug`）。被接入的历史和上游的提交挂在合并提交的第二父之下，不被枚举。

**这条链上只接受两种合并。** (a) 合并恰有两个父提交，且第二父恰好是某个 `refs/tags/dsh-v*` tag 指向的提交（附注 tag 取解引用后的提交）：并入上游发布。点名了发布的 octopus 合并仍会带进其余父提交，不算这一种。(b) 合并后的树等于第一父的树：`-s ours` 接续。其余合并一律报 `merge-commit`，因为话题分支的合并会把不带 trailer 的提交藏在第二父之下；本线上的改动以直接提交或 squash 提交落地。规则 (a) 不对声明的 tag 提任何要求：声明改成更新的 tag 之后，此前每一轮的发布合并仍留在 first-parent 链上，而新 tag 到达不了它们。

门禁的适用范围不变：其他分支、detached HEAD、浅克隆都报 `skipped` 并以 0 退出。所以 `develop`、`core-patches` 和 CI 的 pull-request 检出都会跳过，尽管它们带着 fork 自有路径和不带 trailer 的提交。

## 备选方案

**继续变基，只在 `develop` 上接续旧线。** 线性门禁照样能过，但每一轮都会再次替换本线的全部提交，`develop` 每次拿到的都是一段新的、互不相关的历史，它与上一段的合并基是交叉祖先构造出来的虚拟合并。

**不再把 `feature/core-patches` 声明为补丁线。** 门禁处处跳过，登记失去唯一的机械核对。

**当声明的 tag 是第二父的祖先或第二父本身时接受发布合并。** 从已并入该 tag 的线上拉出的话题分支同样以它为祖先，挂在下面的无 trailer 提交会被放行。任何祖先条件还会让下一轮失败：声明改成更新的 tag 之后，本轮的发布合并仍在范围内，它的第二父比那个 tag 旧。

**只枚举提交，不看路径。** trailer 只说明一个提交认领哪一族，说明不了那一族是否还改着什么。滚动同步要带过去的是差异，所以每条记录交代的也是差异。

## 后果

登记写明每一族相对上游占着哪些路径；一次同步如果让某族退役、或留下一处无主的改动，门禁会一直失败，直到登记写明为止。并入更新的发布之后、改 `基座 tag` 声明之前，整个上游跨度都读作未认领；声明与认领在合并之后的一条登记提交里一起改。

生成物清单是门禁里的常量。某个生成器开始写一份原来由各族手工认领的文件（例如翻译后的目录）时，要在同一轮把它加进这份常量。

pathspec 匹配每条跑一次 `git diff`，每次几毫秒，共几百条。门禁在 CI 里仍然没有约束力；它只在有人对 `feature/core-patches` 跑 `doc-sync` 的地方执行。
