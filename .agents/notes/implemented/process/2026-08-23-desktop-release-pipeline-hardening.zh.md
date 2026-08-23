# Agent Note: 桌面发布给自己所交付的 commit 打 tag,并核对自己构建出了什么

Status: implemented

[English](2026-08-23-desktop-release-pipeline-hardening.md) | 中文

## Problem

桌面发布有两个步骤落在跑它的脚本之外,而且两者失效的方式相同——悄无声息,而且是朝着「看起来没问题」的方向。

**没有任何东西给发布出去的 commit 打 tag。**`desktop-v0.1.0-rc.14` 到 `desktop-v0.1.0-rc.19` 全是事后手工打的,打在当时仓库恰好停在的那个位置上。`apps/desktop/scripts/publish-update.ts` 上传产物、重写清单、回读清单并清理更新源,然后就停了:一个已发布的构建,在有人想起来敲那两条 git 命令之前,没有任何东西指向它的源码出处。忘了打 tag 没有任何东西会报,于是「发布了什么」这份记录取决于发版的人记不记得。桌面应用是 `private` 的,不进任何 registry,所以仓库的发布工作流也没有一个管得着它([私有 app](2026-08-20-private-apps-are-not-release-members.zh.md))。

**一次打包运行可以只构建半个发布,还以 0 退出。**`apps/desktop/scripts/package.ts` 里的 `parseCli` 在两个平台参数都不给时,从 `process.platform === 'darwin'` 推断出 `--mac`,而 `--win` 从来不会被推断出来。于是在 macOS 主机上直接跑 `pnpm --filter @deepseek-ai/dsh-desktop run package` 只会构建 mac 产物。运行的收尾是列出 `dist-app` 里以 `.dmg`、`.zip`、`.exe` 结尾的文件——而 `dist-app` 从不清空,于是上一个版本的 Windows 安装程序也在那张列表里,带着上一个版本的名字,顶着 `products in apps/desktop/dist-app` 这个标题。一个没有 Windows 构建的发布,打印出来的形状和完整的发布一模一样。rc.19 就是这么打包出来的。

## Decision

### 打 tag 是发布的一个步骤:上传之前判定,上传之后执行

一次发布会给它所交付的 commit 打 tag:`desktop-v<version>`,其中版本号就是给产物和清单命名的那个 `apps/desktop/package.json` 字段。tag 带注解,消息就是 `--notes` 本来就必填的那份发布说明文件,于是 `git tag -n` 能看到发布了什么。它指向脚本所在仓库的 `HEAD`。

**判定在第一个字节上传之前就做完。**`apps/desktop/scripts/release-tag.ts` 里的 `planReleaseTag` 接收版本号和 git 报告的事实——HEAD、该 tag 在本地和在 `origin` 上分别指向哪个 commit、工作树是否有改动、有没有 `origin`——返回 `create`、`push-existing`、`skip`,或者一条带着待打印文字的拒绝。三种状态会被拒绝:

- **工作树有未提交改动。**`git status --porcelain` 必须为空,不放过任何一类:给一棵带着未提交改动的树打 tag,指的是一份复现不出这次构建的源码。
- **tag 已经存在,而且指向别的 commit**,无论在本地还是在 `origin` 上。挪动它需要强制推送,而它现在指的那次发布是真实存在的。
- **没有 `origin`。**推不出去的 tag 只有一台机器有。

每条拒绝都是一行,并指明怎么修,在脚本读更新源之前抛出。在那个时刻产物还只在本地,纠正的代价是重跑一次;同样的拒绝如果发生在上传之后,那就是一个已经上线、却没有 tag、也没法诚实补上的发布。

**执行发生在发布完全成功之后**——两个清单都从更新源回读到新版本、清理也跑完之后,在 `main` 的最末尾。更早打 tag 会留下一个 `desktop-v<version>`,指着一次从未抵达客户端的发布。`git push origin <tag>` 绝不带 force。已经指向 HEAD 的 tag——`--republish` 修复一次中断上传时会遇到的情况——只推送、不重建,而在 `origin` 已经持有它时推送就是空操作。

**后段的失败会被如实报出来。**日志会写明该版本已经发布、只有打 tag 这一步失败了,打印出确切的 `git tag -a <tag> -F <notes> && git push origin <tag>`(或者在 tag 已建好、失败的是推送时,只打印推送那条),进程以非零码退出。收尾的总结行无论如何都会点出这个 tag。

`--no-tag` 跳过该步骤连同它的前置校验,于是一个打不了 tag 的仓库照样能发布;`--dry-run` 打印它会打什么 tag,不推送任何东西。`apps/desktop/tests/release-tag.spec.ts` 脱离仓库覆盖这套判断的每一个分支。

### 打包运行点名自己的平台,并证明自己产出了它们

`parseCli` 不再推断任何东西。`--mac`、`--win`,或者两者都要;两个都不给就以非零码退出,并点出这三种写法。每个平台大约花十五分钟,这正是要拒绝、而不是默认两个都构建的理由。

构建结束后,`verifyProducts` 算出这个版本为实际请求的那些平台该交付哪些文件,逐个检查存在且非空,打印带体积的通过清单,并在有缺失或为空时带着每一个名字失败。`apps/desktop/scripts/artifact-names.ts` 里的 `expectedArtifacts` 与 `auditArtifacts` 是纯函数,体积由脚本提供。

期望的文件名是 electron-builder 对 `apps/desktop/electron-builder.yml` 所声明 target 的默认命名——因为没有任何 `artifactName` 覆盖它们:mac 两个 target 是 `DSH Desktop-<version>-arm64-mac.zip` 与 `DSH Desktop-<version>-arm64.dmg`,NSIS target 是 `DSH Desktop Setup <version>.exe`,各自还带一个 `.blockmap`——这与 `publish-update.ts` 要求的配对相同,因为缺了 blockmap 的产物会让每个客户端付出一次全量下载。`apps/desktop/tests/artifact-names.spec.ts` 读那份配置,断言 `productName`、各 target 的 arch 列表,以及没有任何 `artifactName` 覆盖,于是一次改名产物的配置改动会挂在测试上,而不是挂在一次发布上。

命名没有被复制成两份:`publish-update.ts` 从 electron-builder 写出的清单里读产物名,`prune-feed.ts` 从一次发布上传的名字里推导模板。两者描述的都是已经存在的文件。`artifact-names.ts` 是唯一一处在构建产出任何东西之前就说出「它该交付什么」的地方。

## Alternatives considered

**在上传之前、前置校验通过时就打 tag。**信息都在那里,但那是错误的动作时机:这里的上传失败得足够频繁,以至于上传器把断点续传当成常规操作。一个抢在发布之前推出去、而发布随后死掉的 tag,指的是一次谁也装不上的发布,而删除一个已推送的 tag 比迟一点补上它要糟糕得多。前置校验已经把打 tag 里便宜的那一半——判定——提前拿到了,只把动作留到最后。

**把打 tag 失败当作发布失败。**考虑过,而退出码说的正是这个:进程以非零码退出,任何调用方都会看到失败。它绝不能说的是「这次发布失败了」,因为产物已经上线并在被下发。为了「修一下 tag」而重跑发布,会重传约 600 MB,并且在 `--republish` 下覆写一份已上线清单正为其背书的产物。所以日志明确说出这种一半一半的状态,并把收尾的两条命令交出来。

**让 `--no-tag` 成为默认,打 tag 反而要加参数。**那就是现状再加几个步骤:需要主动加的步骤正是会被忘掉的那个,这也正是六个手工 tag 的来历。这个参数是留给真的打不了 tag 的场合——游离的 checkout、没有 `origin` 的仓库——并在命令行上把这个意图说出来。

**两个参数都不给时默认构建两个平台。**那样一次不带参数的调用就会在别人的笔记本上启动半小时的构建,而从 macOS 交叉构建 Windows 安装程序是一个带着自己一套验证姿态的、有意为之的动作,不该被误触启动。立刻退出的代价,不过是把命令带上它漏掉的那个参数再跑一遍。

**保留按主机推断,只把那张列表修好。**列表只是错的一半。推断在命令行上看不见,在两个平台之间还不对称,产出的构建对主机平台是完整的、对另一个平台悄悄是缺的——正是 rc.19 交付出去的那个状态。一张正确的列表会把它报出来,但那次运行仍然是从一开始就起错了。

**拿 electron-builder 写出的清单来核对产物集合。**`latest.yml` 与 `latest-mac.yml` 就落在产物旁边的 `dist-app` 里,还带着确切的文件名,看上去是一份免费的事实来源。它们同样是上一次运行留下的:一个没有执行的平台构建会让上一次的清单原样留在那里,于是这道检查会从它本该发现其缺失的那份产出里读取自己的期望。期望必须独立于这次运行产出了什么。

**在运行时从 `electron-builder.yml` 读 `productName` 和各 target 的 arch**,而不是把它们作为常量、由测试钉住。名字仍然不能只由那份配置推出来——electron-builder 默认的 `artifactName` 模板并不在里面——所以运行时读取只会给一个纯函数添上 YAML 解析和文件 IO,而模板照样是写死的。改由测试去读那份配置,于是一次配置改动会在 `pnpm run test` 时挂掉,而不是在一次发布构建跑了十五分钟之后。

## Consequences

从 rc.20 起,每一个桌面发布都由交付它的那次发布打上 tag,tag 消息就是发布说明;rc.14 到 rc.19 保留当初手工打的那些 tag。

发布现在依赖 git,也依赖能连上 `origin`:前置校验会跑 `git ls-remote`,于是一台连不上远端的机器会在前置校验处失败,而不是在最后失败。`--no-tag` 是通过的方式。发布现在还要求工作树是干净的,这对「带着一处改动就顺手发布」的习惯是一条实打实的约束。

`pnpm --filter @deepseek-ai/dsh-desktop run package` 不带参数现在会失败,而不是构建主机平台。每一次调用都点名自己的平台。

`apps/desktop/tests/release-tag.spec.ts` 钉住各条拒绝(脏工作树、本地 tag 指向别处、`origin` 上的 tag 指向别处、没有 `origin`)、两种成功动作、`--no-tag` 的跳过,以及多个条件同时成立时的优先次序。`apps/desktop/tests/artifact-names.spec.ts` 钉住各平台的名字集合(对着 `electron-builder.yml`)以及审计的通过、缺失、为空三组。git 命令本身没有测试——`git tag -a`、`git push origin <tag>`,以及喂给判定的那四条只读查询——理由和清理步骤的 `rm` 没有测试相同:它们每次发布只对着一个真实仓库跑一次,证据就是那次发布。发布这条路径没有任何测试装置,能让一个假的 origin 证明出比那些判定测试更多的东西。
