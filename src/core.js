// 纯逻辑，不碰任何 Shadowrocket API。CDN 主机列表、Range 解析、区间切分和设置项的规则
// 移植自上游 src/range-core.js 与 src/cdn-resolver.js（见 upstream/README.md）。
(function (BTR) {
  "use strict";

  const MAINLAND_HOSTS = Object.freeze([
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorbos.bilivideo.com",
    "upos-sz-mirror08c.bilivideo.com",
    "upos-sz-mirrorbd.bilivideo.com",
    "upos-sz-mirror14b.bilivideo.com",
    "upos-sz-estgoss.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com"
  ]);

  const OVERSEAS_HOSTS = Object.freeze([
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com",
    "cn-hk-eq-01-03.bilivideo.com"
  ]);

  const THREAD_OPTIONS = Object.freeze([2, 4, 6, 8, 12, 16]);

  const MEDIA_HOST_RE = /(?:^|\.)(?:bilivideo\.(?:com|cn|net)|akamaized\.net|szbdyd\.com|hdslb\.com|xycdn\.com|mountaintoys\.cn|nexusedgeio\.com|ahdohpiechei\.com)$/i;
  const MEDIA_SUFFIX_RE = /\.(?:m4s|mp4|flv)$/i;
  // 只有这种路径的地址才能原样换到别的 upos 节点。PCDN 的 /v1/resource/ 路径不能换。
  const UPOS_PATH_RE = /^\/upgcxcode\//i;
  const HOSTNAME_RE = /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/;
  const URL_RE = /^([a-z][a-z\d+.-]*):\/\/([^/?#:@\s]+)(?::(\d+))?([^?#\s]*)(\?[^#\s]*)?(?:#.*)?$/i;

  // 脚本环境里没有 URL 类，这里只解析需要的几个部分。
  function parseUrl(value) {
    const match = URL_RE.exec(String(value == null ? "" : value).trim());
    if (!match) return null;
    const parts = {
      scheme: match[1].toLowerCase(),
      host: match[2].toLowerCase(),
      port: match[3] || "",
      path: match[4] || "/",
      query: match[5] || ""
    };
    parts.href = buildUrl(parts);
    return parts;
  }

  function buildUrl(parts, override) {
    const changes = override || {};
    const scheme = changes.scheme || parts.scheme;
    const host = changes.host || parts.host;
    const port = Object.prototype.hasOwnProperty.call(changes, "port") ? changes.port : parts.port;
    return scheme + "://" + host + (port ? ":" + port : "") + (parts.path || "/") + (parts.query || "");
  }

  function isAkamaiHost(host) {
    return /\.akamaized\.net$/i.test(String(host || ""));
  }

  function isMediaUrl(parts) {
    if (!parts) return false;
    return (parts.scheme === "http" || parts.scheme === "https")
      && MEDIA_HOST_RE.test(parts.host)
      && MEDIA_SUFFIX_RE.test(parts.path);
  }

  function isUposPath(parts) {
    return Boolean(parts) && UPOS_PATH_RE.test(parts.path || "");
  }

  // 请求头里的 Range。播放器通常只发 bytes=a-b；别的写法都原样放过。
  function parseRangeHeader(value) {
    if (value == null || value === "") return { kind: "none", raw: "" };
    const raw = String(value).trim();
    const match = /^bytes=(\d*)-(\d*)$/i.exec(raw);
    if (!match) return { kind: raw.indexOf(",") >= 0 ? "multi" : "invalid", raw };
    if (match[1] === "" && match[2] === "") return { kind: "invalid", raw };
    if (match[1] === "") return { kind: "suffix", raw, suffixLength: Number(match[2]) };
    const start = Number(match[1]);
    if (match[2] === "") return { kind: "open", raw, start };
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return { kind: "invalid", raw };
    return { kind: "bounded", raw, start, end, length: end - start + 1 };
  }

  function parseContentRange(value) {
    if (typeof value !== "string") return null;
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? null : Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
    return { start, end, total, length: end - start + 1 };
  }

  // 把 [start, end] 平均切成不超过 concurrency 块，每块至少 minChunkBytes。
  function splitRange(start, end, concurrency, minChunkBytes) {
    const length = end - start + 1;
    const limit = Math.max(1, Math.min(64, Math.trunc(concurrency) || 1));
    const minimum = Math.max(32 * 1024, Math.trunc(minChunkBytes) || 128 * 1024);
    const count = Math.max(1, Math.min(limit, Math.ceil(length / minimum)));
    const base = Math.floor(length / count);
    const remainder = length % count;
    const pieces = [];
    let cursor = start;
    for (let index = 0; index < count; index += 1) {
      const size = base + (index < remainder ? 1 : 0);
      pieces.push({ index, start: cursor, end: cursor + size - 1, length: size });
      cursor += size;
    }
    return pieces;
  }

  // 自定义模式里手填的服务器：只留主机名，并且只接受 B 站的视频服务器。
  function normalizeCdnHost(value) {
    let text = String(value == null ? "" : value).trim().toLowerCase();
    if (!text || text.length > 300) return "";
    text = text.replace(/^[a-z][a-z\d+.-]*:\/\//, "");
    text = text.replace(/^[^@/]*@/, "");
    text = text.split(/[/?#:]/)[0];
    return HOSTNAME_RE.test(text) && text.length <= 253 && MEDIA_HOST_RE.test(text) ? text : "";
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  const OVERFETCH_OPTIONS = [0, 1, 2, 4];

  function normalizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const threads = Math.trunc(Number(source.threads));
    const customHosts = (Array.isArray(source.customHosts) ? source.customHosts : [])
      .map(normalizeCdnHost)
      .filter(function (host, index, all) { return host && all.indexOf(host) === index; })
      .slice(0, 32);
    // 真机上 App 的画面请求是 1 MiB 一段，128 KiB 一块正好拆成 8 块，与默认线程数一致。
    const minChunkKiB = Math.round(clamp(source.minChunkKiB, 64, 1024, 128));
    return {
      enabled: source.enabled !== false,
      // "split" 拆分并发下载；"swap" 只把请求换到当前模式的节点，单连接。真机上排错时用。
      accelerate: source.accelerate === "swap" ? "swap" : "split",
      // "auto"：候选节点是 App 原本给的节点加上全部大陆与海外节点，按测得的速度自动挑；
      // 其余三种与浏览器版相同。真机上哪组节点快因网络而异，所以默认交给测速决定。
      mode: ["mainland", "overseas", "custom"].indexOf(source.mode) >= 0 ? source.mode : "auto",
      customHosts,
      // 真机上画面和音轨会同时在拆，再加上副本，8 块一段很容易把环境约 20 个并发的上限撑满。
      threads: THREAD_OPTIONS.indexOf(threads) >= 0 ? threads : 6,
      // 一次请求超过这个大小就不拆分了：整段要先在内存里拼好才能交给播放器。
      maxMiB: Math.round(clamp(source.maxMiB, 2, 24, 8)),
      minChunkKiB,
      // 单连接请求（没有 Range、开区间、太小、太大）是否也换到当前模式的 CDN。
      swapSingle: source.swapSingle !== false,
      // 子请求沿用原地址的协议（App 是明文 http），也可以强制走 https。
      subrequestScheme: source.subrequestScheme === "https" ? "https" : "keep",
      // 超量回传（实验）：App 要 1 MiB，就多下几 MiB 一起回给它。代理没法像浏览器版那样
      // 提前预读（真机验证：脚本交出响应之后，它发出的请求再也不会有回调），能做的只有
      // 在这一次请求里多给一些，让往返次数成倍减少。播放器认不认得看真机。0 表示关闭。
      overfetchMiB: OVERFETCH_OPTIONS.indexOf(Math.trunc(Number(source.overfetchMiB))) >= 0 ? Math.trunc(Number(source.overfetchMiB)) : 0,
      attemptTimeoutSec: Math.round(clamp(source.attemptTimeoutSec, 2, 30, 4)),
      // 曾经按「App 三秒就重发」把这里压到 3 秒，真机上直接翻车：环境自己的连接超时就要两秒，
      // 一次失败之后预算只剩不到一秒，连换个节点重试的机会都没有，于是整段直接放弃。
      // 0.6.0 的失败率因此从 3% 涨到 44%。预算要够试三四次。
      deadlineSec: Math.round(clamp(source.deadlineSec, 2, 40, 8)),
      debug: source.debug === true,
      get maxBytes() { return this.maxMiB * 1024 * 1024; },
      get minChunkBytes() { return this.minChunkKiB * 1024; },
      // 比两块还小的区间拆了也没意义。
      get minSplitBytes() { return this.minChunkKiB * 1024 * 2; },
      get overfetchBytes() { return this.overfetchMiB * 1024 * 1024; }
    };
  }

  function hostsForMode(settings) {
    if (settings.mode === "custom" && settings.customHosts.length) return settings.customHosts.slice();
    if (settings.mode === "auto") return OVERSEAS_HOSTS.concat(MAINLAND_HOSTS);
    return (settings.mode === "overseas" ? OVERSEAS_HOSTS : MAINLAND_HOSTS).slice();
  }

  // 一个分片可以向哪些节点要。规则同上游：当前模式的节点列表，加上 B 站原本给的节点
  // （只在它属于当前模式时保留；海外模式保留 akamai 原地址；自动模式总是保留）。
  function candidateHosts(originalHost, settings) {
    const original = String(originalHost || "").toLowerCase();
    const hosts = hostsForMode(settings);
    const custom = settings.mode === "custom" ? settings.customHosts : [];
    let keepOriginal;
    if (custom.length) keepOriginal = custom.indexOf(original) >= 0;
    else if (settings.mode === "auto") keepOriginal = true;
    else if (settings.mode === "overseas") keepOriginal = MAINLAND_HOSTS.indexOf(original) < 0;
    else keepOriginal = MAINLAND_HOSTS.indexOf(original) >= 0;
    const list = keepOriginal ? [original].concat(hosts) : hosts;
    return list.filter(function (host, index, all) {
      return host && normalizeCdnHost(host) === host && all.indexOf(host) === index;
    });
  }

  // 文件名末尾的编号：30200 到 30299 是音轨，其余当作画面。
  function mediaKind(path) {
    const match = /-(\d+)-(\d+)\.(?:m4s|mp4|flv)$/i.exec(String(path || ""));
    if (!match) return "unknown";
    const id = Number(match[2]);
    return id >= 30200 && id < 30300 ? "audio" : "video";
  }

  function headerGet(headers, name) {
    if (!headers || typeof headers !== "object") return undefined;
    const wanted = String(name).toLowerCase();
    const keys = Object.keys(headers);
    for (let index = 0; index < keys.length; index += 1) {
      if (keys[index].toLowerCase() === wanted) return headers[keys[index]];
    }
    return undefined;
  }

  function lowerHeaders(headers) {
    const output = {};
    if (!headers || typeof headers !== "object") return output;
    Object.keys(headers).forEach(function (key) {
      const value = headers[key];
      output[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value);
    });
    return output;
  }

  BTR.core = Object.freeze({
    OVERFETCH_OPTIONS,
    MAINLAND_HOSTS,
    OVERSEAS_HOSTS,
    THREAD_OPTIONS,
    MEDIA_HOST_RE,
    buildUrl,
    candidateHosts,
    headerGet,
    hostsForMode,
    isAkamaiHost,
    isMediaUrl,
    isUposPath,
    lowerHeaders,
    mediaKind,
    normalizeCdnHost,
    normalizeSettings,
    parseContentRange,
    parseRangeHeader,
    parseUrl,
    splitRange
  });
})(BTR);
