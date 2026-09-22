"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RangeServer } = require("./range-server");
const { MEDIA_URL, createEnv, createStore, mediaRequest } = require("./harness");

let server;
test.before(async () => { server = new RangeServer({ size: 4 * 1024 * 1024 }); await server.start(); });
test.after(async () => { await server.close(); });
test.beforeEach(() => { server.behaviors = {}; server.requests = []; });

async function runWith(request, settings) {
  const store = createStore();
  if (settings) store.setJson("btr.settings", settings);
  const env = createEnv({ server, store });
  const result = await env.run(request);
  return { env, value: result.value, stats: env.store.json("btr.stats") };
}

test("自动模式下留在 App 自己的节点上，除非别人快三倍以上", async () => {
  const noData = await runWith(mediaRequest({ noRange: true }));
  assert.deepEqual(noData.value, {}, "不知道谁快就别乱换");

  // 别的节点测出速度了，但 App 原本那个节点没有任何坏记录：不换。换过去要重新握手，
  // 而它的连接一直被 App 自己用着，是热的。
  const store = createStore();
  const now = Date.now();
  store.setJson("btr.health", { hosts: {
    "upos-sz-mirrorcosov.bilivideo.com": { bps: 320000, measuredAt: now },
    "upos-sz-mirrorali.bilivideo.com": { bps: 200000, measuredAt: now }
  } });
  assert.deepEqual((await createEnv({ server, store }).run(mediaRequest({ noRange: true }))).value, {},
    "原节点没坏记录就留在它身上");

  // 原节点自己测出来很慢，而且别人快三倍以上：这才换。
  const slow = createStore();
  slow.setJson("btr.health", { hosts: {
    "upos-hz-mirrorakam.akamaized.net": { segBps: 100000, segAt: now, bps: 100000, measuredAt: now },
    "upos-sz-mirrorcosov.bilivideo.com": { segBps: 2000000, segAt: now, bps: 2000000, measuredAt: now }
  } });
  const { value } = await createEnv({ server, store: slow }).run(mediaRequest({ noRange: true }));
  assert.equal(new URL(value.url).host, "upos-sz-mirrorcosov.bilivideo.com");
});

test("大陆模式下没有 Range 头：改走大陆节点（只换节点，不拆分）", async () => {
  const { value, stats } = await runWith(mediaRequest({ noRange: true }), { revision: 3, mode: "mainland" });
  assert.ok(value.url, "应当返回改写后的地址");
  const host = new URL(value.url).host;
  assert.ok(/^upos-sz-.*\.bilivideo\.com$/.test(host), host);
  assert.ok(value.url.endsWith(MEDIA_URL.slice(MEDIA_URL.indexOf("/upgcxcode"))), "路径和查询串必须原样保留");
  assert.equal(value.headers.Host, host, "Host 头要跟着改");
  assert.equal(value.headers["X-BTR-Rewritten"], "1");
  assert.equal(value.headers["User-Agent"], mediaRequest().headers["User-Agent"]);
  assert.equal(server.requests.length, 0, "只换节点时脚本自己不发请求");
  assert.equal(stats.rewritten, 1);
  assert.equal(stats.passthrough.noRange, 1);
});

test("关闭“不拆分的请求也换节点”后，没有 Range 的请求原样放过", async () => {
  const { value, stats } = await runWith(mediaRequest({ noRange: true }), { swapSingle: false });
  assert.deepEqual(value, {});
  assert.equal(stats.passthrough.noRange, 1);
});

test("开区间 bytes=a- 不拆分", async () => {
  const { value, stats } = await runWith(mediaRequest({ headers: { Range: "bytes=1000-" } }), { swapSingle: false });
  assert.deepEqual(value, {});
  assert.equal(stats.passthrough.openRange, 1);
  assert.equal(stats.recent[0].range, "bytes=1000-");
});

test("超过上限的区间不拆分", async () => {
  const { value, stats } = await runWith(mediaRequest({ headers: { Range: "bytes=0-4194303" } }), { swapSingle: false, maxMiB: 2 });
  assert.deepEqual(value, {});
  assert.equal(stats.passthrough.tooLarge, 1);
});

test("比两块还小的区间不拆分", async () => {
  const { value, stats } = await runWith(mediaRequest({ headers: { Range: "bytes=0-65535" } }), { swapSingle: false });
  assert.deepEqual(value, {});
  assert.equal(stats.passthrough.tooSmall, 1);
});

test("加速方式设为“只换节点”时，有界 Range 也不拆分，只改地址", async () => {
  const { value, stats } = await runWith(mediaRequest(), { revision: 3, mode: "mainland", accelerate: "swap" });
  assert.ok(value.url, "应当改写地址");
  assert.ok(/^upos-sz-.*\.bilivideo\.com$/.test(new URL(value.url).host));
  assert.equal(server.requests.length, 0);
  assert.equal(stats.rewritten, 1);
  assert.equal(stats.passthrough.splitOff, 1);
});

test("停用后一切原样放过", async () => {
  const { value, stats } = await runWith(mediaRequest(), { enabled: false });
  assert.deepEqual(value, {});
  assert.equal(stats.passthrough.disabled, 1);
  assert.equal(server.requests.length, 0);
});

test("HEAD 请求原样放过", async () => {
  const { value, stats } = await runWith(mediaRequest({ method: "HEAD" }));
  assert.deepEqual(value, {});
  assert.equal(stats.passthrough.notGet, 1);
});

test("PCDN 的 /v1/resource/ 路径不能换节点，原样放过", async () => {
  const url = "http://xy1x2x3x4xy.mcdn.bilivideo.cn:8000/v1/resource/123456-1-30080.m4s?agrr=0&build=7000000";
  const { value, stats } = await runWith(mediaRequest({ url, headers: { Host: "xy1x2x3x4xy.mcdn.bilivideo.cn:8000" } }));
  assert.deepEqual(value, {});
  assert.equal(stats.passthrough.notMedia, 1);
  // 排错时要能在设置页看到 App 到底请求了什么：主机带端口、路径不带查询串。
  assert.equal(stats.recent[0].host, "xy1x2x3x4xy.mcdn.bilivideo.cn:8000");
  assert.equal(stats.recent[0].path, "/v1/resource/123456-1-30080.m4s");
  assert.equal(stats.recent[0].scheme, "http");
  assert.ok(!JSON.stringify(stats).includes("agrr="), "统计里不能出现查询串");
});

test("带有脚本自己标记头的请求立刻放过，不记统计", async () => {
  const { value: viaSub, stats: statsA } = await runWith(mediaRequest({ headers: { "X-BTR-Sub": "1" } }));
  assert.deepEqual(viaSub, {});
  assert.equal(statsA, null);
  const { value: viaRewrite, stats: statsB } = await runWith(mediaRequest({ headers: { "x-btr-rewritten": "1" } }));
  assert.deepEqual(viaRewrite, {});
  assert.equal(statsB, null);
});

test("地址解析不了或没有 $request 时也会调 $done", async () => {
  const env = createEnv({ server });
  assert.deepEqual((await env.run({ url: "not a url", headers: {} })).value, {});
  assert.deepEqual((await env.run(null)).value, {});
});

test("音轨分片按文件名识别为音频", async () => {
  const url = MEDIA_URL.replace("123456-1-30080.m4s", "123456-1-30280.m4s");
  const { stats } = await runWith(mediaRequest({ url, headers: { Range: "bytes=0-524287" } }), { threads: 2 });
  assert.equal(stats.recent[0].kind, "audio");
  assert.equal(stats.recent[0].result, "accelerated");
});
