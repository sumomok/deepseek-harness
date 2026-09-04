# @deepseek-ai/dsh-experimental-component-kit

[English](README.md) | 中文

内容面板 `component` 类目背后的组件行。它只提供 React 渲染器和给它们命名的表：不声明插槽，不读配置，不提供路由，也不认识任何布局。一块内容画在哪里由落位包决定，画成什么样由这一行决定。

node 半边是空插件。它存在只是为了让这一行出现在宿主 `cordis.yml` 里，浏览器产物靠 `dsh.client` 由此被发现。

这里住着两类组件。一类是仓内用普通 React 写的，不依赖别的任何东西；另一类是仓外编译好的 Vue 2 组件，经一层桥挂到另一行拥有的那份 Vue 运行时上。下面的**原件怎么进来**记着为此付出的全部代价。

## 渲染器表

`COMPONENT_RENDERERS` 把目录 id 映射到画它的组件。键是字面量 id，因此落位包只要让自己那份目录**派生出** id 的联合类型，再写一句 `satisfies Record<CatalogId, ComponentRenderer>`，就把两张表钉在了一起：目录里有条目而这一行没有对应渲染器，会在那里变成编译错误，而不是运行时的一块空白。钉住的前提是那个联合类型确实从目录派生；在目录旁边手写一份同名联合，什么都钉不住。写好的那一句在 `component-surface` 的 `ComponentSurface.tsx` 里，对着它的 `COMPONENT_CATALOG` 派生出的 `CatalogId`。

取到这张表是一次跨包的值导入，因此消费方声明 `dsh.client.external: ['@deepseek-ai/dsh-experimental-component-kit/client']`，由加载器从这一行自己的产物里答复该 require。

## 渲染器收到什么

这一行里的每个组件都收同样五个 prop（`ComponentRendererProps`）：`nodeId`，该块在一次落位中的身份；`props`，落位包的 schema 已经接受的块属性；`onAction(actionId, payload)`，用户动作的去处，带上动作 id 与该动作声明的那些属性；`state`，这一块上次上报的手势走到了哪一步（`idle` / `sending` / `sent` / `queued` / `refused`）；以及 `t`，这一行自己的翻译函数。

契约到此为止。渲染器不持有 ctx，不订阅任何东西，不记自己的手势，不做跳转、不发请求、不写数据——它画拿到的东西，说出用户按了什么，再被告知那件事的下场。这件事有没有后续、`state` 从哪里折出来，都由落位包决定。

属性的类型是 `Record<string, unknown>`，因为一张表的类型要服务所有组件，所以每个渲染器自己收窄它声明过的属性。这个收窄不是对调用方的防御：这块内容早已按接纳它的目录 schema 校验过了。

## 文案

这一行拥有一个词典命名空间 `componentKit`，落位包的座位在自己的注册处声明它，而不是再开第二个命名空间——有哪些组件是这一行的事实，所以按钮行的无障碍名称，和「这一行没有这个组件」时显示的那句话，都归这里。块上显示的其余文字全是调用方的。

## 组件清单

- **`el.confirm-bar`** —— 一段简短提示加一行按钮，用来把一个决定摆到用户面前。属性：`title`、`message`、`buttons`（每项 `{ id, label, tone? }`，tone 取 `primary` / `default` / `danger` 之一）。按下按钮会报出 `press` 动作，其 payload 是被按下按钮的 `buttonId`。

条画的是它被交给的那个 `state`，除 `idle` 与 `refused` 外每种状态都不再接受按下，并写明它处在哪一种：手势正在路上、智能体已经拿到、正等着用户下次开口、或者谁也没收到。落位包拿一次按下做什么要隔一整轮才看得见，甚至可能什么都换不来，所以一条按完仍旧原封不动的条，会让「记下了」和「丢了」长得一模一样——而一条自己记着点击的条，落位第一次把它卸载就照样干干净净地回来。`refused` 仍然可按，因为再上报一次是唯一还能做的事。

- **`toy.record`**（`TcFormDetailRenderer`）—— 一份只读记录：成对的名称与值，分列排布。属性：`dataList`（每项 `{ label, display }`）、`labelWidth`（一个像素数，在这里换成组件要的 CSS 长度）、`columnNum`。它不上报任何东西，因此动作出口与动作状态都不读。组件本体是随 tgz 进来的 `TcFormDetail`，这块内容因此成了走通整条 Vue 链路的那一块。

`display` 是空串的那一行仍在原位：组件画出名称，旁边什么也不画——这正是记录有这个属性、但没填值的样子。`0` 与 `false` 同样是值，按各自的文本画出来。只有当一行谁也没命名（没有 `label`，或者 `label` 是空的），或者它的 `display` 根本不是文本时，这一行才被丢掉；后者是校验过的调用产生不了、而另一个构建写下的记录能产生的情况。

## 原件怎么进来

这里有些组件不是在这儿写的。`@sumomok/toy-surface-kit` 是从客户维护的三个源库里搬出来的一批 Vue 2 组件的编译产物，在它自己的仓库里构建，以 `vendor/sumomok-toy-surface-kit-0.3.1.tgz` 的形式进来，依赖写成 `"@sumomok/toy-surface-kit": "file:./vendor/sumomok-toy-surface-kit-0.3.1.tgz"`。用 React 重写这条路评估过，否掉了：那些库的 354 个单文件组件里有 191 个直接写 element-ui 的组件，还有 153 条规则伸进它们的标记，重写等于把客户已经付过账的 bug 历史重来一遍。

**是一份快照，不是一个检出。** 就地覆盖 tgz 是无声无效的：pnpm 按文件路径加一个完整性哈希来记这次安装，而规格没变时它不会重读那个哈希，于是构建拿到的还是旧字节。每次重新构建都要抬版本号、落到新文件名下、改掉 `package.json` 里的规格，然后才 `pnpm install`。

**四个补丁。** 构建不是照搬：源码上打了四个补丁，随 tgz 放在 `patches/` 下，每一个的理由写在它的 `SOURCES.md` 里。它们分别去掉一个 `cronstrue` 依赖、去掉一个下载列、修一处 `toUpperCase` 调用、拿掉一处从 `localStorage` 读 token 的代码。

**六道门禁，跑在 tgz 出现之前。** 构建仓库拒绝发布这样的产物：里面还留着 `from 'vue'`、`'element-ui'`、`'toy-core'`、`'toy-comp'`；字节里含 `fontawesome-webfont`；或者过不了 jsdom 挂载冒烟。前四条拦的是「桶入口把模块加载期副作用一起拖进来」，第五条拦 1.1 MB 的图标字体，最后一条拦文本门禁根本看不见的那类失败——裁剪或内联不完整，模块求值时当场抛错。

**一份 Vue，靠请求而不是打包。** Vue 2 的响应式不跨运行时副本，所以这一行从拥有那唯一一份的行里取 `Vue`：`dsh.client.external` 写上 `@deepseek-ai/dsh-experimental-vue2-echarts-poc/client`，`src/client/vue-shim.ts` 把它供给的那份再导出，`tsdown.config.ts` 把裸规格 `vue` 别名到这个文件——只对浏览器产物生效，也只对裸规格生效。正因如此，`src/` 下任何文件都不得自己 import `vue`，写成什么形式都不行——`vue/dist/…` 这样的子路径别名管不到，会去拿一份自己的副本——一旦有人开始这么做，`tests/source-vue-imports.client.spec.ts` 就会红。被内联进来的库要什么，源码里根本看不见，所以 `tests/client-bundle-vue.client.spec.ts` 去数构建产物 `lib/client.js` 里的 Vue 运行时标记，多出第二份就红。

**element-ui 只装一次，层级 300。** 全仓唯一的那句 `Vue.use(ElementUI)` 在 `installElementUI()` 里，这一行的客户端插件启动时调它。`Vue.use` 没有反操作，所以它是一个模块作用域的开关而不是 effect：把这一行拆掉，组件仍然注册在那份 Vue 上。两个选项都写死——`size: 'small'`；`zIndex: 300` 是因为 element-ui 自己的默认值 2000 会让下拉盖住 1100 的外壳和 1000 的审批弹窗，也就是让一个展开的下拉挡住正在请用户同意的那扇窗。浏览器半边收不到 cordis config，而这一行没有 host 半边，所以要把哪个选项做成配置，做法是让落位包读到它再传进来。

`src/client/element-ui.css` 是 element-ui 的 `theme-chalk/index.css` 的物理拷贝，只改了一处：图标的 `@font-face` 把 woff 内联成 `data:` URI，并且不再提供 truetype 备选——客户端产物是把这张表当 `<style>` 标签注入的，相对字体路径会去页面根下解析。升级版本后按同样的方式重新生成。

**三条红线。** 页面上永远不许出现 `window.Vue`——element-ui 的 UMD 产物会对着它找到的那份 Vue 自行安装，把组件注册到这一行并不拥有的运行时上，症状是无错误、无警告的响应式失效。块里不许用 `el-dialog`、`el-message`、`el-notification`：它们的元素落在宿主元素之外，这里没有任何东西关得掉。交给 Vue 组件的记录必须先过 `freezeDeep`：Vue 会把拿到的东西一层层观测下去，被观测的数组连原型都被换掉，那会反过来动到 React 自己的数据。唯独监听器映射冻不得：Vue 会就地改写它拿到的那个对象，给每个处理函数套上自己的 invoker，所以桥交给 Vue 的是一份拷贝，调用方自己的那张表保持写下来的样子。

## 组合

这一行由 [`component-surface`](../component-surface/README.zh.md) 画出来，它的覆盖层同时组合两者。两者都不属于任何发行包。

## Model Experience

None, as this row is a browser component library and registers no tool, prompt, or result.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **状态由落位包去折，折错了这一行看不出来** —— 这一行只画 `state`，对它不作任何判断，所以某个落位若从不把一块推过 `sending`，或者把另一块的状态交给了这一块，画出来的条看着完全正常，说的却是错的。这一行没有任何东西能发现。
- **状态表是闭的，状态的含义不是** —— 条按交给它的每个状态各画一句，这张表少一句就编译不过。编译器管不了的是落位包新加的投递档并进了已有状态：某个落位悄悄吞掉、谁也没告诉的动作，折成 `sent` 之后，这里画的就是「已发送到对话」。加这种档的人，要连这句话一起定。
- **落位包自己那些句子不经这一行翻译** —— 这一行只本地化条自己关于手势画的那几句；同一次手势落位包在屏幕别处说的话，用的是那个包自己写下的语言。控制台那套落位是由宿主来答一次按下的，宿主拿不到浏览器的语言，于是 `这个动作没能记下来。` 与 `已记下，你下次发消息时对话会看到。` 会出现在聊天里，紧挨着一条写着 `Sent to the conversation` 的条。这一行够不着它们；解法归想要统一界面语言的那套落位，触发器是控制台开始提供中文以外的界面。
- **payload 里能放什么，这一行不做检查** —— 渲染器被信任只把落位包目录为该动作声明过的东西放进 `onAction` 的 payload；这一行不检查，落位包也不做裁剪，而是整条手势一起拒掉。渲染器多放一个该动作没声明的字段，这个控件的每一次按下就都到不了任何地方。
- **一份目录，两个家** —— 这张表里的 id 和校验块属性的目录是两个包里的两份声明，只靠消费方的 `satisfies` 检查系在一起。那句检查只管 id，别的都不管：渲染器读的属性一旦与接纳它的 schema 漂移，编译照样通过，画出来的却是错的。
- **组件之间不做拼装** —— 落位只是把块摞起来；这里没有任何东西会读兄弟块的状态，也没有布局或绑定词表。
- **tgz 是一份对无历史源库的快照** —— 三个源库没有 git、没有版本号、没有变更记录。客户改了什么既 diff 不出来也察觉不到，所以这里的组件会和客户手上跑的那份分叉，而唯一的同步手段是重新人工拷贝源码再跑一遍 tgz 的门禁。这是一笔长期维护债，不是可以关掉的告警。
- **element-ui 自带的中文串不跟随界面语言** —— 分页器的「共 x 条」、空表格的「暂无数据」是编进 element-ui 的，够不着我们任何一份词典，所以在英文界面里仍是中文。要改就得重编 element-ui 自己那一份，那是另一件事。
- **`PopupManager.nextZIndex()` 只会往上加** —— element-ui 从 300 起给每个新弹层发下一个 z-index，而且永不复位，于是一个开了约七百次弹层的会话会爬过 1000 的审批弹窗并盖住它。隐藏一块内容会收起它开的弹层，但没有任何东西把计数器降回去。真正的解法是外壳把自己的层级整体抬到远高于 element-ui 的区间。
- **没有装配快照覆盖** —— 浏览器侧的证据是针对真实组合的 Playwright 场景；快照泳道回放的是发行组合，其中不含任何 experimental 行。
- **「只有一份 Vue」这条对产物的断言在 CI 上不执行** —— `tests/client-bundle-vue.client.spec.ts` 读的是 `lib/client.js`；在 pull request 上，唯一会对这个包跑 `vitest` 的作业是覆盖率作业，它不构建，于是在那里跳过。master 的 `linux-primary` 泳道串行执行它的门禁，build 排在覆盖率门禁之后，所以那里产物同样不存在。本地、以及任何先构建的泳道里它照常执行。仓库里没有任何门禁去读一个已构建客户端产物的正文——同类的另外两个 spec，在 `client/ui-trajectory` 与 `session/session-persistence-sqlite`，在 CI 上因同一原因跳过。CI 覆盖到的是后果：Playwright 场景对着发行产物画出那个 vendored 组件。把这三条一起挂上门禁的触发器，是第一个去读已构建客户端产物的门禁出现。
