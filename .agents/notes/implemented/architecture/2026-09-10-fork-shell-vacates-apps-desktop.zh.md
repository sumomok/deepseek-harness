# Agent Note: fork 的桌面外壳让出 apps/desktop

Status: implemented

[English](2026-09-10-fork-shell-vacates-apps-desktop.md) | 中文

## 问题

上游 0.1.5-rc.1 自带一个 Electron 外壳，落在 `apps/desktop`，包名 `@deepseek-ai/dsh-desktop`——正是本 fork 的外壳自诞生起就占着的路径与名字。把那个基座并进来，会让两个互不相干的外壳挤在同一个目录里，此后上游对它自己那个外壳的每一次改动，都会变成与 fork 代码的冲突，而两者除了路径之外毫无关系。名字同样撞车：pnpm 按清单里的 name 解析 `apps/*`，一个工作区容不下两个都叫 `@deepseek-ai/dsh-desktop` 的包。

上游那个外壳不是这一个的替代品。这个外壳把内置插件组合包播种进 `desktop` profile，服务 `https://lhr.ink/dsh-updates/` 上的更新源，用自签证书签 macOS 构建，并且承载着出货产品赖以成立的登录窗口、渲染服务、插件管理服务与服务端崩溃恢复阶梯。上游那个是另一个产品：`productName: DeepSeek Harness`，自己的产物名，自己的更新主机。

## 决策

**fork 的外壳是 `apps/desktop-shell`，包名 `@deepseek-ai/dsh-desktop-shell`。**路径与名字都空了出来，上游的 `apps/desktop` 因此是以新增的方式到达，而不是合并。凡是点名旧路径的都跟着改：宿主 TypeScript 程序、工作区约束门禁的注释、翻译扫描的排除项、vendored 插件表的检查、同级 app 的 README、本 fork 的常备规则，以及记录着外壳文件住在哪里的那些 implemented Agent Note。打包命令现在是 `pnpm --filter @deepseek-ai/dsh-desktop-shell run package --mac --win`。

**已安装的应用保留 `@deepseek-ai/dsh-desktop` 这个名字。**Electron 从应用 `package.json` 的 `name` 字段取应用名，并由它推出 `userData`、`sessionData`、`crashDumps` 与 macOS 的 `logs` 目录；electron-builder 也由同一个字段推出生成的 `app-update.yml` 里的 `updaterCacheDirName`。光改名字，会把每一份安装的 cookie、登录分区、`Preferences` 与 `desktop-state.json` 挪到够不着的地方，并让更新器的下载缓存变成孤儿，其中包括差分更新要复用的 `current.blockmap`。`electron-builder.yml` 里的 `extraMetadata.name` 把旧名字写进 asar 内那份 `package.json`，于是打包出来的构建解析到的位置与今天一致。`src/app-identity.ts` 在运行期为源码树启动做同一件事：先设名字，再显式设 `userData` 与 `sessionData`——因为这两个是 Electron 在启动过程中解析的，早于本包的第一行代码。

**退役条件。**当上游那个外壳覆盖了这一个在做的事——把内置插件集播种进 profile、fork 的更新源与自签 macOS 路径、登录窗口，以及渲染、插件管理、崩溃恢复三个服务——本包即删除，`apps/desktop` 成为出货客户端。那时出货的东西要么解析到同一批用户目录，要么自带迁移；一个丢掉数据的存量安装不叫升级。

## 这次搬家不改变什么

- `appId: dev.dsh.desktop` 与 `productName: DSH Desktop`，以及随之而来的 bundle 标识符和安装器落位的那个 `DSH Desktop.app`。
- 产物名 `DSH Desktop-<version>-arm64.dmg`、`DSH Desktop-<version>-arm64-mac.zip` 与 `DSH Desktop Setup <version>.exe`——electron-builder 是从 `productName` 拼出它们的。
- 更新源：`channel: latest` 上的 `https://lhr.ink/dsh-updates/mac` 与 `/win`、`publish-update.ts` 回读的两份 manifest，以及它打上的 `desktop-v<version>` tag。
- 各用户目录：`~/Library/Application Support/@deepseek-ai/dsh-desktop` 与 `%APPDATA%\@deepseek-ai\dsh-desktop`、`~/Library/Logs/@deepseek-ai/dsh-desktop`，以及更新器缓存 `@deepseek-aidsh-desktop-updater`。

## 备选方案

**把上游的外壳就地并到这一个上。**两个只共用一条路径的外壳会在 `apps/desktop` 里逐文件交错，而上游每发一版都要把那次消解重演一遍。代价不是一次合并的，是每一次合并的。

**现在就改用上游的外壳，删掉这一个。**它做不了本产品出货的那些事：profile 播种、更新源、自签 macOS 路径、登录窗口与上面那三个服务，在那边都没有对应物。退役条件正是为这件事准备的。

**只搬路径，保留包名。**一个工作区容不下两份都叫 `@deepseek-ai/dsh-desktop` 的清单；pnpm 按名字解析工作区成员，`--filter` 会同时点到两个。

**连应用一起改名，首次启动时迁移用户数据。**一个去拷贝活着的 Chromium profile 的迁移，在它跑过的每一份安装上都有失败形态，而且只要还有旧安装可能更新，它就得一直留着。把名字钉住则没有失败形态。

**只用 `app.setName` 来钉。**实测不成立：在一份名为 `@deepseek-ai/dsh-desktop-shell` 的 `package.json` 下，`app.setName('@deepseek-ai/dsh-desktop')` 之后 `app.getPath('userData')` 仍然是 `.../@deepseek-ai/dsh-desktop-shell`。Electron 在启动过程中就解析了 `userData` 与 `sessionData`，所以这两个要显式设；名字照样要设，因为 macOS 的 `logs` 目录是首次取用时解析的，跟着名字走。

## 影响

工作区包名与已安装应用名从此不同。读 asar 里那份 `package.json` 或 `app.getName()` 的人看到的是 `@deepseek-ai/dsh-desktop`，而产出这个名字的配置行与模块都写明了为什么。

基座并进来之后，`apps/` 下会有两个外壳。只有 `apps/desktop-shell` 会被打包和发布；`apps/desktop` 是 fork 不构建的上游源码。

本包日后再改名，必须把这道钉一起带走。`tests/app-identity.spec.ts` 会在钉住的名字被改时变红，但打包那一半——`extraMetadata`——没有门禁：它由打包来证明，而本次改动不跑打包。

## 测试

`apps/desktop-shell/tests/app-identity.spec.ts` 对着一个替身 `app` 钉住名字与两个目录。解析本身是拿构建产物对着真实的 Electron `app` 实测的，启动时用的是一份名为 `@deepseek-ai/dsh-desktop-shell` 的 `package.json`：钉之前，`userData` 与 `sessionData` 是 `~/Library/Application Support/@deepseek-ai/dsh-desktop-shell`；钉之后是 `~/Library/Application Support/@deepseek-ai/dsh-desktop`，`crashDumps` 是该目录下的 `Crashpad`，`logs` 是 `~/Library/Logs/@deepseek-ai/dsh-desktop`——正是已安装构建今天在用的那几条路径。

打包那一半在这里未获证明，因为本次改动不跑 `package`。下一次打包必须回读 `resources/app-update.yml`，确认 `updaterCacheDirName: '@deepseek-aidsh-desktop-updater'`，并确认 asar 内那份 `package.json` 的 `name` 是 `@deepseek-ai/dsh-desktop`。
