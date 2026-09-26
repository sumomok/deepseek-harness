# Agent Note: The desktop shell prepares settings.yaml for the server's one-time import

Status: implemented

[English](2026-09-26-desktop-settings-yaml-pre-import.md) | 中文

## Problem

到 0.1.0-rc.33 为止,桌面把所有实时设置存在 `$DSH_HOME/settings.yaml` 里,每个命名空间一段。0.1.7 基座去掉了这个文件:服务端首次启动时,`SettingsForms.importLegacyDocument` 把它改名为 `settings.yaml.imported`,再通过设置页用的同一个配置编辑器,把每一段写进 id 与段名相同的 profile 条目。之后没有任何东西再读改名后的文件。

这次导入有两条硬规则。没有同 id 条目的段导入失败。段里只要有一个键不是该条目声明的 volatile 字段,整段失败,包括该条目的 `Config` 里已经根本不存在的键。失败的段只在 `ctx.logger` 上留一条 warn,而桌面组合里没有任何 exporter 把它写到用户或壳看得到的地方,数据则留在一个没人再读的文件里。

rc.33 客户端的文件在好几处撞上这两条规则。`agent-presets` 没有这个 id 的条目;注册表叫 `agent-preset-registry`,选择存在 `selectedDefault`,`code` 预设改叫 `ptc`,rc.2 还删掉了 `modeSelectionEnabled`。`at-file` 属于这一版撤下的插件。四个插件段带着早期插件版本写过、后来的版本不再声明的键,首先是审查网关的 `mode`;手改还可能留下插件 schema 拒绝的值。`llm-deepseek.baseURL` 存的是 Messages 适配器用不了的 chat completions 地址。另外,闪屏在任何服务端存在之前就从 `settings.yaml` 读 `ui-theme`,文件改名之后就会退回跟随系统。

## Decision

`apps/desktop-shell/src/settings-migration.ts` 在启动时紧接着 `seedBuiltinBundles` 运行(排在它的权限行退役之后)、在服务端 spawn 之前。它把文件改写成每一段要么能导入、要么被有记录地删掉。

- **`agent-presets`** 改写成 `agent-preset-registry: { selectedDefault }` 段,`code` 改名为 `ptc`,交给导入器。`modeSelectionEnabled: false` 的客户端不写 `selectedDefault`:它的新会话用的一直是部署默认 `standard`,而 rc.2 已经没有隐藏选择的开关。
- **`ui-theme`** 由壳直接写进 profile 的 `ui-theme` 条目,再从文件里删掉这一段。`theme-preference.ts` 先读这个条目,只有条目不存在时(即升级后的第一次启动)才读 `settings.yaml`。
- **`at-file`** 映射到接替它的两个条目。`enabled: false` 把 `ui-reference` 写成 `disabled: true`。全局忽略列表与 at-file 自己的默认列表不同时,其中的精确名字接在 `file-reference-local` 的 `excludedDirectories` 默认十五个名字之后;空名字和含路径分隔符的名字被删掉,因为该条目的 `validateConfig` 遇到它们会抛错。正则、大小写敏感、按工作区的列表和 `ignorePastedMentions` 没有对应字段,记录后丢弃。然后删掉这一段。
- **四个插件段**只留下各插件的 volatile 键,而且每个值都要是该插件 schema 接受的值;其余逐键删掉,一个坏值不再拖着整张价格表或整个服务器列表一起失败。允许的键和值检查是壳自己的表;`tests/settings-migration-whitelist.spec.ts` 让它与 vendored 包保持一致。
- **`llm-deepseek.baseURL`** 的 host 是 `api.deepseek.com` 时,不论路径一律删掉,改用适配器自己的 Messages 地址。其他 host 保留,用户会在载入后的窗口上看到一次对话框,提示这个地址可能需要更换。
- **重复的审查网关 `- insert:` 行**(权限行退役因为它被改过而保留下来的那种)改写成带同样 config 的按 id 定位的行:网关自己的 bundle 层已经插入了这个 id,再插入一次会让网关的设置页挂不上、`/review` 报错。这一行,以及 `config` 映射里没有 `alwaysAsk` 的每一个按 id 定位的网关行,都补上 `GATEWAY_ALWAYS_ASK`,也就是桌面层那份带 `plugin_manager` 的表,因为这一行的 `config` 会替换桌面层的;有一个用例让这个常量与 `apps/desktop-app/cordis.patch.yml` 保持一致。

壳只对没有 required 字段的目标条目直接写 profile 行(`ui-theme`、`ui-reference`、`file-reference-local`),因为按 id 定位的行会整份替换目标的 `config`。`agent-preset-registry` 要求 `default`,所以这一段走导入器,由它合并到合成后的 config 上。

读写 `settings.yaml` 用的是 `yaml` 2 的 `parseDocument`、`deleteIn` 和 `toString`,与 rc.33 的 settings 文件和导入器是同一个库、同一套 YAML 1.2 core schema,所以不带引号的 `prices.asOf: 2026-09-10`、数字、布尔值和注释都原样保留。profile 的 patch 层按配置编辑器的方式编辑,`!!js` 标量保留为带标签的文本。

`profiles/desktop-shell/settings-migration.json` 记下每个被删掉的值及原因、写了哪些条目、网关行改写前后的原文以及 base URL 的处置。它与 `web-migration.json` 分开:后者是否存在决定 web profile 同步是不是第一次,它的字段 `@haoran/dsh-plugin-updates` 也在读。运行的第一步、在其他任何可能出错的操作之前,把 `settings.yaml` 移动成 `settings.yaml.pre-rc34`;所有改写都从这份原件算出,最后才写回为 `settings.yaml`。marker 的 `state` 从移动之后到最后一处改动之后是 `pending`,然后是 `done`,之后每次启动都整段跳过,只有下面两处延后的部分除外;遇到 `pending` 的运行从原件重新计算所有改写,已经写好、字段相同的条目算作自己写的。marker 不存在、`settings.yaml` 和 `settings.yaml.pre-rc34` 都不存在而 `settings.yaml.imported` 存在时,说明另一个 profile 的服务端先导入过,壳把它复制成 `settings.yaml.pre-rc34` 一次,让这个 profile 也导入一遍。`settings.yaml`、移走的原件、从 `settings.yaml.imported` 复制来的文件、marker 和 patch 层都以 0600 写入,因为这些设置里有 MCP 服务器的环境变量和请求头的值。

有四种启动情形单独处理。移动之后运行抛错,`settings.yaml` 就不存在,那次启动的服务端什么也不导入,按 profile 的条目和随包默认值运行;下一次运行发现只有 `settings.yaml.pre-rc34` 而没有 `settings.yaml`,就从它写出整理好的副本交给服务端导入。所以服务端从不导入原样的 rc.33 文件。这一点要紧,因为导入器把每一段合并进它的条目,之后的导入拿不回已经写进去的值;这样导入一个 `api.deepseek.com` 上的 rc.33 `llm-deepseek.baseURL`,每个 DeepSeek 请求都会发往 chat completions 地址。只有移动本身出错时文件才留在原处。base URL 的提示记在 marker 的 `notices` 里,直到窗口显示过、用户关掉它,再由 `acknowledgeSettingsMigrationNotices` 清掉,所以被强制更新闸门拦下、或服务端启动失败的那次启动,会在下一次启动时再提示。存在却读不了的 marker 不当作不存在:它可能代表一次已经完成的运行,所以不从 `settings.yaml.imported` 或 `settings.yaml.pre-rc34` 复制回任何东西,只记一行日志。网关这一步在 `web-migration.json` 记下 `permissionPatch`、或者没有 `web-migration.json` 时运行:只有写出这个文件的 web 同步才会把权限行复制进来,而同一次启动里更早的播种,每次找不到这个文件都会把它们取回去。文件在却没有 `permissionPatch`(读不读得了都一样),说明退役没做完;在记下之前 marker 带着 `gatewayDeferred`,其余部分照常运行,之后第一次播种记下退役的启动再运行这一步。改成整段跳过迁移,会让服务端原样导入 rc.33 的文件。

## Alternatives considered

**全部交给导入器。**会丢掉 Problem 列出的那些:`agent-presets` 和 `at-file` 没有条目,还带着退役键的插件段整段失败。

**由壳把四个插件段直接写成 profile 行。**壳得为每一行重述它的 required 普通字段(例如网关的 `provider` 和 `model`),还要复刻导入器的合并方式。只剥键、让导入器写这些行,这些行就只有一个写入方。

**把 `agent-preset-registry` 写成一行。**按 id 定位的行会整份替换 `config`,而 `default` 是 required、只由 web-app bundle 行提供,只带 `selectedDefault` 的一行会让注册表起不来。

**所有 `baseURL` 一律删掉。**这会把配置了代理的用户的对话发到他没有选的服务上。非 DeepSeek 的 host 静默保留,请求会失败而用户看不到原因,所以保留并提示。

**把迁移记录写进 `web-migration.json`。**创建这个文件会改变 web profile 同步对「第一次」的判定,而同步每次启动都按已知字段重建它,新字段会被抹掉,S5 的复制回来也会反复发生。

**用 js-yaml 解析。**它的默认 schema 把不带引号的 `asOf` 读成日期、写回成时间戳,balance 插件会拒收;它的 failsafe schema 把数字和布尔值读成字符串,值检查随后就会把它们剥掉。

## Consequences

rc.33 客户端的审查网关、自动压缩、MCP 服务器和余额设置、默认模式、主题以及 @ 引用开关都能跟着升级。没能跟过来的,连同原值列在 `settings-migration.json` 里。

这次迁移或导入器写下的条目带着该条目当时的整份 config,以后 bundle 层对这些字段的新默认值到不了这个用户;每一次在设置页保存本来就有同样的限制。

`PLUGIN_SECTION_KEYS` 里的值检查是四个插件 schema 的副本。键集合每次跑测试都通过 vendored 包的声明文件核对;值判定要加载 vendored 宿主代码,只有 `pnpm run build` 之后才解析得到,在没构建的树上这几例会报告自己被跳过。

写进 `file-reference-local` 的名字隐藏的是同名目录,不是文件:上游的 @ 引用里没有按文件名过滤的设置。

## Related

- [The web profile's plugins stay synced to the desktop](2026-08-25-desktop-web-profile-migration.zh.md) — 负责 `web-migration.json`,这次迁移不碰它。
- [The permission rows an old shell copied into the desktop profile are retired](../bug-fix/2026-09-17-retire-seeded-permission-patch-rows.zh.md) — 先于本迁移运行;它保留下来的网关 insert 行就是这里改写的那一行。
