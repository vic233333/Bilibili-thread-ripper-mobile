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
  const env = createEnv({ server });
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

test("Content-Range 对不上或长度不符的响应会被拒绝并换节点", async () => {
  server.setBehavior("upos-sz-mirrorhw.bilivideo.com", { wrongRange: true });
  server.setBehavior("upos-sz-mirrorbos.bilivideo.com", { truncate: true });
  const env = createEnv({ server });
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
  store.setJson("btr.settings", { attemptTimeoutSec: 3, deadlineSec: 15 });
  const env = createEnv({ server, store });
  const { value, elapsedMs } = await env.run(mediaRequest());
  assert.equal(value.response.status, 206);
  assert.ok(Buffer.from(value.response.body).equals(expected(1048576, 3145727)));
  assert.ok(elapsedMs >= 2500 && elapsedMs < 12000, `耗时应约等于一次超时，实际 ${elapsedMs}ms`);
  const health = env.store.json("btr.health");
  assert.match(health.hosts["upos-sz-mirrorcos.bilivideo.com"].lastError, /Timeout|timed out/);
});

test("所有节点都失败时，请求原样交回，不改地址也不改头", async () => {
  for (const host of MAINLAND) server.setBehavior(host, { status: 403 });
  const store = createStore();
  store.setJson("btr.settings", { deadlineSec: 8 });
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
  for (const call of env.clientCalls) assert.ok(call.url.startsWith("https://upos-sz-"), call.url);
  // 不拆分时的改写也保留 https。
  const rewritten = await env.run(mediaRequest({ url, noRange: true }));
  assert.ok(rewritten.value.url.startsWith("https://upos-sz-"), rewritten.value.url);
});

test("子请求可以强制走 https（这里只检查地址协议，本地服务器按 http 收）", async () => {
  const store = createStore();
  store.setJson("btr.settings", { subrequestScheme: "https", threads: 2 });
  const env = createEnv({ server, store });
  const { value } = await env.run(mediaRequest());
  assert.equal(value.response.status, 206);
  for (const call of env.clientCalls) assert.ok(call.url.startsWith("https://"), call.url);
});
