# Agent Note: 本 fork 出厂即关闭会话遥测与插件清单上报

Status: implemented

[English](2026-09-01-fork-kills-session-telemetry-and-plugin-inventory.md) | 中文

## 问题

`packages/bundle/base/cordis.patch.yml`(每个已发布 profile——desktop、web、headless、ACP、SDK——都会叠加的层)挂载了两行默认就会向 DeepSeek 运营的端点发数据的条目:`session-telemetry-otel`,配置为 `mode: FEEDBACK_ONLY`(一旦 `feedback/record` 事件落地就上传该会话的规范日志,覆盖了该包自己出厂的 `DISABLED` 默认值),以及 `plugin-package-inventory-deepseek`,它会把当前 Loader 活跃插件包清单附加到每一次面向官方 DeepSeek API 的 LLM 请求上。`packages/bundle/sdk-minimal/cordis.patch.yml`(独立的 SDK bundle,并不继承 `base`)另外单独挂载了自己的 `plugin-package-inventory-deepseek` 条目。还有第三行发往同一家运营方:`session-log-deepseek` 会把 `dsh_session_log`——该会话的规范日志前缀,包含上下文——贡献进每一次面向官方 DeepSeek API 的请求,两个 bundle 都挂载了它。本 fork 自己的产品决定是:无论用户的 `DSH_TELEMETRY_MODE`/反馈操作如何、运行哪个 profile,本 fork 发布的任何构建都不上报这三类数据中的任何一类。

## 决定

`packages/bundle/base/cordis.patch.yml` 里的两行,以及 `packages/bundle/sdk-minimal/cordis.patch.yml` 里的 `plugin-package-inventory-deepseek` 那一行,现在都带上了 `disabled: true`。一条被禁用的 Cordis 条目的 `apply()` 永远不会运行,所以这是一个结构性保证,而不是运行时判断:无论由哪个 bundle 构建出的哪个 profile,这两个插件都不会构造出 HTTP 客户端、OTel 导出器,或 Loader 注册表读取器。`session-telemetry-otel` 下的 `config` 块被保留而非删除,好让 `DSH_TELEMETRY_MODE`/`DSH_TELEMETRY_OTLP_URL` 继续说明上游这一行本来期望的字段,供未来某个想重新启用它的、消费这些 bundle 包的下游使用。

第三行答的是另一个开关。`session-log-deepseek` 从自己的 schema 读 `enabled`,上游把该字段默认为 `true`,因此它在 `packages/bundle/base/cordis.patch.yml` 与 `packages/bundle/sdk-minimal/cordis.patch.yml` 里的两行都带 `config: { enabled: false }`。该插件的 `apply()` 按这个取值在注册 `dsh_session_log` 请求贡献之前就返回,而那条贡献是它贡献的全部,所以结果与另外两行一致;与 `disabled: true` 的唯一差别是模块仍被导入、`apply()` 仍运行一次且什么都不注册。选这个字段,是因为它就是该插件自己写明的开关。

`packages/bundle/base/tests/base.spec.ts` 与 `packages/bundle/sdk-minimal/tests/sdk-minimal.spec.ts`(两者本就通过 `entryListSchema` 解析 `cordis.patch.yml` 来检查其他行的 `disabled`/`config` 结构)各自断言本 bundle 里每一行的字面取值,并把 `session-log-deepseek` 行再经该插件自身的 schema 解析一遍,让断言钉住插件实际会读到的值,而不只是文件里的文本。

上传通路的覆盖留在重放语料里。名字以 `sdk-` 开头的组合各自声明自己夹具所记录的策略——三个声明 `enabled: true`(`snapshots/sdk/text-turn`、`serial-created`、`subagent-dsh-sdk-diagnostic`),三个声明 `enabled: false`——因为 `sdk.snapshot.ts` 对这些组合只叠它们自己的 `cordis.yml`。另外三个(`session-title-after-turn`、`subagent-continuable-inheritance`、`subagent-send-message`)什么都不声明,叠的是 `default` 组合的属主 `snapshots/session/text-turn/cordis.yml`,那里显式写着 `enabled: false`。一个什么都不声明的 `sdk-` 组合才会去继承上游 schema 的默认值,在 fork 的 bundle 下改变行为却没有任何夹具说明这件事。

## 权衡过的替代方案

**只依赖 `DSH_TELEMETRY_DISABLED`,处处如此。** 否决:这个开关是上游自己的选择退出机制,只在 `apps/cli` 的启动路径里解析一次,而且对 `plugin-package-inventory-deepseek` 完全没有对应效果。fork 层面「两者都出厂关闭」的产品决定,应该落在每个 profile 都会叠加的 bundle 定义本身里,而不是放进一个用户可以取消设置的环境变量,也不应该为第二个插件另造并维护一个新的环境变量开关。

**引入一个叠加在 `dsh-base` 之上的、fork 自有的 overlay bundle,而不是直接改 `dsh-base` 本身。** 考虑过,因为 `packages/bundle/base` 是随上游同步进来的源码,fork 自己的政策更偏好在插件/组合层定制而非动上游核心。这次否决:本仓库目前没有任何已发布 profile 组合过任何 fork 自有的 overlay bundle(`apps/desktop` 的 `WEB_TEMPLATE_BUNDLES`、`apps/pwa`,以及 SDK/headless/ACP 各 bundle,全都直接组合纯上游 bundle),为了翻转两个 `disabled` 布尔值就新引入一个组合层包,属于为一处两行的改动新造组合层机制——转而把它记作一次核心补丁,这正是 fork 自己既有的、处理「确有必要」的上游源码改动的路径,记入 `.claude/core-patches.md`(见本次提交新增的两条条目),好让下一次类似 rc.27 的同步知道要重新施加它。

## 后果

本 fork 各产品能种出的每一个 profile——desktop、PWA/web、headless、ACP、独立 SDK bundle——都组合 `dsh-base` 或 `dsh-sdk-minimal`,而三条通往 DeepSeek 的行在它所组合的那个 bundle 里全部关闭,通过解析实际提交的 patch 文件验证,而非依赖一次实时网络断言。三条里有两条是结构性的:被禁用条目的 `apply()` 永不运行。第三条靠的是一个取值,而 patch 是整段替换目标行的 `config` 而非合并进去,因此后续的 profile、home 或逐次调用 patch 只要给 `session-log-deepseek` 行任何 `config` 却没重述 `enabled: false`,就会恢复上游的默认开启。代价是:未来某个想把某一行恢复的贡献者,得先找到并撤销一处如今不那么显眼的行(本笔记与 core-patches 台账里都有记录),而不是翻转一个环境变量就完事——这个取舍是把 fork 自己声明的隐私立场,放在了「恢复开关是否好找」之前。
