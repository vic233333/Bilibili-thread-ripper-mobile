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
          env.log("debug", "块 " + piece.index + " " + host.split(".")[0] + " " + Math.round(result.bytes.byteLength / 1024) + "KiB " + result.elapsedMs + "ms " + Math.round(result.bytes.byteLength / result.elapsedMs) + "KB/s" + (settled ? "（副本落败）" : ""));
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
