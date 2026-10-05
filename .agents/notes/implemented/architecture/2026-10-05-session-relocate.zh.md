# Agent Note: 已存会话通过改写当前 header 记录搬到另一个 cwd

Status: implemented

[English](2026-10-05-session-relocate.md) | 中文

## 问题

搬移工作区文件夹时必须保留其中的会话：id 不变、事件不变、cwd 换新。持久化 seam 只提供 `create`、`open`、`flush`、`stat` 与 `list`，cwd 存在不可变的 header 里。JSONL 后端把每个会话存在 `sessionDir(root, cwd, id)`，换 cwd 就意味着换目录，而每个读方都会检查最高一代 header 的 cwd 是否指向它所在的目录（[`assertStoredIdentity`](../../../../packages/session/session-persistence-jsonl/src/index.ts)）。插件无法从外部安全地搬移会话：同一 id 在两个项目目录都有规范 generation 时，`findLog` 与 `listArtifacts` 抛普通 `Error`，于是整个根目录的 `list()` 失败，工作区注册表启动时的 `list()` 也随之失败，宿主起不来。header 的 cwd 指向另一目录时同样失败。

## 决策

`SessionPersistence` 增加可选方法 `relocate(id, cwd, options)` 与 `@mode emit` 事件 `session-persistence/relocated(id, previous, current)`。调用方先判断 `typeof ctx.sessionPersistence.relocate === 'function'`。该方法把会话移到 `cwd` 对应的存储位置并替换 header cwd；id、`createdAt`、谱系、`isSeeded`、inherited cut、事件与 seq 都不变。已存 cwd 已等于 `cwd`（逐字比较）时不做任何改动、不发事件，因此崩溃过的调用方可以重调。任何进程的写句柄或本进程的 pending create 都会让它以 `SessionAlreadyOwnedError` 拒绝。读句柄可以保持打开：会话在两个位置之间不存在时，`open` 与访问存储的句柄读取以 `SessionPersistenceNotFoundError` 拒绝；在源被隐藏前一刻已定位到源的 `open` 或读取，以文件系统的 `ENOENT` 错误拒绝，与不含本补丁的构建遇到日志消失时相同。每次成功搬迁在后端释放所有权后发出一次事件，emit 放在 `try` 里，因为 Cordis 的 `emit` 同步调用监听器且不捕获异常：一个监听器抛错会中止分发，排在它之后的监听器收不到事件，搬迁仍然成功并记一条警告。任何恢复都不发事件。

JSONL 后端只改写当前 generation 的 header 记录。最高一代是历史格式时，先走与写 open 相同的路径发布当前格式后继（[已发布格式迁移](2026-08-31-released-session-format-migrations.zh.md)允许新增以版本命名的后继），再改写这个后继。前几代原样搬走：同一文件系统内的 rename 保留其字节与 inode。唯一被删除的字节是源目录里当前 generation 的副本；它的事件记录在目标中逐字节保留，唯一例外是从撕裂尾部恢复出的完整记录，搬迁按写路径首次追加的方式重新编码它们。

这不是格式迁移：格式版本、header 字段、信封与 `SessionEventMap` 都不变。搬过的会话是标准布局加标准 header，与直接在新 cwd 下创建的会话没有区别，因此同一格式版本的任何运行时都能读取，包括不含本补丁的构建。新 cwd 经系统提示到达模型，系统提示以 `system/message` 记入日志，日志中的 header 记录也持有它。

## 磁盘协议

记号：`C` 是所配编码的当前 generation 文件名，`P` 是保留的前几代，`T` 是名为 `<C>.relocate-<token>.tmp` 的暂存副本，`H(x)` 是隐藏名 `<x>.relocating-<token>`。两种后缀在两种编码下都不是规范名，因此发现、编码检查与 `scripts/migrate-sessions-to-v4.ts` 都会忽略它们。只要没有其他写入方以同一 id 存下第二个会话（见「后果」），三条不变量在每一时刻、对每个进程都成立：根目录下至多一个目录含该 id 的规范 generation（V1）；该目录中最高一代 header 的 cwd 指向该目录（V2）；目标 `C` 一旦存在，源目录不再含任何规范 generation（V3）。唯一的过渡状态是"两处都没有"，从隐藏源持续到发布目标，读作不存在：`stat` 返回 `undefined`，`list` 不列出该会话，`open` 以 `SessionPersistenceNotFoundError` 拒绝。进行中的搬迁经过几次文件系统操作就离开这一状态；在这一状态中退出的搬迁会让会话保持不存在，直到某个后端恢复它的意图。

后端取得进程内写认领与源目录的锁，再次解析会话（见下文），需要时发布历史后继。它持久地建好目标项目目录与会话目录，取得目标的锁，并在写意图之前拒绝含有规范 generation 的目标，以及位于不同文件系统（`stat().dev`）的源与目标；拒绝时删除本次建出的目标会话目录，而本次建出的目标项目目录保留。随后运行时（[`relocation.ts`](../../../../packages/session/session-persistence-jsonl/src/relocation.ts)）依次：删除该 id 的意图临时文件，它们由发布意图之前退出的进程留下；以不替换已有意图的方式写意图 `root/.relocate.<sha256(id)>.json`（POSIX 用 `link`，Windows 用不带 `MOVEFILE_REPLACE_EXISTING` 的 `MoveFileExW`），其中记下源 `C` 的已提交长度（尾部没有撕裂时就是整个文件的长度）；在目标中写出 `T`，内容是新 header 记录、源文件旧 header 之后的已提交字节，以及从撕裂尾部恢复出的记录，fsync 后在 Worker Thread 中按 id、事件数与写入摘要校验；把每个 `P` 改名到目标的 `H(P)`；把源 `C` 改名为 `H(C)`；在其他每个项目目录中查找该 id 的规范 generation，找到即停；以不覆盖方式把 `T` 发布为目标 `C`（POSIX 用 `link`，Windows 用不带 `MOVEFILE_REPLACE_EXISTING` 的 `MoveFileExW`），即提交点；把每个 `H(P)` 恢复为 `P`；删除 `T`、`H(C)`、源锁文件与源目录（含不认识文件的目录保留并报告）；删除意图；释放两把锁与认领；发出事件。所有跨目录操作都在提交点之前，因此跨设备失败仍可回滚。

目标 cwd 规范化后的项目目录与源相同时（`projectKey` 有损：`/a/b` 与 `/a-b` 都是 `--a-b--`），或目标拼写指向同一物理目录时（大小写别名或符号链接的项目目录，按 `dev`/`ino` 判定），搬迁原地改写：写意图，在 `C` 旁暂存 `T`，原子替换 `C`（POSIX 用 `rename`，Windows 用带 `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` 的 `MoveFileExW`）；前几代不动。若先把 `C` 改名移开，某一代历史 generation 会短暂成为最高一代，已打开的读句柄会报告日志缩短。原地改写的意图记下源与目标两种拼写；两者都存在且是两个物理目录时，恢复拒绝它；任一拼写已不指向目录时照常落定，因为落定只删除源 `C` 旁的暂存副本与意图。两种拼写指向同一物理目录的跨目录意图被拒绝：它的两把锁是同一个锁文件，恢复的进程会与自己争用。

## 恢复

启动恢复与调用内失败共用一个判定，只依据磁盘事实：目标 `C` 是否存在？不存在则回滚：`H(C)` 回到源 `C`，每个 `H(P)` 以不覆盖方式回到源目录（内容相同的文件视为已恢复），删除 `T`，只剩锁文件的目标目录被删除，意图被删除。先恢复 `C` 再恢复前几代，避免回滚中途让历史 generation 成为最高一代。会让空的源目录重新可见的回滚，先像发布那一步一样在其他每个项目目录中查找该 id 的规范 generation。目标 `C` 存在且是被搬日志的延续时，从恢复前几代名字一步起补完，且从不碰目标 `C`，因为别的进程可能已经写开它并追加了事件。日志只追加，搬迁只改写 header 记录，所以延续的目标 `C` 在 `T` 还在时以 `T` 开头，否则它的 header 记录除 cwd 外与 `H(C)` 的逐字段相同，且它 header 之后的字节以 `H(C)` header 之后的已提交字节（意图里记录的长度）开头。`T` 是否存在分不清已提交的搬迁与源被隐藏期间在目标处以同一 id 存下的会话：Windows 发布时消耗 `T`，POSIX 在删 `T` 与删 `H(C)` 之间崩溃也留下同样的文件。按已发布的目标而不是按意图或步骤字段判定，能保留别的进程在源被隐藏之前追加到源 `C` 的事件。与意图矛盾的存储——两处都含规范 generation、目标 `C` 不是被搬日志的延续、目标有某一代却没有 `C`、源 `C` 与 `H(C)` 都缺失、隐藏文件的规范名已被不同字节占用，或源被隐藏期间另一个项目目录含该 id 的规范 generation——保留所有文件与意图。

后端的第一次操作（惰性且记忆化的根目录检查，宿主通常经工作区注册表的 `list()` 首次触达）在检查根目录编码之前恢复每一条意图，并对意图中仍存在的目录取锁；锁被占用、意图无效、存储矛盾或 I/O 失败都保留意图并记一条警告，记忆化的检查不会因此 reject。意图临时文件保留，因为它可能属于另一个进程中仍在写它的搬迁；只有同一 id 的 relocate 会删除它们，此时它持有会话所在目录的锁，而该 id 的任何搬迁都必须持有这把锁才能写临时文件。每一次恢复都持有意图所点名目录的锁（已不存在的目录不需要），并在持锁后再读一次意图，只处理未变的意图；意图路径只由 id 决定，按过时的读取结果恢复可能删掉另一次搬迁的意图。relocate 先取得会话所在目录的锁，然后才在这把锁与意图中另一个目录的锁之下落定该会话遗留的意图。只有这把锁的持有者才会为该会话写意图，所以在本次搬迁记下自己的意图之前不会出现新的意图；在本次查找与取锁之间退出的搬迁因此会被落定而不是被覆盖，若意图路径上仍出现意图，搬迁以点名它的 `SessionPersistenceCorruptionError` 拒绝并保留它。会话不存在或存在于两个目录而取锁失败时，relocate 在遗留意图所点名目录的锁之下落定它，再取一次锁。落定时目录被占用以 `SessionAlreadyOwnedError` 拒绝，否则以点名意图文件的 `SessionPersistenceCorruptionError` 拒绝；在找到与读取之间被另一个后端删除的意图视为已落定。调用内失败发生在提交点之前时回滚并重新抛出（回滚也失败时抛 `AggregateError` 并保留意图）；发生在提交点之后时补完清理，清理也失败时调用照常成功、发出事件、记警告，并保留意图等待下次恢复。取消只在提交点之前检查。

## 取锁后重新解析

POSIX 锁指向 inode 而非路径，因此删除活会话的锁文件就失去排他。relocate 在发布目标之后会删除自己持有的源锁文件。此前已解析到源目录的写入方随后可能经租约的 `mkdir` 重建该目录、在其中锁住一个新文件，再从目标读到会话——两个写入方同时存在。因此每次写 open 在取锁后都会再次解析会话；会话已不在所锁目录时，该次 open 在仍持锁时删除它重建的目录，释放锁并重试一次。第二次仍不一致时以 `SessionAlreadyOwnedError` 拒绝，会话已消失时以 `SessionPersistenceNotFoundError` 拒绝。

## 消费方

工作区注册表在运行期跟随该事件。监听器在任何 await 之前替换该会话已索引的 header 并删除其已索引的路径，因此旧工作区不再列出该会话，`relocate` 之后紧接着的 `attachSession` 按新 cwd 校验。随后它的变更队列从每个在另一路径下列有该会话的工作区记录中持久 detach 该会话：`workspace/follow` 的基线按已索引路径过滤，但增量帧发送未过滤的已存 `sessionIds`，而注册表只在启动时引导一次索引，所以只改内存会让旧工作区继续列出该会话。新的规范 cwd 上已有工作区时，队列把会话 attach 到它，因此搬迁不需要重启。事件仍可能到不了注册表：注册表没有运行、恢复补完了搬迁，或排在它之前的监听器抛错。因此注册表在下次启动时，对存储路径在这次启动时解析成功的工作区记录，把规范 cwd 是另一个已存在目录（不同于该记录路径）的每个会话持久 detach；`attachSession` 也会先把通过校验的会话从列出它的其他每个工作区里 detach。只做过滤的话，调用方的 attach 会让同一会话记在两个工作区里，下次启动把它当作不一致的域而拒绝。恢复不发事件，所以调用方仍要幂等地 attach。

投影缓存按会话的生命周期身份为每条记录定键，其中包含 cwd。不改键时，每个搬过的会话都无法命中缓存，而会话列表冷行的标题来自该缓存，于是在各会话被打开一次之前都没有标题。因此缓存的监听器对 `createdAt`、`cwd` 与 `isSeeded` 都与搬迁前 header 一致的记录（当前格式代或前代）改写其 cwd，并保留其行，因为搬迁不改变任何事件。

## 考虑过的替代方案

**用旁注记录新 cwd，而不改写 header。** 搬走目录并在日志旁记录新 cwd，会留下 cwd 指向另一目录的 header；不含本补丁的构建（补丁退役后的上游或降级后的旧版）在 `assertStoredIdentity` 处抛普通 `Error`，`listArtifacts` 不捕获它，于是整个根目录的 `list()` 失败（JSONL spec 以 "list rejects a header whose cwd does not identify its physical log" 固定了这一行为）。目录不搬则会让这类构建悄悄回到旧 cwd。两种形式都让较旧的运行时读错日志，按 [`types.ts`](../../../../packages/core/session/src/types.ts) 的格式版本规则需要升 `SESSION_FORMAT_VERSION`，而 fork 不能占用版本号。它还会扩散到 `decodeStoredLog`、历史身份校验、迁移发布以及每一个 revision 调用点。

**先写新位置，再删旧位置。** 两步之间两个项目目录都含该 id 的规范 generation，每个进程——包括不含补丁的构建与恢复之前的本进程——的 `findLog` 和整个根目录的 `list()` 都会失败。先退役源再发布目标，把这一窗口换成一段不存在的时间，所有读方本来就能处理。

**意图目录放在根目录之外，由配置给出。** 后端不知道 `DSH_HOME`，跨文件系统的 rename 不是原子的，而部署可变的路径需要一个经校验的 `Config` 字段来承载本属内部布局的东西。根目录下的普通文件从不被扫描：发现只列目录，迁移脚本跳过没有日志后缀的名字。

**意图中记录 `step` 字段。** 信任已记录步骤的恢复，要么在别的进程已向已发布目标追加之后回滚，要么在写入方重新打开源之后补完覆盖。按目标 `C` 是否存在判定两种失败都不会发生。

**以非规范名保留源 `C` 的副本。** 这样不删除任何已提交字节，代价是每次搬迁占用两倍空间并需要另一套清理机制；目标已逐字节持有每条事件记录，因此删除该副本。

## 后果

保留的前几代 header 里仍是旧 cwd。只要 `C` 存在它们就不会被读取，而已发布的前代既不承诺回退也不承诺降级支持；手工删除 `C` 会选中 header 指向另一目录的前一代，此后整个根目录的 `list()` 失败。`T` 存在期间搬迁需要两倍于会话的空间。每次搬迁都会改变当前 generation 的 inode，因此其 revision 改变；`historicalCorpusRevision` 按路径做哈希，所以一次搬迁还会让所有历史格式会话的 revision 各变一次，引起一轮重新观察；恰好落在不存在窗口里的 `list()` 会把该会话报告为已删除，直到下一次列出。搬迁 subagent 子会话会让历史格式父会话已记忆的 preparation 失效：父会话下一次读 open 自动重试，下一次写 open 以 `JsonlGenerationSourceChangedError` 拒绝一次。

在隐藏源与发布目标之间退出的搬迁，会让会话在每个已经跑过恢复的进程里保持不存在，直到该进程重启或对该 id 调 relocate。Session Controller 的 `createOrAdopt` 在会话查询报告已存会话缺失时以同一 id 新建会话，agent loop 的 `restoreOrCreateConfigured` 在 `SessionPersistenceNotFoundError` 时退回 `create`；两者都可能在第一个会话不存在期间以同一 id 存下第二个会话。发布那一步，以及每一次会让被隐藏的源重新可见的回滚，都先查找其他项目目录；找到时搬迁停下，意图与隐藏文件保留，一条警告点名该意图，对该 id 的 relocate 以点名该意图的 `SessionPersistenceCorruptionError` 拒绝，与两处都含该会话时的处理相同；同一 id 的会话存在目标处或源处时，恢复也这样停下。[包 README](../../../../packages/session/session-persistence-jsonl/README.zh.md#relocating-a-session) 列出保存原会话的文件以及手工恢复的办法。这次查找只能缩小、不能消除竞态：`create` 在调用时检查 id，在第一次 append 时才存储，所以看到会话不存在、而在查找之后才第一次 append 的 create 仍会让该 id 出现在两个目录，整个根目录的 `list()` 失败——与两个进程在不同 cwd 下用同一 id 创建属于同一类。

取锁后重新解析只在具备它的构建之间排他。不含本补丁的构建在搬迁进行时写 open 该会话，可能解析到源、在搬迁删除源之后经租约的 `mkdir` 重建它、锁住新的锁文件，再在打了补丁的写入方持有目标锁时向目标处的会话追加；两者随后追加相同的 seq。因此在发生 relocate 的根目录上，写入该根目录的每个进程都必须运行含本补丁的构建。

Session Controller 从不释放已 resume 的 Agent，而已 resume 的 Agent 会一直持有写句柄直到宿主退出，因此宿主跟随过或发过 prompt 的会话会以 `SessionAlreadyOwnedError` 拒绝 relocate；调用方要在任何客户端打开会话之前搬迁。恢复不发事件，所以提交点之后的崩溃会丢失 `session-persistence/relocated`；按 cwd 跟踪会话的消费方必须在 `relocate` 返回后幂等地 attach，工作区注册表则在下次启动时修好成员关系。排在注册表之前的监听器抛错后、下次启动之前，旧工作区仍列出该会话，在新路径上 attach 会被拒绝，因为注册表的索引仍是搬迁前的 header。

[`relocation.spec.ts`](../../../../packages/session/session-persistence-jsonl/tests/relocation.spec.ts) 中的崩溃矩阵通过注入的 barrier 在每一步之后停住运行时，覆盖两种编码与两种命名空间操作平台，断言该时刻的 V1–V3 与每个非规范文件的位置，按不含本补丁的后端的方式读根目录（按文件名选最高规范 generation、校验 header 身份、按当前格式解码事件）并要求事件与原文相同，再用该平台的命名空间操作完成恢复，经新的后端检查结果；同一 spec 还在一个于崩溃前已跑过恢复的后端里以同一 id 存下会话，断言恢复让该搬迁保持未落定且 V1、V2 成立。[`relocation.two-process.e2e.ts`](../../../../packages/session/session-persistence-jsonl/tests/relocation.two-process.e2e.ts) 在纯 Node 子进程里用构建产物恢复提交点两侧遗留的意图，并固定另一进程持有会话时的拒绝行为。

这是登记在 [`.claude/core-patches.md`](../../../../.claude/core-patches.md) 中的核心补丁 `session-relocate`。上游 `SessionPersistence` 自己提供搬移会话或修改 cwd 的能力时退役。
