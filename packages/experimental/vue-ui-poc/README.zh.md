# @deepseek-ai/dsh-experimental-vue-ui-poc

[English](README.md) | 中文

在 web GUI 里承载非 React UI 框架的可行性验证。它向 `conversation.session.header.actions` 贡献一个条目——与 [`dsh-client-ui-jobs`](../../client/ui-jobs/README.md) 使用同一个增量座位——而这个条目的主体是一个 Vue 3 组件。插件协议本身没有任何变化：它是一个普通的双面包，node 半边为空，带 `dsh.client` 声明和 `./client` 产物。

## 这个验证证明了什么

slot 系统只接受 React 函数组件，因此 Vue 树通过 `VueBridge` 抵达座位——这是一个持有 Vue 渲染根的 React 组件。桥用的是 Vue 的底层 `render(vnode, container)` 而不是 `createApp`：app 实例自带 plugin、provide 与 config 域，每次 React 提交都要重建再丢弃，而对同一个容器重复调用 `render` 走的是 diff，这正是 Vue 树的响应式状态能跨 React 重渲染存活的原因。卸载走的是在挂载时捕获的 `render(null, container)`，因为 React 会在 passive 清理运行之前清空 ref。

`props` 就是两个框架之间的全部约定。React 半边先解掉每一个 slot 份额——locale 座位 `t`，以及它自己的 `useState` 回声——再把一组扁平的字符串、一个数字和一个回调交给 Vue。桥以下不 import React，桥以上不 import Vue，hook、store 句柄、Cordis 上下文和 React 节点都不越界。TypeScript 会在调用点用 Vue 组件声明的 props 校验这组记录，因此改错 prop 名是构建错误，而不是模板里一个静默的 `undefined`。

探针组件把计数保存在 Vue `ref` 里，并通过 `onCount` prop 上报每个新值。于是一次点击同时走通两个方向：Vue 自己的响应式更新计数，React 存下该值并重渲染，桥再对活着的树打补丁，于是计数在回声变化时依然存活。样式走共享 client 构建管线的 CSS Modules，只用 token，因此 Vue 树跟随主题切换的方式与 React 组件完全一致。

## 组合方式

该插件不属于任何已发布 bundle。用 overlay 叠在 Web 组合之上：

```yaml
- insert:
    - id: vue-ui-poc
      name: '@deepseek-ai/dsh-experimental-vue-ui-poc'
```

`tests/vue-ui-poc.overlay.yml` 就是这个文件；`dsh --profile web --patch <路径>` 应用它。该包必须能从 profile 目录解析到，对树外插件而言意味着 `dsh plugin --profile web add <路径>` 或等价的链接——release bundle 不得声明实验包。

## 产物代价

Vue 不在 shell 的共享模块表里，因此本包的 `lib/client.js` 自带一份 Vue 运行时；React 与 Cordis/slot 层保持 external，通过 loader 注入的 `require` 解析。包级构建配置把 `vue` 钉到它的 runtime-only ESM 构建并定义 Vue 的三个特性开关，因为该包自己的 `require` 条件指向完整构建，会把模板编译器（`@vue/compiler-dom`、`@babel/parser`、`entities`）拖进一个只用 `h()` 渲染、运行期不编译任何模板的产物。这个钉子就是 1.16 MB 与 317 kB 之间的差别。

第二个自带 Vue 的插件会再装一份。跨插件共享一份运行时是模块表的决定（`packages/client/web/src/platform.ts` 里的 `PLATFORM_MODULES`），插件自己安排不了。

## Model Experience

无，因为本包渲染的是纯浏览器侧控件，不触碰任何 prompt、消息、schema、流或工具结果。

#### KV Cache effect

无；本包从不组装或发送模型请求。

## Known Limitations and Deferred Work

- **单文件组件不在受支持路径上** —— 只要包级配置加上 `unplugin-vue` 以及一个把 tsc 产出的 `./x.vue` 说明符重新指回 `src/` 的解析器，`.vue` 文件在 tsdown 的两个 face 下都能编译；但仓库的 Vitest 配置没有 Vue 插件，任何触达 SFC 的测试都会解析失败，而 `.vue` 也落在覆盖率闸的 `packages/*/*/src/**/*.{ts,tsx}` 通配之外。没有 `vue-tsc` 时，SFC 的 props 还会被擦成 `Record<string, unknown>`，丢掉渲染函数写法保留的编译期 prop 校验。因此采用 SFC 是仓库级工具链决定，而非包级决定；本包使用 `defineComponent` + `h()`。
- **一座桥，一个组件** —— 桥只挂载单个 Vue 组件并传一组 prop。slot 子节点、跨桥的 Vue `provide`/`inject`、容器之外的 `<Teleport>` 目标，以及 Vue Router 或 Pinia 都未曾探索。
- **没有共享运行时** —— 见上文“产物代价”；在模块表另有安排之前，每个 Vue 插件都要为自己那份付费。
- **未被组装态快照覆盖** —— 浏览器证据是跑在真实组合上的 Playwright 场景，而不是录制的 transcript；快照通道投影的是模型可见与会话输出，而本包两者皆无。
