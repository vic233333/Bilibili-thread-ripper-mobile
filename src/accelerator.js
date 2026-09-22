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
  // 只有这些错误说明是节点或网络的问题，值得换节点重试并记在节点头上。别的（TypeError、
  // ReferenceError 之类）是脚本自己或环境的问题，换多少个节点都一样，直接放弃整段。
  const HOST_ERRORS = ["TimeoutError", "NetworkError", "BadRange", "BadLength", "EmptyBody"];

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

  // 一块该多久传完：按已测到的最快节点估，超过它的 1.5 倍还没回来就再向另一个节点要一份
  // 副本，先到先用。上游叫这个 hedge。没有测速数据时用固定值。
  function hedgeDelayMs(plan, piece) {
    const now = Date.now();
    let best = 0;
    Object.keys(plan.health.hosts).forEach(function (host) {
      const record = plan.health.hosts[host];
      if (isMeasured(record, now) && record.bps > best) best = record.bps;
    });
    if (!best) return 1200;
    return Math.max(400, Math.min(2500, Math.round(piece.length / best * 1000 * 1.5)));
  }

  // 一块的下载：按节点顺序发请求，失败就换下一个；一份迟迟不回来时再开一份副本。
  // $httpClient 没法取消，输掉的副本会在后台跑完，它的结果只用来更新节点速度。
  function downloadPiece(piece, plan) {
    const order = rotate(plan.pool, piece.index);
    plan.all.forEach(function (host) { if (order.indexOf(host) < 0) order.push(host); });
    const queue = [];
    for (let round = 0; round < RETRY_ROUNDS; round += 1) order.forEach(function (host) { queue.push({ host, round }); });
    return new Promise(function (resolve, reject) {
      let settled = false;
      let running = 0;
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
        if (running > 0) return;
        finish(false, error);
      }
      function launch(isHedge) {
        if (settled) return;
        // 别的块已经宣告失败、整段要交回原连接时，这块也不用再换节点试了。
        if (plan.aborted) { finish(false, lastError || env.makeError("Aborted", "整段下载已放弃")); return; }
        const now = Date.now();
        const remainingSec = (plan.deadlineAt - now) / 1000;
        if (remainingSec < 1) { giveUp(lastError || env.makeError("Deadline", "这次请求的总时限已到")); return; }
        // 整段的重试预算：平均每块三次。所有节点都拒绝同一个地址时，不必让每块把每个节点都
        // 试两遍，早点交回原连接。
        if (plan.attempts >= plan.attemptBudget) {
          if (running === 0) plan.aborted = true;
          giveUp(lastError || env.makeError("Budget", "重试次数已用完"));
          return;
        }
        const host = nextHost();
        if (!host) { giveUp(lastError || env.makeError("NoHosts", "没有可用的 CDN 节点")); return; }
        running += 1;
        plan.attempts += 1;
        if (isHedge) plan.hedges += 1;
        const url = core.buildUrl(plan.parts, { host, port: "", scheme: plan.scheme });
        fetchPiece(url, piece, plan.headers, Math.min(plan.settings.attemptTimeoutSec, remainingSec)).then(function (result) {
          running -= 1;
          markSuccess(plan.health, host, result.bytes.byteLength, result.elapsedMs);
          if (settled) return;
          plan.usage[host] = (plan.usage[host] || 0) + 1;
          result.host = host;
          finish(true, result);
        }, function (error) {
          running -= 1;
          if (!error || HOST_ERRORS.indexOf(error.name) < 0) {
            plan.aborted = true;
            finish(false, error || env.makeError("ScriptError", "未知错误"));
            return;
          }
          markFailure(plan.health, host, error);
          env.log("debug", "子块 " + piece.index + " 在 " + host + " 失败", error);
          lastError = error;
          if (!settled) launch(false);
        });
        scheduleHedge();
      }
      function scheduleHedge() {
        clearHedge();
        if (settled || !env.api.setTimeout || running >= plan.hedgeMax) return;
        timer = env.api.setTimeout(function () {
          timer = null;
          if (!settled && running < plan.hedgeMax) launch(true);
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
      hedges: 0,
      attemptBudget: pieces.length * 3,
      // 每块最多同时几份副本。脚本环境一次最多约 20 个并发请求，线程多时就不开副本。
      hedgeMax: settings.threads <= 10 ? 2 : 1,
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
      hedges: plan.hedges,
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
