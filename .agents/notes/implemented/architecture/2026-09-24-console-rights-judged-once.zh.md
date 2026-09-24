# Agent Note：控制台只判一次登录者的权限，按一张规则表

Status: implemented

[English](2026-09-24-console-rights-judged-once.md) | 中文

## 问题

控制台读了登录者的权限表，却一样都没照着做。`system_map_domains` 与 `system_map_domain_models` 列出目录里的每一个模型，连这个人没有权限行的模型也列，`system_map_model` 也照样描述它们；数据页只要视图把它打开成可写，就给每位访客画出「新增」、修改图标和两个导出，后端要拒的按下去之后才被拒。

权限表不能照字面读。对客户后端源码的审计确认了：`GET /nrms-auth/api/auth/userinfo` 答回以 `resclassenname` 为键的 `auth.resclass[]` 行，生成器只会把其中的布尔写成 `true`，`null` 表示未授予；`search`、`imp`、`exp`、`gridexp` 在每个账号上都是 `null`，管理员也一样；后端自己只校验 `add`、`update`、`delete`；受限账号的表里只有它被授予的模型；一个任何授权都没有的账号收到的是 HTTP 400 code 1。客户页面自己的 `useCloudPermission` 直接读这些布尔，这正是它在这个后端上连查询按钮都藏掉的原因。

## 决定

**一次判定，放在读权限的那道缝上。** `ctx.bizBackend.judge(rights)` 把一次 `userRights()` 调用的答复变成 `may(model, operation)`。它不碰网络，所以调用方读一次权限，想问多少个模型就问多少个。凡是代登录者隐藏或拒绝什么的消费方——三个 `system_map_*` 读，以及数据页的能力路由——都调它，所以谁都不另存一份规则。

**七个操作，用后端计划中的操作码命名。** `read`、`metadata_read`、`create`、`update`、`delete`、`import`、`export` 即 `BIZ_OPERATIONS`，作为外部规范写死。每个操作需要哪些权限标志是部署数据：`BizOperationRules`，每个操作一条规则，要么是 `row`（表里有这个模型的一行），要么是一个非空的权限标志列表，那一行必须至少授予其中一个。缺省就是后端今天实际校验的规则——`read`、`metadata_read`、`export` 是 `row`；`[add]`、`[update]`、`[delete]`；`import` 是 `[add, update]`——哪天后端开始校验某个标志，部署就只写那一条，例如 `export: [exp]`。这张表在构造服务的那一行 `auth-gate` 上以 `bizOperationRules` 配置；它的 schema 在 `biz-backend` 里，`requireBizOperationRules` 在加载时对不对应任何操作的键让这一行失败，因为 schema 会保留未声明的键，拼错一个字就会让本想改的那条规则悄悄停在缺省值上。

**失败即关闭。** 权限读取失败——包括没有任何授权的账号收到的 HTTP 400 code 1——以及一张一个模型都没点名的权限表，什么都不允许；没有那一行的模型什么都不允许。

**system-map 只给看登录者可以查看的东西。** 每个读在分组、解析或列出之前，先把目录收窄到 `may(model, 'metadata_read')` 允许的模型。`system_map_domains` 现在也读权限，只数可见模型，一个都不装的专业不列；权限读取失败时，每个读都以那次拒绝结束，而不是退回整份目录。被藏起的模型与本部署没有的模型用同一句话拒回，即 `No data model the signed-in person may look at is called "…"`，专业也用同样的形式，于是拒绝不透露被藏起的模型存在。`may=` 与 `may` 字段带的是按七个中性名字写出的允许操作，而不再是权限表的标志名。

**数据页收到的是判定，从来不是规则。** kit 0.4.5 新增只归宿主的 `abilities` prop，即 `{ create, update, delete, import, export }`，它只能拿掉入口。只要同时组合了 webserver 与 `ctx.bizBackend`，`component-kit` 的节点半边就占用 `GET /component-kit/abilities?meta=<表>`；处理函数读一次权限，答回 `judge` 给出的五个布尔值。`DataPageRenderer` 按表去取，在答复到达之前以及取不到答复的任何时候传五项全 `false`，并把判定铺在块自己的 props 之后；桥接更新的是同一个 Vue 实例，所以页面既不重挂也不重查。落位目录不声明 `abilities` 属性，所以带着它的调用或写下来的视图会作为未声明属性被拒，`readDataPage` 也从不读它。

这取代了[数据页那份 note](2026-09-19-data-page-replaces-toy-crud.zh.md) 里「宿主不检查访客能做什么」的那一部分：有哪些入口仍由排布决定，按下去成不成仍由后端决定，而在两者之间，宿主现在会拿掉权限表不允许的东西。

## 备选方案

**每次调用都读权限的 `may(model, operation, signal)`。** 它字面上贴合那个说法，但每个模型要花一次请求：在实测的部署上，一次专业清单就要花掉几百次带凭据的读。基于一次读的判定，用一次请求给出同样的答案。

**把规则表发给浏览器、在那边判。** 这会在页面里放第二个按同一套规则求值的东西，它可能与宿主的那个走偏，还会为一个关于单个模型的问题把整张权限表交给页面。判定只是五个布尔值。

**照写的那样读 `exp`、`imp`、`search`、`gridexp`。** 每个账号——管理员也一样——都会失去导出、导入和查询，因为后端从不写这几个标志。规则表让它们在后端开始写的那天依然可用。

**把规则表放进 `biz-backend` 自己的一个插件行。** 这个服务没有行：它由 `auth-gate` 用自己持有的凭据构造，第二个行会把一个服务的构造拆到两份配置里。

**用一句点明原因的拒绝把未列出的模型藏起来。** 「你不能查看这个模型」等于告诉模型、以及读它对话记录的任何人，这个模型存在。两者共用一句话，受限账号看到的目录就与一个更小的部署无法区分。

## 影响

- `ctx.bizBackend` 新增 `judge()`；`BizBackendService` 的构造函数把规则表作为第四个参数，`auth-gate` 的 `Config` 新增逐字段带缺省的 `bizOperationRules`。
- 三个 `system_map_*` 的描述、模型清单的标题、两句未知名字的拒绝以及 `may` 的用词都变了，所以 `snapshots/console/show-chart-turn/tool-schemas.expected.json` 与 `snapshots/console/system-map-turn` 做了无密钥刷新：夹具里的 `SITE` 没有权限行，从「传输专业」里掉了出去，`SpaceLayer` 列出 `may=read,metadata_read,create,update,import,export`。
- `component-kit` 依赖 `biz-backend`，并多占用一条路由；没组合数据后端的组合里，每张数据页画出来时可拿掉的入口都已拿掉。
- `system-map` README 里实测的清单大小早于中性的 `may=` 字段；现在每个列出的行里它最多占 57 个字符。
- 换来的：一张只配一次的规则表，同时决定助手被告知有什么、页面给出什么；后端开始校验某个操作码的那天，只是一行配置的改动。

## 暂缓

权限属于进程，不属于某一次请求：凭据是整个进程的一个 token，所以清单与能力路由描述的都是最后登录的那个人，system-map 那份 note 已为「一人一进程」的部署记下了这一点；触发器是一个进程服务多个人。权限读取不做任何缓存，所以权限变化时开着的页面保留它的判定，直到下一次被画出来；触发器是实测权限读取成本超预算。

## 测试

`biz-backend` 以逐文件 100% 覆盖每一行规则、每个写标志单独生效、未被校验的标志、缺失的行、空表、全部四种失败、改过的规则与格式错误的规则。`system-map` 通过真实工具注册表覆盖收窄、不透露被藏模型的拒绝、空的与失败的权限读取以及配置过的规则，并有一个经 Loader 启动、跑在真实 `judge` 之上的 REAL 组合。`component-kit` 通过一个经 Loader 启动的组合覆盖路由——webserver、配了数据后端并写了 `bizOperationRules` 的真实 `auth-gate`、以及本行，后端是一个答复权限读取的替身；并单用真实 webserver 覆盖——判定后的答复、失败即关闭的答复、400 与 405、没有后端时路由不存在、随后端或本行任一方的 fiber 释放——以及浏览器读取器的失败即关闭路径、五个键对 kit 的 `DATA_PAGE_ABILITY_KEYS` 的对照，还有渲染器在判定之前不画任何可拿掉的入口、判定到达后在同一个实例上就地增减且不重查。`component-surface` 拒绝带 `abilities` 的调用与视图。
