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
    const inflightKey = parts.path + "#" + range.start + "-" + range.end;
    if (settingsModule.claimInflight(inflightKey)) return single("duplicate");
    // 全局在途上限：别的段还在拆时，这段能开的连接就少一些；一条都开不了就只换节点。
    const runId = String(startedAtOf(entry)) + Math.random().toString(36).slice(2, 7);
    // 刚被节点以 412 / 429 顶回来过，就先收着劲跑：线程数减半，三分钟后恢复。
    const pushbackLeft = accelerator.pushbackMs(health);
    if (pushbackLeft) entry.pushback = Math.round(pushbackLeft / 1000);
    const wantThreads = pushbackLeft ? Math.max(2, Math.ceil(settings.threads / 2)) : settings.threads;
    const wantedPieces = Math.min(wantThreads, Math.max(1, Math.ceil(range.length / settings.minChunkBytes)));
    const reserved = settingsModule.reserveBusy(runId, wantedPieces + 2);
    if (reserved.granted < 2) {
      settingsModule.releaseInflight(inflightKey);
      entry.busy = reserved.used;
      return single("busy");
    }
    const runSettings = Object.create(settings, { threads: { value: Math.max(2, Math.min(wantThreads, reserved.granted - 1)) } });
    try {
      const download = await accelerator.downloadRange({ parts, range, headers: forwardHeaders(headers), settings: runSettings, health, maxInflight: reserved.granted });
      settingsModule.releaseBusy(runId);
      settingsModule.releaseInflight(inflightKey);
      accelerator.saveHealth(health);
      entry.threads = download.pieces;
      entry.hosts = download.usage;
      entry.attempts = download.attempts;
      entry.hedges = download.hedges;
      entry.pieceMsMin = download.pieceMsMin;
      entry.pieceMsMax = download.pieceMsMax;
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
      // 设置页以外的请求都记一笔；notMedia 的也记，方便在设置页看到脚本到底匹配到了什么。
      const stats = settingsModule.loadStats();
      settingsModule.recordOutcome(stats, entry);
      settingsModule.saveStats(stats);
    } catch (error) {
      env.log("error", "统计保存失败", error);
    }
    // 每个请求的去向都记一行，这是排错时最有用的信息；每块的细节只在调试日志里。
    const detail = entry.hosts
      ? JSON.stringify(entry.hosts) + " 块耗时 " + entry.pieceMsMin + "~" + entry.pieceMsMax + "ms" + (entry.hedges ? " 副本 " + entry.hedges : "") + (entry.attempts > entry.threads ? " 重试 " + (entry.attempts - entry.threads - (entry.hedges || 0)) : "") + (entry.pushback ? " 限流中 " + entry.pushback + "s" : "")
      : entry.rewrittenTo || entry.error || "";
    env.log("info", outcome.result + "/" + outcome.reason + " " + entry.kind + " " + (entry.range || "") + " " + entry.elapsedMs + "ms", detail);
    try { settingsModule.appendLog(env.logLines, startedAt); }
    catch (error) { env.log("error", "日志保存失败", error); }
    env.finish(outcome.done);
  }

  main().catch(function (error) {
    env.log("error", "脚本崩溃，请求原样放过", error);
    env.finish({});
  });
})(BTR);
