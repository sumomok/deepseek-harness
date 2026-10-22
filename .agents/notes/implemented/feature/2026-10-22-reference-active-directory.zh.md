# Agent Note: 文件引用在点击时按当前工作目录解析

Status: implemented

[English](2026-10-22-reference-active-directory.md) | 中文

## 问题

`working_directory` 工具改变 Session 的有效目录，并把它记为 `working-directory/change` 事件；不可变的 Session 头部保留原来的项目目录。宿主按当前目录列出 `@` 候选（`packages/context/file-reference-local/src/index.ts`，经 `workingDirectory.ensure`），文件工具也按当前目录解析相对路径（`packages/fs/tool-fs/src/session-cwd.ts`）。浏览器却按头部目录解析所有相对文件引用：输入框芯片（`packages/client/ui-reference/src/client/index.ts` 的 `openReference`）、已发送消息里的文件节点（同一文件的 `conversation.user.text.node` 注入），以及承接 Assistant Markdown 链接、工具行与产出文件提及的 Chat `openFile` 闭包（`packages/client/ui-chat/src/client/apply.ts`）。agent 进入子目录之后，从 `@` 菜单选出的文件或回复里的相对链接会按相对头部目录的路径打开，预览报告文件不存在，或显示另一个相对路径同名的文件。宿主按 `header.cwd` 解析 Session 作用域的文件地址（`packages/api/workspace-files/src/index.ts` 的 `workspaceFileScope` 查找）；上游到 `dsh-v0.2.1-rc.2` 仍这样解析。

## 决策

**浏览器在点击那一刻按 Session 的当前工作目录解析相对引用。** 当前目录是 Session 投影 `workingDirectory`（`packages/session/working-directory/src/index.ts`），宿主经它的 wire 视图推给客户端。客户端用 `sessions.binding(sessionId)?.session.projections.faceOf('workingDirectory').getSnapshot()` 读取，并用 `typeof value === 'string'` 收窄。投影缺失或为 null 时——没有持有的 binding、尚未记录目录，或装配里没有 working-directory 服务——以会话列表里的头部目录为基准。

**Sidebar 地址仍以头部目录为根。** 每个打开动作先算 `target = resolveWorkspacePath(current ?? header, path)`，再打开 `fileAddressFor(sessionId, header, target)`。头部工作区内的目标得到相对 Session 的地址（`dsh-resource://file/session/<id>/child/notes.md`），与文件树给同一文件的地址相同；工作区外的目标保留绝对路径，宿主的文件读取接受这种地址。`ReferentRef.target` 携带同一个解析结果，因此 `referent/open` 监听者收到的就是默认动作打开的那个文件。

**四个调用点这样解析。** 在 `ui-reference` 里，输入框芯片的 `openReference` 与已发送文件节点的 `openFile` 注入共用 `locateFile`。在 `ui-chat` 里，`openFile` 闭包保留 `options.line` 作为导航参数，`buildProseReferents` 把当前目录作为 `cwd` 交给 `ProseReferents` 提供方的 `scan` 与 `resolveLink`。两个包各有一份三行的 `currentDirectoryOf`：`dsh-util-workspace-path` 零依赖，读不到 `ISessions`；共享的客户端模块会为三行代码在 fork 的核心补丁线上新增一个文件。

**模型可见的文字不变。** `@` 候选、插入的 mention 文字与回复里的路径都保持原样，因此模型请求与录制会话快照不变。

## 考虑过的替代方案

**在宿主侧改文件作用域的基准目录。** 否决：`workspaceFileScope` 查找给出的 `workspaceRoot` 同时是文件树列举与变更监听的根，按当前目录取值会让文件树随 agent 每次切目录而换根。改为新增基准目录参数或第二种地址作用域，又要为只有点击处需要的解析增加宿主 Remote 参数与地址语法。

**插件层：候选给相对头部目录的路径。** 否决：`@` 行显示与插入的是同一个 `candidate.path`（`ui-reference` 的 `fileCandidate` 与 `onPick`，`packages/context/file-reference/src/grammar.ts` 的 `formatFileMention`），改插入文字就会改行上显示的内容。插入的 mention 会到达模型，而文件工具按当前目录解析相对路径，相对头部目录的路径会指向模型读不到的文件。

**插件层：候选给绝对路径。** 否决：它改变模型可见的文字，也覆盖不到回复里的相对链接（这些链接从不经过 `@` 候选）和用户手打的 mention。

## 后果

引用按点击那一刻的当前目录解析，而不是按写下引用时的目录。agent 再次切换目录后，较早的相对引用——已发送的芯片或回复里的链接——会按新目录解析。要还原每条消息当时的目录，需要按该消息的序号回看 `working-directory/change` 历史；这项工作暂缓，直到有用户报告较早的引用打开了错误的文件。`ChatView` 里的 Markdown 图片来源与图片链接缩略图仍在渲染时按头部目录解析：客户端程序里带类型的 `useProjection` 键不含 `workingDirectory`，它的投影表声明在宿主包里；而跟随 agent 的渲染期基准会把已经正确显示的图片重新解析。

`packages/client/ui-reference/tests/browser-plugin.client.spec.ts` 与 `packages/client/ui-chat/tests/apply-inject.client.spec.tsx` 钉住点击时解析：尚未记录目录与投影为 null 时退回头部目录、工作区内的子目录、工作区外的目录、绝对路径、`#L` 行号、`scan` 与 `resolveLink`，以及 Windows 盘符与反斜杠写法。`apps/web/tests/reference-active-directory.e2e.ts` 经随附装配走用户路径：agent 用 `working_directory` 进入 `child/`，输入框芯片、带行号片段的回复相对链接与已发送消息里的芯片，各自打开工作区根目录里也存在的同名文件在 `child/` 下的那一份。

本 fork 在 `.claude/core-patches.md` 里把这项改动记为核心补丁族 `reference-active-directory`。上游开始按当前目录解析这些点击、宿主文件作用域不再只以 `header.cwd` 为基准，或 `FileReferenceCandidate` 开始携带基准目录或绝对路径时，该族退役。
