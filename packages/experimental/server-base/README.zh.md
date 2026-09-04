# @deepseek-ai/dsh-experimental-server-base

[English](README.md) | 中文

告诉浏览器：这个 dsh 进程被挂在哪个路径前缀下。进程自己无从知道这件事——web 服务器不读任何转发前缀头，它拥有的每一条路由（`/api`、`/plugins`、外壳静态产物、各插件自己的路径）都以根绝对形式注册。因此，把外壳发布在 `/console/` 下的反向代理必须在请求抵达之前把前缀剥掉；而回给浏览器的，又是一个会重新从 origin 根去寻址上述全部路由的页面。本包补上浏览器这一半。

它为一种拿不到独立域名的部署而存在：一个域名后面并列着若干产品，dsh 是其中之一，彼此靠路径区分。挂在 origin 根的进程不需要这一行。

## 它注入什么

在 `webserver/index-inject` 上注入两行，两行携带的都是配置里的 `basePath`，别无其他：

- `{ kind: 'html', placement: 'head', html: '<base href="/console/">' }`——HTML 解析器会把它之后的每一个相对 URL 都按这个值解析：外壳构建产物自己的资源引用，以及客户端模块系统贡献的那几个阻塞解析的插件 bundle 标签。
- `{ kind: 'global', name: '__DSH_BASE__', value: '/console/' }`——运行时代码构造 fetch、WebSocket 或 EventSource 的 URL 时读的就是它。它是 head 里的一个 `<script>`，所以在任何文档脚本运行之前就已赋值；在根本没有 document 的载体里，它同样有确定的值。

两行缺一不可。`<base>` 够得着进程并不生成的那部分标记，却够不着运行时才拼出来的 URL；全局量够得着运行时代码，却够不着解析器早已处理完的标签。

监听器以 `prepend` 注册，这正是把 `<base>` 行排在渲染后 head 首位的手段。`<base>` 只管辖它之后的 URL，head 行按表内顺序渲染，而插件激活顺序无人保证——若某个更早运行的监听器贡献了一行，那一行就会按文档 URL 解析，而页面其余部分按前缀解析。

要让 `<base>` 有东西可管辖，外壳自身的资源引用必须是相对的：`apps/web/vite.config.ts` 设了 `base: './'`，这才使构建出的 `index.html` 引用 `./assets/…` 而不是 `/assets/…`。若改设 `base: '/console/'`，前缀会被烙进产物，一份构建就只能服务一个部署。

## 配置

`basePath` 是**浏览器**寻址时看到的那个路径，首尾斜杠都要带——挂在 `location /console/` 后面就是 `/console/`，挂在 origin 根就是 `/`。它不是服务端的路由前缀。

任何不可用的写法都在加载期失败，否则症状只会是一个白页加每个资源一条 404，而没有任何一句话说明哪里错了：不以 `/` 开头的值、不以 `/` 结尾的值、带查询串或带片段的值、含空路径段（`//`）的值，以及含普通 URL 路径之外字符的值。最后那条检查同时也是让该值可以不经转义直接放进元素带引号属性的依据——`"`、`<`、`>`、`&` 都在被接受的字符集之外。

## 组合方式

本包不在任何发布 bundle 里。`overlay/base-path.patch.yml` 把这一行插到任意界面之上：

```yaml
- insert:
    - id: server-base
      name: '@deepseek-ai/dsh-experimental-server-base'
      config:
        basePath: /console/
```

用 `dsh --profile web --patch <path>` 应用。每个包都必须能从 profile 目录解析到，对仓外插件而言这意味着 `dsh plugin --profile web add <path>` 或等价的链接——发布 bundle 不得声明实验性包。

## 代理那一半

`deploy/nginx.console.conf` 是配套的反向代理样例：`location /console/` 与 `proxy_pass http://127.0.0.1:3080/`，两处的尾斜杠正是执行剥离的部分；`Host` 原样透传；两条事件套接字所需的 WebSocket 升级头；以及为流式回答关掉的缓冲。它是为一台不含 `ngx_http_rewrite_module`、但编进了 `ngx_http_auth_request_module` 的 nginx 写的，因此不用 `rewrite`、`return`、`if`、`set`，并且只发布带尾斜杠的那种前缀写法：那里没有任何手段能把 `/console` 重定向到 `/console/`，而在不带尾斜杠的地址上服务出去的文档落在 `Path=/console/` 之外——页面正是用这个 path 写镜像 cookie 的，浏览器于是一个 cookie 都不会带回来。所有对外发布的链接都带尾斜杠。

dsh 不认证任何人，所以那份样例同时承担了这套部署唯一的认证：一道 `auth_request` 闸只在 `/console/` location 上声明一次，再在它下面逐个地址取消。于是它默认拒绝——`/console/api` 连同两条事件套接字、任何被组合进来的插件所注册的路由、以及内容应用，全都无需被点名就已被拦住；而只把闸挂在入口上，会把 RPC 上行敞着。样例真正放开的是启动引导，而且非放不可：一次导航所能携带的凭据，就是 auth-gate 把 token 镜像进去的那枚 cookie，而写出这枚 cookie 的只有控制台自己的页面。若把文档也一并拦住，这道闸与它唯一的凭据就互为前提：一个 cookie 罐为空的访客——第一次访问、换了浏览器、清了站点数据，或者刚被退出按钮清掉这枚 cookie——会恰好在那张本可以写出它的页面上被拒之门外，此后再无回路。因此，外壳文档、它引用的那几个文件、客户端插件 bundle，以及闸自己的 `/auth-gate/settings` 文档，对任何人都照常服务。这样公开出去的是构建产物，外加关于这套部署的两项事实——外壳文档携带的已组合插件清单与已存的主题偏好，以及那份设置文档里的三个配置值——不含任何对话、会话或工作区内容。页内那道闸（它要去的登录页本身也必须留在这道闸之外可达）只按形状与过期判断：存着的值只要不是一枚 `exp` 仍在未来的 JWT，就把访客送去登录页，此外再没有别的会触发它。证明这一半成立的检查，在这份清单变动时重跑：cookie 罐为空时，`GET /console/` 答 200 与外壳文档，而 `GET /console/api/anything` 答 401 与那张固定页。

nginx 不持任何签名密钥，也不校验 token：它把调用方的凭据递给部署方自己的认证服务，只读状态码——200 放行，401 与 403 都是拒绝，于是过期、轮换、吊销都留在签发 token 的那一方。凭据在外围产品的页面发来 `Authorization` 头时取自该头，否则取自那枚镜像 cookie——每一个资源、每个 iframe、两次 WebSocket 握手都带不了头，正是靠它覆盖。样例里的 cookie 名必须与那条 auth-gate 行的 `cookieName` 写法一致；写成别的就读到空 cookie，把控制台对所有人关上。回答按 token 缓存 30 秒，这也是一枚被吊销的 token 最长还能用多久，而缓存文件的键把那枚 token 写在了磁盘上；这些回答上的 `Set-Cookie` 与 `Vary` 被忽略，否则一个顺手给自己 cookie 续期的会话端点，会让每一条缓存条目都存不下来，把这道闸降级成每个控制台请求一次上游调用。被拒时服务的是部署方提供的一张固定页，而不是跳转：那里没有任何手段能跳转，而 `/api` 与 WebSocket 请求要的本来就是一个状态码，不是一份登录文档。递出这个问题的那一跳是经过校验的 TLS——它是整套部署唯一的认证判定，所以样例对它开了 `proxy_ssl_verify` 并指定了信任库；另一种受支持的形态是认证服务在私网上以明文 http 提供。既不是 200、也不是 401 或 403 的回答，以及压根连不上的认证服务，都会变成 500，由第二张固定页作答：说的是「服务暂时不可用」，而不是「请重新登录」。

这份样例只是部署的一半。`Host` 原样透传，正是为了让 `/api` 浏览器信任栅栏及其背后的 Origin 比对有东西可读；而该栅栏会拒绝任何既非回环、又未被声明的 Host——所以进程侧还必须在 `client-connection` 的 `trustedHosts` 里带上对外域名，与 `basePath` 声明在同一层 overlay 里。少了它，**进程**会对每一个 `/api` 请求答 403，而页面本身照常加载，且这次拒绝与 nginx 无关。

前缀没有剥干净同样不会表现为一个干净的 404：未剥净的路径会走出静态产物根目录，被路径穿越检查以 403 拒绝——那是与栅栏不同的另一种拒绝，同样不是权限问题。

不需要 `sub_filter`。前缀是在进程内部由一个校验过的值作为数据注入浏览器的，只有一个真相来源，nginx 无需改写任何东西；何况字节过滤器根本够不着真正要紧的那些 URL，因为运行时代码是用一些从不完整出现在响应里的字符串拼出它们的。

## Model Experience

None, as this package registers no tool, prompt section, or result: it contributes two rows to the HTML a browser is served, which is decided and rendered outside any model request.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated.

## Known Limitations and Deferred Work

- **`<base>` 会改变页内裸片段链接的解析。** 文档里有 `<base href="/console/">` 之后，`href="#section"` 解析成 `/console/#section`，而不是当前 URL 加上该片段，于是带裸片段链接的页面会发生导航而不是滚动。外壳自身的标记已核对过，但任何贡献了裸 `href="#…"` 的插件都会继承这一变化，必须把路径写全。
- **按 origin 隔离的浏览器存储会在多个前缀之间共享。** `localStorage` 与 `CacheStorage` 按 origin 隔离，从不按路径隔离，所以同一主机名下 `/a/` 与 `/b/` 两个部署会共享外壳的工作区视图、会话草稿以及页面镜像的任何 token，并互相覆盖。本包无从分开它们；需要分开的部署需要的是一个部署一个主机名。
- **前缀下不支持 PWA。** service worker 的作用域由脚本 URL 决定，现有的注册路径与缓存键都是按 origin 根写的，静态 `manifest.webmanifest` 的身份也是相对 origin 而非相对前缀解析的。server 线的 profile 必须不挂 `apps/pwa`；在前缀下组合它会装上一个声称管辖范围超出本部署所有权的 worker。
- **前缀只存在于浏览器侧。** 没有任何东西教给进程它自己的前缀：路由保持根绝对，代理必须剥离。剥不掉前缀的部署——代理必须原样转发前缀——需要让路由表、RPC 端点解析、api-proxy 的路径匹配器与特权方法栅栏一起认识前缀，那是另一项改动。
- **闸并不覆盖外壳自身。** 外壳文档、它引用的那几个文件、客户端插件 bundle 以及 `/auth-gate/settings`，对任何人的请求都照常服务：一次导航所能携带的唯一凭据，正是页内那道闸写出来的，把它们也拦住，就等于让一个 cookie 罐为空的访客无路可进。这样公开出去的是构建产物加三个配置值，而控制台会在访客身份确定之前就先画出来——那段窗口记在 auth-gate 自己的「已知限制」里。若某个部署不能把外壳交给匿名请求，它需要的是一道能自己签发凭据的闸，那是另一套登录方案。
- **一枚被拒但尚未过期的 token 会把访客困住。** 页内那道闸只按形状与过期判断——把访客送去登录页的，是「存着的值不是一枚 `exp` 仍在未来的 JWT」——所以一枚仍未过期、却被认证服务拒绝的 token（被吊销、密钥已轮换、账号已停用），在它看来是可用的，在站点闸那里却是拒绝。这样的访客照样拿到启动引导，控制台照样画出来，而它背后每一个被拦的请求都失败：导航到开放清单之外的地址会落到那张固定页，页面自己的调用则会一直失败，直到那枚 token 自己过期，或者访客按下退出。让页面在自己的调用被答 401 时去登录页，是缺掉的那一半，记在 [auth-gate](../auth-gate/README.zh.md) 的「已知限制」里。
- **退出不一定够得着进程。** auth-gate 的顺序是先 POST `/auth-gate/logout`，好让 node 半边不再花一枚访客已经没有的凭据，而这个请求带的正是这道闸如今要校验、而不只是拿来路由的那枚镜像 cookie。在交还的那枚 token 恰好被这道闸拒绝的路径上，nginx 会对这个 POST 答 401，进程于是继续攥着那枚死 token，直到进程结束或有更新的一枚被投递进来。访客本人照样能走掉，因为后面几步无论前一步结果如何都会执行。
- **离开页面的 URL 不在覆盖范围内。** `<base>` 与 `__DSH_BASE__` 管辖的是页面自己解析的 URL；交给别处的东西——由浏览器下载管理器抓取的下载、被复制到另一个标签页的地址——必须本来就是绝对的。那些调用点自己构造绝对 URL，本包不检查它们。
- **没有装配级快照覆盖**——证据是本包针对已服务 index 的真实组合测试；快照泳道回放的是发布组合，而发布组合不包含实验性行。
