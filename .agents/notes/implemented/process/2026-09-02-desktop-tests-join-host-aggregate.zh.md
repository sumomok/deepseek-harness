# Agent Note: apps/desktop 的测试与打包脚本并入 Host 聚合面

Status: implemented

[English](2026-09-02-desktop-tests-join-host-aggregate.md) | 中文

## 问题

`apps/desktop/tsconfig.json` 的 include 只有 `src`,而两个聚合面都没有覆盖这个包,于是 `apps/desktop/tests/**` 与 `apps/desktop/scripts/**` 不属于任何 TypeScript 工程。Oxlint 的 type-aware 规则经 tsgolint 执行,而 tsgolint 会把每个文件解析到它所属的工程;对这两个目录它报的是 `Got tsconfig for file …: <none>`,于是在一个降级的默认程序上判断——那里 `../src/*.ts` 的导入解析成 `any` 或 `error`。这些判断与 `tsconfig.base.json` 下的 `tsc` 相悖:`noUncheckedIndexedAccess` 使得被 `typescript/no-unnecessary-type-assertion` 标红的非空断言恰恰是必需的,照 lint 提示改反而编译不过。`ce5929b494` 作为权宜之计给 `apps/desktop/tests/**` 关掉了三条规则,并把纳入工程记为后续项。`apps/desktop/src` 从未受影响:它一直归自己的包工程所有。

## 决定

`tsconfig.host.json` 的 include 加入 `apps/desktop/src/**/*.ts`、`apps/desktop/scripts/**/*.ts` 与 `apps/desktop/tests/**/*.ts`,且**不**声明指向该包的 Project Reference。这与聚合面对 `scripts/**/*.ts` 和 `website/**/*.ts` 已有的处置同型:私有、从不发布的源码树直接并入这个 `noEmit` 聚合面,而不是作为被引用的工程去构建。`src` 一并纳入,是为了让测试里 `../src/*.ts` 的导入落在程序列出的文件上;这同时使它们解析到源码而非产出的声明——正是静态门禁与测试在别处一贯遵循的源面规则。选 Host 面是因为这些测试与脚本导入的是 `node:*`、`js-yaml` 与 `@deepseek-ai/dsh-app-boot`,没有任何浏览器侧内容。

Oxlint 现在把 `apps/desktop/tests` 与 `apps/desktop/scripts` 解析到 `tsconfig.host.json`;`apps/desktop/src` 仍解析到更具体的 `apps/desktop/tsconfig.json`——那本就是它此前的归属,所以本次改动没有挪动任何 `src` 上的判断。

`.oxlintrc.json` 里 `apps/desktop/tests/**` 的例外已删除,`scripts/lint-rule-fingerprint.spec.ts` 重新把 override 条数钉在 9;两个文件都与上游逐字节一致。在真实程序上判断后,这三条此前被豁免的规则查出三处缺陷,均在 `apps/desktop/tests/render-service.spec.ts` 中修复而非抑制:

- 两处 `expect.any(Number)` 落在 `maxAgeMs: number` 的位置上,而 vitest 把该匹配器标注为 `any`,现在写作 `expect.any(Number) as unknown as number`——`packages/api/session-controller` 与 `packages/client/modules` 的测试对同一冲突早已采用这一写法。
- 一处主机名用 `` `${'a'.repeat(254)}` `` 构造,是包裹字符串表达式的多余模板串,现在写作 `'a'.repeat(254)`。

`tsconfig.host.json` 归上游所有,但 `apps/desktop` 是 fork 独有,因此这条登记是一处 fork 增量,与退役的例外一并记入 `.claude/core-patches.md`。

## 权衡过的替代方案

**照 `apps/cli` 的样子,从聚合面 reference `./apps/desktop`。** 否决:它会让整仓的 `pnpm run clean` 失效。`scripts/clean.ts:135-139` 从根 solution 出发遍历 Project Reference 图,要求每个工程的 `outDir` 都以 `/types` 结尾,于是在任何删除动作之前就从 `plan()` 抛出 `clean: expected TypeScript outDir to end in /types: apps/desktop/lib`。两个 app 本就不同型:`apps/cli` 把声明产到 `lib/types`,而 `apps/desktop` 把发货的 Electron 运行时产到 `lib`,正是 `main: lib/main.js` 指名的路径。为迁就这个遍历去改产物目录,会挪动打包入口以及 `electron-builder.yml` 与 `scripts/package.ts` 依赖的每一条路径,换来的只是聚合面并不需要的声明。

**把 `apps/desktop/tsconfig.json` 的 include 扩到 `tests` 与 `scripts`。** 否决:该工程的 `rootDir: "src"` 与同一个 `outDir: "lib"` 相配,纳入同级目录就必须把 `rootDir` 放宽到包根,这会把所有产物路径挪成 `lib/src/…`,打断 Electron 入口。它同时违背本仓库自己的归属规则:测试文件归聚合面,包工程只拥有发布源码。

**新增第二个工程文件 `apps/desktop/tsconfig.tests.json`。** 否决:聚合面里三条 include 通配就能达到同一个程序,且不新增需要同步维护的配置;而仓库里其他所有测试文件——`apps/cli/tests`、`packages/*/*/tests`、`apps/web/tests`——本就住在聚合面里,而非按目录另设工程。

**保留 `.oxlintrc.json` 的例外,继续让这两个目录游离于工程之外。** 否决:例外只关掉三条规则,其余所有 type-aware 规则仍在导入未解析的前提下判断桌面端测试,结论在漏报与误报两个方向上都不可信;而 `apps/desktop/scripts`——打包与发版流水线——则根本没有归属工程。

## 后果

`pnpm run typecheck` 现在会类型检查桌面外壳的测试及其打包、发版脚本;此前 `src` 只在打包时经 `pnpm --filter @deepseek-ai/dsh-desktop run build:ts` 被检查,测试与脚本则完全不被检查。type-aware lint 的变化仅限于 `apps/desktop/tests`:`.oxlintrc.json` 的 type-aware override 通配只有 `apps/*/src/**` 与 `apps/*/tests/**`,因此 `apps/desktop/scripts` 保持它本就适用的那些非 type-aware 规则不变。由于聚合面不声明指向该包的 reference,`tsc -b tsconfig.host.json` 仍不为 `apps/desktop` 产出任何东西,`pnpm run clean` 也照常可用。权宜之计的退出条件有机械保证:再往 `.oxlintrc.json` 里加 override 会让把条数钉在 9 的 `scripts/lint-rule-fingerprint.spec.ts` 变红。
