# Agent Note: 投影用工具自己的解析器读调用

Status: implemented

[English](2026-09-03-content-access-projection-parses-with-the-tool.md) | 中文

## Problem

`content_act` 那个 web 场景连录四次、四次都以同一种方式失败，会话日志把全过程留了下来。模型发出的是 `{"action":"click","ref":"e7","label":"","mark":"{class: el-icon-delete}"}`；wire 收了，审批请求照它组出来了，用户也批了——而工具答的是 `Error: [ … {"code":"unrecognized_keys","keys":["mark"],"path":["args","steps",2]} … ]`。

三个缺陷在这里相遇。

**投影把步骤又声明了一遍。** `requests-projection.ts` 在 wire 的 `readActStep` 之外，自带一份 zod 版的步骤读法——`{ ref, label }` 加 `.strict()`——而 wire 那边已经有了 `mark`。同一个调用的两份读法，只要有一边加字段就会分叉，而且是悄悄分叉：工具收了这次调用，折叠也收了，然后投影拒掉了自己刚刚造出来的那个值。注册表在发布之前会解析每一份视图，于是这次拒绝以工具结果的形式到了模型手里。

**交到模型手上的是校验器的 issue 列表。** 对着一个工具自己 schema 里写着的字段说 `unrecognized_keys`，读起来像是「有个参数要改」，而根本没有什么可改：调用是对的，是宿主拒了自己。

**`mark` 没有例子，于是它的形式全靠猜。** 清单打的是 `e7 clickable {class: el-icon-delete}`；描述里写的是「原样照读取印在 `{class: ...}` 里的那串 class token」，模型就把整行连花括号带 `class:` 抄了三次，还试过一次把它当 label。审批文案于是变成 点标为「class: {class: el-icon-delete}」的无名控件。

## Decision

**一个解析器就是 schema。** `parsedBy(read)` 把「本来就在读这次调用参数」的那个函数变成投影用来校验并发布的 schema，两个工具都是：读取走 `readArgs`，步骤走 wire 的 `parseActArgs`。没有第二份声明，也就无从分叉。

**这个单元拒绝的视图，对外是一句话，对内是一条日志。** 发布之前它先检查自己要发布的那个值，把 issues 经由构造时传入的 logger 记下来，然后抛出 `UNPUBLISHABLE_CALL_REFUSAL`：什么都没跑、这次调用可以重发、缺陷在宿主这边。

**标记只有一种写法，凡是提到它的地方都给出来。** `MARK_EXAMPLE`——「读取打出 e7 clickable {class: el-icon-delete} 时，传 ref "e7"、label ""、mark "el-icon-delete"——只要 token 本身，不带花括号，也不带印在它前面的 "class:"」——既是参数描述，也是关于它的两条拒绝语。wire 拒掉带花括号、或以 `class:` 开头的标记：这两样是清单包在 token 外面的东西，出现即说明整行被原样抄了进来。页面确实可以往 class 属性里放花括号——只是没有哪个画页面的东西这么写；真出现了，那一行会带着例子被拒，而不是一个来回之后再去座位那道核对上失败。

## Alternatives considered

**给投影的 schema 加上 `mark`，到此为止。** 这修得了这一次调用，机制原样留着：下一次给步骤加字段照样在审批之后炸，而且炸在一次「从工具自己的测试里根本解释不了」的录制里。

**保留手写 schema，再加一个测试去比对两份读法。** 一个必须把字段逐个列出来的测试，就是第三份声明。

**收下印出来的那种形式，再把外壳剥掉。** 收下 `{class: el-icon-delete}` 等于教会两种写法，还会让座位去比对一串读取从来没有印过的东西。带着例子的拒绝只花一个来回，教的是一种写法。

## Consequences

- 投影现在收的东西与工具收的东西完全一致。`args` 里的未知键由解析器丢弃，而不是拒掉整份视图——对一个宿主自己造出来的值，这才是更好的失败方式；包在外面的信封（`callId`、`tool`、`args`）仍然是严格的。
- 从持久化缓存恢复的检查点同样走这几个 schema，于是存下来的调用也由工具的解析器来读。
- `contentAccessProjection` 现在要一个 logger。这是这个单元唯一的依赖，它存在的理由是：模型看到的那一句话背后的 issues 必须还能捞回来。
- 被拒绝的视图仍然在注册表提交事件的地方抛出，于是这次调用照样失败。变的是模型被告知的内容。

## Testing

`tests/content-read-projection.client.spec.ts` 折叠一条按标记点名的步骤，并把它经 wire schema 读回来；另有一条驱动「这个单元拒绝的视图」——一句话给调用方、issues 给 logger。`tests/content-read-wire.client.spec.ts` 拒掉三种印出来的形式（`{class: …}`、`class: …`、尾部一个花括号）；`tests/content-act-tool.client.spec.ts` 逐字钉住模型为每一种读到的整句，工具 schema 也在内。
