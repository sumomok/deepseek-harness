# @deepseek-ai/dsh-desktop-server

[English](README.md) | 中文

桌面应用内嵌服务器的纯依赖 deploy root:`@deepseek-ai/dsh` 闭包了整个 `dsh web` 运行时(bundle、host 插件、client 产物与已构建的 web 前端 dist)。vendor 框架三件(`cordis`、`cosmokit`、`schemastery`)显式列出,因为 pnpm 的 deployer 会跳过 `link:` 覆盖的包,只有作为直接依赖才能被暂存步骤恢复——python/sdk-runtime 列出它们是同一个原因。它们旁边另有七个作用域外的插件包,各自钉死在一个不可变发布上:`dsh-better-sidebar` 钉在精确的 npm 版本,`dsh-at-file` 钉在作者仓库的一个提交上——因为那位作者的 npm 发布落后于 tag,`@haoran/dsh-screenshot`、`@haoran/dsh-llm-permission-gateway`、`@sumomok/dsh-quote-message`、`@sumomok/dsh-balance` 与 `@haoran/dsh-default-model` 钉在与本清单放在一起提交的 `vendor/` 下的 tarball 上——因为这五个插件哪里都没发布。pnpm 为 `file:` tarball 记录 `integrity` 哈希,与注册表版本完全一样,这正是 `pnpm deploy` 对它物化的每一条 lockfile 条目的要求。它们是桌面客户端的内置插件,正是本清单把它们放进载荷,供壳播种到 `desktop` profile。`apps/desktop/scripts/package.ts` 对本清单执行 `pnpm deploy`,把物化后的树作为 Electron 应用的 `resources/server` 随包分发,由捆绑的 Node 运行时启动。此处没有任何代码;见 [apps/desktop](../desktop/README.zh.md)。
