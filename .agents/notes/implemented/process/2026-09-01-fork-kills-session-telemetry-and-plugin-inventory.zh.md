# Agent Note: 本 fork 出厂即关闭会话遥测与插件清单上报

Status: implemented

[English](2026-09-01-fork-kills-session-telemetry-and-plugin-inventory.md) | 中文

## 问题

`packages/bundle/base/cordis.patch.yml`(每个已发布 profile——desktop、web、headless、ACP、SDK——都会叠加的层)挂载了两行默认就会向 DeepSeek 运营的端点发数据的条目:`session-telemetry-otel`,配置为 `mode: FEEDBACK_ONLY`(一旦 `feedback/record` 事件落地就上传该会话的规范日志,覆盖了该包自己出厂的 `DISABLED` 默认值),以及 `plugin-package-inventory-deepseek`,它会把当前 Loader 活跃插件包清单附加到每一次面向官方 DeepSeek API 的 LLM 请求上。`packages/bundle/sdk-minimal/cordis.patch.yml`(独立的 SDK bundle,并不继承 `base`)另外单独挂载了自己的 `plugin-package-inventory-deepseek` 条目。本 fork 自己的产品决定是:无论用户的 `DSH_TELEMETRY_MODE`/反馈操作如何、运行哪个 profile,本 fork 发布的任何构建都不上报这两类数据中的任何一类。

## 决定

`packages/bundle/base/cordis.patch.yml` 里的两行,以及 `packages/bundle/sdk-minimal/cordis.patch.yml` 里的 `plugin-package-inventory-deepseek` 那一行,现在都带上了 `disabled: true`。一条被禁用的 Cordis 条目的 `apply()` 永远不会运行,所以这是一个结构性保证,而不是运行时判断:无论由哪个 bundle 构建出的哪个 profile,这两个插件都不会构造出 HTTP 客户端、OTel 导出器,或 Loader 注册表读取器。`session-telemetry-otel` 下的 `config` 块被保留而非删除,好让 `DSH_TELEMETRY_MODE`/`DSH_TELEMETRY_OTLP_URL` 继续说明上游这一行本来期望的字段,供未来某个想重新启用它的、消费这些 bundle 包的下游使用。

`apps/desktop/src/server.ts` 的 `startServer` 还在内置服务器的启动环境上额外设置了 `DSH_TELEMETRY_DISABLED: '1'`,并放在 `spec.env` 之前展开,好让调用方(测试)仍可覆盖它。这对 desktop 产品而言,与上面的 `disabled: true` 行是刻意的冗余:`DSH_TELEMETRY_DISABLED` 是上游自己既有的硬性关闭开关(`apps/cli/src/profile-boot.ts` 的 `resolveTelemetryPatch`,作为 `composeProfile` 补丁栈里最顶层、无条件重新施加的 overlay,盖过 `--patch` overlay),已经按行 id 覆盖了任意组合下的 `session-telemetry-otel`——这是本 fork 直接掌控其启动器的那一个产品(desktop)额外的、环境变量层面的第二重保证,不依赖底下具体叠的是哪个 bundle patch。`DSH_TELEMETRY_DISABLED` 对 `plugin-package-inventory-deepseek` 没有任何作用;那一行唯一的关闭开关就是它自己的 `disabled: true`。

`packages/bundle/base/tests/base.spec.ts` 与 `packages/bundle/sdk-minimal/tests/sdk-minimal.spec.ts`(两者本就通过 `entryListSchema` 解析 `cordis.patch.yml` 来检查其他行的 `disabled`/`config` 结构)新增了断言,确认两个 bundle 里对应的行都解析为 `disabled: true`。`apps/desktop/tests/server.spec.ts` 新增了一个脚本化子进程测试,证明被启动的服务器默认能看到 `DSH_TELEMETRY_DISABLED=1`,而显式的 `spec.env` 条目仍能覆盖它。

## 权衡过的替代方案

**只依赖 `DSH_TELEMETRY_DISABLED`,处处如此。** 否决:这个开关是上游自己的选择退出机制,只在 `apps/cli` 的启动路径里解析一次,而且对 `plugin-package-inventory-deepseek` 完全没有对应效果。fork 层面「两者都出厂关闭」的产品决定,应该落在每个 profile 都会叠加的 bundle 定义本身里,而不是放进一个用户可以取消设置的环境变量,也不应该为第二个插件另造并维护一个新的环境变量开关。

**引入一个叠加在 `dsh-base` 之上的、fork 自有的 overlay bundle,而不是直接改 `dsh-base` 本身。** 考虑过,因为 `packages/bundle/base` 是随上游同步进来的源码,fork 自己的政策更偏好在插件/组合层定制而非动上游核心。这次否决:本仓库目前没有任何已发布 profile 组合过任何 fork 自有的 overlay bundle(`apps/desktop` 的 `WEB_TEMPLATE_BUNDLES`、`apps/pwa`,以及 SDK/headless/ACP 各 bundle,全都直接组合纯上游 bundle),为了翻转两个 `disabled` 布尔值就新引入一个组合层包,属于为一处两行的改动新造组合层机制——转而把它记作一次核心补丁,这正是 fork 自己既有的、处理「确有必要」的上游源码改动的路径,记入 `.claude/core-patches.md`(见本次提交新增的两条条目),好让下一次类似 rc.27 的同步知道要重新施加它。

## 后果

本 fork 各产品能种出的每一个 profile——desktop、PWA/web、headless、ACP、独立 SDK bundle——出厂即结构性地零遥测出站、零插件清单上报,通过解析实际提交的 patch 文件验证,而非依赖一次实时网络断言。代价是:未来某个想把这两行恢复的贡献者,得先找到并撤销两处如今不那么显眼的 `disabled: true`(本笔记与 core-patches 台账里都有记录),而不是翻转一个环境变量就完事——这个取舍是把 fork 自己声明的隐私立场,放在了「恢复开关是否好找」之前。
