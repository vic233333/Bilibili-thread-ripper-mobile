/*!
 * Bilibili 线程撕裂者 · 移动端（Shadowrocket 脚本） v0.8.1
 * https://github.com/vic233333/Bilibili-thread-ripper-mobile
 *
 * 原作：MrTangLuyao 的 Bilibili 线程撕裂者（MIT）
 * https://github.com/MrTangLuyao/Bilibili-thread-ripper
 * 本脚本移植了它的 CDN 节点列表、Range 切分与校验规则和节点健康策略，见仓库 upstream/README.md。
 *
 * 许可：MIT，版权声明见仓库 LICENSE。
 * 这个文件由 scripts/build.js 生成，不要直接修改。
 */
(function () {
"use strict";
const BTR = { VERSION: "0.8.1" };

/* src/core.js */
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
      // 单段的总时限（毫秒）：到点不管还有几块在途，一律交回原连接。真机三份日志、三个版本
      // 得到同一条线：播放器从发出请求算起大约只等 2.45 秒，之前交出去的都被用了，之后交出去的
      // 都被丢掉、隔几秒再要一遍。所以拖过这条线毫无价值。直连是流式的，第一个字节几十到几百
      // 毫秒就到，1.9 秒交回还赶得上。这条线会不会随网络变，设置页的「播放器的耐心」在持续量。
      deadlineMs: Math.round(clamp(source.deadlineMs, 800, 40000, 1900) / 100) * 100,
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

/* src/env.js */
// Shadowrocket / Surge 脚本 API 的适配层。脚本里只有这个文件碰 $request、$done、$httpClient、
// $persistentStore 和 $notification；本地测试时把它们换成假的即可。
(function (BTR) {
  "use strict";

  /* global $request, $done, $httpClient, $persistentStore, $notification, $argument */
  const api = {
    request: typeof $request !== "undefined" ? $request : null,
    // 模块脚本行上的 argument=…，例如 mode=https。
    argument: typeof $argument !== "undefined" ? $argument : null,
    done: typeof $done === "function" ? $done : null,
    httpClient: typeof $httpClient !== "undefined" ? $httpClient : null,
    persistentStore: typeof $persistentStore !== "undefined" ? $persistentStore : null,
    notification: typeof $notification !== "undefined" ? $notification : null,
    console: typeof console !== "undefined" ? console : null,
    // WebView 引擎里 setTimeout 是 Window 的方法，只能作为全局函数直接调用；存进对象再调
    // 会报 "Can only call Window.setTimeout on instances of Window"。所以包一层。
    setTimeout: typeof setTimeout === "function" ? function (callback, delayMs) { return setTimeout(callback, delayMs); } : null,
    clearTimeout: typeof clearTimeout === "function" ? function (timer) { return clearTimeout(timer); } : null
  };

  let debugEnabled = false;
  function setDebug(enabled) {
    debugEnabled = enabled === true;
  }

  function safeString(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.name + ": " + value.message;
    try { return JSON.stringify(value); }
    catch (_error) { return String(value); }
  }

  // 这次运行写下的日志，运行结束时由 main 追加到持久存储，在设置页的 /log.txt 里能看到。
  const logLines = [];
  function log(level, message, detail) {
    if (level === "debug" && !debugEnabled) return;
    const suffix = detail === undefined ? "" : " " + safeString(detail);
    const line = "[" + level + "] " + message + suffix;
    logLines.push(line);
    if (!api.console || typeof api.console.log !== "function") return;
    try { api.console.log("[BTR] " + line); }
    catch (_error) {}
  }

  function makeError(name, message, extra) {
    const error = new Error(message || name);
    error.name = name;
    if (extra && typeof extra === "object") Object.keys(extra).forEach(function (key) { error[key] = extra[key]; });
    return error;
  }

  // $persistentStore.read(key) / write(value, key)。每个分片请求都是一次新的脚本运行，
  // 设置、统计和节点健康都靠它跨运行保存。
  const store = {
    read(key) {
      try {
        const value = api.persistentStore && typeof api.persistentStore.read === "function" ? api.persistentStore.read(key) : null;
        return typeof value === "string" ? value : null;
      } catch (_error) {
        return null;
      }
    },
    write(key, value) {
      try {
        if (!api.persistentStore || typeof api.persistentStore.write !== "function") return false;
        return api.persistentStore.write(String(value), key) !== false;
      } catch (_error) {
        return false;
      }
    },
    readJson(key, fallback) {
      const text = store.read(key);
      if (!text) return fallback;
      try {
        const value = JSON.parse(text);
        return value && typeof value === "object" ? value : fallback;
      } catch (_error) {
        return fallback;
      }
    },
    writeJson(key, value) {
      try { return store.write(key, JSON.stringify(value)); }
      catch (_error) { return false; }
    },
    available() {
      return Boolean(api.persistentStore && typeof api.persistentStore.read === "function" && typeof api.persistentStore.write === "function");
    }
  };

  function notify(title, subtitle, body) {
    try {
      if (api.notification && typeof api.notification.post === "function") api.notification.post(title, subtitle || "", body || "");
    } catch (_error) {}
  }

  // 不同环境把二进制响应体交给脚本的方式不一样：Uint8Array、ArrayBuffer、别的 TypedArray，
  // 甚至数字数组。字符串说明这个环境没有给出二进制，返回 null。
  function toBytes(value) {
    if (!value || typeof value !== "object") return null;
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object ArrayBuffer]") return new Uint8Array(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (typeof value[index] !== "number") return null;
      }
      return Uint8Array.from(value);
    }
    return null;
  }

  // 脚本自己的错误（类型错误、引用错误等）原样抛出，好在日志里看到真实原因；
  // 别的都是 $httpClient 报回来的网络问题，归为超时或网络错误，可以换节点重试。
  function isScriptError(error) {
    return error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError || error instanceof RangeError;
  }

  function wrapError(error) {
    if (isScriptError(error)) return error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "NetworkError")) return error;
    const message = safeString(error) || "请求失败";
    const wrapped = makeError(/time/i.test(message) ? "TimeoutError" : "NetworkError", message);
    if (error && typeof error === "object" && error.status) wrapped.status = error.status;
    return wrapped;
  }

  // 一次 GET。回调式的 $httpClient 包成 Promise；即使环境不理会 timeout 参数，
  // 这里也用自己的计时器兜底，超时的连接留给环境自己收拾。
  function httpGet(options) {
    return new Promise(function (resolve, reject) {
      if (!api.httpClient || typeof api.httpClient.get !== "function") {
        reject(makeError("HttpClientMissing", "$httpClient 不可用"));
        return;
      }
      const timeoutSec = Math.max(1, Number(options.timeoutSec) || 8);
      // 真正的回调什么时候到（哪怕已经超时判负了）：预取实验要靠它判断 $done 之后请求还跑不跑。
      const onCallback = typeof options.onCallback === "function" ? options.onCallback : null;
      const sentAt = Date.now();
      let settled = false;
      let timer = null;
      const finish = function (callback, value) {
        if (settled) return;
        settled = true;
        if (timer !== null && api.clearTimeout) api.clearTimeout(timer);
        callback(value);
      };
      if (api.setTimeout) {
        timer = api.setTimeout(function () {
          finish(reject, makeError("TimeoutError", "请求超过 " + timeoutSec + " 秒没有完成"));
        }, timeoutSec * 1000 + 500);
      }
      const request = {
        url: options.url,
        headers: options.headers || {},
        timeout: timeoutSec,
        "binary-mode": true
      };
      try {
        api.httpClient.get(request, function (error, response, data) {
          if (onCallback) {
            try { onCallback(error || null, Date.now() - sentAt, response); } catch (_error) {}
          }
          if (error) {
            finish(reject, wrapError(error));
            return;
          }
          const status = Number(response && (response.status != null ? response.status : response.statusCode)) || 0;
          const headers = BTR.core.lowerHeaders(response && response.headers);
          const body = toBytes(data) || toBytes(response && response.bodyBytes) || toBytes(response && response.body);
          const text = typeof data === "string" ? data : response && typeof response.body === "string" ? response.body : null;
          finish(resolve, { status, headers, body, text });
        });
      } catch (error) {
        finish(reject, wrapError(error));
      }
    });
  }

  // $done 只能调一次，而且无论出什么错都必须调，否则这个请求会一直挂着。
  let finished = false;
  function finish(value) {
    if (finished) return false;
    finished = true;
    try {
      if (api.done) api.done(value === undefined ? {} : value);
    } catch (error) {
      log("error", "$done 调用失败", error);
    }
    return true;
  }

  // argument 的写法是 a=b&c=d，或者环境直接给对象。
  function argumentValue(name) {
    const raw = api.argument;
    if (!raw) return "";
    if (typeof raw === "object") return raw[name] == null ? "" : String(raw[name]);
    const pairs = String(raw).split("&");
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index];
      const at = pair.indexOf("=");
      const key = at >= 0 ? pair.slice(0, at) : pair;
      if (key.trim() === name) return at >= 0 ? pair.slice(at + 1).trim() : "";
    }
    return "";
  }

  function capabilities() {
    return {
      request: Boolean(api.request),
      httpClient: Boolean(api.httpClient && typeof api.httpClient.get === "function"),
      persistentStore: store.available(),
      notification: Boolean(api.notification && typeof api.notification.post === "function"),
      timers: Boolean(api.setTimeout)
    };
  }

  BTR.env = Object.freeze({
    api,
    argumentValue,
    capabilities,
    finish,
    httpGet,
    log,
    logLines,
    makeError,
    notify,
    safeString,
    setDebug,
    store,
    toBytes
  });
})(BTR);

/* src/accelerator.js */
// 把一个 bytes=a-b 的分片请求拆成多块，向多个 CDN 节点并发要，校验后按顺序拼回来。
// 思路来自上游 src/idm-downloader.js 和 src/cdn-resolver.js：每块必须是 206、Content-Range 与
// 请求一致、长度正好，才能接受；失败就换节点重试；快的节点多分一些。
(function (BTR) {
  "use strict";

  const core = BTR.core;
  const env = BTR.env;

  const HEALTH_KEY = "btr.health";
  // 测过的速度算“新鲜”的时限：新鲜的节点按速度排进节点池；过了时限的仍保留速度作为先验
  // （分块时照样按它排），只是排队时让位给新鲜的。每块下载都会刷新速度，所以自我修正得很快。
  const MEASURE_TTL_MS = 90 * 1000;
  // 4xx 是节点明确拒绝了这个地址（比如 akamai 对脚本的子请求返回 403），短时间内重试没有意义。
  const REFUSED_BLOCK_MS = 5 * 60 * 1000;
  // 只有传够这么多字节的一块才拿来算速度，尾巴太短的会误判。
  const SPEED_SAMPLE_MIN_BYTES = 48 * 1024;
  const RETRY_ROUNDS = 2;
  const HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  // 只有这些错误说明是节点或网络的问题，值得换节点重试并记在节点头上。别的（TypeError、
  // ReferenceError 之类）是脚本自己或环境的问题，换多少个节点都一样，直接放弃整段。
  const HOST_ERRORS = ["TimeoutError", "NetworkError", "BadRange", "BadLength", "EmptyBody"];
  // 服务器嫌一次开得太多时会回 412 / 429。这不是节点坏了，是这会儿的并发太高：节点只短暂退避，
  // 同时接下来三分钟所有请求的线程数减半。取自上游 0.9.4.0 自动线程数里的同一处理。
  const PUSHBACK_STATUSES = [412, 429];
  const PUSHBACK_REST_MS = 3 * 60 * 1000;

  function loadHealth() {
    const stored = env.store.readJson(HEALTH_KEY, null);
    if (stored && typeof stored === "object" && stored.hosts && typeof stored.hosts === "object") return stored;
    return { hosts: {} };
  }

  function touchedAt(record) {
    return Math.max(record.okAt || 0, record.failAt || 0, record.measuredAt || 0, record.segAt || 0);
  }

  // 保存时先跟存储里现在的那份合并，按节点取较新的记录。每次请求都是一次独立的脚本运行，
  // 开头读、结尾写；画面和音轨、前后两段经常同时在跑，直接覆盖就是「谁最后写完谁说了算」——
  // 一次拖了几秒的慢运行结束时，会把它开头读到的那份旧记忆整个盖回去，中间别的运行学到的
  // 全部作废。按节点合并后，一次重叠最多丢一个节点的一笔观测。
  function saveHealth(health) {
    const now = Date.now();
    const stored = loadHealth();
    Object.keys(stored.hosts).forEach(function (host) {
      const mine = health.hosts[host];
      const theirs = stored.hosts[host];
      if (!mine || touchedAt(theirs) > touchedAt(mine)) health.hosts[host] = theirs;
    });
    ["leader", "leaderAt", "trialAt", "pushback"].forEach(function (key) {
      if (stored[key] === undefined) return;
      const newer = key === "pushback"
        ? (Number(stored.pushback && stored.pushback.until) || 0) > (Number(health.pushback && health.pushback.until) || 0)
        : key === "leaderAt" || key === "trialAt" ? (Number(stored[key]) || 0) > (Number(health[key]) || 0)
        : (Number(stored.leaderAt) || 0) > (Number(health.leaderAt) || 0);
      if (newer) health[key] = stored[key];
    });
    Object.keys(health.hosts).forEach(function (host) {
      const record = health.hosts[host];
      const touched = Math.max(record.okAt || 0, record.failAt || 0);
      if (!touched || now - touched > HEALTH_MAX_AGE_MS) delete health.hosts[host];
    });
    return env.store.writeJson(HEALTH_KEY, health);
  }

  function recordOf(health, host) {
    if (!health.hosts[host]) health.hosts[host] = {};
    return health.hosts[host];
  }

  // 记分跌得快、涨得慢。真机日志里，一个节点可以在一秒之内从 1 MiB/168 毫秒掉到 1 MiB/5.7 秒；
  // 对称的 EWMA 要四五次测量才会把它赶下领跑位，那就是四五段、二十多秒的卡顿。
  const RISE = 0.3;
  const FALL = 0.7;

  function blend(previous, sample) {
    if (!(previous > 0)) return sample;
    const weight = sample < previous ? FALL : RISE;
    return previous * (1 - weight) + sample * weight;
  }

  // 耗时的极性和速度相反：变慢时跟得紧，变快时慢慢信。
  function blendMs(previous, sample) {
    if (!(previous > 0)) return sample;
    const weight = sample > previous ? FALL : RISE;
    return previous * (1 - weight) + sample * weight;
  }

  function markSuccess(health, host, bytes, elapsedMs) {
    const record = recordOf(health, host);
    const now = Date.now();
    record.fails = 0;
    record.blockedUntil = 0;
    record.okAt = now;
    if (bytes >= SPEED_SAMPLE_MIN_BYTES && elapsedMs > 0) {
      record.bps = blend(record.bps, bytes * 1000 / elapsedMs);
      record.pieceMs = blendMs(record.pieceMs, elapsedMs);
      record.measuredAt = now;
    }
  }

  // 悲观采样。这是这个环境里最要命的一处偏差：脚本一调 $done，没回来的请求就再也不会回调，
  // 所以「慢」这件事本身从来没被记下来过——节点记忆里每一个样本都是「这次赢了」的样本，
  // 慢节点的分数永远停在它状态好的时候。而在开副本的那一刻，我们已经可以断定「这个节点这一块
  // 至少用了这么久」，速度至多是 bytes/elapsedMs。这是能在 $done 之前拿到的唯一一次慢样本。
  const SLOW_SAMPLE_MIN_MS = 250;

  function markSlow(health, host, bytes, elapsedMs) {
    if (!host || !(bytes > 0) || !(elapsedMs >= SLOW_SAMPLE_MIN_MS)) return false;
    const record = recordOf(health, host);
    const bound = bytes * 1000 / elapsedMs;
    // 上界比现有记录还宽，说明还谈不上慢，不记。
    if (record.bps > 0 && bound >= record.bps) return false;
    // 一次观测最多把分数打到四分之一。整条链路抽风的时候每个节点都会吃到这一笔，
    // 要是允许一次就清零，抽风过后所有节点的记忆都成了废墟，谁先侥幸成功谁就当领跑者。
    const floor = record.bps > 0 ? record.bps / 4 : 0;
    record.bps = Math.max(blend(record.bps, bound), floor);
    record.pieceMs = blendMs(record.pieceMs, elapsedMs);
    record.measuredAt = Date.now();
    return true;
  }

  // 整段的实测速度才是“这个节点开五六路能有多快”的可靠证据：单块的测量（试探块、救急的副本）
  // 偏乐观，块小、连接新，读出来的速度撑不起整段。只有某个节点拿走了一段里绝大多数块时才记。
  const SEGMENT_TTL_MS = 2 * 60 * 1000;

  function markSegment(health, leader, bytes, elapsedMs) {
    if (!leader || !(bytes > 0) || !(elapsedMs > 0)) return "";
    const record = recordOf(health, leader);
    record.segBps = blend(record.segBps, bytes * 1000 / elapsedMs);
    record.segAt = Date.now();
    return leader;
  }

  // 领跑者的分数。有整段实测就用整段的；只有单块测量的打对折，因为它偏乐观。
  // App 自己用的那个节点加一点分：它是 B 站调度给这台设备的，地址也是为它签的。
  const PIECE_DISCOUNT = 0.5;
  const ORIGINAL_BONUS = 1.25;
  // 想把在位的领跑者换掉，要比它快这么多倍。换来换去的代价很大：真机日志里五分钟换了 34 次，
  // 每次换到差节点就是一段五六秒。
  const SWITCH_MARGIN = 1.5;

  function hostScore(health, host, originalHost) {
    const record = health.hosts[host];
    if (!record) return 0;
    const fresh = record.segAt && Date.now() - record.segAt < SEGMENT_TTL_MS;
    const pieceScore = (record.bps || 0) * PIECE_DISCOUNT;
    let base = fresh ? (record.segBps || 0) : pieceScore;
    // 整段成绩还「新鲜」但比之后的单块测量更旧时，允许新证据把分往上抬：一个节点在链路抽风
    // 时领跑过一段，整段成绩就烂了两分钟；它下了领跑位之后只有试探块和副本还在测它，
    // 这些单块要是又快起来了，不该被那笔旧账压着回不来。往下压的方向不需要这条，
    // 悲观采样已经管着。
    if (fresh && (record.measuredAt || 0) > record.segAt && pieceScore > base) base = pieceScore;
    return base * (host && host === originalHost ? ORIGINAL_BONUS : 1);
  }

  // App 自己那个节点是首选。真机数据反复指向同一件事：它是 B 站按这台设备调度出来的，
  // App 自己的请求（音轨、太小的段、放过的段）一直在用它，连接常年是热的；我们换过去的节点
  // 每次都要重新握手，换帅后的第一段平均多花一秒半。0.6.0 一度把领跑位让给香港节点并在那里
  // 待了四分半，每段 3 秒多，而同期 akamai 只要 130 毫秒。所以除非它被退避，或者别人有新鲜的
  // 整段实测而且快上三倍，否则就留在它身上。
  const ORIGINAL_STAY_MARGIN = 3;

  // 这一段交给谁。在位的领跑者一直留任，除非有节点明显更快、或者它自己被退避了。
  function chooseLeader(pool, health, originalHost) {
    if (!pool.length) return "";
    const now = Date.now();
    // 退避中的节点不当领跑者，除非所有节点都在退避。
    const usable = pool.filter(function (host) { return !isBlocked(health.hosts[host], now); });
    const ranked = (usable.length ? usable : pool).slice().sort(function (a, b) {
      return hostScore(health, b, originalHost) - hostScore(health, a, originalHost);
    });
    const best = ranked[0];
    // App 原本那个节点还能用，就用它。
    if (originalHost && ranked.indexOf(originalHost) >= 0) {
      const mine = hostScore(health, originalHost, "");
      const rival = best === originalHost ? "" : best;
      const rivalScore = rival ? hostScore(health, rival, "") : 0;
      if (!(mine > 0) || !(rivalScore > mine * ORIGINAL_STAY_MARGIN)) {
        health.leader = originalHost;
        health.leaderAt = now;
        return originalHost;
      }
    }
    const held = health.leader;
    const incumbent = held && pool.indexOf(held) >= 0 && !isBlocked(health.hosts[held], now) ? held : "";
    if (!incumbent) {
      health.leader = best;
      health.leaderAt = now;
      return best;
    }
    if (best !== incumbent && hostScore(health, best, originalHost) > hostScore(health, incumbent, originalHost) * SWITCH_MARGIN) {
      health.leader = best;
      health.leaderAt = now;
      return best;
    }
    return incumbent;
  }

  // App 自己那个节点最多退避这么久。0.7.0 的日志里它在一场抽风里连着失败四次，按 3、6、12、
  // 24、48 秒的阶梯被关了 48 秒，这一分钟里领跑位落在一个慢五到十倍的节点上，两段因此拖过了
  // 播放器的耐心。它是 App 自己一直在用的节点，App 的直连请求根本不理会我们的退避，所以对它
  // 只做短退避：抽风一过就回来。
  const ORIGINAL_BLOCK_MAX_MS = 6 * 1000;

  function markFailure(health, host, error, bytes, elapsedMs, originalHost) {
    const record = recordOf(health, host);
    const now = Date.now();
    // 超时、断连同样是「慢」的证据。以前这里只记退避不动分数，于是一个卡死的节点带着
    // 原封不动的高分熬过退避，立刻又回来当领跑者。
    markSlow(health, host, bytes, elapsedMs);
    record.fails = (record.fails || 0) + 1;
    // 3、6、12、24、48 秒，最多 60 秒。上游对“一个字节都没给”的节点也是这么退避的。
    const cap = originalHost && host === originalHost ? ORIGINAL_BLOCK_MAX_MS : 60 * 1000;
    record.blockedUntil = now + Math.min(cap, 3000 * Math.pow(2, Math.min(record.fails, 4)));
    const status = Number(error && error.status) || 0;
    if (PUSHBACK_STATUSES.indexOf(status) >= 0) health.pushback = { until: now + PUSHBACK_REST_MS, status, host };
    else if (status >= 400 && status < 500 && status !== 408) record.blockedUntil = now + REFUSED_BLOCK_MS;
    record.failAt = now;
    record.lastError = env.safeString(error).slice(0, 100);
  }

  function isBlocked(record, now) {
    return Boolean(record) && (record.blockedUntil || 0) > now;
  }

  // 还要收着劲跑多久（毫秒），0 表示没有限流记录。
  function pushbackMs(health, now) {
    const at = Number(now) || Date.now();
    const until = Number(health && health.pushback && health.pushback.until) || 0;
    return until > at ? until - at : 0;
  }

  function isMeasured(record, now) {
    if (!record) return false;
    // 整段实测比单块测量更可靠，也更值钱：有它就算测过。
    if (record.segAt && now - record.segAt < SEGMENT_TTL_MS) return true;
    return Boolean(record.measuredAt) && now - record.measuredAt < MEASURE_TTL_MS;
  }

  // 这次请求的分块先发给哪些节点。测过速度的按快慢排，再带上一个没测过的去探路；
  // 测过的不到两个时还在热身，把分块撒到所有节点上，一次就把它们都量一遍。
  // 被退避的节点排最后，只在别的都失败时才轮到。
  function orderCandidates(hosts, health, threads, originalHost) {
    const now = Date.now();
    const entries = hosts.map(function (host) { return { host, record: health.hosts[host] || null }; });
    const active = entries.filter(function (entry) { return !isBlocked(entry.record, now); });
    const blocked = entries.filter(function (entry) { return isBlocked(entry.record, now); })
      .sort(function (a, b) { return (a.record.blockedUntil || 0) - (b.record.blockedUntil || 0); });
    // 按挑领跑者时用的同一把尺子排，免得一个整段成绩很好的节点因为单块记录旧了而掉出候选。
    const measured = active.filter(function (entry) { return isMeasured(entry.record, now); })
      .sort(function (a, b) { return hostScore(health, b.host, originalHost) - hostScore(health, a.host, originalHost); });
    const fresh = active.filter(function (entry) { return !isMeasured(entry.record, now); })
      .sort(function (a, b) { return (b.record && b.record.bps || 0) - (a.record && a.record.bps || 0); });
    let pool;
    if (measured.length < 2) pool = measured.concat(fresh);
    else pool = measured.slice(0, Math.max(1, threads)).concat(fresh.slice(0, 1));
    if (!pool.length) pool = blocked;
    const all = measured.concat(fresh, blocked);
    return {
      pool: pool.map(function (entry) { return entry.host; }),
      all: all.map(function (entry) { return entry.host; })
    };
  }

  // 一段只用一个节点。真机日志（2026-09-22，麦迪逊 iPad）分得很开：所有块都落在同一个
  // 节点上的分段，1 MiB 花 70~1125 毫秒；块被撒到三个以上节点的分段，无一例外在 1.4~9.6 秒。
  // 道理也清楚——一段什么时候拼完由最慢的那块决定，多带一个慢节点就是把整段拖到它的速度，
  // 而一个快节点自己开五六路几乎不掉速。所以所有块都给当前最快的节点，别的节点只在某块
  // 卡住时接副本。代价是不再顺手测别的节点，于是每隔一段时间留一块去试，并且给这块更短的
  // 副本等待时间，让它最多只能拖慢半秒。
  const TRIAL_INTERVAL_MS = 45 * 1000;

  function fastestFirst(pool, health, originalHost) {
    return pool.map(function (host) { return { host, bps: hostScore(health, host, originalHost) }; })
      .sort(function (a, b) { return b.bps - a.bps; });
  }

  function assignPieces(pool, health, count, originalHost) {
    const assignment = [];
    if (!pool.length) return assignment;
    const ranked = fastestFirst(pool, health, originalHost);
    const known = ranked.filter(function (entry) { return entry.bps > 0; });
    // 热身：一个测过速度的节点都没有，撒一轮把它们都量一遍。
    if (!known.length) {
      for (let index = 0; index < count; index += 1) assignment.push(pool[index % pool.length]);
      return assignment;
    }
    const leader = chooseLeader(pool, health, originalHost);
    for (let index = 0; index < count; index += 1) assignment.push(leader);
    const now = Date.now();
    // 领跑位不在 App 自己的节点上时，每段都留最后一块去试它：它是我们最想回去的节点，
    // 不试就只有过期的坏成绩，永远回不去。退避中的不试。
    if (count >= 4 && originalHost && leader !== originalHost && pool.indexOf(originalHost) >= 0 && !isBlocked(health.hosts[originalHost], now)) {
      assignment[count - 1] = originalHost;
      return assignment;
    }
    // 隔一阵子留最后一块去试一个还没测过的节点，免得节点记忆永远停在开头那一轮。
    // 「没测过」要包含「测过但已经过期」，否则热身之后这个分支永远不会触发，节点记忆就停在开头那一轮。
    const untried = ranked.filter(function (entry) {
      return entry.bps <= 0 || !isMeasured(health.hosts[entry.host], now);
    });
    if (untried.length && count >= 4 && now - (Number(health.trialAt) || 0) > TRIAL_INTERVAL_MS) {
      health.trialAt = now;
      assignment[count - 1] = untried[0].host;
    }
    return assignment;
  }

  async function fetchPiece(url, piece, headers, timeoutSec) {
    const startedAt = Date.now();
    const requestHeaders = {};
    Object.keys(headers).forEach(function (key) { requestHeaders[key] = headers[key]; });
    requestHeaders.Range = "bytes=" + piece.start + "-" + piece.end;
    const response = await env.httpGet({ url, headers: requestHeaders, timeoutSec });
    const contentRange = core.parseContentRange(response.headers["content-range"]);
    if (response.status !== 206 || !contentRange || contentRange.start !== piece.start || contentRange.end !== piece.end) {
      throw env.makeError("BadRange", "Range 校验失败：HTTP " + response.status + (contentRange ? "" : "，没有可用的 Content-Range"), { status: response.status });
    }
    if (!response.body) {
      if (typeof response.text === "string") throw env.makeError("BinaryUnsupported", "脚本环境把二进制响应当成了文本");
      throw env.makeError("EmptyBody", "节点没有返回数据");
    }
    if (response.body.byteLength !== piece.length) {
      throw env.makeError("BadLength", "子块长度不符：" + response.body.byteLength + "/" + piece.length);
    }
    return {
      bytes: response.body,
      total: contentRange.total,
      contentType: response.headers["content-type"] || "",
      elapsedMs: Math.max(1, Date.now() - startedAt)
    };
  }

  // 一块该多久传完：按已测到的最快节点估，超过它的 1.5 倍还没回来就再向另一个节点要一份
  // 副本，先到先用。上游叫这个 hedge。没有测速数据时用固定值。
  // 副本最迟这时开：单段的预算只有约 1.9 秒，副本再晚就没有时间跑完了。
  const HEDGE_MAX_MS = 1000;

  function hedgeDelayMs(plan, piece) {
    const host = plan.assignment[piece.index] || "";
    const record = host ? plan.health.hosts[host] : null;
    // 先看这块实际派给的那个节点自己一块要跑多久；这比拿全场最快速度去估准得多。
    let estimate = record && record.pieceMs > 0 ? Math.round(record.pieceMs * 1.5 + 120) : 0;
    if (!estimate) {
      const now = Date.now();
      let best = 0;
      Object.keys(plan.health.hosts).forEach(function (item) {
        const other = plan.health.hosts[item];
        if (isMeasured(other, now) && other.bps > best) best = other.bps;
      });
      estimate = best ? Math.round(piece.length / best * 1000 * 1.5) : 0;
    }
    // 试探用的那块：最多让它拖半秒，之后就让领跑者也下一份。
    if (piece.trial) return estimate ? Math.max(300, Math.min(700, estimate)) : 600;
    return estimate ? Math.max(400, Math.min(HEDGE_MAX_MS, estimate)) : 1000;
  }

  // 剩这么点时间连最快的节点也跑不完一块，就不再发新请求。
  const MIN_LAUNCH_MS = 250;

  // 一块的下载：按节点顺序发请求，失败就换下一个；一份迟迟不回来时再开一份副本。
  // $httpClient 没法取消，输掉的副本会在后台跑完，它的结果只用来更新节点速度。
  function downloadPiece(piece, plan) {
    // 第一选择是按速度分到的节点，之后按速度顺序换别的节点；退避中的排最后。
    const first = plan.assignment[piece.index] || plan.pool[piece.index % plan.pool.length];
    // 这块卡住或失败时换谁：按速度从快到慢，而不是轮着来——副本的意义就是尽快拿到这一块。
    const order = [first].concat(fastestFirst(plan.pool, plan.health, plan.originalHost)
      .map(function (entry) { return entry.host; })
      .filter(function (host) { return host !== first; }));
    plan.all.forEach(function (host) { if (order.indexOf(host) < 0) order.push(host); });
    const queue = [];
    for (let round = 0; round < RETRY_ROUNDS; round += 1) order.forEach(function (host) { queue.push({ host, round }); });
    return new Promise(function (resolve, reject) {
      let settled = false;
      // 在途的每次尝试都记下是谁、什么时候发的：开副本那一刻要靠它写悲观上界。
      const running = [];
      let cursor = 0;
      let timer = null;
      let lastError = null;
      function clearHedge() {
        if (timer !== null && env.api.clearTimeout) env.api.clearTimeout(timer);
        timer = null;
      }
      function finish(ok, value) {
        if (settled) return;
        settled = true;
        clearHedge();
        if (ok) resolve(value);
        else reject(value);
      }
      function nextHost() {
        const now = Date.now();
        while (cursor < queue.length) {
          const item = queue[cursor++];
          // 第一轮跳过还在退避的节点，除非全都在退避。
          if (item.round === 0 && isBlocked(plan.health.hosts[item.host], now)
            && queue.some(function (other) { return other.round === 0 && !isBlocked(plan.health.hosts[other.host], now); })) continue;
          return item.host;
        }
        return null;
      }
      function giveUp(error) {
        if (running.length) return;
        finish(false, error);
      }
      function launch(isHedge) {
        if (settled) return;
        // 别的块已经宣告失败、整段要交回原连接时，这块也不用再换节点试了。
        if (plan.aborted) { finish(false, lastError || env.makeError("Aborted", "整段下载已放弃")); return; }
        const now = Date.now();
        const remainingMs = plan.deadlineAt - now;
        if (remainingMs < MIN_LAUNCH_MS) { giveUp(lastError || env.makeError("Deadline", "这次请求的总时限已到")); return; }
        const remainingSec = remainingMs / 1000;
        // 整段的重试预算：平均每块三次。所有节点都拒绝同一个地址时，不必让每块把每个节点都
        // 试两遍，早点交回原连接。
        if (plan.attempts >= plan.attemptBudget) {
          if (!running.length) plan.aborted = true;
          giveUp(lastError || env.makeError("Budget", "重试次数已用完"));
          return;
        }
        const host = nextHost();
        if (!host) { giveUp(lastError || env.makeError("NoHosts", "没有可用的 CDN 节点")); return; }
        const attempt = { host, at: now };
        running.push(attempt);
        plan.inflight += 1;
        plan.attempts += 1;
        if (isHedge) plan.hedges += 1;
        const drop = function () {
          const index = running.indexOf(attempt);
          if (index >= 0) running.splice(index, 1);
          plan.inflight -= 1;
        };
        const url = core.buildUrl(plan.parts, { host, port: "", scheme: plan.scheme });
        fetchPiece(url, piece, plan.headers, Math.min(plan.settings.attemptTimeoutSec, remainingSec)).then(function (result) {
          drop();
          markSuccess(plan.health, host, result.bytes.byteLength, result.elapsedMs);
          env.log("debug", "块 " + piece.index + " " + host.split(".")[0] + " " + Math.round(result.bytes.byteLength / 1024) + "KiB " + result.elapsedMs + "ms " + (result.bytes.byteLength / result.elapsedMs / 1000).toFixed(2) + "MB/s" + (settled ? "（副本落败）" : ""));
          if (settled) return;
          plan.usage[host] = (plan.usage[host] || 0) + 1;
          plan.pieceMs.push(result.elapsedMs);
          result.host = host;
          finish(true, result);
        }, function (error) {
          const waitedMs = Date.now() - attempt.at;
          drop();
          if (!error || HOST_ERRORS.indexOf(error.name) < 0) {
            plan.aborted = true;
            finish(false, error || env.makeError("ScriptError", "未知错误"));
            return;
          }
          markFailure(plan.health, host, error, piece.length, waitedMs, plan.originalHost);
          env.log("debug", "子块 " + piece.index + " 在 " + host + " 失败", error);
          lastError = error;
          if (!settled) launch(false);
        });
        scheduleHedge();
      }
      function scheduleHedge() {
        clearHedge();
        if (settled || !env.api.setTimeout || running.length >= plan.hedgeMax) return;
        timer = env.api.setTimeout(function () {
          timer = null;
          if (settled) return;
          // 到这里就已经能断定：还在途的这几次尝试，各自的节点这一块至少用了这么久。
          // 这是 $done 之前唯一一次能把「慢」记进节点记忆的机会。
          const at = Date.now();
          running.forEach(function (item) { markSlow(plan.health, item.host, piece.length, at - item.at); });
          // 整段同时在途的请求有上限，满了就不开副本，改为再等一个周期。
          if (running.length >= plan.hedgeMax) return;
          if (plan.inflight >= plan.maxInflight) { scheduleHedge(); return; }
          launch(true);
        }, hedgeDelayMs(plan, piece));
      }
      launch(false);
    });
  }

  // context: { parts, range, headers, settings, health }
  async function downloadRange(context) {
    const settings = context.settings;
    const startedAt = Date.now();
    const hosts = core.candidateHosts(context.parts.host, settings);
    if (!hosts.length) throw env.makeError("NoHosts", "当前模式下没有可用的 CDN 节点");
    const ordered = orderCandidates(hosts, context.health, settings.threads, context.parts.host);
    const pieces = core.splitRange(context.range.start, context.range.end, settings.threads, settings.minChunkBytes);
    const plan = {
      parts: context.parts,
      scheme: settings.subrequestScheme === "https" ? "https" : context.parts.scheme,
      headers: context.headers,
      settings,
      health: context.health,
      pool: ordered.pool,
      all: ordered.all,
      originalHost: context.parts.host,
      assignment: assignPieces(ordered.pool, context.health, pieces.length, context.parts.host),
      deadlineAt: startedAt + settings.deadlineMs,
      usage: {},
      attempts: 0,
      hedges: 0,
      pieceMs: [],
      attemptBudget: pieces.length * 3,
      // 每块最多两份副本；整段同时在途的上限由调用方按全局余量给出（脚本环境的上限约 20）。
      hedgeMax: 2,
      inflight: 0,
      maxInflight: Math.max(pieces.length, Math.trunc(Number(context.maxInflight)) || 16),
      aborted: false
    };
    // 分到的节点和领跑的不一样，那块就是去试探的：副本等得更短，不让它拖慢整段。
    pieces.forEach(function (piece, index) {
      piece.trial = Boolean(plan.assignment[index] && plan.assignment[index] !== plan.assignment[0]);
    });
    const tally = {};
    plan.assignment.forEach(function (host) { tally[host.split(".")[0]] = (tally[host.split(".")[0]] || 0) + 1; });
    env.log("debug", "拆成 " + pieces.length + " 块，分配", tally);
    // 到点就交回，不管还有几块在途。播放器（真机三份日志、三个版本一致）从发出请求算起
    // 大约只等 2.45 秒：在此之前交出去的每一段都被用了，在此之后交出去的每一段都被丢掉，
    // 然后它隔几秒再把同一段要一遍。所以拖过时限再拼好毫无价值，只会占着连接、
    // 把抽风时的坏样本继续写进节点记忆。直连是流式的，它的第一个字节几十到几百毫秒就到，
    // 在 1.9 秒交回原连接还赶得上播放器的耐心。
    let handover = null;
    const guard = new Promise(function (_resolve, reject) {
      if (!env.api.setTimeout) return;
      handover = env.api.setTimeout(function () {
        handover = null;
        plan.aborted = true;
        reject(env.makeError("Deadline", "这次请求的总时限已到，交回原连接"));
      }, Math.max(0, plan.deadlineAt - Date.now()));
    });
    let results;
    try {
      results = await Promise.race([Promise.all(pieces.map(function (piece) { return downloadPiece(piece, plan); })), guard]);
    } catch (error) {
      plan.aborted = true;
      throw error;
    } finally {
      if (handover !== null && env.api.clearTimeout) env.api.clearTimeout(handover);
    }
    let total = null;
    results.forEach(function (result) {
      if (result.total == null) return;
      if (total === null) total = result.total;
      else if (total !== result.total) throw env.makeError("TotalMismatch", "各节点报告的文件大小不一致：" + total + " 与 " + result.total);
    });
    if (total !== null && total <= context.range.end) throw env.makeError("TotalMismatch", "文件大小 " + total + " 小于请求的区间");
    const output = new Uint8Array(context.range.length);
    let offset = 0;
    results.forEach(function (result) {
      if (offset + result.bytes.byteLength > output.byteLength) throw env.makeError("BadLength", "拼接后超出请求长度");
      output.set(result.bytes, offset);
      offset += result.bytes.byteLength;
    });
    if (offset !== context.range.length) throw env.makeError("BadLength", "拼接后长度不符：" + offset + "/" + context.range.length);
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    // 整段的成绩记在「我们把这一段押给谁」头上，而不是最后谁交的块最多：押错了人就该算它的账，
    // 不然被副本救回来的慢段会被记成救场那个节点的成绩，慢的那个反而全身而退。
    markSegment(context.health, plan.assignment[0], context.range.length, elapsedMs);
    return {
      bytes: output,
      total,
      contentType: results[0].contentType,
      pieces: pieces.length,
      usage: plan.usage,
      attempts: plan.attempts,
      hedges: plan.hedges,
      leader: plan.assignment[0] || "",
      pieceMsMin: plan.pieceMs.length ? Math.min.apply(null, plan.pieceMs) : 0,
      pieceMsMax: plan.pieceMs.length ? Math.max.apply(null, plan.pieceMs) : 0,
      elapsedMs
    };
  }

  // 节点测速：用一个真实的签名地址，向指定节点同时开 parallel 条连接，各下 bytes 字节的不同区间，
  // 返回合计速度和每条连接的速度。parallel 为 1 就是单连接。设置页的测速表用它。
  // 多条连接合起来能不能超过单条，是判断多线程在这条线路上有没有意义的关键。
  async function probeHost(mediaUrl, host, headers, bytes, timeoutSec, health, parallel) {
    const parts = core.parseUrl(mediaUrl);
    if (!parts) throw env.makeError("BadUrl", "没有可用的视频地址");
    const url = core.buildUrl(parts, { host, port: "" });
    const size = Math.max(1, bytes);
    const lanes = Math.max(1, Math.min(16, Math.trunc(parallel) || 1));
    const startedAt = Date.now();
    const results = await Promise.all(Array.from({ length: lanes }, function (_item, index) {
      const piece = { index, start: index * size, end: (index + 1) * size - 1, length: size };
      return fetchPiece(url, piece, headers, timeoutSec).then(function (result) {
        if (health) markSuccess(health, host, result.bytes.byteLength, result.elapsedMs);
        return { ok: true, bytes: result.bytes.byteLength, elapsedMs: result.elapsedMs, bps: Math.round(result.bytes.byteLength * 1000 / result.elapsedMs) };
      }, function (error) {
        if (health && error && HOST_ERRORS.indexOf(error.name) >= 0) markFailure(health, host, error);
        return { ok: false, elapsedMs: Date.now() - startedAt, error: env.safeString(error).slice(0, 120) };
      });
    }));
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const okLanes = results.filter(function (item) { return item.ok; });
    const totalBytes = okLanes.reduce(function (sum, item) { return sum + item.bytes; }, 0);
    return {
      host,
      parallel: lanes,
      ok: okLanes.length === lanes,
      okLanes: okLanes.length,
      bytes: totalBytes,
      elapsedMs,
      // 合计速度按整体耗时算：这才是播放器实际能拿到的吞吐。
      bps: Math.round(totalBytes * 1000 / elapsedMs),
      laneBps: results.map(function (item) { return item.ok ? item.bps : 0; }),
      error: okLanes.length === lanes ? "" : results.filter(function (item) { return !item.ok; }).map(function (item) { return item.error; })[0]
    };
  }

  BTR.accelerator = Object.freeze({
    HEALTH_KEY,
    PUSHBACK_REST_MS,
    assignPieces,
    downloadRange,
    fetchPiece,
    hedgeDelayMs,
    loadHealth,
    chooseLeader,
    hostScore,
    markFailure,
    markSegment,
    markSlow,
    markSuccess,
    orderCandidates,
    probeHost,
    pushbackMs,
    saveHealth
  });
})(BTR);

/* src/settings.js */
// 设置与统计。设置页由脚本自己生成，在 Safari 里打开 http://btr.settings/ 就能看到；
// 表单用 GET 提交回同一个地址，脚本存进 $persistentStore。
(function (BTR) {
  "use strict";

  const core = BTR.core;
  const env = BTR.env;

  const SETTINGS_HOST = "btr.settings";
  const SETTINGS_KEY = "btr.settings";
  const STATS_KEY = "btr.stats";
  const ENV_KEY = "btr.env";
  const LOG_KEY = "btr.log";
  // 最近一次看到的视频分片地址（带签名）。只存在本机的持久存储里给测速用，两小时后作废；
  // 不进日志、不进诊断 JSON。
  const LAST_MEDIA_KEY = "btr.lastMedia";
  const LAST_MEDIA_TTL_MS = 2 * 60 * 60 * 1000;
  // 播放器等不到三秒就会重发同一段请求。刚开始拆的那段还没拼完时又来一份，第二份不再拆，
  // 单连接改走最快的节点，免得两份一起抢带宽。
  const INFLIGHT_KEY = "btr.inflight";
  const INFLIGHT_TTL_MS = 12 * 1000;
  const RECENT_LIMIT = 12;
  const LOG_LIMIT = 300;
  const LOG_LINE_LIMIT = 400;
  const LOG_BYTES_LIMIT = 48 * 1024;
  const AUTO_REFRESH_OPTIONS = [5, 15, 30];

  // 心跳：每次运行写下的最小记录，用来回答“脚本到底有没有在跑”和“存储到底存不存得住”。
  // 只有几十字节，统计和节点记忆写不进去的时候它通常还写得进去。
  const BEAT_KEY = "btr.beat";
  // 预取实验的结果单独放一把键：它的回调落在 $done 之后，万一环境把晚到的写入当成整份快照回写，
  // 也只会波及这把键，碰不到设置和统计。
  const PROBE_KEY = "btr.probe";
  // 存储自检写的临时键。
  const PROBE_STORE_KEY = "btr.storetest";

  const RESET_LABELS = {
    settings: "设置（恢复默认）",
    stats: "统计",
    health: "节点记忆",
    env: "环境判断",
    log: "日志",
    all: "全部（设置、统计、节点记忆、环境判断、日志）"
  };

  function loadRawSettings() {
    return env.store.readJson(SETTINGS_KEY, {});
  }

  // 设置的版本号。默认值变了的时候，老版本保存下来的旧默认值要让位给新默认值。
  const SETTINGS_REVISION = 7;

  function loadSettings() {
    const raw = loadRawSettings();
    const revision = Number(raw.revision) || 1;
    // 第 2 版：每块最小从 256 KiB 改成 128 KiB。第 1 版保存的 256 是当时的默认值，不是用户的选择。
    if (revision < 2 && Number(raw.minChunkKiB) === 256) delete raw.minChunkKiB;
    // 第 3 版：默认 CDN 模式从大陆改成自动。之前保存的“大陆”是当时的默认值。
    if (revision < 3 && raw.mode === "mainland") delete raw.mode;
    // 第 4 版：单个分片的总时限从 20 秒改成 10 秒。
    if (revision < 4 && Number(raw.deadlineSec) === 20) delete raw.deadlineSec;
    // 第 5 版：总时限 10 → 3 秒，单块尝试 6 → 4 秒。
    if (revision < 5 && Number(raw.deadlineSec) === 10) delete raw.deadlineSec;
    if (revision < 5 && Number(raw.attemptTimeoutSec) === 6) delete raw.attemptTimeoutSec;
    // 第 6 版：总时限 3 → 8 秒。3 秒是个错误，一次失败就没有重试的余地了。
    if (revision < 6 && Number(raw.deadlineSec) === 3) delete raw.deadlineSec;
    // 第 7 版：总时限改成毫秒计，默认 1.9 秒。8 秒是第 6 版的默认值；用户自己填过的换算过去。
    if (revision < 7 && raw.deadlineSec !== undefined) {
      if (Number(raw.deadlineSec) !== 8 && raw.deadlineMs === undefined) raw.deadlineMs = Number(raw.deadlineSec) * 1000;
      delete raw.deadlineSec;
    }
    return core.normalizeSettings(raw);
  }

  function saveSettings(settings) {
    const plain = {
      revision: SETTINGS_REVISION,
      enabled: settings.enabled,
      accelerate: settings.accelerate,
      mode: settings.mode,
      customHosts: settings.customHosts,
      threads: settings.threads,
      maxMiB: settings.maxMiB,
      minChunkKiB: settings.minChunkKiB,
      overfetchMiB: settings.overfetchMiB,
      swapSingle: settings.swapSingle,
      subrequestScheme: settings.subrequestScheme,
      attemptTimeoutSec: settings.attemptTimeoutSec,
      deadlineMs: settings.deadlineMs,
      debug: settings.debug
    };
    return env.store.writeJson(SETTINGS_KEY, plain);
  }

  function emptyStats() {
    return { since: Date.now(), seen: 0, accelerated: 0, rewritten: 0, passthrough: {}, bytes: 0, elapsedMs: 0, recent: [], schemes: {}, lastHttpAt: 0, lastHttpsAt: 0, patience: emptyPatience() };
  }

  // 播放器的耐心：我们交出去的段里，被用了的最慢一段花了多久，被丢掉的最快一段花了多久。
  // 这两个数夹住的就是播放器的超时线；它会不会随网络变，看这里最直接。
  function emptyPatience() {
    return { used: 0, usedMaxMs: 0, wasted: 0, wastedMinMs: 0 };
  }

  function loadStats() {
    const stored = env.store.readJson(STATS_KEY, null);
    if (!stored || typeof stored !== "object" || typeof stored.seen !== "number") return emptyStats();
    if (!stored.passthrough || typeof stored.passthrough !== "object") stored.passthrough = {};
    if (!Array.isArray(stored.recent)) stored.recent = [];
    if (!stored.schemes || typeof stored.schemes !== "object") stored.schemes = {};
    if (!stored.patience || typeof stored.patience !== "object") stored.patience = emptyPatience();
    return stored;
  }

  function saveStats(stats) {
    return env.store.writeJson(STATS_KEY, stats);
  }

  // 记下每个文件有多大：超量回传要把多下的那一段夹在文件末尾以内，而文件总长只有在
  // 第一次拼完分片、读到 Content-Range 的 /total 时才知道。只留最近几个文件。
  const SIZES_KEY = "btr.sizes";
  const SIZES_LIMIT = 6;
  const SIZES_TTL_MS = 6 * 60 * 60 * 1000;

  function loadSizes() {
    const stored = env.store.readJson(SIZES_KEY, null);
    return stored && typeof stored === "object" ? stored : {};
  }

  function knownTotal(path) {
    const item = loadSizes()[path];
    if (!item || Date.now() - (Number(item.at) || 0) > SIZES_TTL_MS) return 0;
    return Number(item.total) || 0;
  }

  function rememberTotal(path, total) {
    const size = Number(total) || 0;
    if (!path || size <= 0) return false;
    const sizes = loadSizes();
    sizes[path] = { total: size, at: Date.now() };
    const keys = Object.keys(sizes).sort(function (a, b) { return (Number(sizes[b].at) || 0) - (Number(sizes[a].at) || 0); });
    const kept = {};
    keys.slice(0, SIZES_LIMIT).forEach(function (key) { kept[key] = sizes[key]; });
    return env.store.writeJson(SIZES_KEY, kept);
  }

  function loadBeat() {
    const stored = env.store.readJson(BEAT_KEY, null);
    return stored && typeof stored === "object" ? stored : {};
  }

  // role: "media"（分片请求那次运行）或 "page"（设置页那次运行）。
  function recordBeat(role) {
    const beat = loadBeat();
    const now = Date.now();
    if (role === "media") {
      beat.mediaAt = now;
      beat.mediaN = (Number(beat.mediaN) || 0) + 1;
    } else {
      beat.pageAt = now;
      beat.pageN = (Number(beat.pageN) || 0) + 1;
    }
    beat.v = BTR.VERSION;
    return env.store.writeJson(BEAT_KEY, beat);
  }

  // 存储自检：分三层问清楚问题出在哪。有没有这个接口；写完能不能马上读回来；
  // 上一次运行写下的东西这次还在不在。第三项才是“统计一直清零”要看的那一项。
  const STORE_KEYS = [
    ["btr.settings", "设置"], ["btr.stats", "统计"], ["btr.health", "节点记忆"], ["btr.log", "日志"],
    ["btr.env", "环境判断"], ["btr.beat", "心跳"], ["btr.probe", "预取实验"], ["btr.delivered", "交付记录"],
    ["btr.lastMedia", "测速用地址"], ["btr.sizes", "文件大小记忆"], ["btr.inflight", "在途登记"], ["btr.busy", "全局在途"]
  ];

  function storeSelfTest() {
    const previous = env.store.readJson(PROBE_STORE_KEY, null);
    const token = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
    const wrote = env.store.writeJson(PROBE_STORE_KEY, { token, at: Date.now(), version: BTR.VERSION });
    const readBack = env.store.readJson(PROBE_STORE_KEY, null);
    return {
      available: env.capabilities().persistentStore,
      wrote: Boolean(wrote),
      sameRun: Boolean(readBack && readBack.token === token),
      previous: previous && previous.token ? { ageMs: Date.now() - (Number(previous.at) || 0), version: previous.version || "" } : null,
      keys: STORE_KEYS.map(function (item) {
        const text = env.store.read(item[0]);
        return { key: item[0], label: item[1], bytes: text ? text.length : 0 };
      })
    };
  }

  // entry: { at, kind, host, range, length, result, reason, elapsedMs, threads, hosts, error }
  function recordOutcome(stats, entry) {
    stats.seen += 1;
    if (entry.scheme) {
      stats.schemes[entry.scheme] = (stats.schemes[entry.scheme] || 0) + 1;
      if (entry.scheme === "https") stats.lastHttpsAt = entry.at;
      else if (entry.scheme === "http") stats.lastHttpAt = entry.at;
    }
    if (entry.result === "accelerated") {
      stats.accelerated += 1;
      stats.bytes += Number(entry.delivered) || Number(entry.length) || 0;
      stats.elapsedMs += Number(entry.elapsedMs) || 0;
    } else if (entry.result === "rewritten") {
      stats.rewritten += 1;
      stats.passthrough[entry.reason] = (stats.passthrough[entry.reason] || 0) + 1;
    } else {
      stats.passthrough[entry.reason] = (stats.passthrough[entry.reason] || 0) + 1;
    }
    const patience = stats.patience || (stats.patience = emptyPatience());
    if (Array.isArray(entry.usedMs)) {
      entry.usedMs.forEach(function (ms) {
        patience.used += 1;
        patience.usedMaxMs = Math.max(patience.usedMaxMs, ms);
      });
      delete entry.usedMs;
    }
    if (entry.redo > 0) {
      patience.wasted += 1;
      patience.wastedMinMs = patience.wastedMinMs ? Math.min(patience.wastedMinMs, entry.redo) : entry.redo;
    }
    stats.recent.unshift(entry);
    if (stats.recent.length > RECENT_LIMIT) stats.recent.length = RECENT_LIMIT;
  }

  // 最近交出去的段。播放器丢掉一段之后会在几秒内把同一段（偶尔从段中间某个位置起）再要一遍，
  // 所以一段交出去十五秒内没被再要，就算被用了。每段只记路径、区间、时刻、耗时。
  const DELIVERED_KEY = "btr.delivered";
  const DELIVERED_WINDOW_MS = 15 * 1000;
  const DELIVERED_LIMIT = 40;

  function loadDelivered() {
    const stored = env.store.readJson(DELIVERED_KEY, null);
    return Array.isArray(stored) ? stored : [];
  }

  function rememberDelivered(path, range, elapsedMs) {
    const list = loadDelivered();
    list.push({ path: String(path), start: range.start, end: range.end, at: Date.now(), ms: Math.round(elapsedMs) });
    while (list.length > DELIVERED_LIMIT) list.shift();
    env.store.writeJson(DELIVERED_KEY, list);
  }

  // 这个请求是不是在再要一段我们刚交出去的。返回 { redoMs, usedMs }：redoMs 是被丢的那份当时
  // 花了多久（0 表示不是再要）；usedMs 是这次顺手结算出来的、已经过了窗口没被再要的那些段的耗时。
  function noteRedo(path, range) {
    const now = Date.now();
    const list = loadDelivered();
    const usedMs = [];
    let redoMs = 0;
    const keep = list.filter(function (item) {
      if (now - item.at > DELIVERED_WINDOW_MS) { usedMs.push(item.ms); return false; }
      if (!redoMs && item.path === String(path) && range.start >= item.start && range.start <= item.end) { redoMs = item.ms; return false; }
      return true;
    });
    if (keep.length !== list.length) env.store.writeJson(DELIVERED_KEY, keep);
    return { redoMs, usedMs };
  }

  // 最近几次多线程请求的实测速度（字节每秒）。超量回传靠它估算“多给这么多还来不来得及”，
  // 用实测而不是单节点的理论速度，因为实测里已经含上了拆块、握手和副本的代价。
  function recentBps(stats, samples) {
    const list = (stats && Array.isArray(stats.recent) ? stats.recent : [])
      .filter(function (item) { return item && item.result === "accelerated" && Number(item.delivered || item.length) > 0 && Number(item.elapsedMs) > 0; })
      .slice(0, samples || 5);
    if (list.length < 2) return 0;
    const bytes = list.reduce(function (sum, item) { return sum + Number(item.delivered || item.length); }, 0);
    const ms = list.reduce(function (sum, item) { return sum + Number(item.elapsedMs); }, 0);
    return ms > 0 ? bytes * 1000 / ms : 0;
  }

  function loadLog() {
    const stored = env.store.readJson(LOG_KEY, null);
    return Array.isArray(stored) ? stored : [];
  }

  // 把这次运行的日志追加到持久存储，只留最近的几百行。
  function appendLog(lines, at) {
    if (!lines || !lines.length) return false;
    const stamp = formatTime(at || Date.now());
    const log = loadLog();
    lines.forEach(function (line) { log.push((stamp + " " + line).slice(0, LOG_LINE_LIMIT)); });
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
    // 再按总字节数收一次：一把键太大时，有的脚本环境会整个写不进去，那会把统计和设置一起拖下水。
    let size = log.reduce(function (sum, line) { return sum + line.length + 3; }, 0);
    while (log.length > 1 && size > LOG_BYTES_LIMIT) size -= log.shift().length + 3;
    return env.store.writeJson(LOG_KEY, log);
  }

  // 优先记画面分片的地址（文件大，测速时多路并发的偏移不会越界）；音轨地址只在没有画面地址时凑数。
  // 同时记下 App 自己用过的原节点，测速表把它们都列为基线。
  function rememberMedia(url, userAgent, kind, originalHost) {
    const current = loadLastMedia() || { originalHosts: [] };
    const hosts = Array.isArray(current.originalHosts) ? current.originalHosts.slice() : [];
    if (originalHost && hosts.indexOf(originalHost) < 0) hosts.unshift(originalHost);
    const keepCurrent = current.url && current.kind === "video" && kind !== "video";
    return env.store.writeJson(LAST_MEDIA_KEY, {
      url: keepCurrent ? current.url : url,
      kind: keepCurrent ? current.kind : kind || "",
      userAgent: userAgent || current.userAgent || "",
      originalHosts: hosts.slice(0, 4),
      at: Date.now()
    });
  }

  function loadLastMedia() {
    const stored = env.store.readJson(LAST_MEDIA_KEY, null);
    if (!stored || typeof stored.url !== "string" || Date.now() - (stored.at || 0) > LAST_MEDIA_TTL_MS) return null;
    if (!Array.isArray(stored.originalHosts)) stored.originalHosts = [];
    return stored;
  }

  function loadInflight() {
    const stored = env.store.readJson(INFLIGHT_KEY, null);
    const now = Date.now();
    const output = {};
    if (stored && typeof stored === "object") {
      Object.keys(stored).forEach(function (key) {
        if (now - (Number(stored[key]) || 0) < INFLIGHT_TTL_MS) output[key] = stored[key];
      });
    }
    return output;
  }

  // 返回 true 表示同一段已经在拆了。
  function claimInflight(key) {
    const inflight = loadInflight();
    if (inflight[key]) return true;
    inflight[key] = Date.now();
    env.store.writeJson(INFLIGHT_KEY, inflight);
    return false;
  }

  function releaseInflight(key) {
    const inflight = loadInflight();
    delete inflight[key];
    env.store.writeJson(INFLIGHT_KEY, inflight);
  }

  // 全局在途请求数：脚本环境一次最多约 20 个并发，超过就排队，排队会让所有节点一起“超时”。
  // 每次拆分前登记自己要开多少条，结束后注销；登记二十秒后自动作废，防止崩掉的运行占着名额。
  const BUSY_KEY = "btr.busy";
  const BUSY_TTL_MS = 20 * 1000;
  const GLOBAL_INFLIGHT_LIMIT = 14;

  function loadBusy() {
    const stored = env.store.readJson(BUSY_KEY, null);
    const now = Date.now();
    const output = {};
    if (stored && typeof stored === "object") {
      Object.keys(stored).forEach(function (key) {
        const item = stored[key];
        if (item && now - (Number(item.at) || 0) < BUSY_TTL_MS) output[key] = item;
      });
    }
    return output;
  }

  // 返回这次还能开几条连接（可能是 0）。
  function reserveBusy(runId, wanted) {
    const busy = loadBusy();
    const used = Object.keys(busy).reduce(function (sum, key) { return sum + (Number(busy[key].n) || 0); }, 0);
    const granted = Math.max(0, Math.min(wanted, GLOBAL_INFLIGHT_LIMIT - used));
    if (granted > 0) {
      busy[runId] = { n: granted, at: Date.now() };
      env.store.writeJson(BUSY_KEY, busy);
    }
    return { granted, used };
  }

  function releaseBusy(runId) {
    const busy = loadBusy();
    delete busy[runId];
    env.store.writeJson(BUSY_KEY, busy);
  }

  function loadEnvFlags() {
    const stored = env.store.readJson(ENV_KEY, null);
    return stored && typeof stored === "object" ? stored : {};
  }

  // 脚本自己是 http 版还是 https 版：模块脚本行的 argument=mode=… 告诉它。每次运行都记一下，
  // 设置页那次运行也带同样的参数，所以直接读就行；没有参数的老模块按看到过的协议推断。
  function currentMode(stats) {
    const declared = env.argumentValue("mode");
    if (declared === "https" || declared === "http") return { mode: declared, declared: true };
    return { mode: stats && stats.schemes && stats.schemes.https ? "https" : "http", declared: false };
  }

  // https 版装好了却没有 https 分片进来，多半是解密没生效：证书没装、没信任，或域名不在解密列表里。
  // 解密没生效时 https 分片压根到不了脚本，所以只能靠“缺席”判断：
  //   "recent"：最近十分钟收到过明文分片，却没有 https 分片，几乎可以肯定解密没生效；
  //   "never"：从来没收到过 https 分片，可能是还没播放，也可能是解密没生效，给一条常驻提示。
  function httpsProblem(mode, stats) {
    if (mode.mode !== "https" || !mode.declared) return "";
    const now = Date.now();
    const window = 10 * 60 * 1000;
    const httpRecently = stats.lastHttpAt && now - stats.lastHttpAt < window;
    const httpsRecently = stats.lastHttpsAt && now - stats.lastHttpsAt < window;
    if (httpsRecently) return "";
    if (httpRecently) return "recent";
    if (!stats.lastHttpsAt) return "never";
    return "";
  }

  function shortHost(host) {
    return String(host || "").replace(/\.(bilivideo\.(com|cn|net)|akamaized\.net)$/i, "");
  }

  function saveEnvFlags(flags) {
    return env.store.writeJson(ENV_KEY, flags);
  }

  function parseQuery(query) {
    const output = {};
    String(query || "").replace(/^\?/, "").split("&").forEach(function (pair) {
      if (!pair) return;
      const index = pair.indexOf("=");
      const rawKey = index >= 0 ? pair.slice(0, index) : pair;
      const rawValue = index >= 0 ? pair.slice(index + 1) : "";
      let key;
      let value;
      try { key = decodeURIComponent(rawKey.replace(/\+/g, " ")); } catch (_error) { key = rawKey; }
      try { value = decodeURIComponent(rawValue.replace(/\+/g, " ")); } catch (_error) { value = rawValue; }
      output[key] = value;
    });
    return output;
  }

  function settingsFromQuery(query) {
    const truthy = function (value) { return value === "1" || value === "on" || value === "true"; };
    return core.normalizeSettings({
      enabled: truthy(query.enabled),
      accelerate: query.accelerate,
      mode: query.mode,
      customHosts: String(query.customHosts || "").split(/[\s,;]+/),
      threads: Number(query.threads),
      maxMiB: Number(query.maxMiB),
      minChunkKiB: Number(query.minChunkKiB),
      overfetchMiB: Number(query.overfetchMiB),
      swapSingle: truthy(query.swapSingle),
      subrequestScheme: query.subrequestScheme,
      attemptTimeoutSec: Number(query.attemptTimeoutSec),
      deadlineMs: Number(query.deadlineMs),
      debug: truthy(query.debug)
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024 * 1024) return (value / 1024 / 1024 / 1024).toFixed(2) + " GiB";
    if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + " MiB";
    if (value >= 1024) return (value / 1024).toFixed(0) + " KiB";
    return value + " B";
  }

  function formatSpeed(bps) {
    const value = Number(bps) || 0;
    if (!value) return "-";
    // 速度统一按十进制 MB/s（1 MB = 1000000 字节），跟测速软件、运营商的口径一致（乘 8 就是 Mbps）。
    return (value / 1e6).toFixed(2) + " MB/s";
  }

  function formatTime(at) {
    if (!at) return "-";
    const date = new Date(at);
    const pad = function (number) { return (number < 10 ? "0" : "") + number; };
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  const REASON_LABELS = {
    ok: "已加速",
    disabled: "已停用",
    notGet: "不是 GET 请求",
    notMedia: "不是可换节点的视频地址",
    noRange: "没有 Range 头",
    openRange: "开区间 Range（bytes=a-）",
    unsupportedRange: "不支持的 Range 写法",
    tooSmall: "区间太小，不值得拆",
    tooLarge: "区间超过上限",
    duplicate: "同一段还在拆，重发的这份不再拆",
    busy: "同时在途的请求已到上限，这份不拆",
    splitOff: "设置为只换节点",
    binaryUnsupported: "环境不支持二进制响应",
    failed: "多线程下载失败，已交回原连接",
    scriptError: "脚本或环境出错，已交回原连接（请把日志发到 Issue）",
    error: "脚本出错，已交回原连接",
    deadline: "超过总时限"
  };

  const RESULT_LABELS = { accelerated: "多线程", rewritten: "只换节点", passthrough: "原样放过" };

  // 「用了的最慢 2392 ms · 丢了的最快 2535 ms」。两个数夹住的就是播放器的超时线。
  function patienceText(patience) {
    const p = patience || emptyPatience();
    if (!p.used && !p.wasted) return "还没量到";
    const parts = [];
    if (p.used) parts.push("用了的最慢 " + p.usedMaxMs + " ms");
    if (p.wasted) parts.push("丢了的最快 " + p.wastedMinMs + " ms");
    return parts.join(" · ");
  }

  function patienceNote(patience) {
    const p = patience || emptyPatience();
    if (!p.used && !p.wasted) return "交出去的段被用了还是被丢了，播一会儿就有数";
    return "被用 " + p.used + " 段，被丢 " + p.wasted + " 段。总时限应明显低于「丢了的最快」";
  }

  function renderPage(state) {
    const settings = state.settings;
    const stats = state.stats;
    const health = state.health;
    const flags = state.flags;
    const capabilities = state.capabilities;
    const hosts = core.hostsForMode(settings);
    const now = Date.now();
    const avgSpeed = stats.elapsedMs ? stats.bytes * 1000 / stats.elapsedMs : 0;
    const checked = function (flag) { return flag ? " checked" : ""; };
    const selected = function (flag) { return flag ? " selected" : ""; };
    const reasonRows = Object.keys(stats.passthrough).sort().map(function (reason) {
      return "<tr><td>" + escapeHtml(REASON_LABELS[reason] || reason) + "</td><td class=num>" + stats.passthrough[reason] + "</td></tr>";
    }).join("");
    const hostCell = function (host) {
      return "<td class=host><abbr title=\"" + escapeHtml(host) + "\">" + escapeHtml(shortHost(host)) + "</abbr></td>";
    };
    const healthRows = Object.keys(health.hosts).sort().map(function (host) {
      const record = health.hosts[host];
      const hostState = (record.blockedUntil || 0) > now ? "退避中" : record.okAt ? "正常" : record.failAt ? "失败过" : "未知";
      const lastError = String(record.lastError || "");
      return "<tr>" + hostCell(host) + "<td>" + hostState + "</td><td class=num>" + formatSpeed(record.bps) + "</td><td class=num>" + (record.fails || 0) + "</td><td class=err><abbr title=\"" + escapeHtml(lastError) + "\">" + escapeHtml(lastError.length > 36 ? lastError.slice(0, 36) + "…" : lastError) + "</abbr></td></tr>";
    }).join("");
    const recentRows = stats.recent.map(function (entry) {
      const usage = entry.hosts ? Object.keys(entry.hosts).map(function (host) { return shortHost(host).replace(/^upos-sz-/, "") + "×" + entry.hosts[host]; }).join(" ") : "";
      const speed = entry.result === "accelerated" && entry.elapsedMs ? formatSpeed(entry.length * 1000 / entry.elapsedMs) : "";
      const pathText = entry.path ? String(entry.path).split("/").pop() : "";
      return "<tr><td class=num>" + formatTime(entry.at) + "</td><td>" + escapeHtml(entry.kind === "audio" ? "音" : entry.kind === "video" ? "画" : "?") + "</td>"
        + "<td class=host><abbr title=\"" + escapeHtml((entry.scheme || "") + "://" + (entry.host || "") + (entry.path || "")) + "\">" + escapeHtml((entry.scheme === "https" ? "🔒 " : "") + shortHost(entry.host)) + (pathText ? "<br><small>" + escapeHtml(pathText) + "</small>" : "") + "</abbr></td>"
        + "<td class=num>" + escapeHtml(entry.range || "") + (entry.length ? "<br><small>" + formatBytes(entry.length) + "</small>" : "") + "</td>"
        + "<td>" + escapeHtml(RESULT_LABELS[entry.result] || entry.result || "") + (entry.reason && entry.reason !== "ok" ? "<br><small>" + escapeHtml(REASON_LABELS[entry.reason] || entry.reason) + "</small>" : "") + (entry.error ? "<br><small>" + escapeHtml(entry.error) + "</small>" : "") + "</td>"
        + "<td class=num>" + (entry.elapsedMs || 0) + " ms" + (speed ? "<br><small>" + speed + "</small>" : "") + (entry.threads ? "<br><small>" + entry.threads + " 块 " + escapeHtml(usage) + "</small>" : "") + "</td></tr>";
    }).join("");
    const message = state.message ? "<div class=notice>" + escapeHtml(state.message) + "</div>" : "";
    const mode = currentMode(stats);
    const modeBadge = "<span class=\"badge" + (mode.mode === "https" ? " on" : "") + "\">" + (mode.mode === "https" ? "http + https 模式" : "http 明文模式") + "</span>";
    const problem = httpsProblem(mode, stats);
    const httpsWarning = problem
      ? "<div class=" + (problem === "recent" ? "warn" : "sub") + " style=\"" + (problem === "recent" ? "" : "background:#eef1f6;border-radius:10px;padding:10px 14px;margin:12px 0") + "\"><b>"
        + (problem === "recent"
          ? "https 版已装好，但最近十分钟只收到了明文分片，没有任何 https 分片。"
          : "https 版已启用，但脚本还没收到过任何 https 分片。")
        + "</b>" + (problem === "recent" ? "几乎可以肯定 HTTPS 解密没有真正生效。" : "如果你已经播放过视频，说明解密没有生效；解密没生效时 https 分片根本到不了脚本，这里不会有任何记录。") + "逐项检查："
        + "<ol style=\"margin:8px 0 0;padding-left:20px\">"
        + "<li>配置 → 点当前配置文件右侧的 ⓘ → HTTPS 解密：开关是否打开。</li>"
        + "<li>同一页「域名」列表里必须有 <code>*.bilivideo.com</code>、<code>*.bilivideo.cn</code>、<code>*.bilivideo.net</code>、<code>*.akamaized.net</code>。只有 <code>*.bilibili.com</code> 是不够的，视频分片不走那个域名。</li>"
        + "<li>同一页「证书」→ 生成新的 CA 证书 → 安装证书；然后 系统设置 → 已下载描述文件 → 安装。</li>"
        + "<li>系统设置 → 通用 → 关于本机 → 证书信任设置 → 打开 Shadowrocket 的证书。</li>"
        + "<li>做完后在 数据 → 代理 里看 <code>upos-</code> 的 443 连接是否变成 <code>https://upos-…/upgcxcode/…</code> 的完整地址。</li>"
        + "</ol>如果证书都装好了，App 的 https 分片仍然全部放不出来，说明 App 对视频域名做了证书固定，请改回 http 版。</div>"
      : "";
    const logText = loadLog().join("\n");
    const diagText = JSON.stringify({ version: BTR.VERSION, capabilities, settings, flags, stats, health, log: loadLog() }, null, 2);
    const auto = AUTO_REFRESH_OPTIONS.indexOf(state.autoRefresh) >= 0 ? state.autoRefresh : 0;
    const refreshMeta = auto ? "<meta http-equiv=\"refresh\" content=\"" + auto + ";url=/?auto=" + auto + "\">" : "";
    const refreshLinks = "<div class=sub>自动刷新：" + (auto ? "<a href=\"/\">关</a>" : "<b>关</b>") + AUTO_REFRESH_OPTIONS.map(function (seconds) {
      return " · " + (auto === seconds ? "<b>" + seconds + " 秒</b>" : "<a href=\"/?auto=" + seconds + "\">" + seconds + " 秒</a>");
    }).join("") + "</div>";
    const beat = state.beat || {};
    const mediaRuns = Number(beat.mediaN) || 0;
    const pageOpens = Number(beat.pageN) || 0;
    const warnings = [];
    if (!capabilities.persistentStore) warnings.push("这个环境没有 $persistentStore，设置和统计都保存不了。");
    // 心跳记到分片脚本跑过，统计却读不回来：数据没保存下来，不是脚本没跑。
    else if (!state.statsStored && mediaRuns > 0) warnings.push("分片脚本运行过 " + mediaRuns + " 次，统计却读不回来：持久存储没有把数据保存下来。点下面的「存储自检」看是哪一层断了。");
    else if (pageOpens <= 1) warnings.push("这是记到的第 " + pageOpens + " 次打开设置页。刷新一下，这个数字应该变成 " + (pageOpens + 1) + "；如果一直不涨，说明存储没有生效，统计当然也会一直是 0。");
    if (!capabilities.httpClient) warnings.push("这个环境没有 $httpClient，脚本无法发起下载。");
    if (!capabilities.timers) warnings.push("这个环境没有 setTimeout，子请求只能依赖环境自身的超时。");
    if (flags.binaryUnsupported) warnings.push("之前检测到脚本环境把二进制响应当成了文本，现在只换节点、不拆分。修好后点下面的“重新检测环境”。");
    const warningHtml = warnings.length ? "<div class=warn>" + warnings.map(escapeHtml).join("<br>") + "</div>" : "";

    return "<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">"
      + refreshMeta
      + "<title>线程撕裂者 · 移动端设置</title>"
      + "<style>"
      + "body{margin:0;padding:16px;font:15px/1.5 -apple-system,\"PingFang SC\",\"Helvetica Neue\",sans-serif;background:#f4f5f7;color:#18191c}"
      + "h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}"
      + ".sub{color:#61666d;font-size:13px}.card{background:#fff;border-radius:12px;padding:14px 16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.06)}"
      + "label.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #eee}label.row:last-child{border-bottom:0}"
      + "label.row span{flex:1}label.row small{display:block;color:#9499a0;font-size:12px}"
      + "select,input[type=number]{font:inherit;padding:6px 8px;border:1px solid #d0d3d9;border-radius:8px;min-width:96px;background:#fff}"
      + "textarea{width:100%;box-sizing:border-box;font:13px/1.4 ui-monospace,Menlo,monospace;padding:8px;border:1px solid #d0d3d9;border-radius:8px;min-height:72px}"
      + "input[type=checkbox]{width:22px;height:22px}"
      + "button,.btn{display:inline-block;font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:10px;background:#fb7299;color:#fff;text-decoration:none;margin:6px 6px 0 0}"
      + ".btn.secondary{background:#e3e5e7;color:#18191c}"
      + ".scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -16px;padding:0 16px}"
      + "table{width:100%;min-width:560px;border-collapse:collapse;font-size:13px}th,td{padding:6px 6px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{color:#61666d;font-weight:500;white-space:nowrap}"
      + "td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}td.host{white-space:nowrap}td.err{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}abbr{text-decoration:none}"
      + "code{font:12px ui-monospace,Menlo,monospace;background:#f1f2f3;padding:1px 4px;border-radius:4px}"
      + ".copied{color:#0c6b3b;font-size:13px;margin-left:8px}"
      + ".copybox{width:100%;box-sizing:border-box;height:140px;margin-top:6px;font:11px/1.4 ui-monospace,Menlo,monospace;padding:8px;border:1px solid #d0d3d9;border-radius:8px;background:#fafbfc;-webkit-user-select:text;user-select:text}summary{cursor:pointer}"
      + ".notice{background:#e6f7ee;color:#0c6b3b;border-radius:10px;padding:10px 14px;margin:12px 0}.warn{background:#fff3e0;color:#8a4b00;border-radius:10px;padding:10px 14px;margin:12px 0}"
      + ".kv{display:grid;grid-template-columns:1fr 1fr;gap:8px}.kv div{background:#f7f8fa;border-radius:10px;padding:10px}.kv b{display:block;font-size:20px}.kv small{color:#61666d}"
      + ".badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#e3e5e7}.badge.on{background:#fb7299;color:#fff}"
      + "</style></head><body>"
      + "<h1>Bilibili 线程撕裂者 <span class=badge" + (settings.enabled ? " on" : "") + ">" + (settings.enabled ? "已启用" : "已停用") + "</span> " + modeBadge + "</h1>"
      + "<div class=sub>移动端 · Shadowrocket 脚本 · 版本 " + escapeHtml(BTR.VERSION)
      + (mode.declared ? "" : " · 模块没有声明模式，按看到过的协议推断") + "</div>"
      + refreshLinks
      + message + httpsWarning + warningHtml
      + "<div class=card><div class=kv>"
      + "<div><small>看到的分片请求</small><b>" + stats.seen + "</b></div>"
      + "<div><small>多线程完成</small><b>" + stats.accelerated + "</b></div>"
      + "<div><small>只换了节点</small><b>" + stats.rewritten + "</b></div>"
      + "<div><small>多线程平均速度</small><b>" + formatSpeed(avgSpeed) + "</b></div>"
      + "<div><small>多线程下载量</small><b>" + formatBytes(stats.bytes) + "</b></div>"
      + "<div><small>统计开始于" + (state.statsStored ? "" : "（这次新建的）") + "</small><b>" + formatTime(stats.since) + "</b></div>"
      + "<div><small>分片脚本运行过</small><b>" + mediaRuns + " 次</b>" + (beat.mediaAt ? "<small>最后一次 " + formatTime(beat.mediaAt) + "</small>" : "<small>还没跑过</small>") + "</div>"
      + "<div><small>设置页打开过</small><b>" + pageOpens + " 次</b><small>刷新一次应当 +1</small></div>"
      + "<div><small>播放器的耐心</small><b>" + patienceText(stats.patience) + "</b><small>" + patienceNote(stats.patience) + "</small></div>"
      + "</div></div>"
      + "<form class=card method=get action=\"/save\">"
      + "<h2 style=\"margin-top:0\">设置</h2>"
      + "<label class=row><span>启用加速<small>关掉后所有请求原样放过</small></span><input type=checkbox name=enabled value=1" + checked(settings.enabled) + "></label>"
      + "<label class=row><span>加速方式<small>多线程出问题时先退回“只换节点”排查</small></span><select name=accelerate>"
      + "<option value=split" + selected(settings.accelerate === "split") + ">多线程拆分</option>"
      + "<option value=swap" + selected(settings.accelerate === "swap") + ">只换节点</option></select></label>"
      + "<label class=row><span>CDN 模式<small>自动：App 原本的节点加全部大陆、海外节点一起测速，只用最快的几个。哪组快因网络而异，先跑一次节点测速</small></span><select name=mode>"
      + "<option value=auto" + selected(settings.mode === "auto") + ">自动（按测速）</option>"
      + "<option value=mainland" + selected(settings.mode === "mainland") + ">大陆 CDN</option>"
      + "<option value=overseas" + selected(settings.mode === "overseas") + ">海外 CDN</option>"
      + "<option value=custom" + selected(settings.mode === "custom") + ">自定义</option></select></label>"
      + "<label class=row style=\"display:block\"><span>自定义节点<small>每行一个主机名，只在自定义模式下生效；留空时按大陆 CDN。当前模式的候选：" + escapeHtml(hosts.join("、")) + "</small></span><textarea name=customHosts placeholder=\"upos-sz-mirrorali.bilivideo.com\">" + escapeHtml(settings.customHosts.join("\n")) + "</textarea></label>"
      + "<label class=row><span>并发线程<small>一个分片最多拆成几块同时下载</small></span><select name=threads>"
      + core.THREAD_OPTIONS.map(function (option) { return "<option value=" + option + selected(settings.threads === option) + ">" + option + "</option>"; }).join("")
      + "</select></label>"
      + "<label class=row><span>单个分片上限 (MiB)<small>整个分片要先在内存里拼好，超过就不拆</small></span><input type=number name=maxMiB min=2 max=24 step=1 value=" + settings.maxMiB + "></label>"
      + "<label class=row><span>每块最小 (KiB)<small>块太小时请求往返占大头</small></span><input type=number name=minChunkKiB min=64 max=1024 step=64 value=" + settings.minChunkKiB + "></label>"
      + "<label class=row><span>超量回传（实验）<small>App 要 1 MiB，就多下这么多一起交给它。真机已验证脚本交出响应之后发不出请求，预读只能这样做；播放器不认就会卡住或花屏，遇到就调回“关”</small></span><select name=overfetchMiB>"
      + core.OVERFETCH_OPTIONS.map(function (value) { return "<option value=" + value + selected(settings.overfetchMiB === value) + ">" + (value ? "多给 " + value + " MiB" : "关") + "</option>"; }).join("")
      + "</select></label>"
      + "<label class=row><span>不拆分的请求也换节点<small>没有 Range、开区间或太大太小的请求，单连接改走当前模式最快的节点</small></span><input type=checkbox name=swapSingle value=1" + checked(settings.swapSingle) + "></label>"
      + "<label class=row><span>子请求协议<small>App 的分片是明文 http；有些网络对 http 干扰大时可以试 https</small></span><select name=subrequestScheme>"
      + "<option value=keep" + selected(settings.subrequestScheme === "keep") + ">跟原地址一样</option>"
      + "<option value=https" + selected(settings.subrequestScheme === "https") + ">强制 https</option></select></label>"
      + "<label class=row><span>单块超时 (秒)</span><input type=number name=attemptTimeoutSec min=3 max=30 step=1 value=" + settings.attemptTimeoutSec + "></label>"
      + "<label class=row><span>单个分片总时限 (毫秒)<small>到点不管还差几块，一律交回原连接。播放器大约只等 2.45 秒（见上面「播放器的耐心」），拖过去再拼好也会被丢掉；直连的第一个字节很快就到，所以要留出余量</small></span><input type=number name=deadlineMs min=800 max=40000 step=100 value=" + settings.deadlineMs + "></label>"
      + "<label class=row><span>调试日志<small>在 Shadowrocket 的脚本日志里看每块的去向</small></span><input type=checkbox name=debug value=1" + checked(settings.debug) + "></label>"
      + "<button type=submit>保存</button>"
      + "</form>"
      + "<div class=card><h2 style=\"margin-top:0\">节点记忆</h2>"
      + (healthRows ? "<div class=scroll><table><tr><th>节点</th><th>状态</th><th>速度</th><th>连败</th><th>最近错误</th></tr>" + healthRows + "</table></div><div class=sub style=\"margin-top:6px\">节点名省略了 .bilivideo.com 后缀，长按可看全名；表格可以左右滑动。</div>" : "<div class=sub>还没有节点数据。播放一个视频后再来看。</div>")
      + "</div>"
      + "<div class=card><h2 style=\"margin-top:0\">放过原因</h2>"
      + (reasonRows ? "<table>" + reasonRows + "</table>" : "<div class=sub>暂无</div>")
      + "</div>"
      + "<div class=card><h2 style=\"margin-top:0\">最近请求</h2>"
      + (recentRows ? "<div class=scroll><table><tr><th>时间</th><th></th><th>原节点</th><th>Range</th><th>结果</th><th>耗时</th></tr>" + recentRows + "</table></div>" : "<div class=sub>暂无。打开 B 站 App 播放一个视频，再刷新这个页面。</div>")
      + "</div>"
      + "<div class=card><h2 style=\"margin-top:0\">复制</h2>"
      + "<div class=sub>点按钮复制到剪贴板。这个页面是 http，iOS 有时不允许网页写剪贴板；那时按钮会把下面文本框里的内容全选好，再点系统弹出的「拷贝」即可。都不含签名地址和 Cookie。</div>"
      + "<button type=button data-copy=log>复制日志</button>"
      + "<button type=button data-copy=diag>复制诊断 JSON</button><span class=copied id=copied></span>"
      + "<details id=box-log style=\"margin-top:10px\"><summary class=sub>日志文本（" + loadLog().length + " 行）</summary><textarea id=copy-log class=copybox readonly>" + escapeHtml(logText) + "</textarea></details>"
      + "<details id=box-diag style=\"margin-top:6px\"><summary class=sub>诊断 JSON 文本</summary><textarea id=copy-diag class=copybox readonly>" + escapeHtml(diagText) + "</textarea></details>"
      + "<script>(function(){var tip=document.getElementById('copied');"
      + "function selectAll(ta){ta.readOnly=false;ta.contentEditable='true';ta.focus();var range=document.createRange();range.selectNodeContents(ta);var sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);ta.setSelectionRange(0,ta.value.length);}"
      + "function restore(ta){ta.readOnly=true;ta.contentEditable='false';}"
      + "function attempt(kind){var ta=document.getElementById('copy-'+kind);var box=document.getElementById('box-'+kind);box.open=true;var ok=false;try{selectAll(ta);ok=document.execCommand('copy');}catch(e){ok=false;}"
      + "if(ok){restore(ta);try{window.getSelection().removeAllRanges();}catch(e){}tip.textContent='已复制';setTimeout(function(){tip.textContent='';},2500);}"
      + "else{tip.textContent='已全选，请点系统弹出的「拷贝」';setTimeout(function(){restore(ta);tip.textContent='';},8000);}}"
      + "[].forEach.call(document.querySelectorAll('button[data-copy]'),function(btn){btn.addEventListener('click',function(){attempt(btn.getAttribute('data-copy'));});});})();</script>"
      + "</div>"
      + "<div class=card><h2 style=\"margin-top:0\">操作</h2>"
      + "<a class=\"btn secondary\" href=\"/reset?what=stats\">清空统计</a>"
      + "<a class=\"btn secondary\" href=\"/reset?what=health\">清空节点记忆</a>"
      + "<a class=\"btn secondary\" href=\"/reset?what=env\">重新检测环境</a>"
      + "<a class=\"btn secondary\" href=\"/speedtest\">节点测速</a>"
      + "<a class=\"btn secondary\" href=\"/probe/after-done\">预取实验</a>"
      + "<a class=\"btn secondary\" href=\"/log.txt\">查看日志</a>"
      + "<a class=\"btn secondary\" href=\"/reset?what=log\">清空日志</a>"
      + "<a class=\"btn secondary\" href=\"/store/test\">存储自检</a>"
      + "<a class=\"btn secondary\" href=\"/diag.json\">诊断 JSON</a>"
      + "<a class=\"btn secondary\" href=\"/reset?what=settings\">恢复默认设置</a>"
      + "<a class=\"btn secondary\" href=\"/reset?what=all\">全部重置</a>"
      + "</div>"
      + "<div class=sub style=\"margin:20px 0\">这个页面由脚本本地生成，不联网。地址栏里的 btr.settings 不是真实域名。<br>原作：<a href=\"https://github.com/MrTangLuyao/Bilibili-thread-ripper\">MrTangLuyao/Bilibili-thread-ripper</a>（MIT）。移植：<a href=\"https://github.com/vic233333/Bilibili-thread-ripper-mobile\">vic233333/Bilibili-thread-ripper-mobile</a>。</div>"
      + "</body></html>";
  }

  // 测速页：每个节点一行，页面里的脚本逐个请求 /speedtest/run?host=…，把结果填进表格。
  // 每次 run 都是一次独立的脚本运行，不会撞上设置页脚本的 10 秒时限。
  function renderSpeedtest(settings, lastMedia) {
    const original = lastMedia ? core.parseUrl(lastMedia.url) : null;
    const originals = [];
    if (original) originals.push(original.host);
    (lastMedia && lastMedia.originalHosts || []).forEach(function (host) { if (originals.indexOf(host) < 0) originals.push(host); });
    const hosts = originals.slice();
    core.MAINLAND_HOSTS.concat(core.OVERSEAS_HOSTS, settings.customHosts).forEach(function (host) { if (hosts.indexOf(host) < 0) hosts.push(host); });
    const rows = hosts.map(function (host) {
      const label = originals.indexOf(host) >= 0 ? "<br><small>App 原本用的节点（基线）</small>" : core.MAINLAND_HOSTS.indexOf(host) >= 0 ? "<br><small>大陆</small>" : core.OVERSEAS_HOSTS.indexOf(host) >= 0 ? "<br><small>海外</small>" : "<br><small>自定义</small>";
      return "<tr data-host=\"" + escapeHtml(host) + "\"><td class=host>" + escapeHtml(host) + label + "</td><td class=num data-cell=ms>-</td><td class=num data-cell=speed>-</td><td data-cell=note>等待</td></tr>";
    }).join("");
    const body = !original
      ? "<div class=warn>还没有可用的视频地址。先在 B 站 App 里播放一个视频，再回到这里。地址两小时内有效。</div>"
      : "<div class=sub>用最近一次" + (lastMedia.kind === "video" ? "画面" : "音轨") + "分片的地址，向每个节点下载 256 KiB，逐个节点进行。前几行是 App 自己用过的节点，也就是不装脚本时的基线；其余是脚本会换到的节点。测速也会更新“节点记忆”里的速度。</div>"
        + "<div class=sub style=\"margin:8px 0\">并发数：<select id=lanes><option value=1>单连接</option><option value=4>4 路并发</option><option value=8 selected>8 路并发</option></select>"
        + "　每路大小：<select id=bytes><option value=131072>128 KiB</option><option value=262144 selected>256 KiB</option><option value=1048576>1 MiB</option><option value=2097152>2 MiB</option></select>"
        + "<br>并发档位下“速度”是几条连接合起来的吞吐。<b>同一节点 8 路合计明显高于单连接，多线程才有意义；合计和单连接差不多，说明线路有总带宽上限。</b>"
        + "<br>单连接下 1 MiB 的速度远高于 256 KiB，说明每个新连接的握手和慢启动占了大头，那就该拆得更大、更少，或者干脆只换节点不拆。</div>"
        + "<table><tr><th>节点</th><th>耗时</th><th>速度</th><th>结果</th></tr>" + rows + "</table>"
        + "<button id=again type=button style=\"margin-top:12px\">开始测速</button>"
        + "<script>(function(){var rows=[].slice.call(document.querySelectorAll('tr[data-host]'));var btn=document.getElementById('again');var lanes=document.getElementById('lanes');var bytes=document.getElementById('bytes');function fmt(b){return b?(b/1e6).toFixed(2)+' MB/s':'-';}"
        + "function run(i){if(i>=rows.length){btn.disabled=false;lanes.disabled=false;bytes.disabled=false;return;}var row=rows[i];var host=row.getAttribute('data-host');row.querySelector('[data-cell=note]').textContent='测速中…';"
        + "fetch('/speedtest/run?host='+encodeURIComponent(host)+'&bytes='+bytes.value+'&parallel='+lanes.value,{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){row.querySelector('[data-cell=ms]').textContent=(d.elapsedMs||0)+' ms';row.querySelector('[data-cell=speed]').textContent=d.okLanes?fmt(d.bps)+(d.parallel>1?' 合计':''):'-';"
        + "var per=(d.laneBps||[]).filter(function(x){return x>0;}).map(function(x){return (x/1e6).toFixed(2);});row.querySelector('[data-cell=note]').textContent=d.ok?(d.parallel>1?'正常，每路 '+per.join('/')+' MB/s':'正常'):(d.okLanes?d.okLanes+'/'+d.parallel+' 路成功，'+(d.error||''):(d.error||'失败'));}).catch(function(e){row.querySelector('[data-cell=note]').textContent='请求失败：'+e;}).then(function(){run(i+1);});}"
        + "btn.addEventListener('click',function(){btn.disabled=true;lanes.disabled=true;bytes.disabled=true;rows.forEach(function(r){r.querySelector('[data-cell=ms]').textContent='-';r.querySelector('[data-cell=speed]').textContent='-';r.querySelector('[data-cell=note]').textContent='等待';});run(0);});})();</script>";
    return "<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>节点测速</title>"
      + "<style>body{margin:0;padding:16px;font:15px/1.5 -apple-system,\"PingFang SC\",sans-serif;background:#f4f5f7;color:#18191c}h1{font-size:20px;margin:0 0 8px}.sub{color:#61666d;font-size:13px;margin-bottom:12px}.warn{background:#fff3e0;color:#8a4b00;border-radius:10px;padding:10px 14px}table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:12px}th,td{padding:8px 6px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{color:#61666d;font-weight:500}td.num{text-align:right;white-space:nowrap}td.host{word-break:break-all}small{color:#9499a0}button{font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:10px;background:#fb7299;color:#fff}button:disabled{opacity:.5}a{color:#fb7299}</style></head><body>"
      + "<h1>节点测速</h1><div class=sub><a href=\"/\">← 返回设置</a></div>" + body + "</body></html>";
  }

  async function runSpeedtest(query) {
    const lastMedia = loadLastMedia();
    const host = core.normalizeCdnHost(query.host);
    if (!lastMedia) return jsonResponse({ ok: false, error: "还没有可用的视频地址，先播放一个视频" });
    if (!host) return jsonResponse({ ok: false, error: "节点名不合法" });
    const bytes = Math.max(64 * 1024, Math.min(2 * 1024 * 1024, Math.trunc(Number(query.bytes)) || 256 * 1024));
    const parallel = Math.max(1, Math.min(16, Math.trunc(Number(query.parallel)) || 1));
    // 单次测速的总量不超过 8 MiB，脚本环境的内存有限。
    if (bytes * parallel > 8 * 1024 * 1024) return jsonResponse({ ok: false, error: "并发数乘每路大小不能超过 8 MiB" });
    const headers = { "Accept-Encoding": "identity", "X-BTR-Sub": "1" };
    if (lastMedia.userAgent) headers["User-Agent"] = lastMedia.userAgent;
    const health = BTR.accelerator.loadHealth();
    const result = await BTR.accelerator.probeHost(lastMedia.url, host, headers, bytes, 9, health, parallel);
    BTR.accelerator.saveHealth(health);
    return jsonResponse(result);
  }

  // 先把结果标成“已发出、等待回调”，立刻返回页面；回调若在 $done 之后到达，会把结果改成 ok。
  // 页面自己隔两秒去读结果。请求用的是最近一次视频地址上的 64 KiB。
  // 预取实验：脚本把页面交给 $done 之后，它还剩下什么能力？分四项记录，页面轮询
  // /probe/after-done/result 看结果。
  //   control —— 交出页面之前就跑完的请求，用来证明这个节点此刻确实连得上、要多久；
  //   pending —— 交出页面之前发出、回调落在 $done 之后的请求，预取要用的就是它；
  //   delayed —— 交出页面之后由定时器发出的请求；
  //   timer   —— 一个 25 秒的定时器，证明脚本上下文还活着、还能写存储。
  // 只有 control 成功而 pending、delayed 都收不到回调，才能断定是环境不让跑，而不是节点连不上。
  const PROBE_BYTES = 64 * 1024;
  const PROBE_TIMEOUT_SEC = 40;

  function loadProbe() {
    const stored = env.store.readJson(PROBE_KEY, null);
    return stored && typeof stored === "object" ? stored : {};
  }

  function recordProbe(name, value) {
    const probe = loadProbe();
    probe[name] = value;
    probe.updatedAt = Date.now();
    env.store.writeJson(PROBE_KEY, probe);
  }

  // 发一个探针请求。onCallback 记下真正的回调什么时候到，哪怕这边已经按超时判负了。
  function probeRequest(name, url, headers, timeoutSec) {
    const sentAt = Date.now();
    recordProbe(name, { state: "sent" });
    return env.httpGet({
      url: url,
      headers: headers,
      timeoutSec: timeoutSec,
      onCallback: function (error, ms) {
        recordProbe(name + "Callback", { ms: ms, ok: !error, error: error ? env.safeString(error).slice(0, 80) : "" });
      }
    }).then(function (response) {
      const bytes = response.body ? response.body.length : 0;
      const ok = (response.status === 206 || response.status === 200) && bytes > 0;
      recordProbe(name, { state: ok ? "ok" : "http", status: response.status, bytes: bytes, ms: Date.now() - sentAt });
    }, function (error) {
      recordProbe(name, { state: "failed", ms: Date.now() - sentAt, error: env.safeString(error).slice(0, 100) });
    });
  }

  function probeAfterDone() {
    const lastMedia = loadLastMedia();
    if (!lastMedia) return htmlResponse("<!doctype html><meta charset=utf-8><p>还没有可用的视频地址，先播放一个视频。<a href=\"/\">返回</a></p>");
    const settings = loadSettings();
    const parts = core.parseUrl(lastMedia.url);
    const hostList = core.candidateHosts(parts.host, settings);
    const host = hostList.indexOf(parts.host) >= 0 ? parts.host : hostList[0];
    const url = core.buildUrl(parts, host === parts.host ? {} : { host: host, port: "" });
    const headers = { "Accept-Encoding": "identity", "X-BTR-Sub": "1", Range: "bytes=0-" + (PROBE_BYTES - 1) };
    if (lastMedia.userAgent) headers["User-Agent"] = lastMedia.userAgent;
    const startedAt = Date.now();
    env.store.writeJson(PROBE_KEY, { version: BTR.VERSION, host: host, startedAt: startedAt, updatedAt: startedAt });
    // 先跑一次普通请求，跑完再交页面：它成功了，后面两项收不到回调才说明问题在环境。
    return probeRequest("control", url, headers, 6).then(function () {
      probeRequest("pending", url, headers, PROBE_TIMEOUT_SEC);
      if (env.api.setTimeout) {
        env.api.setTimeout(function () { probeRequest("delayed", url, headers, PROBE_TIMEOUT_SEC); }, 1500);
        env.api.setTimeout(function () { recordProbe("timer", { state: "ok", ms: Date.now() - startedAt }); }, 25000);
      } else {
        recordProbe("timer", { state: "missing" });
      }
      return htmlResponse(renderProbePage(host));
    });
  }

  function renderProbePage(host) {
    return "<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>预取实验</title>"
      + "<style>body{margin:0;padding:16px;font:15px/1.6 -apple-system,\"PingFang SC\",sans-serif;background:#f4f5f7;color:#18191c}.card{background:#fff;border-radius:12px;padding:14px 16px;margin:12px 0}code{background:#f1f2f3;padding:1px 4px;border-radius:4px}a{color:#fb7299}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #eee;vertical-align:top}th{color:#61666d;font-weight:500;white-space:nowrap}.v{font-weight:600}</style></head><body>"
      + "<h1 style=\"font-size:20px\">预取实验</h1>"
      + "<div class=card>脚本正在对 <code>" + escapeHtml(host) + "</code> 发四个探针，全部只取 64 KiB。对照那一发在交出页面之前就跑完了；另外两发的回调落在 <code>$done</code> 之后。它们要是都收不到回调，预取就走不通。最多等一分钟。</div>"
      + "<div class=card id=verdict>正在测…</div>"
      + "<div class=card><table id=rows><tr><th>探针</th><th>结果</th></tr></table></div>"
      + "<div><a href=\"/\">← 返回设置</a></div>"
      + "<script>(function(){"
      + "var names={control:'对照（交页面之前跑完）',pending:'$done 之后回调',delayed:'$done 之后发出',timer:'25 秒定时器'};"
      + "var order=['control','pending','delayed','timer'];"
      + "var verdict=document.getElementById('verdict');var rows=document.getElementById('rows');var tries=0;"
      + "function cell(d,key){var it=d[key];var cb=d[key+'Callback'];if(!it)return'未开始';"
      + "var text=it.state==='ok'?('成功 '+(it.ms!=null?it.ms+' ms':'')+(it.bytes?('，'+it.bytes+' 字节'):'')):"
      + "it.state==='sent'?'已发出，还没回来':"
      + "it.state==='http'?('回来了但不是分片：HTTP '+it.status):"
      + "it.state==='failed'?('失败：'+(it.error||'')):it.state;"
      + "if(cb)text+='（真回调 '+cb.ms+' ms 到）';return text;}"
      + "function render(d){var html='<tr><th>探针</th><th>结果</th></tr>';"
      + "order.forEach(function(k){html+='<tr><th>'+names[k]+'</th><td>'+cell(d,k)+'</td></tr>';});rows.innerHTML=html;"
      + "var c=d.control||{},p=d.pending||{},l=d.delayed||{};"
      + "if(c.state&&c.state!=='ok'&&c.state!=='sent'){verdict.innerHTML='<span class=v>实验无效</span>：对照那一发就没成，这个节点现在连不上，换个节点或重新播放一段视频再试。';return true;}"
      + "if(p.state==='ok'||l.state==='ok'){verdict.innerHTML='<span class=v>预取可行</span>：脚本在交出页面之后仍然能把请求跑完。';return true;}"
      + "if(tries>=20){verdict.innerHTML='<span class=v>预取走不通</span>：对照那一发'+(c.ms?('只用了 '+c.ms+' ms'):'成功了')+'，但交出页面之后的两发都没有回调'+((d.timer&&d.timer.state==='ok')?'（定时器却照常在跑，说明脚本还活着，只是网络被停了）':'')+'。';return true;}"
      + "return false;}"
      + "function poll(){fetch('/probe/after-done/result',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){tries++;if(render(d))return;setTimeout(poll,3000);})"
      + ".catch(function(e){verdict.textContent='读取结果失败：'+e;});}"
      + "setTimeout(poll,1500);})();</script></body></html>";
  }

  // 存储自检页：三层结论写在最上面，下面列出每把键当前占多少字节。
  function renderStoreTest(result, beat) {
    const rows = result.keys.map(function (item) {
      return "<tr><th>" + escapeHtml(item.label) + "<br><small style=\"color:#9499a0\">" + escapeHtml(item.key) + "</small></th><td>" + (item.bytes ? item.bytes + " 字节" : "空") + "</td></tr>";
    }).join("");
    const verdict = !result.available
      ? "<b>这个环境没有 $persistentStore。</b>脚本存不下任何东西，统计、设置、节点记忆每次运行都会回到默认值。"
      : !result.wrote || !result.sameRun
        ? "<b>写得进、读不回来。</b>同一次运行里刚写下的值就读不出来，存储接口是坏的。"
        : result.previous
          ? "<b>存储正常。</b>上一次运行写下的值这次还在，写于 " + Math.round(result.previous.ageMs / 1000) + " 秒前（版本 " + escapeHtml(result.previous.version) + "）。统计还是清零的话，问题不在存储。"
          : "<b>还差一步。</b>这次写下了一个值，但没看到上一次的。<u>刷新这个页面</u>：再看到这句话就说明跨运行保存失败，那正是统计一直清零的原因。";
    return "<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>存储自检</title>"
      + "<style>body{margin:0;padding:16px;font:15px/1.6 -apple-system,\"PingFang SC\",sans-serif;background:#f4f5f7;color:#18191c}.card{background:#fff;border-radius:12px;padding:14px 16px;margin:12px 0}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #eee}th{font-weight:500;color:#61666d}td{text-align:right;font-variant-numeric:tabular-nums}a{color:#fb7299}code{background:#f1f2f3;padding:1px 4px;border-radius:4px}</style></head><body>"
      + "<h1 style=\"font-size:20px\">存储自检</h1>"
      + "<div class=card>" + verdict + "</div>"
      + "<div class=card><table>"
      + "<tr><th>接口存在</th><td>" + (result.available ? "是" : "否") + "</td></tr>"
      + "<tr><th>写入返回成功</th><td>" + (result.wrote ? "是" : "否") + "</td></tr>"
      + "<tr><th>同一次运行读回</th><td>" + (result.sameRun ? "是" : "否") + "</td></tr>"
      + "<tr><th>上一次运行的值还在</th><td>" + (result.previous ? "是" : "否") + "</td></tr>"
      + "<tr><th>分片脚本运行过</th><td>" + (Number(beat.mediaN) || 0) + " 次</td></tr>"
      + "<tr><th>设置页打开过</th><td>" + (Number(beat.pageN) || 0) + " 次</td></tr>"
      + "</table></div>"
      + "<div class=card><table>" + rows + "</table></div>"
      + "<div><a href=\"/store/test\">再测一次</a> · <a href=\"/\">← 返回设置</a></div>"
      + "</body></html>";
  }

  // 做完事就跳回设置页。/save 和 /reset 都会改东西，留在那个地址上一刷新就再做一次：
  // Safari 恢复标签页、下拉刷新、误点返回都算一次刷新，统计于是永远停在 0，「统计开始于」
  // 每次都变成当下。跳转之后地址栏是 /，刷新多少次都不会再重置。
  function redirect(path) {
    // 绝对地址：有的客户端对相对 Location 处理得不一致。
    const target = "http://" + SETTINGS_HOST + path;
    return {
      status: 302,
      headers: { Location: target, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      body: "<!doctype html><html lang=zh-CN><meta charset=utf-8><meta http-equiv=refresh content=\"0;url=" + escapeHtml(target) + "\"><p>已处理，正在返回设置页…… <a href=\"" + escapeHtml(target) + "\">点这里</a></p></html>"
    };
  }

  function htmlResponse(body, status) {
    return { status: status || 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body };
  }

  function jsonResponse(value) {
    return { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(value, null, 2) };
  }

  // 返回 { status, headers, body } 或它的 Promise，交给 $done({ response })。
  function handle(parts) {
    const query = parseQuery(parts.query);
    const path = (parts.path || "/").replace(/\/+$/, "") || "/";
    // 每打开一次页面就 +1。刷新之后这个数字不涨，就说明存储根本没在保存。
    recordBeat("page");
    let message = "";
    if (query.done === "saved") message = "设置已保存。";
    else if (query.done === "savefail") message = "设置保存失败：这个环境没有可用的 $persistentStore。";
    else if (query.done === "reset") message = RESET_LABELS[query.what] ? "已重置：" + RESET_LABELS[query.what] + "。" : "没有指定要重置什么。";
    if (path === "/speedtest") return htmlResponse(renderSpeedtest(loadSettings(), loadLastMedia()));
    if (path === "/speedtest/run") return runSpeedtest(query);
    // 实验：脚本调完 $done 之后，它发出的请求还会不会跑完。会的话就能在交付这一段之后预取下一段。
    if (path === "/probe/after-done") return probeAfterDone();
    if (path === "/probe/after-done/result") return jsonResponse(loadProbe());
    if (path === "/store/test") return htmlResponse(renderStoreTest(storeSelfTest(), loadBeat()));
    if (path === "/save") {
      const next = settingsFromQuery(query);
      return redirect("/?done=" + (saveSettings(next) ? "saved" : "savefail"));
    } else if (path === "/reset") {
      const what = query.what || "";
      // “全部重置”连设置一起恢复默认，不然线程数、每块大小这些会留着上次存的值。
      if (what === "settings" || what === "all") env.store.writeJson(SETTINGS_KEY, { revision: SETTINGS_REVISION });
      if (what === "stats" || what === "all") saveStats(emptyStats());
      // 直接写空，不走 saveHealth：那个会跟存储里现有的记录合并，重置就重置不掉了。
      if (what === "health" || what === "all") env.store.writeJson(BTR.accelerator.HEALTH_KEY, { hosts: {} });
      if (what === "env" || what === "all") { saveEnvFlags({}); env.store.writeJson(PROBE_KEY, {}); }
      if (what === "log" || what === "all") env.store.writeJson(LOG_KEY, []);
      if (what === "all") {
        env.store.writeJson(LAST_MEDIA_KEY, {});
        env.store.writeJson(SIZES_KEY, {});
        env.store.writeJson(INFLIGHT_KEY, {});
        env.store.writeJson(BUSY_KEY, {});
        env.store.writeJson(BEAT_KEY, {});
        // 心跳刚被清掉，这次打开要重新记上，不然页面显示“打开过 0 次”，看着像存储坏了。
        recordBeat("page");
      }
      return redirect("/?done=reset&what=" + encodeURIComponent(what));
    } else if (path === "/diag.json") {
      return jsonResponse({
        version: BTR.VERSION,
        capabilities: env.capabilities(),
        settings: loadSettings(),
        flags: loadEnvFlags(),
        stats: loadStats(),
        beat: loadBeat(),
        probe: loadProbe(),
        health: BTR.accelerator.loadHealth(),
        log: loadLog()
      });
    } else if (path === "/log.txt") {
      const lines = loadLog();
      return {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        body: "Bilibili 线程撕裂者 · 移动端 v" + BTR.VERSION + " · 最近 " + lines.length + " 行日志（最新在最后）\n\n" + (lines.length ? lines.join("\n") : "（还没有日志。播放一个视频后再看。开调试日志能看到每块的去向。）") + "\n"
      };
    } else if (path !== "/") {
      return htmlResponse("<!doctype html><meta charset=utf-8><p>没有这个页面。<a href=\"/\">返回设置</a></p>", 404);
    }
    return htmlResponse(renderPage({
      settings: loadSettings(),
      stats: loadStats(),
      statsStored: Boolean(env.store.read(STATS_KEY)),
      beat: loadBeat(),
      health: BTR.accelerator.loadHealth(),
      flags: loadEnvFlags(),
      capabilities: env.capabilities(),
      autoRefresh: Number(query.auto) || 0,
      message
    }));
  }

  BTR.settings = Object.freeze({
    ENV_KEY,
    LOG_KEY,
    SETTINGS_HOST,
    SETTINGS_KEY,
    STATS_KEY,
    REASON_LABELS,
    GLOBAL_INFLIGHT_LIMIT,
    appendLog,
    claimInflight,
    knownTotal,
    loadBeat,
    recentBps,
    recordBeat,
    rememberTotal,
    loadBusy,
    releaseBusy,
    reserveBusy,
    emptyStats,
    handle,
    loadEnvFlags,
    loadLastMedia,
    loadLog,
    noteRedo,
    releaseInflight,
    rememberDelivered,
    rememberMedia,
    loadSettings,
    loadStats,
    parseQuery,
    recordOutcome,
    saveEnvFlags,
    saveSettings,
    saveStats,
    settingsFromQuery
  });
})(BTR);

if (typeof __BTR_EXPOSE__ === "function") __BTR_EXPOSE__(BTR);

/* src/main.js */
// 入口。每个匹配到的请求进来都跑一遍：设置页直接回应；视频分片决定是拆分下载、只换节点
// 还是原样放过。不论走到哪一步，最后一定调 $done。
(function (BTR) {
  "use strict";

  const core = BTR.core;
  const env = BTR.env;
  const accelerator = BTR.accelerator;
  const settingsModule = BTR.settings;

  // 脚本自己发出的子请求，以及已经被改写过一次的请求，都带这个标记，避免再进一次脚本。
  const SUB_HEADER = "X-BTR-Sub";
  const REWRITE_HEADER = "X-BTR-Rewritten";
  const DROP_HEADERS = ["host", "range", "content-length", "connection", "proxy-connection", "accept-encoding", "if-range", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "te", "upgrade", "x-btr-sub", "x-btr-rewritten"];

  function pass(reason) {
    return { result: "passthrough", reason, done: {} };
  }

  function startedAtOf(entry) {
    return entry && entry.at ? entry.at : Date.now();
  }

  // 子请求带上 App 原本的请求头（User-Agent 尤其重要，CDN 会拒绝桌面 UA 的 App 地址）。
  function forwardHeaders(headers) {
    const output = {};
    Object.keys(headers || {}).forEach(function (key) {
      if (DROP_HEADERS.indexOf(key.toLowerCase()) >= 0) return;
      output[key] = headers[key];
    });
    output["Accept-Encoding"] = "identity";
    output[SUB_HEADER] = "1";
    return output;
  }

  // 不拆分的请求：单连接改走当前模式里最靠前的节点。
  function rewrite(parts, headers, settings, health, reason) {
    const hosts = core.candidateHosts(parts.host, settings);
    if (!hosts.length) return pass(reason);
    // 单连接也走同一个领跑者，别让“只换节点”的请求跑到一个刚被判定为慢的节点上。
    const host = accelerator.chooseLeader(accelerator.orderCandidates(hosts, health, settings.threads, parts.host).pool, health, parts.host);
    if (!host || host === parts.host) return pass(reason);
    const nextHeaders = {};
    Object.keys(headers || {}).forEach(function (key) {
      nextHeaders[key] = key.toLowerCase() === "host" ? host : headers[key];
    });
    nextHeaders[REWRITE_HEADER] = "1";
    return {
      result: "rewritten",
      reason,
      host,
      done: { url: core.buildUrl(parts, { host, port: "" }), headers: nextHeaders }
    };
  }

  // 多给一段要在这次请求里下完，所以估算的时间得留足余量：App 等不到三秒就会重发同一段。
  const OVERFETCH_BUDGET_MS = 2200;

  function overfetchTarget(parts, range, settings, health, entry) {
    const extra = settings.overfetchBytes;
    if (!extra) return range;
    if (accelerator.pushbackMs(health)) return range;
    const total = settingsModule.knownTotal(parts.path);
    if (!total) return range;
    const end = Math.min(range.end + extra, total - 1, range.start + settings.maxBytes - 1);
    if (end <= range.end) return range;
    const length = end - range.start + 1;
    const bps = settingsModule.recentBps(settingsModule.loadStats());
    if (!bps || length / bps * 1000 > OVERFETCH_BUDGET_MS) return range;
    entry.overfetch = end - range.end;
    return { kind: "bounded", raw: range.raw, start: range.start, end, length };
  }

  async function decide(parts, method, headers, settings, entry) {
    if (!settings.enabled) return pass("disabled");
    if (method !== "GET") return pass("notGet");
    if (!core.isMediaUrl(parts) || !core.isUposPath(parts)) return pass("notMedia");
    // 给设置页的节点测速留一个真实地址。只存在本机。
    settingsModule.rememberMedia(parts.href, core.headerGet(headers, "user-agent"), entry.kind, parts.host);
    const range = core.parseRangeHeader(core.headerGet(headers, "range"));
    entry.range = range.kind === "bounded" ? range.start + "-" + range.end : (range.raw || "(无)").slice(0, 40);
    if (range.kind === "bounded") entry.length = range.length;
    const health = accelerator.loadHealth();
    const flags = settingsModule.loadEnvFlags();
    const single = function (reason) {
      return settings.swapSingle ? rewrite(parts, headers, settings, health, reason) : pass(reason);
    };
    if (settings.accelerate === "swap") return single("splitOff");
    if (flags.binaryUnsupported) return single("binaryUnsupported");
    if (range.kind !== "bounded") return single(range.kind === "none" ? "noRange" : range.kind === "open" ? "openRange" : "unsupportedRange");
    if (range.length > settings.maxBytes) return single("tooLarge");
    if (range.length < settings.minSplitBytes) return single("tooSmall");
    // 超量回传（实验）：多下一段一起交给 App。只在三件事都成立时才做——文件总长已知
    // （多出来的那截不能越过文件末尾）、最近几次的实测速度撑得住、不在限流中。
    const target = overfetchTarget(parts, range, settings, health, entry);
    const inflightKey = parts.path + "#" + range.start + "-" + range.end;
    // 这段是不是我们刚交出去过的：是的话，上次那份被播放器丢了。这是量「播放器耐心」的唯一办法。
    const redo = settingsModule.noteRedo(parts.path, range);
    if (redo.redoMs) entry.redo = redo.redoMs;
    if (redo.usedMs.length) entry.usedMs = redo.usedMs;
    if (settingsModule.claimInflight(inflightKey)) return single("duplicate");
    // 全局在途上限：别的段还在拆时，这段能开的连接就少一些；一条都开不了就只换节点。
    const runId = String(startedAtOf(entry)) + Math.random().toString(36).slice(2, 7);
    // 刚被节点以 412 / 429 顶回来过，就先收着劲跑：线程数减半，三分钟后恢复。
    const pushbackLeft = accelerator.pushbackMs(health);
    if (pushbackLeft) entry.pushback = Math.round(pushbackLeft / 1000);
    const wantThreads = pushbackLeft ? Math.max(2, Math.ceil(settings.threads / 2)) : settings.threads;
    const wantedPieces = Math.min(wantThreads, Math.max(1, Math.ceil(target.length / settings.minChunkBytes)));
    const reserved = settingsModule.reserveBusy(runId, wantedPieces + 2);
    if (reserved.granted < 2) {
      settingsModule.releaseInflight(inflightKey);
      entry.busy = reserved.used;
      return single("busy");
    }
    const runSettings = Object.create(settings, { threads: { value: Math.max(2, Math.min(wantThreads, reserved.granted - 1)) } });
    try {
      const download = await accelerator.downloadRange({ parts, range: target, headers: forwardHeaders(headers), settings: runSettings, health, maxInflight: reserved.granted });
      settingsModule.releaseBusy(runId);
      settingsModule.releaseInflight(inflightKey);
      accelerator.saveHealth(health);
      entry.threads = download.pieces;
      entry.leader = download.leader;
      entry.hosts = download.usage;
      entry.attempts = download.attempts;
      entry.hedges = download.hedges;
      entry.pieceMsMin = download.pieceMsMin;
      entry.pieceMsMax = download.pieceMsMax;
      // 实际交出去多少字节：超量回传时比 App 问的那一段大，速度统计要按真实的量算。
      entry.delivered = target.length;
      // 文件总长只有从分片响应的 Content-Range 才知道，记下来给下一次的超量回传用。
      if (download.total) settingsModule.rememberTotal(parts.path, download.total);
      const responseHeaders = {
        "Content-Type": download.contentType || "video/mp4",
        "Content-Range": "bytes " + target.start + "-" + target.end + "/" + (download.total === null ? "*" : download.total),
        "Content-Length": String(target.length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-BTR": BTR.VERSION + "; pieces=" + download.pieces + "; hosts=" + Object.keys(download.usage).length + "; ms=" + download.elapsedMs
      };
      // 记的是从请求进来到交出去的全程，播放器的耐心量的就是这个。
      settingsModule.rememberDelivered(parts.path, target, Date.now() - startedAtOf(entry));
      return { result: "accelerated", reason: "ok", done: { response: { status: 206, headers: responseHeaders, body: download.bytes } } };
    } catch (error) {
      settingsModule.releaseBusy(runId);
      settingsModule.releaseInflight(inflightKey);
      accelerator.saveHealth(health);
      entry.error = env.safeString(error).slice(0, 120);
      if (error && error.name === "BinaryUnsupported") {
        flags.binaryUnsupported = true;
        flags.binaryUnsupportedAt = Date.now();
        settingsModule.saveEnvFlags(flags);
        env.notify("线程撕裂者", "脚本环境不支持二进制响应", "已改为只换 CDN、不拆分。详情见 http://btr.settings/");
        return single("binaryUnsupported");
      }
      // 多线程失败时把请求原样交回：什么都没改，App 自己去它原来的节点拿。
      const hostError = error && ["TimeoutError", "NetworkError", "BadRange", "BadLength", "EmptyBody", "NoHosts", "Budget", "TotalMismatch"].indexOf(error.name) >= 0;
      return pass(error && error.name === "Deadline" ? "deadline" : hostError ? "failed" : "scriptError");
    }
  }

  async function main() {
    const request = env.api.request;
    if (!request || typeof request.url !== "string") {
      env.finish({});
      return;
    }
    const parts = core.parseUrl(request.url);
    if (!parts) {
      env.finish({});
      return;
    }
    if (parts.host === settingsModule.SETTINGS_HOST) {
      const response = await settingsModule.handle(parts);
      env.finish({ response });
      return;
    }
    const headers = request.headers && typeof request.headers === "object" ? request.headers : {};
    if (core.headerGet(headers, SUB_HEADER) || core.headerGet(headers, REWRITE_HEADER)) {
      env.finish({});
      return;
    }
    const method = String(request.method || "GET").toUpperCase();
    const settings = settingsModule.loadSettings();
    env.setDebug(settings.debug);
    const startedAt = Date.now();
    // 只记主机、端口和路径，不记带签名的查询串。
    const entry = {
      at: startedAt,
      kind: core.mediaKind(parts.path),
      host: parts.host + (parts.port ? ":" + parts.port : ""),
      scheme: parts.scheme,
      path: parts.path.length > 72 ? "…" + parts.path.slice(-72) : parts.path,
      method
    };
    let outcome;
    try {
      outcome = await decide(parts, method, headers, settings, entry);
    } catch (error) {
      env.log("error", "脚本出错，请求原样放过", error);
      entry.error = env.safeString(error).slice(0, 120);
      outcome = pass("error");
    }
    entry.result = outcome.result;
    entry.reason = outcome.reason;
    entry.elapsedMs = Date.now() - startedAt;
    if (outcome.host) entry.rewrittenTo = outcome.host;
    try {
      // 心跳先写：统计存不下来时，靠它还能看出脚本到底有没有跑过。
      settingsModule.recordBeat("media");
      // 设置页以外的请求都记一笔；notMedia 的也记，方便在设置页看到脚本到底匹配到了什么。
      const stats = settingsModule.loadStats();
      settingsModule.recordOutcome(stats, entry);
      settingsModule.saveStats(stats);
    } catch (error) {
      env.log("error", "统计保存失败", error);
    }
    // 每个请求的去向都记一行，这是排错时最有用的信息；每块的细节只在调试日志里。
    // 节点名只留能认出来的那一截：upos-sz-mirrorali.bilivideo.com → mirrorali。
    const shortHost = function (host) {
      return String(host || "").replace(/^upos-[a-z]{2}-/, "").replace(/\.(bilivideo\.(com|cn|net)|akamaized\.net|szbdyd\.com)(:\d+)?$/, "");
    };
    const detail = entry.hosts
      ? "领跑 " + shortHost(entry.leader) + " 原 " + shortHost(parts.host) + " " + JSON.stringify(entry.hosts) + " 块耗时 " + entry.pieceMsMin + "~" + entry.pieceMsMax + "ms" + (entry.hedges ? " 副本 " + entry.hedges : "") + (entry.attempts > entry.threads ? " 重试 " + (entry.attempts - entry.threads - (entry.hedges || 0)) : "") + (entry.pushback ? " 限流中 " + entry.pushback + "s" : "") + (entry.overfetch ? " 多给 " + Math.round(entry.overfetch / 1024) + "KiB" : "")
      : (entry.rewrittenTo ? "→ " + shortHost(entry.rewrittenTo) + " " : "") + (entry.error || "") + (entry.kind !== "unknown" ? " 原 " + shortHost(parts.host) : "");
    const redoNote = entry.redo ? "（" + entry.redo + "ms 前交出的那份被丢了）" : "";
    env.log("info", outcome.result + "/" + outcome.reason + " " + entry.kind + " " + (entry.range || "") + " " + entry.elapsedMs + "ms" + redoNote, detail);
    try { settingsModule.appendLog(env.logLines, startedAt); }
    catch (error) { env.log("error", "日志保存失败", error); }
    env.finish(outcome.done);
  }

  main().catch(function (error) {
    env.log("error", "脚本崩溃，请求原样放过", error);
    env.finish({});
  });
})(BTR);
})();
