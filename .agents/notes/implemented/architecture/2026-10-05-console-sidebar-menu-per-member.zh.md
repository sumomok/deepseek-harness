# Agent Note: 控制台侧栏把每位成员的菜单存进这位成员自己的存储

Status: implemented

[English](2026-10-05-console-sidebar-menu-per-member.md) | 中文

## Problem

控制台侧栏的菜单——工作流、它们的分组和工作台对话的 id——是 `server-sidebar` 这一行的三个 volatile Config 字段。它的 server-menu 路由在宿主进程里用 `settings.update` 保存它们，写进这个进程每位访客都读的 profile 补丁。这与「一位登录者一个进程」相符。一个控制台进程服务多位成员时，它就成了大家共用的一份菜单：一位成员保存会改写所有成员的菜单。工作台 id 更糟：页面打不开已存的工作台对话时，会在加载时新建一段并保存它的 id，所以一旦每位成员只看得到自己的对话，共用的 id 会在每次加载时于成员之间来回改，每改一次就新建一段对话并改写 profile 补丁。

## Decision

**`perMember` 开关把菜单移进成员目录。** `server-sidebar` 新增 Config 字段 `perMember`，默认 `false`，不是 volatile，含义与 `dsh-experimental-auth-gate` 的同名字段相同。开启后，server-menu 路由把每位成员的菜单存进 `ctx.consoleMembers.memberStore(<成员>, 'server-sidebar')`，每个请求现取 `ctx.get('consoleMembers')`，既不调 `settings.update`，也不调别的任何写 profile 补丁的东西。路由的判断顺序与 auth-gate 按成员的 token 路由相同：方法 405、跨站 `POST` 403、非 JSON 的 `POST` 415、没有目录在运行 503、请求认不出成员 401，后两步在读请求体之前；随后请求体 413 或 400、合并后菜单的校验 400、保存点名另一位成员的对话 400。读不懂的已存副本答 500，而不是当作空菜单读；同一成员的保存逐个执行，每次都读到前一次写下的内容，所以同时发出的几次保存都会落地。

**这一行不能锁，所以开关是这一行的字段。** 控制台的权限锁在 profile 补丁之上的一层重述 volatile 行来钉住它们，`dsh-config-editor` 在那里拒绝对它们的任何设置写入。侧栏自己的路由每次保存都做这一次写入，锁住的行会拒绝菜单的每一次保存。因此单人控制台把这一行留在 bundle 层，菜单在那里按设计保持可写。开启 `perMember` 后路由不再经 settings 写入，多人部署就能在 profile 补丁之上重述整行，写 `perMember: true`、不带菜单。这份部署锁 `members-lock.patch.yml` 属于成员目录的上线，不随本次改动加入。为了不让一行带着没人读的菜单，`perMember` 开着而 `workflows` 或 `groups` 非空、或 `workbenchSessionId` 有值时，这一行在加载时失败，报错只点字段名，不带任何值；这项检查排在菜单的跨元素检查之前，后者的拒绝会引用工作流和分组的 id。

**单人模式不变。** 不开 `perMember` 时，路由、它的回答和它的设置写入就是原先运行的代码，原样移进 `serveProfileMenu`，现有 spec 不改动全部通过。组合加载完成后，`perMember` 与是否有 `consoleMembers` 服务在运行不一致的行，两个方向都写一行错误日志：没有目录的按成员行对每位成员答 503，目录旁边的共用行把一份菜单交给每位成员。

**保存不得点名另一位成员的对话。** 一次保存要存的各工作流 `homeSessionId` 与 `workbenchSessionId` 逐个交给 `principalOfSession`；目录判给另一位成员的，保存被拒绝，文案固定，既不点名那位成员，也不带 id。否则成员可以把别人的对话存进自己的菜单，再从菜单里打开它。宿主给每位成员的会话列表是第一道检查，这里是第二道。目录判给无人或不认识的对话照常保存，因为工作流对它的对话是弱引用，对话可能已经不在了。

**身份路由仍是部署配置。** `/server-menu/identity` 只回答 `displayNameClaim`，对每位成员都一样，所以它不认成员，不论目录是否在运行都提供。

## Alternatives considered

**锁住这一行，把菜单存到 settings 服务里的别处。** settings 名下的任何位置都是每进程一份文档，是同一个共用问题；而锁存在的意义就是不让访客写共用文档。

**在这一行的 Config 里按成员分键存菜单。** 菜单仍是一份每位访客的设置写入都能替换的 volatile 文档，profile 补丁会装下每位成员的对话 id，`settings/describe` 也会把它们交给任何访客。

**把旧的共用菜单复制给每位成员当模板。** 它的对话 id 属于各自的创建者，所以除了一份以外，每份副本都会指向另一位成员的对话；旧菜单由迁移归给一位成员或作废，不由这一行处理。

**把读不懂的已存副本当作空菜单读。** 合并到它上面的下一次保存会替换这位成员存过的一切；答 500 则把副本留给修复。

## Consequences

多人部署在这一行和 auth-gate 那一行上开启 `perMember`，组合一个 `consoleMembers` 提供者，并在 profile 补丁之上以空菜单重述这一行。在这次重述出现之前，设置写入仍能把菜单字段写进这一行的 Config；路由从不读它们，下次启动时这一行在加载时失败。成员目录的存储是每位成员菜单的唯一一份：没有东西把它写进 profile 补丁，所以 profile 的备份不再含有这些菜单。两种模式下保存被答以 401 或 503 时，浏览器都显示「保存失败：请刷新页面后重试」（Failed to save: refresh the page and try again），并把拒绝送去浏览器控制台。读取按同样的界线区分：浏览器只在没有任何东西服务这条路由时当作空菜单；路由拒绝的读取或根本没有到达路由的读取，会让侧栏显示菜单没有读出来，在刷新页面之前，页面不保存菜单，也不为它打开、新建或归档对话；菜单加载成功之后，先读工作流列表再写回的路径在那次读取失败时什么都不写。不这样做的话，副本读不出的成员每次加载都会多出一段新的工作台对话，一次被拒的读取会让一次保存把成员的工作流替换成只有新那一条的列表，「移出列表」也可能归档成员自己的工作台或工作流对话，因为菜单未知时它们留在临时列表里。

## Testing

`packages/experimental/server-sidebar/tests/member-menu-route.client.spec.ts` 用一个仅供测试的 `consoleMembers` 行（`tests/fixtures/console-members.client.ts`）经测试组合运行这一行。它用请求体永远发不完的请求钉住判断顺序，证明 401 与 503 在读请求体之前；保存只进保存者自己的存储，不进 profile 补丁，也不进另一位成员的菜单；拒绝点名另一位成员的工作流或工作台对话，且两者都不引用；目录不认识或判给无人的对话照常保存；读不懂的副本和被拒绝的写入答 500，文案与日志固定；同一成员的两次和三次并发保存都落地，排在目录抛错的那次保存后面的保存照样落地，而另一位成员的保存不等待；加载时的字段拒绝，包括菜单本身违反跨元素检查的情形；以及两行不一致日志。`workflow-api.client.spec.ts`、`workflow-store.client.spec.ts`、`server-sidebar-root.client.spec.tsx` 与 `browser-plugin.client.spec.ts` 钉住浏览器对被拒读取的处理。现有 `server-menu` spec 不改动，覆盖单人路径；`apps/web/tests/server-sidebar.e2e.ts` 运行出厂控制台组合。
