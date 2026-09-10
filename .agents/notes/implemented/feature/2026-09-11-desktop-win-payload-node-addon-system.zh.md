# Agent Note: 把 node-addon-system 的本机变体挡在 Windows 载荷之外

Status: implemented

[English](2026-09-11-desktop-win-payload-node-addon-system.md) | 中文

## 问题

桌面外壳从同一份暂存树派生出各平台的服务端载荷，途中丢掉承载别的平台二进制的目录。`apps/desktop-shell/scripts/package.ts` 里的 `PLATFORM_DIR_RULES` 按目标逐条点名这些目录，而当成品载荷仍带着一个以它跑不了的平台命名的变体目录时，`verifyPrunedPayload` 让构建失败。

上游把原生家族 `node-addon-landlock-run` 改名为 `@deepseek-ai/node-addon-system`，并新增了预编译的 POSIX `flock` 绑定，家族由此有了 darwin 变体。Landlock 只有 Linux 有，所以在此之前 macOS 构建主机根本不会装下该家族的任何成员，Windows 载荷也就无物可带。有了 flock，主机装出 `@deepseek-ai/node-addon-system-darwin-arm64`；没有任何规则指向 `@deepseek-ai` 这个 scope，该目录于是搭上 Windows 载荷，在这个基座上第一次打 Windows 就停在闸门上：

```
[platform-variant] @deepseek-ai/node-addon-system-darwin-arm64 names darwin-arm64 and rode into the win payload.
```

## 决策

`win` 列表新增一条指向该 scope 的规则：`{ parent: '@deepseek-ai', keep: name => !name.startsWith('node-addon-system-') }`。该家族只发布 `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64` 四个成员，在 Windows 上它们无一例外都是载荷跑不了的二进制；结尾那个 `-` 保住入口包 `@deepseek-ai/node-addon-system` 本身，它是两处调用点所在的纯 JavaScript。

丢掉这些变体不改变 Windows 行为，因为 win32 上入口包根本不会去解析变体。`native/system/packages/entry/src/flock.ts` 的 `loadBinding` 对 linux 与 darwin 之外的任何平台抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM`，抛在 `require.resolve` 之前。`src/index.ts` 的 `launcherPath` 捕获解析失败，返回 pnpm 布局本该使用、而并不存在的那个路径；`probe` 是可用性的唯一信号，二进制缺失与内核不强制一样报 `unusable`。两处调用点都用 `process.platform` 与 `process.arch` 拼模板字符串，所以闸门那道只认字面量参数的 `runtime-resolved` 扫描同样点不到这个家族。

这条规则的不对称是有意的。`verifyPruneRules` 会让丢不掉任何东西的规则失败，而对称的 darwin 规则正是丢不掉任何东西：npm 的 `os`/`cpu` 字段决定 macOS 主机上只装一个变体 `node-addon-system-darwin-<arch>`，而那恰恰是 macOS 载荷必须带上的那一个。

## 备选方案

**照「两个列表点名同一批 parent」的惯例补一条对称的 `darwin` 规则。** 不予采纳：mac 构建主机上该 scope 只有 mac 载荷要保留的那个变体，规则匹配到零个条目，`verifyPruneRules` 会以死规则判它失败。该惯例守的是两侧都有成员的家族；这个家族在 win32 上没有成员。

**在 `EXEMPTIONS['platform-variant']` 里豁免这条 finding。** 不予采纳：豁免只是让报告闭嘴，macOS 的绑定照样随 Windows 安装器出货。finding 是对的，错的是载荷。

**给该家族发布一个 win32 成员。** 不予采纳：flock 是 POSIX、launcher 是 Landlock，没有可供构建的 Windows 实现；为迁就一条拷贝过滤规则而加一个空包，只是多一个带版本号的搭载物。

**把规则指向 `@deepseek-ai/node-addon-system`。** 因与 `@vscode` 按 scope 寻址相同的理由不予采纳：变体是该 scope 下的兄弟包，不是入口包的子目录，指向入口包的规则什么也匹配不到。

## 后果

Windows 载荷不再携带 macOS 的 flock 绑定，Windows 打包得以越过载荷闸门。Windows 上 `flock` 照旧抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM`，Landlock launcher 照旧探测为 `unusable`，与此前一致。

这条规则假定构建主机是 POSIX。在 Windows 主机上该家族一个成员也装不下，scope 里只剩入口包，这条规则本身就会变成死规则。这种情况今天不会出现——fork 的两个平台都在 macOS 上打包——而且届时的表现是闸门大声报出死规则，而不是产出一份坏载荷。

`PLATFORM_DIR_RULES` 没有单元测试：`package.ts` 在导入时就跑 `main()`，这张表因此不可导入，而覆盖率闸门的 `packages/*/*/src` 范围也够不到 `apps/`。它的证据是构建本身——`verifyPruneRules` 证明每条规则在暂存树上都确有所丢，`verifyPrunedPayload` 证明每份成品载荷只带自己平台的变体。
