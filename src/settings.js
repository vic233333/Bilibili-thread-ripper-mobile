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
  const SETTINGS_REVISION = 3;

  function loadSettings() {
    const raw = loadRawSettings();
    const revision = Number(raw.revision) || 1;
    // 第 2 版：每块最小从 256 KiB 改成 128 KiB。第 1 版保存的 256 是当时的默认值，不是用户的选择。
    if (revision < 2 && Number(raw.minChunkKiB) === 256) delete raw.minChunkKiB;
    // 第 3 版：默认 CDN 模式从大陆改成自动。之前保存的“大陆”是当时的默认值。
    if (revision < 3 && raw.mode === "mainland") delete raw.mode;
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
      swapSingle: settings.swapSingle,
      subrequestScheme: settings.subrequestScheme,
      attemptTimeoutSec: settings.attemptTimeoutSec,
      deadlineSec: settings.deadlineSec,
      debug: settings.debug
    };
    return env.store.writeJson(SETTINGS_KEY, plain);
  }

  function emptyStats() {
    return { since: Date.now(), seen: 0, accelerated: 0, rewritten: 0, passthrough: {}, bytes: 0, elapsedMs: 0, recent: [], schemes: {}, lastHttpAt: 0, lastHttpsAt: 0 };
  }

  function loadStats() {
    const stored = env.store.readJson(STATS_KEY, null);
    if (!stored || typeof stored !== "object" || typeof stored.seen !== "number") return emptyStats();
    if (!stored.passthrough || typeof stored.passthrough !== "object") stored.passthrough = {};
    if (!Array.isArray(stored.recent)) stored.recent = [];
    if (!stored.schemes || typeof stored.schemes !== "object") stored.schemes = {};
    return stored;
  }

  function saveStats(stats) {
    return env.store.writeJson(STATS_KEY, stats);
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
    ["btr.env", "环境判断"], ["btr.beat", "心跳"], ["btr.probe", "预取实验"],
    ["btr.lastMedia", "测速用地址"], ["btr.inflight", "在途登记"], ["btr.busy", "全局在途"]
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
        + "<script>(function(){var rows=[].slice.call(document.querySelectorAll('tr[data-host]'));var btn=document.getElementById('again');var lanes=document.getElementById('lanes');var bytes=document.getElementById('bytes');function fmt(b){return b?(b/1024/1024).toFixed(2)+' MiB/s':'-';}"
        + "function run(i){if(i>=rows.length){btn.disabled=false;lanes.disabled=false;bytes.disabled=false;return;}var row=rows[i];var host=row.getAttribute('data-host');row.querySelector('[data-cell=note]').textContent='测速中…';"
        + "fetch('/speedtest/run?host='+encodeURIComponent(host)+'&bytes='+bytes.value+'&parallel='+lanes.value,{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){row.querySelector('[data-cell=ms]').textContent=(d.elapsedMs||0)+' ms';row.querySelector('[data-cell=speed]').textContent=d.okLanes?fmt(d.bps)+(d.parallel>1?' 合计':''):'-';"
        + "var per=(d.laneBps||[]).filter(function(x){return x>0;}).map(function(x){return Math.round(x/1024);});row.querySelector('[data-cell=note]').textContent=d.ok?(d.parallel>1?'正常，每路 '+per.join('/')+' KB/s':'正常'):(d.okLanes?d.okLanes+'/'+d.parallel+' 路成功，'+(d.error||''):(d.error||'失败'));}).catch(function(e){row.querySelector('[data-cell=note]').textContent='请求失败：'+e;}).then(function(){run(i+1);});}"
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
    if (path === "/speedtest") return htmlResponse(renderSpeedtest(loadSettings(), loadLastMedia()));
    if (path === "/speedtest/run") return runSpeedtest(query);
    // 实验：脚本调完 $done 之后，它发出的请求还会不会跑完。会的话就能在交付这一段之后预取下一段。
    if (path === "/probe/after-done") return probeAfterDone();
    if (path === "/probe/after-done/result") return jsonResponse(loadProbe());
    if (path === "/store/test") return htmlResponse(renderStoreTest(storeSelfTest(), loadBeat()));
    if (path === "/save") {
      const next = settingsFromQuery(query);
      message = saveSettings(next) ? "设置已保存。" : "设置保存失败：这个环境没有可用的 $persistentStore。";
    } else if (path === "/reset") {
      const what = query.what || "";
      // “全部重置”连设置一起恢复默认，不然线程数、每块大小这些会留着上次存的值。
      if (what === "settings" || what === "all") env.store.writeJson(SETTINGS_KEY, { revision: SETTINGS_REVISION });
      if (what === "stats" || what === "all") saveStats(emptyStats());
      if (what === "health" || what === "all") BTR.accelerator.saveHealth({ hosts: {} });
      if (what === "env" || what === "all") { saveEnvFlags({}); env.store.writeJson(PROBE_KEY, {}); }
      if (what === "log" || what === "all") env.store.writeJson(LOG_KEY, []);
      if (what === "all") {
        env.store.writeJson(LAST_MEDIA_KEY, {});
        env.store.writeJson(INFLIGHT_KEY, {});
        env.store.writeJson(BUSY_KEY, {});
        env.store.writeJson(BEAT_KEY, {});
      }
      message = RESET_LABELS[what] ? "已重置：" + RESET_LABELS[what] + "。" : "没有指定要重置什么。";
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
    loadBeat,
    recordBeat,
    loadBusy,
    releaseBusy,
    reserveBusy,
    emptyStats,
    handle,
    loadEnvFlags,
    loadLastMedia,
    loadLog,
    releaseInflight,
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
