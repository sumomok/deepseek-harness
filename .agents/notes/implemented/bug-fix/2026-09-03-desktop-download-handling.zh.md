# Agent Note: 由壳来安置所服务 UI 的下载,而不是弹窗去问

Status: implemented

[English](2026-09-03-desktop-download-handling.md) | 中文

## Problem

用户报告桌面客户端「导出日志无法导出成功」。

[`dsh-session-log-export`](../../../../packages/session-query/session-log-export/README.zh.md) 通过 `GET /api/session.export?sessionId=…` 把整棵会话树导出成 ZIP,响应带 `Content-Disposition: attachment`。它的浏览器那一半先用 `HEAD` 预检,再把 GET URL 交给一个游离的 `<a download>`,随即报出「Session 导出已开始下载」——交接之后的一切都是浏览器下载管理器的活儿,这个分界正是该包 README 明写的:GET 被接受之后的子会话或附件读取失败由下载管理器报告,而不是由对话框报告。

桌面窗口是一张浏览器面,背后并没有下载管理器。[`apps/desktop/src/main.ts`](../../../../apps/desktop/src/main.ts) 在应用窗口上注册了 `setWindowOpenHandler` 与 `will-navigate`,此外别无他物;壳里仅有的两个 `will-download` 处理器分别属于隐藏渲染窗口和登录窗口,各自挂在自己的临时 partition 上,都覆盖不到应用窗口所在的默认 session。于是 Electron 的默认流程接管了:一张模态「存储为」面板,压在一个早已宣布下载开始的页面上,点名一个用户没要求命名的文件,对它从哪儿来只字不提。把面板划掉,这次导出就无声地没了,页面上却仍是成功的样子;而传输中途失败更是无处可报——那正是上游 README 交给一个在这里并不存在的下载管理器的角色。

## Decision

壳只安置自己服务出去的东西,别的一概不碰。

**已被[导出会话日志时先问存到哪里](2026-09-04-desktop-download-save-dialog.zh.md)部分取代。**仍然现行的:整条重定向链上的同源判定、`uniquePath` 的编号、`NSDownloadsFolderUsageDescription` 这个键,以及文末记下的两条上游缺陷。在那份 Note 里被替换掉的:被接管的下载改为弹一个保存对话框、不再静默写盘,于是 `decideDownload` 给出 `{ kind: 'ask', dialog }`,在途 `claimed` 集合与 `no-free-name` 结局随静默写盘一起消失,`announceDownload` 也随那条播报结果的通知一起消失。下面各段会说明它们各自现在的状态。

[`apps/desktop/src/download-policy.ts`](../../../../apps/desktop/src/download-policy.ts) 把整个判定装成一个纯函数。`decideDownload` 读 `DownloadItem.getURLChain()`,回答壳接不接管这次下载——当时是 `{ kind: 'save', path }`,现在是 `{ kind: 'ask', dialog }`——还是把它留给 Electron。这条链上的每一跳都必须属于内嵌服务器的 origin——也就是 `ServerHandle.url`,它本身就是一个纯 origin——因为传输最终停在哪个 URL,说明不了它从哪里起手:从别的站点起手再重定向进服务器的下载,不归这个壳安置;从服务器起手再重定向出去的,也已经不是服务器的文件了。空链同样算作未被服务。

每一跳的 origin 从解析后的 URL 读、而不是去测 scheme,正是这条策略能扛住导出功能自身演进的原因:`blob:` URL 解析出来的是铸造它的那个页面的 origin,所以一个页面自己带进度条 fetch 完再把结果交给 `<a download>`,就是在从自己这里下载,与直连 `/api` URL 同等对待。`data:`、`about:`、`file:` 以及不透明的 `blob:` 都解析成 origin `null`,任何服务器 origin 都不可能与之相等,因此永远不会被接管。

存盘用的文件名是下载自己建议的那个名字取最后一段路径,拼到 `app.getPath('downloads')` 上,再由 `uniquePath` 去重:在最后一个点后缀之前插入 ` (2)`、` (3)` ……,于是 `session.tar.gz` 编号成 `session.tar (2).gz`,`.zshrc` 成 `.zshrc (2)`。当时一个名字被占用,指的是它已在磁盘上,**或者**本进程已经把它交给了一次尚未结束的传输——也就是壳传进来的 `claimed` 集合;导出的文件名由会话 id 推导而来,所以对同一个会话点两次会建议出同一个名字,而在第一次传输写下第一个字节之前,磁盘上并没有这个文件。这个搜索是有界的;万一某个目录把所有候选名都占满了,它给出 `{ kind: 'default', reason: 'no-free-name' }` 而不是一个已经是文件的路径——比弹面板更糟的只有覆盖。这两道保险都属于静默写盘,随它一起退场;取代它们的东西见那份接续的 Note。Chromium 在壳看到之前就已经把 `DownloadItem.getFilename()` 清洗过了;策略仍然再次剥掉路径分隔符与光秃秃的 `.`/`..` 段,因为它是「建议的名字」与「写下的路径」之间唯一的一步,必须自己读起来就站得住。

`main.ts` 把这个判定接进 `createBootWindow`。`attachDownloadHandling` 在 `window.webContents.session` 上注册 `will-download`——应用窗口没声明 partition,所以那就是默认 session——回答一次被接管的下载——当时是设置存盘路径并把它加入认领,现在是设置对话框选项——在 `default` 判定上原封不动地返回,于是 Electron 的面板留在它原来的位置。因为别的 origin 而走 `default` 是家常便饭,不说话;当时为 `no-free-name` 写的那行日志随那个结局一起消失。监听器在窗口的 `closed` 事件里摘除:session 活得比窗口长,而 macOS 每次走一趟 Dock 都会销毁并重建窗口,留下的监听器会一趟攒一个。`done` 时先释放认领,再由 `reportDownload` 往 `dsh-server.log` 的 sink 写一行——`[desktop] download saved: <path>`,或 `[desktop] download cancelled|interrupted: <path>`——并把结果播报出去。

当时播报走 [`apps/desktop/src/notifications.ts`](../../../../apps/desktop/src/notifications.ts) 里新增的第二个入口,它与下面这套理由一起被接续的 Note 删掉了。`announceDownload` 与该模块既有的 `announce` 有两处不同,恰是一次下载所需要的:它在 macOS 上也投递,因为 Dock 角标既带不出文件名也给不出通往文件的路;它不管窗口有没有人看着都投递,因为页面只说了下载开始,文件去了哪里不在这里说就没地方说。点击一条完成通知会对存盘路径调用 `shell.showItemInFolder`。只有中断那条会给出补救——「传输中断,请重新导出」——因为用户自己取消的传输不需要任何指示。注意力事件那套「角标 + 弹跳」的分野原样不动。

[`apps/desktop/electron-builder.yml`](../../../../apps/desktop/electron-builder.yml) 新增一段 `mac.extendInfo`,写入中文的 `NSDownloadsFolderUsageDescription`,与应用其余面向用户的文案一致。macOS 把 `~/Downloads` 拦在 TCC 后面,首次往那里写会拉起系统自己的授权弹窗;没有这个键,弹窗说不出任何理由。这也是该文件里第一条 Info.plist 字符串——这个应用并不声明摄像头或麦克风用途——所以这一段是新增而非扩充。

## Testing

[`apps/desktop/tests/download-policy.spec.ts`](../../../../apps/desktop/tests/download-policy.spec.ts) 覆盖判定本身:同源 `/api` URL 与同源 `blob:` URL 都被接管;换端口、换主机、换 scheme、跨源 `blob:`,以及 `data:`/`about:`/`file:`/不透明 `blob:` 一律留给 Electron;从别处进入服务器的链与离开服务器的链都被拒绝,而服务器内部的两跳链被接管,空链亦被拒绝;建议的文件名被削到最后一段,只剩路径语法时回落到 `download`;去重器从 2 开始数,跨过磁盘上已有的名字。针对 `claimed` 集合与 `no-free-name` 的那几条用例随这两个结局一起退场。

[`apps/desktop/tests/notifications.spec.ts`](../../../../apps/desktop/tests/notifications.spec.ts) 当时用一个替身 `electron` 覆盖 `announceDownload`,因为它承载的那个承诺——点一下就定位到存下的文件——是一个任何日志行都显示不出来的回调:完成通知注册的 click 会带着存盘路径调用 `shell.showItemInFolder`,失败通知根本不注册 click,而一个自称不支持通知的平台上一条也不会被构造出来。这三条用例连同那个替身随函数一起退场。

Electron 那一半——处理器究竟落在哪个 session 上,以及面板是否真的不见了——单元测试够不着,改由真进程检查覆盖:把构建好的壳跑在 Electron 43 上、对着一个临时 `$DSH_HOME`,点会话头部的「Session 日志」按钮,再读产出的文件与日志行。

## Alternatives considered

**保留面板,改写页面上的那句提示。**在一个没有下载管理器的壳里,「接下来交给浏览器」这句话的诚实版本是换个说法,但那句文案属于一个无从知道自己跑在壳里的上游包。要在那边改,就得发明一个壳→页面的标记——注入的全局变量、请求头,或者一个服务出去的能力位——好让浏览器那一半渲染第二套措辞。那是为了更差的结果新增一条跨边界契约:用户照样吃一张没人要的模态面板,传输中途失败照样无处可报。

**不看 origin,所有下载一律接管。**一个处理器管全部确实更简单,还能整个去掉 origin 比对;但窗口能到达它页面链接到的任何 origin,把来自任意站点的文件不问一声就静默写进下载文件夹,这个决定这个壳没资格做。把接管限制在壳自己启动的那个服务器上,新行为就仍然落在壳本来就拥有的范围里。

**把判定直接写在 `will-download` 处理器里。**处理器里本来就有 `item` 和 `app`,分支也不长。写在里面会让 origin 比对、文件名清洗与去重器只能通过一个真实 Electron session 才够得着——而那恰恰是必须拿 `blob:`、`data:` 和碰名场景去练的代码,这些场景真进程检查一个也穷举不了。

**播报复用 `announce`。**它已经存在,也已经在记日志。它同样会在窗口有焦点时压掉自己,而那正是点击导出的时刻;并且它在 macOS 上只投一个没有文字的 Dock 角标——于是文件名与去向,这条消息仅有的内容,永远不会被显示出来。

**问一次,然后记住一个下载目录。**记住的目录意味着要存的状态、要暴露的设置面,以及它搬家时的迁移。系统下载文件夹本来就是浏览器会把文件放进去的地方,而那正是页面自己的措辞所承诺的行为。

## Consequences

用户当时失去了选位置的机会:来自内嵌服务器的下载落在系统下载文件夹里,壳这边无法改道,文件只能事后再挪。换来的是上游那句提示第一次在桌面端为真——「Session 导出已开始下载」之后跟着的是一次真的能完成的下载。两个平台行为一致,同一个文件夹、同一套编号,这与同一模块里对注意力事件刻意做的平台分野是相反的取向。选位置这件事在接续的 Note 里回来了;那条播报结果的通知没有,因为它在报告问题的用户机器上什么都不投递。

macOS 的授权弹窗是否会带着这段新描述出现,并未在签名构建上验证过;键已声明,而真进程检查跑的是未签名的开发壳,它的 TCC 身份并不是打包应用的身份。只有打包构建才能确认这一点。

诊断过程中发现的两条事实记录在此,不在本次修复范围内。报告用户的存储里仍有三个会话导出时返回 HTTP 500:它们带着一个由旧版 `@haoran/dsh-llm-permission-gateway` 写入的自定义事件 `permissionRules/decision`,当时没有标 `ignorable: true`,于是日志加载直接以 `SessionFormatUnsupportedError` 拒绝,ZIP 根本没开始。这正是本 fork 自己那条插件审计规则——第三方插件的自定义会话事件必须 `ignorable: true`,否则卸载后会把会话日志砸死——落到了真实用户身上,该由那个插件修,不是壳。另一条是上游的归档把媒体条目命名为 `media/sha256:<hex>.<ext>`;冒号在 ZIP 条目名里合法,在 Windows 文件名里非法,于是 Windows 的解压工具要么拒绝这些条目,要么把它们改名。两者都是上游或插件的缺陷,壳的下载处理既不制造也不掩盖它们。
