# Agent Note: 把 apps/desktop-server 的第三方插件从已退役的 client runtime 上重新 vendor 出来

Status: implemented

[English](2026-09-01-desktop-server-vendored-plugins-off-client-runtime.md) | 中文

## 问题

`apps/desktop-server` 的九个 `vendor/*.tgz` 第三方插件(`@haoran/dsh-clickable-refs`、`@haoran/dsh-connection-banner`、`@haoran/dsh-default-model`、`@haoran/dsh-llm-permission-gateway`、`@haoran/dsh-plugin-updates`、`@haoran/dsh-screenshot`、`@haoran/dsh-vision-switch`、`@sumomok/dsh-balance`、`@sumomok/dsh-quote-message`)都是针对 `@deepseek-ai/dsh-client-runtime` 构建的,而 rc.26 上游同步(0.1.2-alpha.2)已将其彻底移除——其能力面拆分进了 `@deepseek-ai/dsh-api-session-controller` 及其他包。`pnpm-workspace.yaml` 曾带一条临时的 `overrides` 条目,把 `@deepseek-ai/dsh-client-runtime` 钉死在 `0.1.1-rc.2`(旧名下最后一个真实注册表版本),以便 `pnpm install` 不会因这些插件声明的 `>=0.1.0-rc.1 <0.2.0-0` 可选 peer 而解析失败——该 override 自己的注释就已标明这是临时桥接,"针对新包名重新 vendor 这些 tarball 另行跟踪"。

## 决定

九个插件中的七个(除 `@haoran/dsh-default-model` 和 `@haoran/dsh-llm-permission-gateway` 外——这两个从未依赖过 `dsh-client-runtime`)已在独立的 `dsh-plugins` 仓库源码层面修复,各自完成一次版本号提升与独立提交,随后重新打包并重新 vendor 到此处:

| 插件 | 新版本 | tarball sha256 |
|---|---|---|
| `@haoran/dsh-clickable-refs` | 0.4.0 | `cd62d5d398d23a253acda05887d08b2085e066eeec18a6eb72f82343e073ad22` |
| `@haoran/dsh-connection-banner` | 0.2.0 | `4f0a9c9bfa33ce62fdd5ffc9398a0f049ee661ebc431b31b82cdade88b959a01` |
| `@haoran/dsh-plugin-updates` | 0.2.0 | `889947266b84f00c7ba9bae9fe0d22cbbc0fab5fa12855bf1a7c9b7ca862233c` |
| `@haoran/dsh-screenshot` | 0.5.0 | `b95846bcc20d2313bbc7c9c9aedbf0896f0fc2a92c2302dee5c54e8f797d8269` |
| `@haoran/dsh-vision-switch` | 0.2.0 | `660e9ce0e8ff643b4b8def0b2c86423fc404789117eb695ae388eff8c46ac485` |
| `@sumomok/dsh-balance` | 0.3.2 | `06a802c91b59eb403f91bcb22656930278792cc1dc81ca9bb204dcac97c0beb7` |
| `@sumomok/dsh-quote-message` | 0.3.0 | `33c8f5fe27e4ace8e0d1f42423d938ffd05a8936fa07d8ebf61862ecbcd2b21e` |

这七个插件的清单里(peer、dev、`dsh.client.inject`)都已不再出现 `@deepseek-ai/dsh-client-runtime`;每个插件都改到了其实际用到的能力对应的真正后继包上——`@deepseek-ai/dsh-api-session-controller/client` 提供 `ISessions`/`UseProjection`/会话自身持久的 `modelSelection` 投影,`@deepseek-ai/dsh-client-ui-conversation/client` 提供 composer chain 现已单值化的 `pendingInteraction`,`@deepseek-ai/dsh-client-ui-user-questions/client` 提供待答问题的载体,`@deepseek-ai/dsh-client-ui-settings/client` 提供 `SettingsScope`。`apps/desktop-server/vendor/` 现在只保留这七个新 tarball(旧版本已删除,不并存),`apps/desktop-server/package.json` 的 `file:./vendor/...` 依赖串指向新文件名,`scripts/gen-third-party-notices.ts` 里硬编码的 vendor tarball 路径(以及它生成的 `THIRD_PARTY_NOTICES.md`)也已同步更新。

`pnpm-workspace.yaml` 中的 `@deepseek-ai/dsh-client-runtime` override 已删除。`pnpm install` 零 `ERR_PNPM_NO_MATCHING_VERSION` 通过。

## 本决定范围外的那两个插件已不再引入这个已退役的包名

`pnpm why @deepseek-ai/dsh-client-runtime` 是空的。`dsh-at-file` 与 `dsh-better-sidebar` 是各自独立维护的上游项目,不是本仓库构建的插件,因而在本决定覆盖的九个之外;如今它们也各因自己的理由,成了 `apps/desktop-server/vendor/` 下的 vendor tarball。`dsh-better-sidebar` 的 manifest 里已完全不再出现这个已退役的包名;`dsh-at-file` 的 manifest 仍把它声明为可选 peer,`pnpm-lock.yaml` 记下了这条声明,却没有任何东西去安装它——因为 pnpm 从不自动安装可选 peer,而本工作区没有任何包依赖这个名字。本笔记当初不打算加的那条窄 override,现在依然不需要。[vendored plugin reference gate](2026-09-03-vendored-plugin-reference-gate.zh.md) 负责其中每一份归档如何命名,以及如何与复述它的那些文档保持一致。

## 权衡过的替代方案

**保留一条只覆盖剩余两个消费者的更窄 override。** 目前否决:一旦七个范围内插件不再需要它,这条 override 钉住的版本本来就会被普通的注册表解析自然满足,再加一条 override 纯属多余,并非修复任何真正损坏的东西。如果日后 `dsh-at-file` 或 `dsh-better-sidebar` 被重新 vendor 且这一解析不再顺利,那时再引入一条范围更窄的 override 才是正确的下一步,而不是在此提前动手。

**在同一轮里把 `dsh-at-file`/`dsh-better-sidebar` 也重新 vendor。** 否决:两者都是本仓库与 `dsh-plugins` 之外的第三方项目,有各自的发版节奏;修复它们自己的 peer 声明需要改它们自己的源码,不属于本仓库的改动范围。

## 后果

临时桥接已经拆除:`apps/desktop-server` 的九个 vendor 插件现在全部依赖真实的、当前的包名,不再有一条覆盖全工作区的 override 替一个 `pnpm-workspace.yaml` 自己的注释都已点名已退役的包顶着。代价是 `dsh-at-file` 仍带着那条 `dsh-client-runtime` 可选 peer 声明,本决定是明知故留——没有任何东西会去解析它,而是否处理它属于那个插件自己的上游,不属于本决定。
