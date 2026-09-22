/*!
 * Bilibili 线程撕裂者 · 移动端（Shadowrocket 脚本） v0.1.2
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
const BTR = { VERSION: "0.1.2" };

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

  function normalizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const threads = Math.trunc(Number(source.threads));
    const customHosts = (Array.isArray(source.customHosts) ? source.customHosts : [])
      .map(normalizeCdnHost)
      .filter(function (host, index, all) { return host && all.indexOf(host) === index; })
      .slice(0, 32);
    const minChunkKiB = Math.round(clamp(source.minChunkKiB, 64, 1024, 256));
    return {
      enabled: source.enabled !== false,
      // "split" 拆分并发下载；"swap" 只把请求换到当前模式的节点，单连接。真机上排错时用。
      accelerate: source.accelerate === "swap" ? "swap" : "split",
      mode: source.mode === "overseas" || source.mode === "custom" ? source.mode : "mainland",
      customHosts,
      threads: THREAD_OPTIONS.indexOf(threads) >= 0 ? threads : 8,
      // 一次请求超过这个大小就不拆分了：整段要先在内存里拼好才能交给播放器。
      maxMiB: Math.round(clamp(source.maxMiB, 2, 24, 8)),
      minChunkKiB,
      // 单连接请求（没有 Range、开区间、太小、太大）是否也换到当前模式的 CDN。
      swapSingle: source.swapSingle !== false,
      // 子请求沿用原地址的协议（App 是明文 http），也可以强制走 https。
      subrequestScheme: source.subrequestScheme === "https" ? "https" : "keep",
      attemptTimeoutSec: Math.round(clamp(source.attemptTimeoutSec, 3, 30, 8)),
      deadlineSec: Math.round(clamp(source.deadlineSec, 5, 40, 20)),
      debug: source.debug === true,
      get maxBytes() { return this.maxMiB * 1024 * 1024; },
      get minChunkBytes() { return this.minChunkKiB * 1024; },
      // 比两块还小的区间拆了也没意义。
      get minSplitBytes() { return this.minChunkKiB * 1024 * 2; }
    };
  }

  function hostsForMode(settings) {
    if (settings.mode === "custom" && settings.customHosts.length) return settings.customHosts.slice();
    return (settings.mode === "overseas" ? OVERSEAS_HOSTS : MAINLAND_HOSTS).slice();
  }

  // 一个分片可以向哪些节点要。规则同上游：当前模式的节点列表，加上 B 站原本给的节点
  // （只在它属于当前模式时保留；海外模式保留 akamai 原地址）。
  function candidateHosts(originalHost, settings) {
    const original = String(originalHost || "").toLowerCase();
    const hosts = hostsForMode(settings);
    const custom = settings.mode === "custom" ? settings.customHosts : [];
    let keepOriginal;
    if (custom.length) keepOriginal = custom.indexOf(original) >= 0;
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

  /* global $request, $done, $httpClient, $persistentStore, $notification */
  const api = {
    request: typeof $request !== "undefined" ? $request : null,
    done: typeof $done === "function" ? $done : null,
    httpClient: typeof $httpClient !== "undefined" ? $httpClient : null,
    persistentStore: typeof $persistentStore !== "undefined" ? $persistentStore : null,
    notification: typeof $notification !== "undefined" ? $notification : null,
    console: typeof console !== "undefined" ? console : null,
    setTimeout: typeof setTimeout === "function" ? setTimeout : null,
    clearTimeout: typeof clearTimeout === "function" ? clearTimeout : null
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

  function wrapError(error) {
    if (error instanceof Error) return error;
    const message = safeString(error) || "请求失败";
    return makeError(/time/i.test(message) ? "TimeoutError" : "NetworkError", message);
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
  // 测过的速度只算这么久；之后这个节点回到“没测过”的那一组，重新给它机会。
  const MEASURE_TTL_MS = 90 * 1000;
  // 只有传够这么多字节的一块才拿来算速度，尾巴太短的会误判。
  const SPEED_SAMPLE_MIN_BYTES = 48 * 1024;
  const RETRY_ROUNDS = 2;
  const HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  function loadHealth() {
    const stored = env.store.readJson(HEALTH_KEY, null);
    if (stored && typeof stored === "object" && stored.hosts && typeof stored.hosts === "object") return stored;
    return { hosts: {} };
  }

  function saveHealth(health) {
    const now = Date.now();
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

  function markSuccess(health, host, bytes, elapsedMs) {
    const record = recordOf(health, host);
    const now = Date.now();
    record.fails = 0;
    record.blockedUntil = 0;
    record.okAt = now;
    if (bytes >= SPEED_SAMPLE_MIN_BYTES && elapsedMs > 0) {
      const bps = bytes * 1000 / elapsedMs;
      record.bps = record.bps ? record.bps * 0.65 + bps * 0.35 : bps;
      record.measuredAt = now;
    }
  }

  function markFailure(health, host, error) {
    const record = recordOf(health, host);
    const now = Date.now();
    record.fails = (record.fails || 0) + 1;
    // 3、6、12、24、48 秒，最多 60 秒。上游对“一个字节都没给”的节点也是这么退避的。
    record.blockedUntil = now + Math.min(60 * 1000, 3000 * Math.pow(2, Math.min(record.fails, 4)));
    record.failAt = now;
    record.lastError = env.safeString(error).slice(0, 100);
  }

  function isBlocked(record, now) {
    return Boolean(record) && (record.blockedUntil || 0) > now;
  }

  function isMeasured(record, now) {
    return Boolean(record && record.measuredAt) && now - record.measuredAt < MEASURE_TTL_MS;
  }

  // 这次请求的分块先发给哪些节点。测过速度的按快慢排，再带上一个没测过的去探路；
  // 测过的不到两个时还在热身，把分块撒到所有节点上，一次就把它们都量一遍。
  // 被退避的节点排最后，只在别的都失败时才轮到。
  function orderCandidates(hosts, health, threads) {
    const now = Date.now();
    const entries = hosts.map(function (host) { return { host, record: health.hosts[host] || null }; });
    const active = entries.filter(function (entry) { return !isBlocked(entry.record, now); });
    const blocked = entries.filter(function (entry) { return isBlocked(entry.record, now); })
      .sort(function (a, b) { return (a.record.blockedUntil || 0) - (b.record.blockedUntil || 0); });
    const measured = active.filter(function (entry) { return isMeasured(entry.record, now); })
      .sort(function (a, b) { return (b.record.bps || 0) - (a.record.bps || 0); });
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

  function rotate(list, offset) {
    if (!list.length) return [];
    const shift = offset % list.length;
    return list.slice(shift).concat(list.slice(0, shift));
  }

  async function downloadPiece(piece, plan) {
    const order = rotate(plan.pool, piece.index);
    plan.all.forEach(function (host) { if (order.indexOf(host) < 0) order.push(host); });
    let lastError = null;
    for (let round = 0; round < RETRY_ROUNDS; round += 1) {
      for (let index = 0; index < order.length; index += 1) {
        // 别的块已经宣告失败、整段要交回原连接时，这块也不用再换节点试了。
        if (plan.aborted) throw lastError || env.makeError("Aborted", "整段下载已放弃");
        // 整段的重试预算：平均每块三次。所有节点都拒绝同一个地址时，不必让每块把每个节点都
        // 试两遍，早点交回原连接。
        if (plan.attempts >= plan.attemptBudget) {
          plan.aborted = true;
          throw lastError || env.makeError("Budget", "重试次数已用完");
        }
        const host = order[index];
        const now = Date.now();
        const remainingSec = (plan.deadlineAt - now) / 1000;
        if (remainingSec < 1) throw lastError || env.makeError("Deadline", "这次请求的总时限已到");
        // 第一轮跳过还在退避的节点，除非全都在退避。
        if (round === 0 && isBlocked(plan.health.hosts[host], now) && order.some(function (other) { return !isBlocked(plan.health.hosts[other], now); })) continue;
        const url = core.buildUrl(plan.parts, { host, port: "", scheme: plan.scheme });
        plan.attempts += 1;
        try {
          const result = await fetchPiece(url, piece, plan.headers, Math.min(plan.settings.attemptTimeoutSec, remainingSec));
          markSuccess(plan.health, host, result.bytes.byteLength, result.elapsedMs);
          plan.usage[host] = (plan.usage[host] || 0) + 1;
          result.host = host;
          return result;
        } catch (error) {
          if (error && error.name === "BinaryUnsupported") throw error;
          markFailure(plan.health, host, error);
          env.log("debug", "子块 " + piece.index + " 在 " + host + " 失败", error);
          lastError = error;
        }
      }
    }
    throw lastError || env.makeError("NoHosts", "没有可用的 CDN 节点");
  }

  // context: { parts, range, headers, settings, health }
  async function downloadRange(context) {
    const settings = context.settings;
    const startedAt = Date.now();
    const hosts = core.candidateHosts(context.parts.host, settings);
    if (!hosts.length) throw env.makeError("NoHosts", "当前模式下没有可用的 CDN 节点");
    const ordered = orderCandidates(hosts, context.health, settings.threads);
    const pieces = core.splitRange(context.range.start, context.range.end, settings.threads, settings.minChunkBytes);
    const plan = {
      parts: context.parts,
      scheme: settings.subrequestScheme === "https" ? "https" : context.parts.scheme,
      headers: context.headers,
      settings,
      health: context.health,
      pool: ordered.pool,
      all: ordered.all,
      deadlineAt: startedAt + settings.deadlineSec * 1000,
      usage: {},
      attempts: 0,
      attemptBudget: pieces.length * 3,
      aborted: false
    };
    env.log("debug", "拆成 " + pieces.length + " 块，节点池", plan.pool);
    let results;
    try {
      results = await Promise.all(pieces.map(function (piece) { return downloadPiece(piece, plan); }));
    } catch (error) {
      plan.aborted = true;
      throw error;
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
    return {
      bytes: output,
      total,
      contentType: results[0].contentType,
      pieces: pieces.length,
      usage: plan.usage,
      attempts: plan.attempts,
      elapsedMs: Math.max(1, Date.now() - startedAt)
    };
  }

  BTR.accelerator = Object.freeze({
    HEALTH_KEY,
    downloadRange,
    fetchPiece,
    loadHealth,
    markFailure,
    markSuccess,
    orderCandidates,
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
  const RECENT_LIMIT = 12;
  const LOG_LIMIT = 300;
  const AUTO_REFRESH_OPTIONS = [5, 15, 30];

  function loadRawSettings() {
    return env.store.readJson(SETTINGS_KEY, {});
  }

  function loadSettings() {
    return core.normalizeSettings(loadRawSettings());
  }

  function saveSettings(settings) {
    const plain = {
      enabled: settings.enabled,
      accelerate: settings.accelerate,
      mode: settings.mode,
      customHosts: settings.customHosts,
      threads: settings.threads,
      maxMiB: settings.maxMiB,
      minChunkKiB: settings.minChunkKiB,
      swapSingle: settings.swapSingle,
      subrequestScheme: settings.subrequestScheme,
      attemptTimeoutSec: settings.attemptTimeoutSec,
      deadlineSec: settings.deadlineSec,
      debug: settings.debug
    };
    return env.store.writeJson(SETTINGS_KEY, plain);
  }

  function emptyStats() {
    return { since: Date.now(), seen: 0, accelerated: 0, rewritten: 0, passthrough: {}, bytes: 0, elapsedMs: 0, recent: [] };
  }

  function loadStats() {
    const stored = env.store.readJson(STATS_KEY, null);
    if (!stored || typeof stored !== "object" || typeof stored.seen !== "number") return emptyStats();
    if (!stored.passthrough || typeof stored.passthrough !== "object") stored.passthrough = {};
    if (!Array.isArray(stored.recent)) stored.recent = [];
    return stored;
  }

  function saveStats(stats) {
    return env.store.writeJson(STATS_KEY, stats);
  }

  // entry: { at, kind, host, range, length, result, reason, elapsedMs, threads, hosts, error }
  function recordOutcome(stats, entry) {
    stats.seen += 1;
    if (entry.result === "accelerated") {
      stats.accelerated += 1;
      stats.bytes += Number(entry.length) || 0;
      stats.elapsedMs += Number(entry.elapsedMs) || 0;
    } else if (entry.result === "rewritten") {
      stats.rewritten += 1;
      stats.passthrough[entry.reason] = (stats.passthrough[entry.reason] || 0) + 1;
    } else {
      stats.passthrough[entry.reason] = (stats.passthrough[entry.reason] || 0) + 1;
    }
    stats.recent.unshift(entry);
    if (stats.recent.length > RECENT_LIMIT) stats.recent.length = RECENT_LIMIT;
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
    lines.forEach(function (line) { log.push(stamp + " " + line); });
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
    return env.store.writeJson(LOG_KEY, log);
  }

  function loadEnvFlags() {
    const stored = env.store.readJson(ENV_KEY, null);
    return stored && typeof stored === "object" ? stored : {};
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
      swapSingle: truthy(query.swapSingle),
      subrequestScheme: query.subrequestScheme,
      attemptTimeoutSec: Number(query.attemptTimeoutSec),
      deadlineSec: Number(query.deadlineSec),
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
    return (value / 1024 / 1024).toFixed(2) + " MiB/s";
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
    splitOff: "设置为只换节点",
    binaryUnsupported: "环境不支持二进制响应",
    failed: "多线程下载失败，已交回原连接",
    error: "脚本出错，已交回原连接",
    deadline: "超过总时限"
  };

  const RESULT_LABELS = { accelerated: "多线程", rewritten: "只换节点", passthrough: "原样放过" };

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
    const healthRows = Object.keys(health.hosts).sort().map(function (host) {
      const record = health.hosts[host];
      const state = (record.blockedUntil || 0) > now ? "退避中" : record.okAt ? "正常" : record.failAt ? "失败过" : "未知";
      return "<tr><td class=host>" + escapeHtml(host) + "</td><td>" + state + "</td><td class=num>" + formatSpeed(record.bps) + "</td><td class=num>" + (record.fails || 0) + "</td><td>" + escapeHtml(record.lastError || "") + "</td></tr>";
    }).join("");
    const recentRows = stats.recent.map(function (entry) {
      const usage = entry.hosts ? Object.keys(entry.hosts).map(function (host) { return host.split(".")[0] + "×" + entry.hosts[host]; }).join(" ") : "";
      const speed = entry.result === "accelerated" && entry.elapsedMs ? formatSpeed(entry.length * 1000 / entry.elapsedMs) : "";
      return "<tr><td>" + formatTime(entry.at) + "</td><td>" + escapeHtml(entry.kind === "audio" ? "音" : entry.kind === "video" ? "画" : "?") + "</td><td class=host>" + escapeHtml(entry.host || "") + (entry.path ? "<br><small>" + escapeHtml((entry.scheme && entry.scheme !== "http" ? entry.scheme + " " : "") + entry.path) + "</small>" : "") + "</td><td class=num>" + escapeHtml(entry.range || "") + "</td><td class=num>" + (entry.length ? formatBytes(entry.length) : "") + "</td><td>" + escapeHtml(RESULT_LABELS[entry.result] || entry.result || "") + (entry.reason && entry.reason !== "ok" ? "<br><small>" + escapeHtml(REASON_LABELS[entry.reason] || entry.reason) + "</small>" : "") + (entry.error ? "<br><small>" + escapeHtml(entry.error) + "</small>" : "") + "</td><td class=num>" + (entry.elapsedMs || 0) + " ms" + (speed ? "<br><small>" + speed + "</small>" : "") + (entry.threads ? "<br><small>" + entry.threads + " 块 " + escapeHtml(usage) + "</small>" : "") + "</td></tr>";
    }).join("");
    const message = state.message ? "<div class=notice>" + escapeHtml(state.message) + "</div>" : "";
    const auto = AUTO_REFRESH_OPTIONS.indexOf(state.autoRefresh) >= 0 ? state.autoRefresh : 0;
    const refreshMeta = auto ? "<meta http-equiv=\"refresh\" content=\"" + auto + ";url=/?auto=" + auto + "\">" : "";
    const refreshLinks = "<div class=sub>自动刷新：" + (auto ? "<a href=\"/\">关</a>" : "<b>关</b>") + AUTO_REFRESH_OPTIONS.map(function (seconds) {
      return " · " + (auto === seconds ? "<b>" + seconds + " 秒</b>" : "<a href=\"/?auto=" + seconds + "\">" + seconds + " 秒</a>");
    }).join("") + "</div>";
    const warnings = [];
    if (!capabilities.persistentStore) warnings.push("这个环境没有 $persistentStore，设置和统计都保存不了。");
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
      + "table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:6px 4px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{color:#61666d;font-weight:500}"
      + "td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}td.host{word-break:break-all}"
      + ".notice{background:#e6f7ee;color:#0c6b3b;border-radius:10px;padding:10px 14px;margin:12px 0}.warn{background:#fff3e0;color:#8a4b00;border-radius:10px;padding:10px 14px;margin:12px 0}"
      + ".kv{display:grid;grid-template-columns:1fr 1fr;gap:8px}.kv div{background:#f7f8fa;border-radius:10px;padding:10px}.kv b{display:block;font-size:20px}.kv small{color:#61666d}"
      + ".badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#e3e5e7}.badge.on{background:#fb7299;color:#fff}"
      + "</style></head><body>"
      + "<h1>Bilibili 线程撕裂者 <span class=badge" + (settings.enabled ? " on" : "") + ">" + (settings.enabled ? "已启用" : "已停用") + "</span></h1>"
      + "<div class=sub>移动端 · Shadowrocket 脚本 · 版本 " + escapeHtml(BTR.VERSION) + "</div>"
      + refreshLinks
      + message + warningHtml
      + "<div class=card><div class=kv>"
      + "<div><small>看到的分片请求</small><b>" + stats.seen + "</b></div>"
      + "<div><small>多线程完成</small><b>" + stats.accelerated + "</b></div>"
      + "<div><small>只换了节点</small><b>" + stats.rewritten + "</b></div>"
      + "<div><small>多线程平均速度</small><b>" + formatSpeed(avgSpeed) + "</b></div>"
      + "<div><small>多线程下载量</small><b>" + formatBytes(stats.bytes) + "</b></div>"
      + "<div><small>统计开始于</small><b>" + formatTime(stats.since) + "</b></div>"
      + "</div></div>"
      + "<form class=card method=get action=\"/save\">"
      + "<h2 style=\"margin-top:0\">设置</h2>"
      + "<label class=row><span>启用加速<small>关掉后所有请求原样放过</small></span><input type=checkbox name=enabled value=1" + checked(settings.enabled) + "></label>"
      + "<label class=row><span>加速方式<small>多线程出问题时先退回“只换节点”排查</small></span><select name=accelerate>"
      + "<option value=split" + selected(settings.accelerate === "split") + ">多线程拆分</option>"
      + "<option value=swap" + selected(settings.accelerate === "swap") + ">只换节点</option></select></label>"
      + "<label class=row><span>CDN 模式<small>海外看冷门视频一般选大陆 CDN</small></span><select name=mode>"
      + "<option value=mainland" + selected(settings.mode === "mainland") + ">大陆 CDN</option>"
      + "<option value=overseas" + selected(settings.mode === "overseas") + ">海外 CDN</option>"
      + "<option value=custom" + selected(settings.mode === "custom") + ">自定义</option></select></label>"
      + "<label class=row style=\"display:block\"><span>自定义节点<small>每行一个主机名，只在自定义模式下生效；留空时按大陆 CDN。当前模式会用到：" + escapeHtml(hosts.join("、")) + "</small></span><textarea name=customHosts placeholder=\"upos-sz-mirrorali.bilivideo.com\">" + escapeHtml(settings.customHosts.join("\n")) + "</textarea></label>"
      + "<label class=row><span>并发线程<small>一个分片最多拆成几块同时下载</small></span><select name=threads>"
      + core.THREAD_OPTIONS.map(function (option) { return "<option value=" + option + selected(settings.threads === option) + ">" + option + "</option>"; }).join("")
      + "</select></label>"
      + "<label class=row><span>单个分片上限 (MiB)<small>整个分片要先在内存里拼好，超过就不拆</small></span><input type=number name=maxMiB min=2 max=24 step=1 value=" + settings.maxMiB + "></label>"
      + "<label class=row><span>每块最小 (KiB)<small>块太小时请求往返占大头</small></span><input type=number name=minChunkKiB min=64 max=1024 step=64 value=" + settings.minChunkKiB + "></label>"
      + "<label class=row><span>不拆分的请求也换节点<small>没有 Range、开区间或太大太小的请求，单连接改走当前模式最快的节点</small></span><input type=checkbox name=swapSingle value=1" + checked(settings.swapSingle) + "></label>"
      + "<label class=row><span>子请求协议<small>App 的分片是明文 http；有些网络对 http 干扰大时可以试 https</small></span><select name=subrequestScheme>"
      + "<option value=keep" + selected(settings.subrequestScheme === "keep") + ">跟原地址一样</option>"
      + "<option value=https" + selected(settings.subrequestScheme === "https") + ">强制 https</option></select></label>"
      + "<label class=row><span>单块超时 (秒)</span><input type=number name=attemptTimeoutSec min=3 max=30 step=1 value=" + settings.attemptTimeoutSec + "></label>"
      + "<label class=row><span>单个分片总时限 (秒)<small>到点还没拼完就交回原连接</small></span><input type=number name=deadlineSec min=5 max=40 step=1 value=" + settings.deadlineSec + "></label>"
      + "<label class=row><span>调试日志<small>在 Shadowrocket 的脚本日志里看每块的去向</small></span><input type=checkbox name=debug value=1" + checked(settings.debug) + "></label>"
      + "<button type=submit>保存</button>"
      + "</form>"
      + "<div class=card><h2 style=\"margin-top:0\">节点记忆</h2>"
      + (healthRows ? "<table><tr><th>节点</th><th>状态</th><th>速度</th><th>连败</th><th>最近错误</th></tr>" + healthRows + "</table>" : "<div class=sub>还没有节点数据。播放一个视频后再来看。</div>")
      + "</div>"
      + "<div class=card><h2 style=\"margin-top:0\">放过原因</h2>"
      + (reasonRows ? "<table>" + reasonRows + "</table>" : "<div class=sub>暂无</div>")
      + "</div>"
      + "<div class=card><h2 style=\"margin-top:0\">最近请求</h2>"
      + (recentRows ? "<table><tr><th>时间</th><th></th><th>原节点</th><th>Range</th><th>大小</th><th>结果</th><th>耗时</th></tr>" + recentRows + "</table>" : "<div class=sub>暂无。打开 B 站 App 播放一个视频，再刷新这个页面。</div>")
      + "</div>"
      + "<div class=card><h2 style=\"margin-top:0\">操作</h2>"
      + "<a class=\"btn secondary\" href=\"/reset?what=stats\">清空统计</a>"
      + "<a class=\"btn secondary\" href=\"/reset?what=health\">清空节点记忆</a>"
      + "<a class=\"btn secondary\" href=\"/reset?what=env\">重新检测环境</a>"
      + "<a class=\"btn secondary\" href=\"/log.txt\">查看日志</a>"
      + "<a class=\"btn secondary\" href=\"/reset?what=log\">清空日志</a>"
      + "<a class=\"btn secondary\" href=\"/diag.json\">诊断 JSON</a>"
      + "<a class=\"btn secondary\" href=\"/reset?what=all\">全部重置</a>"
      + "</div>"
      + "<div class=sub style=\"margin:20px 0\">这个页面由脚本本地生成，不联网。地址栏里的 btr.settings 不是真实域名。<br>原作：<a href=\"https://github.com/MrTangLuyao/Bilibili-thread-ripper\">MrTangLuyao/Bilibili-thread-ripper</a>（MIT）。移植：<a href=\"https://github.com/vic233333/Bilibili-thread-ripper-mobile\">vic233333/Bilibili-thread-ripper-mobile</a>。</div>"
      + "</body></html>";
  }

  function htmlResponse(body, status) {
    return { status: status || 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body };
  }

  function jsonResponse(value) {
    return { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(value, null, 2) };
  }

  // 返回 { status, headers, body }，交给 $done({ response })。
  function handle(parts) {
    const query = parseQuery(parts.query);
    const path = (parts.path || "/").replace(/\/+$/, "") || "/";
    let message = "";
    if (path === "/save") {
      const next = settingsFromQuery(query);
      message = saveSettings(next) ? "设置已保存。" : "设置保存失败：这个环境没有可用的 $persistentStore。";
    } else if (path === "/reset") {
      const what = query.what || "";
      if (what === "stats" || what === "all") saveStats(emptyStats());
      if (what === "health" || what === "all") BTR.accelerator.saveHealth({ hosts: {} });
      if (what === "env" || what === "all") saveEnvFlags({});
      if (what === "log" || what === "all") env.store.writeJson(LOG_KEY, []);
      message = what ? "已重置：" + what + "。" : "没有指定要重置什么。";
    } else if (path === "/diag.json") {
      return jsonResponse({
        version: BTR.VERSION,
        capabilities: env.capabilities(),
        settings: loadSettings(),
        flags: loadEnvFlags(),
        stats: loadStats(),
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
    appendLog,
    emptyStats,
    handle,
    loadEnvFlags,
    loadLog,
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
    const host = accelerator.orderCandidates(hosts, health, settings.threads).pool[0];
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

  async function decide(parts, method, headers, settings, entry) {
    if (!settings.enabled) return pass("disabled");
    if (method !== "GET") return pass("notGet");
    if (!core.isMediaUrl(parts) || !core.isUposPath(parts)) return pass("notMedia");
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
    try {
      const download = await accelerator.downloadRange({ parts, range, headers: forwardHeaders(headers), settings, health });
      accelerator.saveHealth(health);
      entry.threads = download.pieces;
      entry.hosts = download.usage;
      entry.attempts = download.attempts;
      const responseHeaders = {
        "Content-Type": download.contentType || "video/mp4",
        "Content-Range": "bytes " + range.start + "-" + range.end + "/" + (download.total === null ? "*" : download.total),
        "Content-Length": String(range.length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-BTR": BTR.VERSION + "; pieces=" + download.pieces + "; hosts=" + Object.keys(download.usage).length + "; ms=" + download.elapsedMs
      };
      return { result: "accelerated", reason: "ok", done: { response: { status: 206, headers: responseHeaders, body: download.bytes } } };
    } catch (error) {
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
      return pass(error && error.name === "Deadline" ? "deadline" : "failed");
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
      env.finish({ response: settingsModule.handle(parts) });
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
      // 设置页以外的请求都记一笔；notMedia 的也记，方便在设置页看到脚本到底匹配到了什么。
      const stats = settingsModule.loadStats();
      settingsModule.recordOutcome(stats, entry);
      settingsModule.saveStats(stats);
    } catch (error) {
      env.log("error", "统计保存失败", error);
    }
    // 每个请求的去向都记一行，这是排错时最有用的信息；每块的细节只在调试日志里。
    env.log("info", outcome.result + "/" + outcome.reason + " " + entry.kind + " " + (entry.range || "") + " " + entry.elapsedMs + "ms", entry.hosts || entry.rewrittenTo || entry.error || "");
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
