# 上游原始文件

这个目录里的文件**原样复制**自 MrTangLuyao 的 [Bilibili 线程撕裂者](https://github.com/MrTangLuyao/Bilibili-thread-ripper)，只作对照和溯源用，脚本并不直接加载它们。

- 上游版本：`0.9.3.0`
- 上游提交：`3c8fdc634d506f8cf482654076f5b1f7b89f2b3a`（2026-09-21，`Update README.md`）
- 上游许可：MIT，见本目录下的 `LICENSE`

| 文件 | 移植到本仓库的内容 |
| --- | --- |
| `range-core.js` | Range 头与 Content-Range 的解析规则、区间切分算法、B 站媒体主机的判定正则、设置项的默认值 |
| `cdn-resolver.js` | 大陆与海外 CDN 主机列表、把签名地址换到别的节点的方法、节点健康记录和退避策略 |
| `idm-downloader.js` | 每块子区间必须校验 206 状态、Content-Range 与长度才能接受，失败后换节点重试、按节点速度分配的思路 |

移植时改掉的地方：Shadowrocket 的脚本环境没有 `URL`、`fetch`、`AbortController` 和流式读取，这些都换成了正则解析和 `$httpClient` 回调；每个分片请求都是一次独立的脚本运行，节点健康改用 `$persistentStore` 跨运行保存。

更新上游文件时，把新版本复制过来并改这个说明里的版本和提交号，再对照差异同步 `src/` 里的移植。
