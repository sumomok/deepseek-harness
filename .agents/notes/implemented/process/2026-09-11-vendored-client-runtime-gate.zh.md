# Agent Note: Vendored client halves apply in the real client runtime

Status: implemented

[English](2026-09-11-vendored-client-runtime-gate.md) | 中文

## 问题

装好的 rc.32 桌面客户端打开后只剩一条启动失败信息：`failed to apply loader entry 641ca806 (@haoran/dsh-desktop-update): client api: method "desktopUpdate/install" conflicts with its namespace service`。`@haoran/dsh-desktop-update@0.1.0` 的浏览器半边把一个 Remote 方法命名为 `install`，而它已经是 `RemoteNamespaceService.prototype` 的成员，于是 [`assertMethodAvailable`](../../../../packages/api/gateway/src/client/index.ts) 拒绝该 contribution，`apply` 抛出。只要有一个条目没有激活，Web 启动就判整页失败，所以一个插件拖垮了整个应用。

同一份载荷此前已经通过两道门禁。静态检查读取 `dsh.client` 声明、bundle 是否存在和 profile 种子，这些都看不到一个 Remote 方法名撞上类原型。运行时冒烟则用 HTTP 取回每个 `client.js`，在 `node:vm` 里对着手写的 `ctx` 执行，而那个 `ctx` 的 `remote.$mount` 来者不拒——真正拒绝这次冲突的规则，正住在被桩替换掉的生产 Client Remote 服务里。rc.31 曾因同一形态的疏漏损失一次发布：一道插件客户端检查从未真正跑到装机产物上。

## 决策

[`apps/desktop-shell/tests/vendored-client-runtime.client.spec.ts`](../../../../apps/desktop-shell/tests/vendored-client-runtime.client.spec.ts) 在 jsdom 里、不依赖仓库构建，用出厂页面真正使用的运行时加载并 apply 每个内置插件的浏览器半边。

条目来自 [`BUILTIN_WEB_BUNDLES`](../../../../apps/desktop-shell/src/profile-seed.ts)，经[部署根](../../../../apps/desktop-server/package.json)的清单解析，而那正是载荷随包发出的 `node_modules` 闭包：凡声明了 `dsh.client` 的名字都贡献其声明的 `./client` 产物，两个没有声明的（`@haoran/dsh-default-model` 和组合层 `@deepseek-ai/dsh-desktop-app`）则在用例里被点名，这样某个包日后长出浏览器半边时，就无法只进载荷而不进门禁。被覆盖的每一条都是 `file:` 压缩包依赖，这也是这套用例能读到真实构建产物 `lib/client.js`、同时自己把工作区导入解析到源码的原因。

bundle 经生产的 [`ClientModuleSystem`](../../../../packages/client/modules/src/client/system.ts) 抵达，模块表种子就是外壳共享的那份 `getStaticModules()`，所以一个 bundle 若请求模块表之外的说明符，在这里失败的方式与在页面上完全一致。随后每个半边在一个 Cordis 根上 apply，这个根携带生产的 SlotRegistry、`LocaleRuntime`、`UiConversation`、输入触发服务、Typert 注册表，以及掌管命名空间与方法规则的 Client Remote 服务。每个插件各有一张页面，另有一条用例把整套插件 apply 在同一张页面上，这正是出厂客户端的做法。

被替换掉的是线那头的 Host：Connection 载体不回答任何请求，设置传输是一份内存 scope，Host 提供的 `session` 命名空间由用例自带的一个 descriptor 经真实注册器挂载而成——因为生成的 `/remote` contribution 只会产出到构建后的 `lib/`。没有任何内置半边在 apply 期间调用 Remote 方法，所以它们都不依赖回答。

## 这道门禁看不到什么

任何需要 Host 回答的东西。载体拒绝每个请求，因此 apply 之后的读取（`atFile/getSettings`、`accountBalance/get`、`pluginUpdates/list`）只走到各插件自己的失败分支。

停在 `ctx.slots.inject(key, …)` 后面的 slot 注册。该调用要等到某个声明者持有这个 key，而本台架不声明任何 key，于是插件的注册体从不执行：把某个插件的 slot key 改成任何地方都不存在的名字，用例依然是绿的。slot key、条目 id 和组件本身仍由各功能用例和 `apps/web/tests` 的 assembled-boot 线负责。

页面下发的 HTML `__ModuleLoader__` 门面，用例把它重建成一个普通对象，因为执行注入脚本需要构建后的 client-modules bundle。该门面自身的行为由 `packages/client/modules/tests` 负责。

React 渲染、布局，以及挂载之后的一切：这道门禁回答的是一个半边能否 apply，而不是它画得对不对。

## 编译面

这套用例读 Client 的 Context 合并，而 `apps/desktop-shell/tests` 其余部分读 Host 的那份，一个程序无法同时容纳两者。因此该文件带上已经用于区分两个聚合的 `*.client.spec.ts` 后缀：[`tsconfig.client.json`](../../../../tsconfig.client.json) 纳入 `apps/*/tests/**/*.client.spec.ts`，[`tsconfig.host.json`](../../../../tsconfig.host.json) 将其排除，与 `apps/web` 把客户端项目和 Host 面 e2e 文件分开的做法一致。

## 考虑过的替代方案

**复用 `apps/web/tests/assembled-boot.ts`。** 它是仓库里最忠实的客户端运行时——真实的 `AppWebEntry`、真实的 Loader、真实的图——但它挂载的是每个工作区客户端包构建后的 `lib/client.js`，因此必须先跑 `pnpm run build`。这使它成为产物面的通道，不适合一套必须在日常 `vitest` 调用里跑起来的源码面用例。它的 e2e 通道继续覆盖整装页面；这道门禁则以足够低的代价覆盖内置半边，可以每次改动都跑。

**给现有的 `node:vm` 桩补上缺的那条规则。** 在桩里复述 `assertMethodAvailable` 只能抓住这一个 bug，而复述出来的规则终将与被复述的规则漂移。这次失败缺的不是一条断言，而是一个运行时。

**为 `remote.session` 挂载真实的 `@deepseek-ai/dsh-api-remotes` 装配。** 它的客户端半边导入十五个只有构建后才存在的生成 `/remote` 产物，为一个被注入的服务名挂载它，等于把构建依赖重新引回来。用例自带的一个 descriptor 经真实注册器就能发布同一个服务，且不带这些代价。

**把用例放进某个包而不是 `apps/desktop-shell`。** 条目清单和内置载荷都属于桌面外壳，为了安置一个 spec 新建一个包，只会让门禁远离它守护的东西。拆分单个文件的编译面是更小的代价。

## 后果

本次提交落地时是红的。`@haoran/dsh-desktop-update@0.1.0` 仍是当前 vendored 的压缩包，因此单插件用例和整套用例都以生产错误文本失败；等 0.1.1 改名该方法并重新 vendor 后转绿。让门禁红着落地正是用意所在——一道先对着它为之而写的缺陷验证过的门禁，不会在这件事上悄悄失灵。

这套用例约 1.6 秒跑完，给 `pnpm exec vitest run apps/desktop-shell/tests` 增加约一秒，因此不需要单独的通道。

今后每个 vendored 插件都要付一份代价：若某个浏览器半边注入了本台架不提供的服务，门禁会因缺服务而失败，而不是因它自身的行为失败，台架必须补上那个服务。这正是期望的方向——另一条路是一道悄悄不再覆盖新插件的门禁。

## 验证

三次变异，每次改在一个 vendored bundle 上并按字节还原。把 `mcpServers/list` 改名为 `mcpServers/namespace`，失败信息为 `client api: method "mcpServers/namespace" conflicts with its namespace service`。把 `@haoran/dsh-btw` 的 locale 命名空间从 `btw` 改成已注册的 `common`，失败信息为 `locale namespace "common" already has locale "zh"`。把该插件的 slot key 改成无人声明的名字则不会失败，这正是上文记录的缺口。
