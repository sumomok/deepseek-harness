# Agent Note: 把「发送前密钥容器确认」补丁移植到 0.1.2 重组之上

Status: implemented

[English](2026-09-01-secret-container-confirmation-port.md) | 中文

## 问题

这项能力由两个原始补丁按序落地：`ebd4e9c1f4`（"confirm before sending a file that lives in a known secret container"）新增一个纯粹的名称/路径启发式判定（`matchSecretContainerFiles`）、一个即时的芯片警示态，以及一道包住 composer 两个提交入口的两键发送前确认弹窗；`7e37c74cdf`（同系列的后续修复）把芯片在视觉上与图片附件栏对齐、把 `attachmentSizeText` 从只认兆字节升级为 B/KB/MB 三档，并把原本容易被忽略的圆点+描边警示态加强为可读的行内文字标签加行下方提示。两者都早于上游 0.1.2 的包重组，且都依赖 `98020a23cd` 的 composer 草稿文件面（已移植为 `a21f837b51`）与 `fabc93555c` 的 referent/open 缝隙（已移植为 `0b32bd30ad`），本次移植已具备这两处前置条件。本次移植把两个原始补丁压缩合并为一个提交：`7e37c74cdf` 在上游从未独立于 `ebd4e9c1f4` 单独发布过一个值得原样复现的中间状态，此压缩合并已在台账中记录。

## 决策

**宿主侧的配置字段与投影，从已退役的 `packages/host/apiproxy` 搬到 `SessionController.Config` 上。** `packages/host/apiproxy` 在重组后的代码树上已不存在；重组已经把它的 `imageLimits`／`fileLimits` 启动期常量会话投影搬到了 `packages/api/session-controller/src/list.ts`，注册在 `ApiSessionList` 的构造函数里。`secretContainerExtraPatterns` 走同一条路径：新增的 `Config.secretContainerExtraPatterns?: readonly string[]` 字段（用 `z.array(z.string()).default([])` 校验）从 `SessionController` 的构造函数流入新增的 `ApiSessionList` 构造函数参数，后者直接注册 `secretContainerExtraPatterns` 投影——与 `imageLimits`／`fileLimits` 不同，它不指名任何其他缝隙的能力（它是部署自身的 Config 值，而非一次附件服务查询），因此不需要配套的 `ctx.inject(['attachments'], ...)` 包装，只要投影注册表被组装出来它就恒在，这与原始补丁自己的注释所述完全一致。

**`Config` 的 zod schema 需要 `as z<Config>` 类型断言，而不是直接标注 `z<Config>`。** `secretContainerExtraPatterns` 在 TypeScript 接口上是 `readonly string[]`（与本仓库其他 `Config` 接口里的每一个数组字段一致），但 zod 推导出的数组类型是可变的；在本仓库的 `exactOptionalPropertyTypes: true` 下，直接 `static Config: z<Config> = z.object({...})` 这种赋值标注会因型变问题编译失败。`packages/preset/agent-presets/src/index.ts` 自己的 `AgentPresets.Config` 携带完全相同的「只读数组 vs schema」不匹配，并用 `}) as z<Config>` 而非赋值标注来解决；本次移植沿用这一已确立的写法，而非另造新模式。

**客户端侧的启发式判定模块（`secret-container.ts`）原样移植进 `ui-conversation`，而不是 `ui-primitives`。** 与 `attachmentSizeText`／`partitionDroppedFiles`（在 `98020a23cd` 移植期间搬到 `ui-primitives`，因为 `ui-attachment`——一个独立的动态 client 包——需要把它们当作运行时值导入）不同，`matchSecretContainerFiles`／`secretContainerCandidate` 只被 `ui-conversation` 自己的 `InputBar.tsx` 消费——没有其他包把它们当运行时值导入。`ui-attachment` 的 `FileChip`／`ComposerAttachments` 从未见过这套启发式判定本身，只经由 `ComposerAttachmentsOwnerProps` 拿到已经算好的 `secretContainerHitIds: ReadonlySet<DraftAttachmentId>`，因此不涉及 `dsh.client.external`／跨动态包的顾虑，原始补丁的包落点原样成立。

**`attachmentSizeText` 的 B/KB/MB 修复落在 `packages/client/ui-primitives/src/byte-size.ts`，而不是 `ui-conversation/attachment-labels.ts`。** 原始的 `7e37c74cdf` 补丁改的是 `attachment-labels.ts`，因为那是该补丁所在基线代码树上 `attachmentSizeText` 的落点；`98020a23cd` 的移植早已把这个函数搬到 `ui-primitives`（理由同上，跨包运行时导入），因此本次修复的落点跟随函数搬到了它现在的位置。函数的每一个消费者（composer 芯片、消息气泡的 `FileCard`、图片/文件拒收提示条）共用同一份实现，因此这一处修复无需第二个改动点即可惠及全部消费者。

**键盘映射的 `submit:` 处理器把包装后的调用路由经过既有的 `gate` ref，而不是直接闭包捕获 `requestSubmit`。** 重组后的 `InputBar.tsx`（晚于两个原始补丁）早已把它的 Lexical 键盘映射注册在一个仅以 `[editor, keyboard]` 为依赖数组的 `useEffect` 里，其余全部实时状态都经由每次渲染都刷新的 `gate` ref 对象读取——这是原始补丁所在基线代码树没有的模式（它们的键盘映射布线直接闭包捕获组件状态）。`requestSubmit` 加入 `gate.current`，与既有的 `intakeDrop` 并列，键盘映射的 `submit:` 分支改为调用 `g.requestSubmit(() => { keyboard.submit(...) })` 而不是直接调用 `keyboard.submit(...)`——若在该 effect 的过期闭包里直接捕获 `requestSubmit` 本身，会用编辑器首次挂载那一刻存在的 `secretHits` 做闸门判断，而不会跟随之后渲染重新计算出的命中集合。主发送按钮的 `onPrimary` 处理器不需要这层间接：它是每次渲染都重新定义的普通函数，因此直接引用 `requestSubmit`（同样每次渲染都重新定义的 `useCallback`）在那里已经是正确的，与原始补丁自身未加包装的调用一致。

**`Modal` 的 `closeLabel` 在当前代码树上是必填属性，不同于原始补丁 `<Modal open ... />` 那种不传 `closeLabel` 的调用。** 当前的 `packages/client/ui-primitives/src/Modal.tsx` 按 `headless` 做判别：非 headless（默认形态，也正是这个确认弹窗需要的——带标题、描述与操作行的对话框）要求 `closeLabel: string`。本仓库客户端各包里每一处非 headless 的 `Modal` 调用都传入 `closeLabel={t('close')}`，经由合并进每个包翻译器的通用 locale 命名空间（`@deepseek-ai/dsh-client-locale`）解析，而非包内自定义键——`ui-conversation` 自己的 `PermissionSelect.tsx` 早已这样做，且未声明任何本地 `close` 键。本次移植的 `Modal` 调用沿用同一约定，而不是另加一个多余的 `secretConfirm.close` 键。

## 考虑过的替代方案

**保留 `ebd4e9c1f4` 与 `7e37c74cdf` 为两个独立提交，严格遵守「一个原始补丁对应一个提交」。** 对这一对补丁已具体否决：`7e37c74cdf` 自身的 diff 在目标代码树上与 `ebd4e9c1f4` 的 diff 密不可分——它改的正是 `ebd4e9c1f4` 引入的同一段芯片标记与 CSS，且其自身的提交信息把自己定性为同一特性的现场测试后续打磨，而非一项独立能力。拆成两个提交将需要一个中间提交先交付原始补丁自身已经不可读的警示态（原始补丁自己的提交信息援引 rc.25 现场测试结果确认了这一点）作为一次故意的、短暂上线的倒退。压缩合并已在台账中记录，并点名两个原始 SHA。

**把 `secretContainerExtraPatterns` 的投影注册挪进既有的 `ctx.inject(['attachments'], ...)` 代码块里、紧挨 `imageLimits`／`fileLimits`，图个位置上的整齐。** 已否决：这样做会让该投影的存在与否取决于是否组装了附件服务，而该字段实际上应当恒可用（它是部署自身的 `SessionController.Config`，只要 `ApiSessionList` 本身被构造出来就存在）——原始补丁自己的宿主侧设计明确说明它不需要配套依赖，把它塞进受附件服务门控的代码块会静默收窄这一可用性。

## 后果

`packages/api/session-controller/tests/test-remote.ts` 的 `TestSessionRemoteDefaults` 新增 `secretContainerExtraPatterns?: readonly string[]`，按 `coldBlankProbeMaxBytes`／`nativeOpen` 既有的方式穿进 `SessionController` 构造调用。`packages/api/session-controller/tests/session-projections.host.spec.ts` 新增了原始补丁的两个宿主侧投影测试（无需附件服务即可发布的常量单元、以及默认空值），改为直接调用 `createSessionTestRemote` 并在其 defaults 里带上 `secretContainerExtraPatterns`，而非原始补丁的 `createApiProxy`。`packages/client/ui-conversation/tests/input-bar.client.spec.tsx` 新增了 `secretContainerExtraPatterns` 的 `BenchOptions` 字段与 `useProjection` 桩分支，以及原始补丁完整的 `describe('secret-container pre-send confirmation', ...)` 代码块，仅针对本代码树基于 Lexical 的输入区做了适配（用 `textarea.textContent` 而非 `.value`，与本文件其余全部草稿内容断言一致）。`packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx` 与 `packages/client/ui-conversation/tests/attachment-labels.client.spec.tsx` 里既有的兆字节格式断言（`5MB`、`1MB` 等）需要更新为新的 `5 MB`／`1 MB` 带空格形式，`packages/client/ui-primitives/tests/byte-size.client.spec.ts` 新增了完整的 B/KB/MB 矩阵。`docs/config-catalog.md`／`.zh.md` 与 `packages/api/session-controller/README.md`／`.zh.md` 新增了这个新 Config 字段的条目（英文目录经 `pnpm run gen-config-catalog` 重新生成；中文目录代码围栏里的内容按本文档自身既有的约定原样保留英文，围栏之外的说明文字才是中文——这里无需额外说明文字，因为整个新增内容就是那个代码围栏块本身）。`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 经 `pnpm run gen-client-catalog` 拾取了拓宽后的 `ComposerAttachmentsOwnerProps` 形状，并连带机械性地挪动了若干条无关的 `source:` 行号引用（源于新字段在 `slots.ts` 里的插入位置）。

**退役条件。** 与原始补丁一致：这是仅存在于本 fork、为上游尚不具备的能力打的产品安全垫。一旦上游自己的 composer 具备等价的发送前内容敏感性确认，本补丁（及本次移植）退役，本 fork 转而适配上游的形态。
