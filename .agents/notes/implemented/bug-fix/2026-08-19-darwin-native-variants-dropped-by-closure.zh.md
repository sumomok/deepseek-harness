# Agent Note：闭包收敛删掉了 darwin 侧的原生变体包

Status: implemented

[English](2026-08-19-darwin-native-variants-dropped-by-closure.md) | 中文

## 问题

从收敛后的闭包构建出的第一个 macOS 载荷在启动闸挂掉，`sharp.mjs:171` 报
`Could not load the sharp module using the darwin-arm64 runtime`。把
`staging/server` 与 `staging/server-mac` 的包名全集取差集，除了三个正确离开的
win32 包，还有三个本该留在 darwin 载荷里的带平台后缀的包也走了：
`@img/sharp-libvips-darwin-arm64`、`@vscode/ripgrep-darwin-arm64`、
`node-addon-require-builtin-darwin-arm64`。

`bundle-closure.ts` 的 `NATIVE` 名单里带平台后缀的条目有五个，五个全是 win32。
darwin 侧被留给可达性去保住，而那只在有 JavaScript 静态 require 它时才成立：
`@koromix/koffi-darwin-arm64` 正是靠这一点活下来的；而一个在调用时经
`require.resolve` 取到、或者由 `.node` 的动态库搜索找到的变体，可达性遍历看不见，
于是被当作无人引用的第三方目录删掉。

Windows 从未暴露这个故障。它的四个变体全在名单里，而且它的 sharp 只有一个包——
`libvips-42.dll` 就打在 `@img/sharp-win32-x64` 内部，macOS 才把这个库拆成独立的
`@img/sharp-libvips-darwin-*`。

只有 sharp 被抓到，因为只有它在开机时加载。搜索要等某个工具跑起来才碰到 ripgrep，
加载器要再晚一个插件才碰到 `node-addon-require-builtin`，所以这两个会一路发到用户手上。

## 决定

`NATIVE` 同时列出两个平台各自选中的变体，用 `process.arch` 派生（`PLATFORM_DIR_RULES`
本来就是这么写的），并在文档注释里写明：这份对称正是动态解析的变体得以存活的原因。

这处改动会逼出第二处。`@vscode/ripgrep-darwin-*` 一旦进了 `NATIVE`，它在 Windows
载荷里也会存活，而本该删掉它的那条规则匹配不到任何东西：
`{ parent: '@vscode/ripgrep', keep: name => name !== 'bin' }` 指向的目录根本不发布
`bin/`——ripgrep 是在调用时从兄弟包（`@vscode/ripgrep-<platform>-<arch>`）解析二进制的。
现在这条规则改为指向 `@vscode` 这个 scope 并选出兄弟包，两个 target 各写一条，
顺带终结了此前两个载荷各自搭载对方平台 `rg` 的行为。

`7zip-bin` 不带任何 install 脚本，解包出来的二进制也没有可执行位，因此在首次安装该
依赖的机器上，Windows 侧 `after-pack` 的封包步骤会以 `EACCES` 失败。该钩子在调用前
设置这个位。

这次失败属于一类值得点名的故障，因为具体事实很难迁移，而这一类很好迁移：凡是依赖
「解包出来的依赖带着某个文件属性」的东西——这次是可执行位，下次可能是符号链接或者
大小写敏感的文件名——在增量安装出来的开发机上一直是对的，只有干净安装之后才会错。
而干净安装只发生在 CI 和新机器上，恰好是最不方便调试的两个地方。新加进构建路径的
依赖，就是该预期它出现的位置。

## 验证

启动闸通过，并在派生出的 darwin 载荷上报告 38 个客户端模块。构建出的 `.app` 里
`en.lproj` 与 `zh_CN.lproj` 都在——那是本次发版里另一处独立的语言包修复。

## 待办：把这条不变量做成机械可查

这次能抓到，靠的是启动闸恰好加载了 sharp。三个被删的包里有两个只在使用时才失败；
而且同一份知识——哪些包是平台专属的——被编码了两遍，一遍是 `NATIVE` 的保留名单，
一遍是 `PLATFORM_DIR_RULES` 的丢弃规则，靠人手保持一致。今天发现的两处故障，
都是某份手写名单只写了一半。

值得加的门禁是：对比 `staging/server` 与每个派生出的 `staging/server-<target>` 的包名，
凡是消失项的名字带平台标识（`win32`、`darwin`、`linux`、`msvc`、`arm64`、`x64`）
而又没有任何显式丢弃规则解释它，就让构建失败并打印出来。更强的形态是让两份名单都由
家族前缀加当前平台派生，而不是手写两个半边。
