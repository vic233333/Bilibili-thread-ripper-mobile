"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RangeServer } = require("./range-server");
const { APP_UA, createEnv, createStore, mediaRequest } = require("./harness");

const MAINLAND = [
  "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com",
  "upos-sz-mirror08c.bilivideo.com", "upos-sz-mirrorbd.bilivideo.com", "upos-sz-mirror14b.bilivideo.com",
  "upos-sz-estgoss.bilivideo.com", "upos-sz-mirrorcos.bilivideo.com"
];

let server;
test.before(async () => { server = new RangeServer({ size: 4 * 1024 * 1024 }); await server.start(); });
test.after(async () => { await server.close(); });
test.beforeEach(() => { server.behaviors = {}; server.requests = []; });

function expected(start, end) {
  return Buffer.from(server.file.subarray(start, end + 1));
}

test("一个 2 MiB 的 bytes=a-b 分片被拆成 8 块，从多个大陆节点拼回正确的字节", async () => {
  const store = createStore();
  store.setJson("btr.settings", { revision: 3, mode: "mainland", threads: 8 });
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest());
  assert.ok(value.response, "应当直接返回响应");
  assert.equal(value.response.status, 206);
  assert.equal(value.response.headers["Content-Range"], `bytes 1048576-3145727/${server.size}`);
  assert.equal(value.response.headers["Content-Length"], String(2 * 1024 * 1024));
  assert.equal(value.response.headers["Content-Type"], "video/mp4");
  assert.equal(value.response.headers["Accept-Ranges"], "bytes");
  assert.ok(/pieces=8;/.test(value.response.headers["X-BTR"]));
  assert.ok(Buffer.from(value.response.body).equals(expected(1048576, 3145727)), "拼回的字节必须和源文件一致");

  const hosts = new Set(server.requests.map((item) => item.host));
  assert.equal(server.requests.length, 8, "8 块各一个子请求");
  assert.ok(hosts.size >= 4, `热身阶段应把块撒到多个节点上，实际 ${hosts.size}`);
  for (const host of hosts) assert.ok(MAINLAND.includes(host), `${host} 不是大陆节点；akamai 原地址在大陆模式下不该被用`);
  for (const item of server.requests) {
    assert.equal(item.headers["user-agent"], APP_UA, "子请求必须带 App 的 UA");
    assert.equal(item.headers["accept-encoding"], "identity");
    assert.equal(item.headers["x-btr-sub"], "1");
    assert.equal(item.headers.range, item.range);
    assert.ok(/^bytes=\d+-\d+$/.test(item.range));
    assert.ok(item.path.includes("upsig=deadbeef"), "查询串（签名）必须原样带上");
  }
  const stats = env.store.json("btr.stats");
  assert.equal(stats.seen, 1);
  assert.equal(stats.accelerated, 1);
  assert.equal(stats.recent[0].result, "accelerated");
  assert.equal(stats.recent[0].kind, "video");
  assert.equal(stats.recent[0].length, 2 * 1024 * 1024);
  const health = env.store.json("btr.health");
  assert.ok(Object.keys(health.hosts).length >= 4);
  for (const host of Object.keys(health.hosts)) assert.ok(health.hosts[host].bps > 0, `${host} 应该测出速度`);
});

test("线程数和最小块大小由设置决定", async () => {
  const store = createStore();
  store.setJson("btr.settings", { threads: 4, minChunkKiB: 64 });
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest());
  assert.equal(value.response.status, 206);
  assert.equal(server.requests.length, 4);
  const lengths = server.requests.map((item) => { const m = /^bytes=(\d+)-(\d+)$/.exec(item.range); return Number(m[2]) - Number(m[1]) + 1; });
  assert.deepEqual(lengths.sort((a, b) => a - b), [524288, 524288, 524288, 524288]);
});

test("一个节点返回 403 时，这块换别的节点重试，整段仍然成功，该节点进入退避", async () => {
  server.setBehavior("upos-sz-mirrorali.bilivideo.com", { status: 403 });
  const env = createEnv({ server });
  const { value } = await env.run(mediaRequest());
  assert.equal(value.response.status, 206);
  assert.ok(Buffer.from(value.response.body).equals(expected(1048576, 3145727)));
  const refused = server.requestsFor("upos-sz-mirrorali.bilivideo.com");
  assert.ok(refused.length >= 1, "第一次热身应当试过这个节点");
  const health = env.store.json("btr.health");
  assert.ok(health.hosts["upos-sz-mirrorali.bilivideo.com"].blockedUntil > Date.now(), "被拒绝的节点应当退避");
  assert.equal(health.hosts["upos-sz-mirrorali.bilivideo.com"].fails, 1);

  // 下一次请求不再把块分给它。
  server.requests = [];
  const second = await env.run(mediaRequest());
  assert.equal(second.value.response.status, 206);
  assert.equal(server.requestsFor("upos-sz-mirrorali.bilivideo.com").length, 0, "退避中的节点不该再被分到块");
});

const MEDIA_PATH = "/upgcxcode/12/34/123456/123456-1-30080.m4s";

function fastHistory(count) {
  return {
    since: Date.now(), seen: count, accelerated: count, rewritten: 0, passthrough: {}, bytes: 0, elapsedMs: 0, schemes: {},
    recent: Array.from({ length: count }, () => ({ result: "accelerated", length: 1048576, elapsedMs: 100 }))
  };
}

test("超量回传：知道文件多大、速度也够时，多下一段一起交给播放器", async () => {
  const store = createStore();
  store.setJson("btr.settings", { revision: 3, mode: "mainland", threads: 8, overfetchMiB: 1 });
  store.setJson("btr.sizes", { [MEDIA_PATH]: { total: server.size, at: Date.now() } });
  store.setJson("btr.stats", fastHistory(3));
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
  assert.equal(value.response.status, 206);
  assert.equal(value.response.headers["Content-Range"], `bytes 0-2097151/${server.size}`, "回给播放器的区间要比它问的大一段");
  assert.equal(value.response.headers["Content-Length"], String(2 * 1024 * 1024));
  assert.ok(Buffer.from(value.response.body).equals(expected(0, 2097151)), "多出来的那段字节也要对");
  assert.equal(store.json("btr.stats").recent[0].overfetch, 1048576);
});

test("超量回传的三道闸：不知道文件多大、速度不够、越过文件末尾", async () => {
  const base = { revision: 3, mode: "mainland", threads: 8, overfetchMiB: 4 };

  // 还没拼过这个文件，不知道总长：照常只回它问的那一段，并把总长记下来备用。
  const first = createStore();
  first.setJson("btr.settings", base);
  first.setJson("btr.stats", fastHistory(3));
  const cold = createEnv({ server, store: first });
  const one = await cold.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
  assert.equal(one.value.response.headers["Content-Range"], `bytes 0-1048575/${server.size}`);
  assert.equal(first.json("btr.sizes")[MEDIA_PATH].total, server.size, "拼完应当记住文件多大");

  // 最近几次都很慢：多给一段来不及，就别给。
  const slow = createStore();
  slow.setJson("btr.settings", base);
  slow.setJson("btr.sizes", { [MEDIA_PATH]: { total: server.size, at: Date.now() } });
  slow.setJson("btr.stats", Object.assign(fastHistory(3), {
    recent: Array.from({ length: 3 }, () => ({ result: "accelerated", length: 1048576, elapsedMs: 3000 }))
  }));
  const tired = await createEnv({ server, store: slow }).run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
  assert.equal(tired.value.response.headers["Content-Range"], `bytes 0-1048575/${server.size}`);

  // 贴着文件末尾：多出来的那截会被夹到最后一个字节，不会越界。
  const tail = createStore();
  tail.setJson("btr.settings", base);
  tail.setJson("btr.sizes", { [MEDIA_PATH]: { total: server.size, at: Date.now() } });
  tail.setJson("btr.stats", fastHistory(3));
  const near = await createEnv({ server, store: tail }).run(mediaRequest({ headers: { Range: `bytes=2097152-3145727` } }));
  assert.equal(near.value.response.headers["Content-Range"], `bytes 2097152-${server.size - 1}/${server.size}`);
  assert.ok(Buffer.from(near.value.response.body).equals(expected(2097152, server.size - 1)));
});

test("节点回 412 是限流不是拒绝：只短暂退避，下一段的线程数减半", async () => {
  server.setBehavior("upos-sz-mirrorali.bilivideo.com", { status: 412 });
  const store = createStore();
  store.setJson("btr.settings", { revision: 3, mode: "mainland", threads: 8, minChunkKiB: 128 });
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest());
  assert.equal(value.response.status, 206);
  const health = store.json("btr.health");
  const record = health.hosts["upos-sz-mirrorali.bilivideo.com"];
  assert.ok(record.blockedUntil - Date.now() < 60 * 1000, "限流只短暂退避，不是按拒绝封五分钟");
  assert.ok(health.pushback.until > Date.now(), "应当记下全局限流");
  assert.equal(health.pushback.status, 412);

  // 限流期内的下一段：线程数减半，日志里说明还要收着跑多久。
  server.behaviors = {};
  server.requests = [];
  const second = createEnv({ server, store });
  const next = await second.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
  assert.equal(next.value.response.status, 206);
  const stats = store.json("btr.stats");
  assert.equal(stats.recent[0].threads, 4, "限流中线程数减半");
  assert.ok(stats.recent[0].pushback > 0);
});

test("Content-Range 对不上或长度不符的响应会被拒绝并换节点", async () => {
  server.setBehavior("upos-sz-mirrorhw.bilivideo.com", { wrongRange: true });
  server.setBehavior("upos-sz-mirrorbos.bilivideo.com", { truncate: true });
  const store = createStore();
  store.setJson("btr.settings", { revision: 3, mode: "mainland", threads: 8 });
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest());
  assert.equal(value.response.status, 206);
  assert.ok(Buffer.from(value.response.body).equals(expected(1048576, 3145727)));
  const health = env.store.json("btr.health");
  assert.match(health.hosts["upos-sz-mirrorhw.bilivideo.com"].lastError, /BadRange/);
  assert.match(health.hosts["upos-sz-mirrorbos.bilivideo.com"].lastError, /BadLength/);
});

test("一个节点挂起不回时，超时后换节点，整段仍成功", async () => {
  server.setBehavior("upos-sz-mirrorcos.bilivideo.com", { hang: true });
  const store = createStore();
  store.setJson("btr.settings", { revision: 3, mode: "mainland", threads: 8, attemptTimeoutSec: 3, deadlineSec: 15 });
  const env = createEnv({ server, store });
  const { value, elapsedMs } = await env.run(mediaRequest());
  assert.equal(value.response.status, 206);
  assert.ok(Buffer.from(value.response.body).equals(expected(1048576, 3145727)));
  // 没有测速数据时副本在 1.2 秒后启动，整段不必等到 3 秒超时。
  assert.ok(elapsedMs < 3000, `副本应在超时之前救回这块，实际 ${elapsedMs}ms`);
  const stats = env.store.json("btr.stats");
  assert.ok(stats.recent[0].hedges >= 1, "应当开过副本");
  assert.ok(!stats.recent[0].hosts["upos-sz-mirrorcos.bilivideo.com"], "挂起的节点不该算作赢家");
});

test("一个节点很慢时，超过预计时间就再向别的节点要一份副本，先到先用", async () => {
  // 先热身一次，让节点有测速数据，副本的等待时间才会按速度估算。
  const store = createStore();
  store.setJson("btr.settings", { threads: 4, minChunkKiB: 256 });
  const warm = createEnv({ server, store });
  assert.equal((await warm.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }))).value.response.status, 206);
  const health = store.json("btr.health");
  const measured = Object.keys(health.hosts).filter((host) => health.hosts[host].measuredAt);
  assert.ok(measured.length >= 4, "热身应测出多个节点的速度");
  // 让这一段的领跑者变得极慢：它会拿到块，但副本会救回来。自动模式下领跑者是 App 自己的节点
  // （本地各节点速度差不多，没有谁快到三倍）；以前这里挑「测速最快的」，那个节点不一定拿得到块，
  // 测试就会随机地一个副本都不开。
  const fastest = "upos-hz-mirrorakam.akamaized.net";
  assert.ok(measured.includes(fastest), "热身应测到 App 自己的节点");
  server.setBehavior(fastest, { delayMs: 5000 });
  const env = createEnv({ server, store });
  const { value, elapsedMs } = await env.run(mediaRequest({ headers: { Range: "bytes=1048576-2097151" } }));
  assert.equal(value.response.status, 206);
  assert.ok(Buffer.from(value.response.body).equals(expected(1048576, 2097151)));
  assert.ok(elapsedMs < 4000, `副本应在慢节点之前回来，实际 ${elapsedMs}ms`);
  const stats = store.json("btr.stats");
  assert.ok(stats.recent[0].hedges >= 1, "应当开过副本");
  assert.ok(!Object.keys(stats.recent[0].hosts).includes(fastest) || stats.recent[0].hosts[fastest] < 1, "慢节点不该算作赢家");
});

test("所有节点都失败时，请求原样交回，不改地址也不改头", async () => {
  for (const host of MAINLAND) server.setBehavior(host, { status: 403 });
  const store = createStore();
  store.setJson("btr.settings", { revision: 3, deadlineSec: 8, mode: "mainland" });
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest());
  assert.deepEqual(value, {}, "失败时必须 $done({})");
  const stats = env.store.json("btr.stats");
  assert.equal(stats.accelerated, 0);
  assert.equal(stats.passthrough.failed, 1);
  assert.match(stats.recent[0].error, /BadRange/);
  // 整段的重试预算是每块平均三次：8 块 × 8 节点 × 2 轮本来最多 128 次，预算把它压到 24 次左右。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(server.requests.length <= 32, `放弃后不该继续大量重试，实际 ${server.requests.length} 次`);
  assert.ok(server.requests.length >= 16, `放弃前至少要把每个节点都试过一遍，实际 ${server.requests.length} 次`);
});

test("真机上 App 的 1 MiB 画面请求按线程数拆块，83 KiB 的音轨请求只换节点", async () => {
  const store = createStore();
  store.setJson("btr.settings", { revision: 3, mode: "mainland", threads: 8 });
  const env = createEnv({ server, store });
  // 真机日志里的请求是 bytes=22020096-23068671 这种正好 1 MiB 的区间；假文件只有 4 MiB，取同样大小的一段。
  const video = await env.run(mediaRequest({ headers: { Range: "bytes=2097152-3145727" } }));
  assert.equal(video.value.response.status, 206);
  assert.ok(/pieces=8;/.test(video.value.response.headers["X-BTR"]), video.value.response.headers["X-BTR"]);
  assert.ok(Buffer.from(video.value.response.body).equals(expected(2097152, 3145727)));
  const audio = await env.run(mediaRequest({ url: require("./harness").AUDIO_URL, headers: { Range: "bytes=1402836-1486154" } }));
  assert.ok(audio.value.url, "音轨请求太小，只换节点");
  const stats = env.store.json("btr.stats");
  assert.equal(stats.recent[0].reason, "tooSmall");
});

test("环境层面的错误（比如 TypeError）不怪到节点头上，整段立刻放弃", async () => {
  const store = createStore();
  const env = createEnv({ server, store, brokenClient: true });
  const { value, elapsedMs } = await env.run(mediaRequest());
  assert.deepEqual(value, {});
  assert.ok(elapsedMs < 1000, "不该逐个节点重试");
  const stats = store.json("btr.stats");
  assert.equal(stats.passthrough.scriptError, 1, JSON.stringify(stats.passthrough));
  assert.match(stats.recent[0].error, /TypeError: Can only call Window\.setTimeout/);
  assert.deepEqual(store.json("btr.health").hosts, {}, "不该给任何节点记失败");
});

test("$httpClient 回调里的普通 Error 算网络错误，会换节点重试", async () => {
  const store = createStore();
  const env = createEnv({ server: null, store });
  const { value } = await env.run(mediaRequest({ headers: { Range: "bytes=0-524287" } }));
  assert.deepEqual(value, {});
  const stats = store.json("btr.stats");
  assert.equal(stats.passthrough.failed, 1, JSON.stringify(stats.passthrough));
  assert.match(stats.recent[0].error, /NetworkError: .*no server/);
  assert.ok(Object.keys(store.json("btr.health").hosts).length >= 2, "节点应被记上失败");
});

test("自动模式：没有测速数据时热身撒到原节点和所有节点；有数据后只用最快的几个", async () => {
  const store = createStore();
  store.setJson("btr.settings", { threads: 8 });
  const env = createEnv({ server, store });
  const first = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
  assert.equal(first.value.response.status, 206);
  const warmHosts = new Set(server.requests.map((item) => item.host));
  assert.ok(warmHosts.has("upos-hz-mirrorakam.akamaized.net"), "自动模式保留 App 原本的节点");
  assert.ok(warmHosts.size >= 6);
  // 模拟真机测速结果：原本的海外节点远快于其他。
  const now = Date.now();
  const health = { hosts: {} };
  ["upos-sz-mirrorcosov.bilivideo.com", "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirror14b.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"].forEach((host, index) => {
    health.hosts[host] = { bps: [320000, 260000, 250000, 60000, 20000][index], measuredAt: now, okAt: now };
  });
  store.setJson("btr.health", health);
  server.requests = [];
  const second = await env.run(mediaRequest({ headers: { Range: "bytes=1048576-2097151" } }));
  assert.equal(second.value.response.status, 206);
  const usage = second.value.response.headers["X-BTR"];
  const hosts = server.requests.map((item) => item.host);
  const slowUsed = hosts.filter((host) => host === "upos-sz-mirrorhw.bilivideo.com").length;
  assert.equal(slowUsed, 0, `慢节点不该再拿到块：${hosts.join(",")} ${usage}`);
  // App 自己的节点是例外：领跑位不在它身上时，每段留最后一块去试它，不然永远回不去。
  assert.equal(hosts.filter((host) => host === "upos-hz-mirrorakam.akamaized.net").length, 1, `App 自己的节点每段试一块：${hosts.join(",")}`);
  assert.ok(hosts.filter((host) => host === "upos-sz-mirrorcosov.bilivideo.com").length >= 2);
});

test("海外模式会把 akamai 原地址也留作候选，并且只用海外节点", async () => {
  const store = createStore();
  store.setJson("btr.settings", { mode: "overseas", threads: 4 });
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest());
  assert.equal(value.response.status, 206);
  const hosts = new Set(server.requests.map((item) => item.host));
  for (const host of hosts) {
    assert.ok(!MAINLAND.includes(host), `${host} 是大陆节点，海外模式不该用`);
  }
});

test("自定义模式只用填写的节点，不合法的主机名会被丢掉", async () => {
  const store = createStore();
  store.setJson("btr.settings", { mode: "custom", customHosts: ["upos-sz-mirrorcos.bilivideo.com", "https://upos-sz-mirrorali.bilivideo.com/", "evil.example.com", "not a host"], threads: 4 });
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest());
  assert.equal(value.response.status, 206);
  const hosts = new Set(server.requests.map((item) => item.host));
  assert.deepEqual([...hosts].sort(), ["upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorcos.bilivideo.com"]);
});

test("经 MITM 解密后的 https 分片同样被拆分，子请求默认沿用 https", async () => {
  const url = "https://upos-hz-mirrorakam.akamaized.net" + require("./harness").MEDIA_URL.slice("http://upos-hz-mirrorakam.akamaized.net".length);
  const store = createStore();
  store.setJson("btr.settings", { threads: 4 });
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest({ url }));
  assert.equal(value.response.status, 206);
  assert.ok(Buffer.from(value.response.body).equals(expected(1048576, 3145727)));
  assert.equal(env.clientCalls.length, 4);
  for (const call of env.clientCalls) assert.ok(call.url.startsWith("https://"), call.url);
  // 不拆分时的改写也保留 https（热身后已有测速数据，会换到测得最快的节点）。
  const rewritten = await env.run(mediaRequest({ url, noRange: true }));
  assert.ok(!rewritten.value.url || rewritten.value.url.startsWith("https://"), rewritten.value.url);
});

test("子请求可以强制走 https（这里只检查地址协议，本地服务器按 http 收）", async () => {
  const store = createStore();
  store.setJson("btr.settings", { subrequestScheme: "https", threads: 2 });
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest());
  assert.equal(value.response.status, 206);
  for (const call of env.clientCalls) assert.ok(call.url.startsWith("https://"), call.url);
});

test("到了总时限就交回原连接，不等在途的块：播放器只等 2.45 秒，拖过去再拼好也会被丢", async () => {
  for (const host of MAINLAND) server.setBehavior(host, { delayMs: 3000 });
  const store = createStore();
  store.setJson("btr.settings", { revision: 7, mode: "mainland", deadlineMs: 800 });
  const env = createEnv({ server, store });
  const { value, elapsedMs } = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
  assert.deepEqual(value, {}, "到点必须 $done({}) 交回原连接");
  assert.ok(elapsedMs >= 750 && elapsedMs < 1300, `应在 800 毫秒左右交回，实际 ${elapsedMs}ms`);
  const stats = store.json("btr.stats");
  assert.equal(stats.passthrough.deadline, 1);
  assert.match(stats.recent[0].error, /Deadline/);
  // 交回之后不再发新请求；已经发出去的由环境自己收拾。
  const sent = server.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(server.requests.length, sent, "交回之后不该再发请求");
});

test("量播放器的耐心：交出去的段几秒内又被要了就算被丢，过了窗口没再要就算被用", async () => {
  const store = createStore();
  store.setJson("btr.settings", { revision: 7, mode: "mainland", threads: 4 });
  // 一条 20 秒前交出去、没被再要的记录：这次运行顺手结算成「被用」。
  store.setJson("btr.delivered", [{ path: "/upgcxcode/old.m4s", start: 0, end: 1048575, at: Date.now() - 20000, ms: 2392 }]);
  const env = createEnv({ server, store });
  const first = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
  assert.equal(first.value.response.status, 206);
  let stats = store.json("btr.stats");
  assert.equal(stats.patience.used, 1);
  assert.equal(stats.patience.usedMaxMs, 2392);
  assert.equal(stats.patience.wasted, 0);
  const delivered = store.json("btr.delivered");
  assert.equal(delivered.length, 1, "刚交出去的这段记下来了，旧的那条结算后删掉");
  assert.equal(delivered[0].start, 0);
  // 同一段马上又来要（从段中间某个位置起也算）：上一份被丢了。
  const again = await env.run(mediaRequest({ headers: { Range: "bytes=524288-1048575" } }));
  assert.equal(again.value.response.status, 206);
  stats = store.json("btr.stats");
  assert.equal(stats.patience.wasted, 1);
  assert.ok(Math.abs(stats.patience.wastedMinMs - stats.recent[1].elapsedMs) <= 2, "被丢的那份当时的耗时");
  assert.equal(stats.recent[0].redo, stats.patience.wastedMinMs);
  const log = store.json("btr.log").join("\n");
  assert.match(log, /前交出的那份被丢了/);
  assert.match(log, /领跑 \S+ 原 mirrorakam/, "日志里要写领跑者和 App 原本的节点");
  const page = (await createEnv({ server: null, store }).run({ url: "http://btr.settings/", method: "GET", headers: {} })).value.response.body;
  assert.ok(page.includes("用了的最慢 2392 ms"), "设置页显示播放器的耐心");
  assert.ok(page.includes("丢了的最快"));
});
