# @deepseek-ai/dsh-desktop-app

[English](README.md) | 中文

桌面应用自己的组合层。`@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 是每个 `dsh web` 部署共用的出厂组合包，两者都刻意把一部分行留在不偏向任何具体部署的取值上；本包就是桌面应用替自己做出这些选择的地方。它不含代码：整个包就是 `cordis.patch.yml` 加上指向它的 `dsh.bundle.patch` 清单字段，因此 `loadProfile` 读取该层时不导入任何模块。`apps/desktop-server` 把它列为依赖，使它进入 `pnpm deploy` materialize 出的载荷；`apps/desktop/src/profile-seed.ts` 把它排在 `BUILTIN_WEB_BUNDLES` 末位，于是无论全新 profile 还是升级而来的 profile，它都排在桌面 profile 的 `dsh.profile.bundles` 末位。排在最后意味着它覆盖 dsh-base、dsh-web-app 以及每一个内置插件层，而 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 仍在它之后生效——这里的一行是用户可以替换的默认值，而不是无法摆脱的设定。它目前携带的唯一一行打开了对话正文的全文搜索（`session-query-sqlite` 的 `openAt: first-search`，落在一份持久的派生索引上），而出厂组合包把它关着；`apps/desktop/tests/desktop-content-search.spec.ts` 组合真实的各层并断言桌面 profile 最终得到的取值。外壳见 [apps/desktop](../desktop/README.zh.md)，载荷见 [apps/desktop-server](../desktop-server/README.zh.md)。
