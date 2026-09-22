# Bilibili 线程撕裂者 · 移动端（Shadowrocket）

给 **B 站官方 iOS App** 加速的 Shadowrocket 脚本。它把 App 的每个视频分片请求拆成多块，向多个 CDN 节点并发下载，校验后按原顺序拼好交还播放器。思路、CDN 节点列表和校验规则全部来自 MrTangLuyao 的浏览器扩展 [Bilibili 线程撕裂者](https://github.com/MrTangLuyao/Bilibili-thread-ripper)（MIT），本仓库是它面向手机 App 的移植。

> 状态：**待真机验证**。脚本逻辑在本地用假 CDN 做了完整的自动化测试（见[开发与测试](#开发与测试)），但 Shadowrocket 脚本引擎处理二进制响应的真实行为、B 站 App 分片请求的实际大小，都要在真机上确认。脚本对这两点都做了自动退化：环境不支持时改为只换 CDN 节点，分片太大时也只换节点，绝不会让视频放不出来。

## 目录

- [它怎么工作](#它怎么工作)
- [安装](#安装)
- [设置页](#设置页)
- [怎么确认它在工作](#怎么确认它在工作)
- [已知限制](#已知限制)
- [排错](#排错)
- [开发与测试](#开发与测试)
- [与浏览器版的关系](#与浏览器版的关系)
- [许可与致谢](#许可与致谢)

## 它怎么工作

B 站 App 拿播放清单走的是 gRPC，而**真正下载视频分片的请求是明文 HTTP**，落在 `upos-*.akamaized.net`、`upos-*.bilivideo.com` 这类 CDN 上。这一点是 [BiliFastCDN](https://github.com/MinamiHashiRun0/BiliFastCDN) 的作者用真机抓包证实的。明文意味着 Shadowrocket 不用解密 HTTPS、不用装证书，就能在请求发出前把它接住。

```text
B 站 App 播放器
        ↓  GET http://upos-hz-mirrorakam.akamaized.net/upgcxcode/….m4s   Range: bytes=a-b
Shadowrocket 脚本
        ↓  把 [a, b] 切成 N 块
   ↙       ↓       ↓       ↘
mirrorali  mirrorhw  mirrorcos  …   （每块一个子请求，带上 App 原本的 User-Agent）
   ↘       ↓       ↓       ↙
每块检查 206、Content-Range、长度，不对就换节点重试
        ↓  拼成一个 206 响应
B 站 App 播放器（它以为只发了一次请求）
```

和浏览器版一样，每块的字节位置、长度和文件总大小都要对得上才会被接受；任何一块最终失败，整个请求**原样交回**给 App 自己去下，不改地址也不改头。

脚本是无状态的：每个分片请求都是一次独立的运行。节点速度、退避、统计和设置都通过 Shadowrocket 的持久存储跨运行保存。节点选择规则移植自上游：热身阶段把块撒到所有节点一次测速，之后按速度排序，快的多分，再带一个没测过的节点探路；失败的节点按 3、6、12、24、48 秒退避。一块迟迟不回来时（超过按最快节点估算时间的 1.5 倍），会再向另一个节点要一份副本，先到先用，这样一个卡住的节点拖不慢整段；输掉的副本在后台跑完，结果只用来更新节点速度。

### 调参

真机上 App 每次要 1 MiB，播放器等这 1 MiB 的耐心大约只有三秒，超过就会重发同一段请求，脚本就得再拆一次，白费流量。所以目标是让每个 1 MiB 在一秒左右回来：

- **线程 8、每块 128 KiB** 是默认值，1 MiB 正好 8 块。单个节点到你这里的速度只有一两百 KB/s 时，可以试 **线程 12、每块 64 KiB**，块更小、并发更多。线程超过 10 时不再开副本，因为脚本环境一次最多约 20 个并发请求。
- 日志里 `accelerated/ok video … 800ms {…} 副本 1` 的耗时就是这 1 MiB 的总时间，后面是各节点拿到的块数和开过的副本数。持续超过三秒说明所有节点到你这里都慢，多线程也救不了，换 CDN 模式试试。
- 第一次播放会慢一两秒：节点还没测速，块撒到所有节点上热身。

## 安装

需要 iOS 上的 [Shadowrocket](https://apps.apple.com/us/app/shadowrocket/id932747118)，版本不低于 2.1.62（从这个版本起可以直接运行 Surge 格式脚本）。有两种装法，选一种。

### 方式一：整份配置文件（不用代理、不想折腾的选这个）

一份现成的 Shadowrocket 配置，不含任何代理节点，所有流量直连，只加载线程撕裂者脚本。

1. 在 iPhone 上点这个链接直接导入：`shadowrocket://config/add/https://raw.githubusercontent.com/vic233333/Bilibili-thread-ripper-mobile/main/shadowrocket/bilibili-thread-ripper.conf`

   或者手动：Shadowrocket → 配置 → 右上角 **＋** → 粘贴下面的地址 → 下载：

   ```text
   https://raw.githubusercontent.com/vic233333/Bilibili-thread-ripper-mobile/main/shadowrocket/bilibili-thread-ripper.conf
   ```

2. 配置列表里点它 → **使用配置**。
3. 首页 → 全局路由 保持 **配置**（这份配置的规则本来就是全部直连）。如果连接开关因为没有节点打不开，随便添加一个占位节点，比如 SOCKS5 `127.0.0.1:1080`，它不会被用到。
4. 打开连接开关，播放一个 B 站视频，再在 Safari 打开 `http://btr.settings/` 看「最近请求」。

更新：配置 → 点这个文件 → 更新，它会按文件里的 `update-url` 重新下载。需要 https 版本时用 `bilibili-thread-ripper-https.conf`，见[下文](#可选也处理-https-的分片)。

### 方式二：模块（已经有自己的配置或订阅的选这个）

1. Shadowrocket → 配置 → 模块 → 右上角 **＋** → 填入模块地址 → 下载：

   ```text
   https://raw.githubusercontent.com/vic233333/Bilibili-thread-ripper-mobile/main/shadowrocket/bilibili-thread-ripper.sgmodule
   ```

2. 回到配置，确认模块已勾选启用。
3. 确认 Shadowrocket 已连接，并且 B 站 App 的流量经过它。分流策略无所谓，`DIRECT` 也可以：脚本只要求请求经过 Shadowrocket，不要求走代理。
4. 打开 B 站 App 播放一个视频，然后在 Safari 打开 `http://btr.settings/`，「最近请求」里应该开始出现记录。

不需要开启 HTTPS 解密，也不需要安装证书。模块里没有 `[MITM]` 段。

### 没有代理节点、不想用订阅配置也能用

Shadowrocket 总是带着一个配置运行，但不必是任何订阅：它内置了 `default.conf`，模块直接挂在当前配置上，配置 → 模块 里勾选即可。这个模块只有 `[Script]` 和 `[Host]`，没有分流规则，所以全局路由设成什么都能生效。

- **不用代理**：首页「全局路由」选 **直连**，然后打开连接开关。所有流量直连，但仍经过 Shadowrocket，脚本照常工作。如果开关因为没有节点而打不开，随便添加一个占位节点（比如 SOCKS5 `127.0.0.1:1080`），直连模式下它不会被用到。
- **本来就用代理**：保持你现在的配置和路由不动，只要模块勾上就行。B 站分片走直连还是走代理由你的规则决定，脚本两种都能处理。

更新：Shadowrocket 不会自动更新模块。配置 → 模块 → 左滑对应模块 → 更新。模块和配置文件里的脚本地址带着版本号（`bilibili-thread-ripper.js?v=版本`），每次发版都会变，Shadowrocket 拿到新模块后就会按新地址重新下载脚本，不会用旧缓存。设置页顶部显示的版本号应与仓库 `package.json` 一致；不一致就是模块或配置还没更新到。

### 可选：也处理 https 的分片

默认模块只匹配明文 `http://` 的分片，不需要证书。真机抓包（iPad，2026-09）看到的情况是**两种都有**：起播的头几秒 App 用明文 http 向 `upos-hz-mirrorakam.akamaized.net` 和 `upos-sz-mirrorcosov.bilivideo.com` 取分片，之后的连接改走 443 端口的 TLS，并且会先尝试 QUIC（UDP 443）。所以默认模块只能加速明文那一部分；想覆盖全部，用带 HTTPS 的模块变体：

```text
https://raw.githubusercontent.com/vic233333/Bilibili-thread-ripper-mobile/main/shadowrocket/bilibili-thread-ripper-https.sgmodule
```

用整份配置的话，对应的是 `bilibili-thread-ripper-https.conf`（同一目录，导入方式相同）。

它与默认模块的区别有三点：脚本匹配 `https?://`；多了一个 `[MITM]` 段，只解密 `*.bilivideo.com`、`*.bilivideo.cn`、`*.bilivideo.net`、`*.akamaized.net` 这几个视频 CDN 域名，B 站的接口域名不在其中；多了几条规则拒掉这些域名的 QUIC（UDP 443），QUIC 无法解密，拒掉后 App 会退回 TCP 的 TLS。使用前要在 Shadowrocket 里：配置 → HTTPS 解密 → 开启，生成证书 → 安装证书 → 到系统 设置 → 通用 → 关于本机 → 证书信任设置 里完全信任它。两个模块不要同时启用。

代价和风险：每个分片多一次解密再加密，CPU 和电量开销高一些；如果 B 站 App 对视频 CDN 域名做了证书固定，解密后它会拒绝连接，表现为开了 HTTPS 解密后视频完全放不出来，那就只能用默认模块。脚本自己发出的子请求与此无关，它们本来就可以选 https（见设置页「子请求协议」）。

## 设置页

在 Safari 打开 `http://btr.settings/`（这不是真实域名，模块里把它指到了本机，请求在发出前就被脚本接住）。

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用加速 | 开 | 关掉后所有请求原样放过 |
| 加速方式 | 多线程拆分 | 可改为“只换节点”：不拆分，只把每个请求单连接改到当前模式最快的节点。多线程出问题时先退到这里排查 |
| CDN 模式 | 大陆 CDN | 与浏览器版相同：大陆、海外、自定义。海外看冷门视频一般选大陆 |
| 自定义节点 | 空 | 每行一个主机名，只接受 B 站视频服务器的域名，只在自定义模式生效 |
| 并发线程 | 8 | 一个分片最多拆成几块同时下载。可选 2 到 16 |
| 单个分片上限 | 8 MiB | 整段要先在内存里拼好再交给播放器，超过就不拆，只换节点 |
| 每块最小 | 128 KiB | 块太小时请求往返成本占大头；App 的画面请求是 1 MiB 一段，128 KiB 正好拆成 8 块 |
| 不拆分的请求也换节点 | 开 | 没有 Range、开区间、太大或太小的请求改走当前模式最快的节点，单连接 |
| 子请求协议 | 跟原地址一样 | App 是明文 http；有些网络对 http 干扰大时可以试 https |
| 单块超时 | 6 秒 | 一块超过这个时间没回来就换节点；在此之前副本机制通常已经救回来了 |
| 单个分片总时限 | 20 秒 | 到点没拼完就交回原连接 |
| 调试日志 | 关 | 在 Shadowrocket 的脚本日志里看到每块的去向 |

页面下方还有：节点记忆（每个节点的状态、速度、连败次数）、放过原因统计、最近 12 个请求的明细，以及清空统计、清空节点记忆、重新检测环境、查看日志、导出诊断 JSON 的按钮。所有数据都在本机，页面不联网；明细里只显示节点和 Range，不显示带签名的完整地址。

页面顶部可以选自动刷新（5、15、30 秒），边播视频边看统计变化。

### 日志

脚本自己保留最近 300 行运行日志，跨运行保存，在 `http://btr.settings/log.txt` 查看，`/diag.json` 里也有。开了「调试日志」后每块的去向和失败原因都会记进去。要发给别人时，在 Safari 里全选复制，或者用 `/diag.json` 一次带上设置、统计、节点记忆和日志。日志里没有签名地址和 Cookie。

Shadowrocket 自己的请求记录在 数据 → 代理，先打开「启用日志记录」；点一条记录能看到请求头和响应头，被加速的响应带 `X-BTR` 头。右上角 ··· 里可以导出或删除日志文件。

## 怎么确认它在工作

- **设置页的「最近请求」**：结果一栏是「多线程」，后面写着拆了几块、用了哪些节点、这次的速度。若全是「只换节点」或「原样放过」，看放过原因那一栏。
- **Shadowrocket 的脚本日志**：每次多线程完成会记一行 `accelerated/ok`。开调试日志后还能看到每块失败时的节点和原因。
- **响应头**：Shadowrocket 的请求记录里，被加速的响应带有 `X-BTR: <版本>; pieces=N; hosts=M; ms=…`。
- **体感**：同一个冷门 4K 视频，拖动到没缓存的位置，比较关掉模块前后的起播时间。

## 真机上观察到的 App 请求形态

2026-09-22 在 iPad 上用 0.1.2 抓到的情况，决定了默认参数怎么定：

- 画面分片是**正好 1 MiB 的有界 Range**（例如 `bytes=22020096-23068671`），每秒一到几条；音轨分片约 83 KiB 一条。所以默认每块 128 KiB，1 MiB 正好拆成 8 块；音轨太小不拆，只换节点。
- 起播的头几秒走明文 http，之后会切到 443 端口的 TLS 并先尝试 QUIC；默认模块只覆盖明文部分。
- `setTimeout` 在 Shadowrocket 的 WebView 引擎里只能作为全局函数调用，0.1.3 之前的版本因此每块都失败，日志里是 `TypeError: Can only call Window.setTimeout on instances of Window`。

## 已知限制

- **整段缓冲，不能流式**。脚本必须把一个分片的所有块拼完再一次性交给播放器，所以单个分片有大小上限（默认 8 MiB，最高 24 MiB）。如果 App 一次请求几十 MB 的整个文件，脚本只能换节点，不能拆分。请先在设置页看「最近请求」里的 Range 大小，再决定上限怎么调。
- **每块最多约 20 个并发**。这是 Surge 系脚本环境的规格，脚本把线程数上限定在 16。
- **内存**。多个分片同时进来时（画面和声音各一路），内存占用约是上限的两三倍。Network Extension 进程的内存限制很紧，上限调太高可能导致 Shadowrocket 被系统杀掉，表现为断流。出现这种情况就把上限调回 8 MiB 或更低。
- **每个分片多几十毫秒**。脚本调度有固定开销，对高码率视频不明显，对码率很低的视频反而可能变慢。
- **只拆分 `/upgcxcode/` 路径的分片**。脚本会看到所有 B 站视频 CDN 主机的明文请求并记入统计，但 PCDN（`/v1/resource/`，一般在 8000 端口）的地址不能整体换到 upos 节点，脚本对它们只记录、不处理。想屏蔽 PCDN 请用别的规则。
- **不能绕过任何权限**。和上游一样，它只加速你已经有权访问的字节。
- **只在 Shadowrocket 上测试**。模块是 Surge 格式，Surge 与 Loon 理论上也能用，但脚本参数（`engine=webview`）是 Shadowrocket 特有的，其他工具会忽略它。
- **二进制响应体的传递是真机上最大的未知数**。脚本能检测到 `$httpClient` 是否返回二进制（不行就自动退化），但无法检测 `$done` 传回的二进制响应体是否完好。若真机上多线程“成功”却放不出来，按[排错](#排错)里的步骤切换引擎或退回只换节点。

## 排错

**更新了模块或配置，设置页显示的版本号还是旧的**。脚本文件是按地址缓存的，Shadowrocket 和 GitHub 的 CDN 都会缓存几分钟。从 0.1.1 起脚本地址带版本参数，只要模块或配置文件本身更新到了新版本，脚本就一定是新的。所以先确认模块或配置文件更新成功（打开它看 `script-path` 里的 `?v=`），刚推送的版本等五分钟再更新一次；还不行就删掉模块重新添加，或者断开再连接一次 Shadowrocket。

**设置页打不开**。确认模块（或整份配置）已启用且 Shadowrocket 已连接。`btr.settings` 不是真实域名，模块和配置里都有一条 `[Host] btr.settings = 185.199.108.153` 把它指到一个会进入隧道的占位地址，请求在发出前就被脚本接住；如果你自己的配置改过 DNS 策略导致这条不生效，在配置的 `[Host]` 段手动加上同一行。看到 GitHub 的 404 页说明域名解析对了但脚本没有接到请求，检查脚本是否下载成功（配置 → 模块 → 点模块看脚本状态）。

**「最近请求」一直是空的，但 数据 → 代理 里明明有 http 的 `upos-` 请求，且策略写的是 `FINAL,DIRECT` 而不是 `HTTP-REQUEST,…`**。这正是 0.1.1 之前真机上出现的情况：两条脚本规则用了同一个脚本地址，只有设置页那条生效。0.1.2 起两条规则的地址不同（`?role=media` 与 `?role=settings`），匹配规则也改成了最简单的写法。更新到 0.1.2 以上即可。

**「最近请求」一直是空的**。说明脚本没有匹配到 App 的任何 CDN 请求（脚本会看到所有 B 站视频 CDN 主机的明文请求，哪怕不能拆分也会记一笔）。依次检查：B 站 App 的流量是否经过 Shadowrocket（数据 → 代理 → 先打开「启用日志记录」，再播放视频，看有没有 `upos-`、`mcdn`、`bilivideo` 的请求）；那些请求是 `http://` 还是 `https://`（默认模块只匹配明文，https 要换[带 HTTPS 的模块变体](#可选也处理-https-的分片)）；端口是不是 80（非标准端口上的明文 HTTP，Shadowrocket 可能不按 HTTP 处理）。导出日志前一定先打开「启用日志记录」，否则导出的 `.db` 文件是空的。把 数据 → 代理 里的请求截图或导出文件发到 Issue。

**「最近请求」里全是「不是可换节点的视频地址」**。看那一行下面的路径：`/v1/resource/…` 是 PCDN，脚本不处理；非 `/upgcxcode/` 的其他路径说明 App 用了新的地址格式，请把截图发到 Issue。

**结果全是「只换节点」，原因是「环境不支持二进制响应」**。脚本试过一次下载，发现 `$httpClient` 把二进制当文本返回，于是退化为只换节点，并弹了一次通知。这是 Shadowrocket 脚本引擎的行为，请到 Issue 反馈你的 Shadowrocket 版本；升级后可以在设置页点「重新检测环境」再试。

**结果全是「只换节点」，原因是「区间超过上限」**。App 一次请求的分片比上限大。看明细里的大小，酌情调高上限（注意内存限制），或者接受只换节点。

**结果全是「只换节点」，原因是「没有 Range 头」或「开区间」**。App 在这个场景下不用有界 Range 请求，脚本无法拆分。请把明细截图发到 Issue，这决定了后续版本要不要支持开区间。

**播放卡住或断流**。把上限调低（4 MiB）、线程调到 4，观察是否好转；再看 Shadowrocket 是否被系统重启。如果只换节点也卡，试试把 CDN 模式换成海外。

**多线程之后视频花屏、放不出来，但「最近请求」显示“多线程”成功**。这说明拼好的字节没有完整地从脚本传回播放器，最可能是脚本引擎在传递二进制响应体时出了问题。依次尝试：把设置页的「加速方式」改成“只换节点”，确认视频恢复；再到 Shadowrocket 配置 → 模块 → 编辑这个模块，把两条脚本里的 `engine=webview` 改成 `engine=jsc`，改回“多线程拆分”再试。把结果（哪个引擎能用）发到 Issue。

**视频完全放不出来**。先关掉模块确认是不是脚本的问题。若关掉就好，请在设置页导出诊断 JSON（`/diag.json`）连同 Shadowrocket 版本发 Issue。诊断 JSON 不含签名地址和 Cookie。

## 开发与测试

没有运行时依赖。需要 Node.js 18 以上。

```text
src/            脚本源码，按 core → env → accelerator → settings → main 的顺序拼接
  core.js         CDN 节点列表、地址与 Range 解析、区间切分、设置项规则（移植自上游）
  env.js          Shadowrocket / Surge API 适配层，唯一碰 $request、$done、$httpClient、$persistentStore 的地方
  accelerator.js  并发下载、校验、拼接、节点健康（移植自上游）
  settings.js     设置页、统计、持久化
  main.js         入口：判断拆分、只换节点或放过，保证一定调 $done
scripts/build.js  把 src/ 拼成 shadowrocket/bilibili-thread-ripper.js
shadowrocket/     模块文件与整份配置文件（各有默认 http 版、含 HTTPS 解密版）和生成的脚本，地址都指向本仓库 main 分支
test/             本地测试：假 CDN（支持 Range、按节点注入故障）、假脚本环境、node:test 用例
upstream/         上游原始文件的副本，只作对照
```

```bash
npm run build   # 生成 shadowrocket/bilibili-thread-ripper.js
npm test        # 先构建，再跑全部测试
```

测试覆盖：多块拼接的字节正确性；节点 403、Content-Range 错位、响应截断、节点挂起时的换节点重试；所有节点失败时的原样交回与重试预算；三种 CDN 模式的候选节点；无 Range、开区间、过大过小、停用、非 GET、PCDN 路径、脚本自身标记头等放过路径；环境不支持二进制时的退化和恢复；设置页的渲染、保存、边界值、重置和诊断 JSON。

改了 `src/` 之后要重新构建并把生成的脚本一起提交，Shadowrocket 加载的是生成文件。发版时改 `package.json` 的版本号再构建：构建会把版本号同步到模块和配置文件里的脚本地址（`?v=`），用户更新模块后才能拿到新脚本。

## 与浏览器版的关系

浏览器版接管的是网页播放器的 MediaSource，能流式地把字节喂给播放器；移动端脚本没有播放器可接管，只能在 HTTP 层把一个请求换成一个响应，所以有整段缓冲的限制。两者共用的是 CDN 节点列表、Range 切分与校验规则和节点健康策略，这些逻辑移植时按脚本环境重写了（脚本环境没有 `URL`、`fetch`、`AbortController` 和流式读取）。`upstream/README.md` 列出了每个文件移植了什么。

## 许可与致谢

本项目采用 [MIT 协议](LICENSE)。

原作 **Bilibili 线程撕裂者** 由 [MrTangLuyao](https://github.com/MrTangLuyao) 开发，MIT 协议，本仓库移植时依据的是它的 `0.9.3.0` 版本（提交 `3c8fdc6`）。原作 README 里对 B 站 CDN 分层架构和“大陆 CDN + 多线程”为什么有效的解释，同样适用于这里。

App 分片走明文 HTTP 这一关键事实来自 [MinamiHashiRun0/BiliFastCDN](https://github.com/MinamiHashiRun0/BiliFastCDN) 的抓包记录。
