# Agent Note：两份 content-access 的 Web fixture 留在录制会话语料库之外

Status: implemented

[English](2026-09-03-content-access-fixtures-outside-the-corpus.md) | 中文

## 问题

内容「眼与手」这条线是在上游 0.1.2-alpha.5 之前分出去的，它的两个 Web 场景 —— `content-read` 与 `content-act` —— 把各自的会话 fixture 录在紧挨着 spec 的位置，即 `apps/web/tests/snapshots/<场景>/session.jsonl`，因为当时每一份 Web 会话 fixture 都在那里。

这条线现在并入的基座，已经把录制会话语料库搬到了仓库根部的 `snapshots/{acp,sdk,session,web}/` 树下。[`scripts/session-snapshot-corpus.corpus.ts`](../../../../scripts/session-snapshot-corpus.corpus.ts) 会遍历这棵树，要求其下每个目录都带一份 `snapshot.yml`，写明场景名、profile、录制时对着的 `composition`、录制方式是 `live` 还是 `authored`，以及一个 `header` 块——外加决定哪个场景拥有某份 `session.jsonl`、哪个只是借用的归属规则。留在 `apps/web/tests/snapshots/` 下的是 `*.expected.md` 交互快照，语料库不管它们。

## 决定

两份 fixture 留在原地。只有两个场景共同借用的那份种子跟着走，改指 `snapshots/web/fresh-round-trip/session.jsonl`，因为文件本身搬了家。

把它们收进语料库，意味着要写两份清单，以及语料库随后对它们提出的任何钉子——钉住 header 就要 `system-prompt.expected.md` 与 `tool-schemas.expected.json`，要声明 composition，会改动工作区的场景还要一份工作区期望。那是有自己验收标准的快照工装活，在一次向前合并里做，落地时拿不出任何证据说明这些钉子钉的是这条线的组合，而不是当天恰好的样子。

## 影响

两个场景都能无密钥地对着已构建的应用回放，且是绿的。它们拿不到的是语料库给成员的那些东西：没有清单声明它们录制时对着的组合，因此组合漂移只能被 spec 自己写的断言抓到；`assertReplaySession` 的持久化日志比对保持关闭，因为 [`apps/web/tests/scaffold.ts`](../../../../apps/web/tests/scaffold.ts) 是按同级目录的 `snapshot.yml` 打开它的，而这里没有；`pnpm run test:snapshot` 根本看不见它们，于是模型侧的读取报告或步骤报告一旦变化，只有这两个 spec 会发现，仓库级别没有任何东西会。

重录它们仍然需要密钥与 `DSH_SNAPSHOT=record`，而 `recordFixture` 的 `afterSeed` 裁剪——这条线当初改动那段采集的原因——在哪个位置都照常工作。

## 备选方案

**在这次合并里就把 fixture 搬走并补上最小清单。** 一份为了满足遍历器而写、并非对着录制实测出来的 `composition` 与 `header`，钉不住任何东西；语料库随后会把两个没有录制作为依据的场景报告成已覆盖。

**删掉 fixture，直接重录进语料库。** 录制需要真实密钥，而一次向前合并没有理由要求这个；何况重录出来的一对会带着它自己那次的模型选择，那是改变这两个场景断言的内容，而不是搬家。
