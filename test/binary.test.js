"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RangeServer } = require("./range-server");
const { createEnv, createStore, mediaRequest } = require("./harness");

let server;
test.before(async () => { server = new RangeServer({ size: 2 * 1024 * 1024 }); await server.start(); });
test.after(async () => { await server.close(); });
test.beforeEach(() => { server.behaviors = {}; server.requests = []; });

test("环境把二进制当文本返回时：改为只换节点，记下标记，只通知一次，之后不再尝试下载", async () => {
  const store = createStore();
  store.setJson("btr.settings", { revision: 3, mode: "mainland" });
  const env = createEnv({ server, store, binaryMode: false });
  const first = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
  assert.ok(first.value.url, "退化为只换节点");
  assert.ok(server.requests.length >= 1, "第一次应当真的试过下载");
  assert.equal(env.notifications.length, 1);
  assert.match(env.notifications[0].subtitle, /二进制/);
  const flags = store.json("btr.env");
  assert.equal(flags.binaryUnsupported, true);
  let stats = store.json("btr.stats");
  assert.equal(stats.passthrough.binaryUnsupported, 1);
  assert.equal(stats.rewritten, 1);

  server.requests = [];
  const second = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
  assert.ok(second.value.url);
  assert.equal(server.requests.length, 0, "标记存在时不该再发子请求");
  assert.equal(env.notifications.length, 1, "不重复通知");
  stats = store.json("btr.stats");
  assert.equal(stats.passthrough.binaryUnsupported, 2);
});

test("在设置页点“重新检测环境”后会再试一次下载", async () => {
  const store = createStore();
  store.setJson("btr.env", { binaryUnsupported: true });
  const env = createEnv({ server, store });
  await env.run({ url: "http://btr.settings/reset?what=env", method: "GET", headers: {} });
  assert.deepEqual(store.json("btr.env"), {});
  const result = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
  assert.equal(result.value.response.status, 206);
});
