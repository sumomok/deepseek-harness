# @deepseek-ai/dsh-desktop-server

[English](README.md) | 中文

桌面应用内嵌服务器的纯依赖 deploy root:`@deepseek-ai/dsh` 闭包了整个 `dsh web` 运行时(bundle、host 插件、client 产物与已构建的 web 前端 dist)。vendor 框架三件(`cordis`、`cosmokit`、`schemastery`)显式列出,因为 pnpm 的 deployer 会跳过 `link:` 覆盖的包,只有作为直接依赖才能被暂存步骤恢复——python/sdk-runtime 列出它们是同一个原因。`apps/desktop/scripts/package.ts` 对本清单执行 `pnpm deploy`,把物化后的树作为 Electron 应用的 `resources/server` 随包分发,由捆绑的 Node 运行时启动。此处没有任何代码;见 [apps/desktop](../desktop/README.md)。
