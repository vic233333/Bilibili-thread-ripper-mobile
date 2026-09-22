"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createEnv, createStore, loadModules } = require("./harness");

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));

function page(pathname) {
  return { url: `http://btr.settings${pathname}`, method: "GET", headers: { Host: "btr.settings", "User-Agent": "Safari" } };
}

test("设置页能打开，显示版本和默认设置", async () => {
  const env = createEnv({ server: null });
  const { value } = await env.run(page("/"));
  assert.equal(value.response.status, 200);
  assert.match(value.response.headers["Content-Type"], /text\/html/);
  assert.ok(value.response.body.includes(pkg.version));
  assert.ok(value.response.body.includes("已启用"));
  assert.ok(value.response.body.includes("<option value=auto selected>"));
  assert.ok(value.response.body.includes("upos-sz-mirrorali.bilivideo.com"));
  assert.equal(env.store.json("btr.stats"), null, "设置页自己不算进统计");
});

test("保存表单后设置写进存储，页面回显新值", async () => {
  const env = createEnv({ server: null });
  const query = "enabled=1&mode=custom&customHosts=upos-sz-mirrorcos.bilivideo.com%0Aupos-sz-mirrorali.bilivideo.com%2C+bad+host&threads=4&maxMiB=12&minChunkKiB=512&subrequestScheme=https&attemptTimeoutSec=6&deadlineMs=2500&debug=1";
  const { value } = await env.run(page(`/save?${query}`));
  assert.equal(value.response.status, 302, "保存完要跳回设置页，留在 /save 上刷新会再存一次");
  assert.equal(value.response.headers.Location, "http://btr.settings/?done=saved");
  const saved = env.store.json("btr.settings");
  assert.deepEqual(saved, {
    revision: 7,
    enabled: true,
    accelerate: "split",
    mode: "custom",
    customHosts: ["upos-sz-mirrorcos.bilivideo.com", "upos-sz-mirrorali.bilivideo.com"],
    threads: 4,
    maxMiB: 12,
    minChunkKiB: 512,
    overfetchMiB: 0,
    swapSingle: false,
    subrequestScheme: "https",
    attemptTimeoutSec: 6,
    deadlineMs: 2500,
    debug: true
  });
  const back = (await env.run(page("/?done=saved"))).value.response.body;
  assert.ok(back.includes("设置已保存"));
  assert.ok(back.includes("<option value=4 selected>"));
  assert.ok(back.includes("<option value=custom selected>"));
});

test("越界的值会被拉回范围，缺失的复选框当作关闭", async () => {
  const env = createEnv({ server: null });
  await env.run(page("/save?mode=nonsense&threads=999&maxMiB=999&minChunkKiB=1&attemptTimeoutSec=0&deadlineMs=1000000"));
  const saved = env.store.json("btr.settings");
  assert.equal(saved.enabled, false);
  assert.equal(saved.mode, "auto");
  assert.equal(saved.threads, 6);
  assert.equal(saved.maxMiB, 24);
  assert.equal(saved.minChunkKiB, 64);
  assert.equal(saved.attemptTimeoutSec, 2);
  assert.equal(saved.deadlineMs, 40000);
  assert.equal(saved.swapSingle, false);
});

test("第 1 版设置里保存的旧默认值 256 KiB 让位给新默认值，用户自己改过的值保留", async () => {
  const BTR = await loadModules();
  const oldDefault = createStore();
  oldDefault.setJson("btr.settings", { minChunkKiB: 256, threads: 4 });
  let env = createEnv({ server: null, store: oldDefault });
  let diag = JSON.parse((await env.run(page("/diag.json"))).value.response.body);
  assert.equal(diag.settings.minChunkKiB, 128);
  assert.equal(diag.settings.threads, 4);
  const chosen = createStore();
  chosen.setJson("btr.settings", { revision: 2, minChunkKiB: 256 });
  env = createEnv({ server: null, store: chosen });
  diag = JSON.parse((await env.run(page("/diag.json"))).value.response.body);
  assert.equal(diag.settings.minChunkKiB, 256);
  assert.equal(BTR.core.normalizeSettings({}).minChunkKiB, 128);
  assert.equal(BTR.core.normalizeSettings({}).attemptTimeoutSec, 4);
  // 第 3 版：旧版本保存的“大陆”让位给“自动”；第 3 版自己保存的“大陆”保留。
  const oldMainland = createStore();
  oldMainland.setJson("btr.settings", { revision: 2, mode: "mainland" });
  env = createEnv({ server: null, store: oldMainland });
  diag = JSON.parse((await env.run(page("/diag.json"))).value.response.body);
  assert.equal(diag.settings.mode, "auto");
  const chosenMainland = createStore();
  chosenMainland.setJson("btr.settings", { revision: 3, mode: "mainland" });
  env = createEnv({ server: null, store: chosenMainland });
  diag = JSON.parse((await env.run(page("/diag.json"))).value.response.body);
  assert.equal(diag.settings.mode, "mainland");
});

test("重置统计、节点记忆和环境标记", async () => {
  const store = createStore();
  store.setJson("btr.stats", { since: 1, seen: 9, accelerated: 3, rewritten: 1, passthrough: { noRange: 5 }, bytes: 10, elapsedMs: 10, recent: [] });
  store.setJson("btr.health", { hosts: { "upos-sz-mirrorali.bilivideo.com": { bps: 1, okAt: Date.now() } } });
  store.setJson("btr.env", { binaryUnsupported: true });
  const env = createEnv({ server: null, store });
  const { value } = await env.run(page("/reset?what=all"));
  assert.equal(value.response.status, 302);
  assert.equal(value.response.headers.Location, "http://btr.settings/?done=reset&what=all");
  assert.ok((await env.run(page("/?done=reset&what=all"))).value.response.body.includes("已重置"));
  assert.equal(store.json("btr.stats").seen, 0);
  assert.deepEqual(store.json("btr.health"), { hosts: {} });
  assert.deepEqual(store.json("btr.env"), {});
});

test("全部重置把设置也恢复成默认值", async () => {
  const store = createStore();
  store.setJson("btr.settings", { revision: 3, enabled: true, threads: 16, minChunkKiB: 1024, mode: "mainland", debug: true });
  store.setJson("btr.busy", { run: { n: 8, at: Date.now() } });
  store.setJson("btr.lastMedia", { url: "http://upos-sz-mirrorali.bilivideo.com/upgcxcode/1/2/3/3-1-30080.m4s?x=1", at: Date.now() });
  const env = createEnv({ server: null, store });
  const { value } = await env.run(page("/reset?what=all"));
  assert.equal(value.response.status, 302);
  assert.deepEqual(store.json("btr.settings"), { revision: 7 });
  assert.deepEqual(store.json("btr.busy"), {});
  assert.deepEqual(store.json("btr.lastMedia"), {});
  const diag = JSON.parse((await env.run(page("/diag.json"))).value.response.body);
  assert.equal(diag.settings.threads, 6, "线程数回到默认");
  assert.equal(diag.settings.minChunkKiB, 128, "每块大小回到默认");
  assert.equal(diag.settings.mode, "auto");
  assert.equal(diag.settings.debug, false);
});

test("恢复默认设置只动设置，统计和节点记忆留着", async () => {
  const store = createStore();
  store.setJson("btr.settings", { revision: 3, threads: 16, minChunkKiB: 1024 });
  store.setJson("btr.stats", { since: 1, seen: 9, accelerated: 3, rewritten: 1, passthrough: {}, bytes: 10, elapsedMs: 10, recent: [] });
  store.setJson("btr.health", { hosts: { "upos-sz-mirrorali.bilivideo.com": { bps: 1, okAt: Date.now() } } });
  const env = createEnv({ server: null, store });
  const { value } = await env.run(page("/reset?what=settings"));
  assert.equal(value.response.status, 302);
  assert.ok((await env.run(page("/?done=reset&what=settings"))).value.response.body.includes("恢复默认"));
  assert.deepEqual(store.json("btr.settings"), { revision: 7 });
  assert.equal(store.json("btr.stats").seen, 9);
  assert.ok(store.json("btr.health").hosts["upos-sz-mirrorali.bilivideo.com"]);
});

test("第 4 版保存的旧时限让位给新默认值，用户自己改过的保留", async () => {
  const stale = createStore();
  stale.setJson("btr.settings", { revision: 4, deadlineSec: 10, attemptTimeoutSec: 6 });
  let diag = JSON.parse((await createEnv({ server: null, store: stale }).run(page("/diag.json"))).value.response.body);
  assert.equal(diag.settings.deadlineMs, 1900, "10 秒是第 4 版的默认值，不是用户的选择");
  assert.equal(diag.settings.deadlineSec, undefined, "第 7 版起总时限按毫秒计");
  assert.equal(diag.settings.attemptTimeoutSec, 4);
  const chosen = createStore();
  chosen.setJson("btr.settings", { revision: 4, deadlineSec: 25, attemptTimeoutSec: 8 });
  diag = JSON.parse((await createEnv({ server: null, store: chosen }).run(page("/diag.json"))).value.response.body);
  assert.equal(diag.settings.deadlineMs, 25000, "自己改过的值要保留，换算成毫秒");
  assert.equal(diag.settings.attemptTimeoutSec, 8);
  // 第 6 版的默认 8 秒同样让位。
  const six = createStore();
  six.setJson("btr.settings", { revision: 6, deadlineSec: 8 });
  diag = JSON.parse((await createEnv({ server: null, store: six }).run(page("/diag.json"))).value.response.body);
  assert.equal(diag.settings.deadlineMs, 1900);
});

test("诊断 JSON 包含版本、能力、设置和统计", async () => {
  const env = createEnv({ server: null });
  const { value } = await env.run(page("/diag.json"));
  const diag = JSON.parse(value.response.body);
  assert.equal(diag.version, pkg.version);
  assert.equal(diag.capabilities.httpClient, true);
  assert.equal(diag.capabilities.persistentStore, true);
  assert.equal(diag.settings.threads, 6);
  assert.equal(diag.settings.maxBytes, 8 * 1024 * 1024);
});

test("脚本日志跨运行保存，/log.txt 能看到，可清空", async () => {
  const { RangeServer } = require("./range-server");
  const { mediaRequest } = require("./harness");
  const server = new RangeServer({ size: 2 * 1024 * 1024 });
  await server.start();
  try {
    const store = createStore();
    // 固定成大陆节点：原地址的 akamai 不在候选里，noRange 那一次必定换节点，不看测速的脸色。
    store.setJson("btr.settings", { revision: 3, mode: "mainland", threads: 2, debug: true });
    const env = createEnv({ server, store });
    await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    await env.run(mediaRequest({ noRange: true }));
    const { value } = await env.run(page("/log.txt"));
    assert.equal(value.response.status, 200);
    assert.match(value.response.headers["Content-Type"], /text\/plain/);
    assert.match(value.response.body, /accelerated\/ok video 0-1048575/);
    assert.match(value.response.body, /rewritten\/noRange/);
    assert.match(value.response.body, /拆成 2 块/, "调试日志也应写入");
    const diag = JSON.parse((await env.run(page("/diag.json"))).value.response.body);
    assert.ok(diag.log.length >= 2);
    await env.run(page("/reset?what=log"));
    assert.deepEqual(store.json("btr.log"), []);
  } finally {
    await server.close();
  }
});

test("日志最多保留 300 行", async () => {
  const store = createStore();
  store.setJson("btr.log", Array.from({ length: 299 }, (_, index) => `old ${index}`));
  const env = createEnv({ server: null, store });
  await env.run({ url: "http://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/3/3-1-30080.m4s", method: "HEAD", headers: {} });
  const log = store.json("btr.log");
  assert.equal(log.length, 300);
  assert.equal(log[0], "old 0");
  assert.match(log[299], /passthrough\/notGet/);
});

test("设置页可选自动刷新", async () => {
  const env = createEnv({ server: null });
  const plain = (await env.run(page("/"))).value.response.body;
  assert.ok(!plain.includes("http-equiv=\"refresh\""));
  assert.ok(plain.includes("自动刷新：<b>关</b>"));
  const auto = (await env.run(page("/?auto=15"))).value.response.body;
  assert.ok(auto.includes("<meta http-equiv=\"refresh\" content=\"15;url=/?auto=15\">"));
  assert.ok(auto.includes("<b>15 秒</b>"));
  const bogus = (await env.run(page("/?auto=1"))).value.response.body;
  assert.ok(!bogus.includes("http-equiv=\"refresh\""), "不在选项里的间隔不生效");
});

test("节点测速：没有视频地址时提示，有地址时逐个节点测，结果也更新节点记忆", async () => {
  const { RangeServer } = require("./range-server");
  const { mediaRequest, MEDIA_URL } = require("./harness");
  const server = new RangeServer({ size: 2 * 1024 * 1024 });
  await server.start();
  try {
    const store = createStore();
    let env = createEnv({ server, store });
    let pageHtml = (await env.run(page("/speedtest"))).value.response.body;
    assert.ok(pageHtml.includes("还没有可用的视频地址"));
    // 播放一次后记住了地址（含签名，但不进诊断 JSON）；之后来的音轨地址不会覆盖画面地址，但原节点都记下。
    await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    const { AUDIO_URL } = require("./harness");
    const audioUrl = AUDIO_URL.replace("upos-hz-mirrorakam.akamaized.net", "upos-sz-mirrorcosov.bilivideo.com");
    await env.run(mediaRequest({ url: audioUrl, headers: { Host: "upos-sz-mirrorcosov.bilivideo.com", Range: "bytes=0-83318" } }));
    const remembered = store.json("btr.lastMedia");
    assert.equal(remembered.url, MEDIA_URL);
    assert.equal(remembered.kind, "video");
    assert.equal(remembered.userAgent, "Bilibili Freedoooooom/MarkII");
    assert.deepEqual(remembered.originalHosts, ["upos-sz-mirrorcosov.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"]);
    const diag = JSON.parse((await env.run(page("/diag.json"))).value.response.body);
    assert.ok(!JSON.stringify(diag).includes("upsig="), "诊断 JSON 不能带签名地址");
    pageHtml = (await env.run(page("/speedtest"))).value.response.body;
    assert.ok(pageHtml.includes("upos-hz-mirrorakam.akamaized.net"), "App 原本用的节点在表里");
    assert.ok(pageHtml.indexOf("upos-sz-mirrorcosov.bilivideo.com") < pageHtml.indexOf("data-host=\"upos-sz-mirrorali.bilivideo.com\""), "原节点排在前面");
    assert.ok((pageHtml.match(/App 原本用的节点（基线）/g) || []).length === 2);
    assert.ok(pageHtml.includes("id=lanes") && pageHtml.includes("id=bytes"), "有并发与大小档位");
    const tooBig = JSON.parse((await env.run(page("/speedtest/run?host=upos-sz-mirrorali.bilivideo.com&bytes=2097152&parallel=8"))).value.response.body);
    assert.equal(tooBig.ok, false);
    server.requests = [];
    server.setBehavior("upos-sz-mirrorhw.bilivideo.com", { status: 403 });
    const ok = JSON.parse((await env.run(page("/speedtest/run?host=upos-sz-mirrorali.bilivideo.com&bytes=262144"))).value.response.body);
    assert.equal(ok.ok, true);
    assert.equal(ok.parallel, 1);
    assert.equal(ok.bytes, 262144);
    assert.ok(ok.bps > 0);
    assert.equal(server.requests[0].headers["user-agent"], "Bilibili Freedoooooom/MarkII");
    assert.ok(server.requests[0].path.includes("upsig=deadbeef"), "测速要带原地址的签名");
    server.requests = [];
    const many = JSON.parse((await env.run(page("/speedtest/run?host=upos-sz-mirrorali.bilivideo.com&bytes=131072&parallel=4"))).value.response.body);
    assert.equal(many.ok, true);
    assert.equal(many.parallel, 4);
    assert.equal(many.okLanes, 4);
    assert.equal(many.bytes, 4 * 131072);
    assert.equal(many.laneBps.length, 4);
    assert.deepEqual(server.requests.map((item) => item.range).sort(), ["bytes=0-131071", "bytes=131072-262143", "bytes=262144-393215", "bytes=393216-524287"], "四路各下不同区间");
    const bad = JSON.parse((await env.run(page("/speedtest/run?host=upos-sz-mirrorhw.bilivideo.com"))).value.response.body);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /BadRange/);
    const invalid = JSON.parse((await env.run(page("/speedtest/run?host=evil.example.com"))).value.response.body);
    assert.equal(invalid.ok, false);
    const health = store.json("btr.health");
    assert.ok(health.hosts["upos-sz-mirrorali.bilivideo.com"].bps > 0);
    assert.ok(health.hosts["upos-sz-mirrorhw.bilivideo.com"].fails >= 1);
  } finally {
    await server.close();
  }
});

test("同一段还在拆的时候再来一份，只换节点不再拆；拆完后再来则照常拆", async () => {
  const { RangeServer } = require("./range-server");
  const { mediaRequest } = require("./harness");
  const server = new RangeServer({ size: 2 * 1024 * 1024 });
  await server.start();
  try {
    const store = createStore();
    store.setJson("btr.settings", { revision: 3, mode: "mainland" });
    const env = createEnv({ server, store });
    // 先人为登记一段“正在拆”。
    store.setJson("btr.inflight", { ["/upgcxcode/12/34/123456/123456-1-30080.m4s#0-1048575"]: Date.now() });
    const dup = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    assert.ok(dup.value.url, "重复的那份只换节点");
    assert.equal(store.json("btr.stats").recent[0].reason, "duplicate");
    // 过期的登记不算。
    store.setJson("btr.inflight", { ["/upgcxcode/12/34/123456/123456-1-30080.m4s#0-1048575"]: Date.now() - 60000 });
    const fresh = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    assert.equal(fresh.value.response.status, 206);
    assert.deepEqual(store.json("btr.inflight"), {}, "拆完后登记被清掉");
  } finally {
    await server.close();
  }
});

test("设置页显示模式徽标；https 版长时间只收到明文分片时提示检查解密与证书", async () => {
  const { RangeServer } = require("./range-server");
  const { mediaRequest, MEDIA_URL } = require("./harness");
  const server = new RangeServer({ size: 2 * 1024 * 1024 });
  await server.start();
  try {
    // http 版：徽标写明文，没有提示。
    let store = createStore();
    let env = createEnv({ server, store, argument: "mode=http" });
    await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    let html = (await env.run(page("/"))).value.response.body;
    assert.ok(html.includes("http 明文模式"));
    assert.ok(!html.includes("没有收到任何 https 分片"));
    assert.ok(!html.includes("按看到过的协议推断"));
    // https 版、还没有任何分片：常驻的温和提示。
    store = createStore();
    env = createEnv({ server, store, argument: "mode=https" });
    html = (await env.run(page("/"))).value.response.body;
    assert.ok(html.includes("http + https 模式"));
    assert.ok(html.includes("还没收到过任何 https 分片"));
    assert.ok(!html.includes("只收到了明文分片"));
    // 只有明文进来：升级为醒目警告。
    await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    html = (await env.run(page("/"))).value.response.body;
    assert.ok(html.includes("只收到了明文分片，没有任何 https 分片"));
    assert.ok(html.includes("*.bilivideo.com"));
    // https 分片进来了：提示消失，行首有锁。
    const httpsUrl = "https://" + MEDIA_URL.slice("http://".length);
    await env.run(mediaRequest({ url: httpsUrl, headers: { Range: "bytes=0-1048575" } }));
    html = (await env.run(page("/"))).value.response.body;
    assert.ok(!html.includes("https 分片。</b>") && !html.includes("还没收到过任何 https 分片"));
    assert.ok(html.includes("🔒 upos-hz-mirrorakam"));
    const stats = store.json("btr.stats");
    assert.deepEqual(stats.schemes, { http: 1, https: 1 });
    // 老模块没有 argument：按看到过的协议推断并注明。
    env = createEnv({ server, store });
    html = (await env.run(page("/"))).value.response.body;
    assert.ok(html.includes("按看到过的协议推断"));
    assert.ok(html.includes("http + https 模式"));
  } finally {
    await server.close();
  }
});

test("设置页带一键复制：日志和诊断 JSON 预先放在页面里，节点名省略后缀", async () => {
  const store = createStore();
  store.setJson("btr.log", ["12:00:00 [info] accelerated/ok video 0-1 5ms"]);
  store.setJson("btr.health", { hosts: { "upos-sz-mirrorali.bilivideo.com": { bps: 1000000, okAt: Date.now(), measuredAt: Date.now(), lastError: "x".repeat(80) } } });
  const env = createEnv({ server: null, store });
  const html = (await env.run(page("/"))).value.response.body;
  assert.ok(html.includes("data-copy=log") && html.includes("data-copy=diag"));
  assert.ok(html.includes("<textarea id=copy-log class=copybox readonly>") && html.includes("accelerated/ok video 0-1 5ms"));
  assert.ok(html.includes("<textarea id=copy-diag class=copybox readonly>") && html.includes("&quot;version&quot;"));
  assert.ok(html.includes("<details id=box-log"), "文本框放在可展开的区块里，复制失败时可以手动全选");
  assert.ok(html.includes("<abbr title=\"upos-sz-mirrorali.bilivideo.com\">upos-sz-mirrorali</abbr>"));
  assert.ok(html.includes("x".repeat(36) + "…"), "过长的错误信息要截断");
  assert.ok(html.includes("class=scroll"));
});

test("模块和配置文件的脚本行都声明了模式", () => {
  const dir = path.resolve(__dirname, "..", "shadowrocket");
  for (const file of fs.readdirSync(dir).filter((name) => /\.(sgmodule|conf)$/.test(name))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const mode = file.includes("https") ? "https" : "http";
    const lines = text.split("\n").filter((line) => /^btr-(media|settings) = /.test(line));
    for (const line of lines) assert.ok(line.includes(`argument=mode=${mode},`), `${file}: ${line}`);
  }
});

test("全局在途上限：别的段占着名额时这段少开几条，占满时只换节点；登记会过期", async () => {
  const { RangeServer } = require("./range-server");
  const { mediaRequest } = require("./harness");
  const server = new RangeServer({ size: 4 * 1024 * 1024 });
  await server.start();
  try {
    const store = createStore();
    store.setJson("btr.settings", { revision: 3, mode: "mainland", threads: 8 });
    // 别的运行占了 10 条：这段最多只能开 4 条，减去副本余量后拆 3 块。
    store.setJson("btr.busy", { other: { n: 10, at: Date.now() } });
    let env = createEnv({ server, store });
    let result = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    assert.equal(result.value.response.status, 206);
    assert.ok(/pieces=3;/.test(result.value.response.headers["X-BTR"]), result.value.response.headers["X-BTR"]);
    assert.deepEqual(Object.keys(store.json("btr.busy")), ["other"], "结束后自己的登记要注销");
    // 占满了：只换节点。
    store.setJson("btr.busy", { other: { n: 13, at: Date.now() } });
    store.setJson("btr.health", { hosts: { "upos-sz-mirrorali.bilivideo.com": { bps: 1, measuredAt: Date.now() } } });
    result = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    assert.ok(result.value.url, "应当只换节点");
    assert.equal(store.json("btr.stats").recent[0].reason, "busy");
    // 过期的登记不算。
    store.setJson("btr.busy", { other: { n: 13, at: Date.now() - 60000 } });
    result = await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    assert.ok(/pieces=8;/.test(result.value.response.headers["X-BTR"]));
  } finally {
    await server.close();
  }
});

test("预取实验页：先交付页面，回调之后把结果写进标记", async () => {
  const { RangeServer } = require("./range-server");
  const { mediaRequest } = require("./harness");
  const server = new RangeServer({ size: 2 * 1024 * 1024 });
  await server.start();
  try {
    const store = createStore();
    const env = createEnv({ server, store });
    await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    const { value } = await env.run(page("/probe/after-done"));
    assert.equal(value.response.status, 200);
    assert.ok(value.response.body.includes("预取实验"));
    const atDelivery = store.json("btr.probe");
    assert.equal(atDelivery.control.state, "ok", "对照那一发在交页面之前就该跑完");
    assert.equal(atDelivery.pending.state, "sent", "页面交出去时另一发还在路上");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const result = JSON.parse((await env.run(page("/probe/after-done/result"))).value.response.body);
    assert.equal(result.pending.state, "ok", "Node 里回调当然会到；真机上要看 Shadowrocket");
    assert.equal(result.delayed.state, "ok", "交出页面之后由定时器发出的那一发也该跑完");
    assert.ok(result.pendingCallback.ms >= 0, "真回调到达的时间也要记下来");
    assert.equal(result.control.bytes, 64 * 1024);
  } finally {
    await server.close();
  }
});

test("重置和保存都跳回设置页：停在那个地址上反复刷新不会一再重置", async () => {
  const { RangeServer } = require("./range-server");
  const { mediaRequest } = require("./harness");
  const server = new RangeServer({ size: 2 * 1024 * 1024 });
  await server.start();
  try {
    const store = createStore();
    const env = createEnv({ server, store });
    await env.run(page("/reset?what=all"));
    await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    const since = store.json("btr.stats").since;
    assert.equal(store.json("btr.stats").seen, 1);

    // 跳转的落点是设置页，刷新它多少次都只是看一眼。
    for (let round = 0; round < 3; round += 1) {
      const { value } = await env.run(page("/?done=reset&what=all"));
      assert.equal(value.response.status, 200);
    }
    assert.equal(store.json("btr.stats").seen, 1, "看页面不该清掉统计");
    assert.equal(store.json("btr.stats").since, since, "“统计开始于”不该每次刷新都往后走");
    assert.equal(store.json("btr.beat").mediaN, 1);

    // 全部重置刚清掉心跳，这次打开要重新记上，不然看着像存储坏了。
    await env.run(page("/reset?what=all"));
    assert.equal(store.json("btr.beat").pageN, 1);
  } finally {
    await server.close();
  }
});

test("心跳记下脚本跑过几次，统计存不下来时也看得出来", async () => {
  const { RangeServer } = require("./range-server");
  const { mediaRequest } = require("./harness");
  const server = new RangeServer({ size: 2 * 1024 * 1024 });
  await server.start();
  try {
    const store = createStore();
    const env = createEnv({ server, store });
    await env.run(mediaRequest({ headers: { Range: "bytes=0-1048575" } }));
    await env.run(mediaRequest({ noRange: true }));
    assert.equal(store.json("btr.beat").mediaN, 2, "两次分片请求应当记两次心跳");
    const first = await env.run(page("/"));
    assert.equal(store.json("btr.beat").pageN, 1);
    assert.ok(first.value.response.body.includes("分片脚本运行过"));
    await env.run(page("/"));
    assert.equal(store.json("btr.beat").pageN, 2, "每打开一次设置页 +1");

    // 存储把统计丢了：页面要说出“脚本跑过、但存不下来”，而不是一味显示 0。
    store.remove("btr.stats");
    const again = await env.run(page("/"));
    assert.match(again.value.response.body, /持久存储没有把数据保存下来/);
    assert.ok(again.value.response.body.includes("这次新建的"));
  } finally {
    await server.close();
  }
});

test("存储自检分三层报告：接口、同一次运行读回、跨运行保留", async () => {
  const store = createStore();
  const env = createEnv({ server: null, store });
  const first = await env.run(page("/store/test"));
  assert.equal(first.value.response.status, 200);
  assert.match(first.value.response.body, /还差一步/, "第一次没有上一次的值可比");
  const second = await env.run(page("/store/test"));
  assert.match(second.value.response.body, /存储正常/, "第二次应当读到上一次写下的值");
  assert.match(second.value.response.body, /btr\.stats/, "要列出每把键占多少字节");

  const dead = createEnv({ server: null, noStore: true });
  const broken = await dead.run(page("/store/test"));
  assert.match(broken.value.response.body, /没有 \$persistentStore/);
});

test("不存在的页面返回 404", async () => {
  const env = createEnv({ server: null });
  const { value } = await env.run(page("/nothing"));
  assert.equal(value.response.status, 404);
});

test("core 里的解析规则", async () => {
  const BTR = await loadModules();
  const { core } = BTR;
  assert.deepEqual(core.parseRangeHeader("bytes=0-99"), { kind: "bounded", raw: "bytes=0-99", start: 0, end: 99, length: 100 });
  assert.equal(core.parseRangeHeader("bytes=5-").kind, "open");
  assert.equal(core.parseRangeHeader("bytes=-500").kind, "suffix");
  assert.equal(core.parseRangeHeader("bytes=0-1,5-9").kind, "multi");
  assert.equal(core.parseRangeHeader("bytes=9-5").kind, "invalid");
  assert.equal(core.parseRangeHeader(undefined).kind, "none");
  assert.deepEqual(core.parseContentRange("bytes 10-19/100"), { start: 10, end: 19, total: 100, length: 10 });
  assert.equal(core.parseContentRange("bytes 10-19/15"), null);
  assert.equal(core.parseContentRange("bytes 10-19/*").total, null);

  const parts = core.parseUrl("http://upos-hz-mirrorakam.akamaized.net:80/upgcxcode/a/b.m4s?x=1&y=2#frag");
  assert.equal(parts.host, "upos-hz-mirrorakam.akamaized.net");
  assert.equal(parts.port, "80");
  assert.equal(parts.path, "/upgcxcode/a/b.m4s");
  assert.equal(parts.query, "?x=1&y=2");
  assert.equal(core.buildUrl(parts, { host: "upos-sz-mirrorali.bilivideo.com", port: "" }), "http://upos-sz-mirrorali.bilivideo.com/upgcxcode/a/b.m4s?x=1&y=2");
  assert.ok(core.isMediaUrl(parts) && core.isUposPath(parts));
  assert.equal(core.isMediaUrl(core.parseUrl("http://example.com/upgcxcode/a/b.m4s")), false);
  assert.equal(core.isUposPath(core.parseUrl("http://a.mcdn.bilivideo.cn:8000/v1/resource/b.m4s")), false);

  const pieces = core.splitRange(0, 1024 * 1024 - 1, 8, 256 * 1024);
  assert.equal(pieces.length, 4);
  assert.equal(pieces[0].start, 0);
  assert.equal(pieces[3].end, 1024 * 1024 - 1);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.length, 0), 1024 * 1024);
  assert.equal(core.splitRange(0, 99, 8, 256 * 1024).length, 1);

  assert.equal(core.normalizeCdnHost("HTTPS://upos-sz-mirrorali.bilivideo.com/path"), "upos-sz-mirrorali.bilivideo.com");
  assert.equal(core.normalizeCdnHost("cn-hk-eq-01-01.bilivideo.com:443"), "cn-hk-eq-01-01.bilivideo.com");
  assert.equal(core.normalizeCdnHost("evil.example.com"), "");
  assert.equal(core.mediaKind("/upgcxcode/1/2/3/3-1-30280.m4s"), "audio");
  assert.equal(core.mediaKind("/upgcxcode/1/2/3/3-1-30080.m4s"), "video");
  assert.equal(core.mediaKind("/upgcxcode/1/2/3/3-1-100026.m4s"), "video");
  assert.equal(core.mediaKind("/foo.m4s"), "unknown");

  const auto = core.normalizeSettings({});
  assert.equal(auto.mode, "auto");
  assert.deepEqual(core.candidateHosts("upos-hz-mirrorakam.akamaized.net", auto), ["upos-hz-mirrorakam.akamaized.net", ...core.OVERSEAS_HOSTS, ...core.MAINLAND_HOSTS]);
  assert.deepEqual(core.candidateHosts("upos-sz-mirrorcosov.bilivideo.com", auto)[0], "upos-sz-mirrorcosov.bilivideo.com");
  assert.equal(core.candidateHosts("upos-sz-mirrorcosov.bilivideo.com", auto).length, core.OVERSEAS_HOSTS.length + core.MAINLAND_HOSTS.length, "原节点已在列表里时不重复");
  const mainland = core.normalizeSettings({ mode: "mainland" });
  assert.deepEqual(core.candidateHosts("upos-hz-mirrorakam.akamaized.net", mainland), [...core.MAINLAND_HOSTS]);
  assert.deepEqual(core.candidateHosts("upos-sz-mirrorcos.bilivideo.com", mainland)[0], "upos-sz-mirrorcos.bilivideo.com");
  const overseas = core.normalizeSettings({ mode: "overseas" });
  assert.deepEqual(core.candidateHosts("upos-hz-mirrorakam.akamaized.net", overseas), ["upos-hz-mirrorakam.akamaized.net", ...core.OVERSEAS_HOSTS]);
  assert.deepEqual(core.candidateHosts("upos-sz-mirrorali.bilivideo.com", overseas), [...core.OVERSEAS_HOSTS]);
});

test("节点排序：热身时撒到所有节点，测过速度后按快慢并保留一个探路名额，退避的排最后", async () => {
  const BTR = await loadModules();
  const { accelerator } = BTR;
  const now = Date.now();
  const hosts = ["a.bilivideo.com", "b.bilivideo.com", "c.bilivideo.com", "d.bilivideo.com"];
  const warm = accelerator.orderCandidates(hosts, { hosts: { "a.bilivideo.com": { bps: 100, measuredAt: now } } }, 8);
  assert.deepEqual(warm.pool, hosts, "只有一个测过时仍在热身");
  const measured = accelerator.orderCandidates(hosts, { hosts: {
    "a.bilivideo.com": { bps: 100, measuredAt: now },
    "b.bilivideo.com": { bps: 300, measuredAt: now },
    "c.bilivideo.com": { bps: 999, measuredAt: now - 10 * 60 * 1000 },
    "d.bilivideo.com": { blockedUntil: now + 5000, fails: 1 }
  } }, 8);
  assert.deepEqual(measured.pool, ["b.bilivideo.com", "a.bilivideo.com", "c.bilivideo.com"], "快的在前，过期的 c 当探路");
  assert.deepEqual(measured.all, ["b.bilivideo.com", "a.bilivideo.com", "c.bilivideo.com", "d.bilivideo.com"]);
  const allBlocked = accelerator.orderCandidates(hosts.slice(0, 2), { hosts: {
    "a.bilivideo.com": { blockedUntil: now + 9000 },
    "b.bilivideo.com": { blockedUntil: now + 1000 }
  } }, 8);
  assert.deepEqual(allBlocked.pool, ["b.bilivideo.com", "a.bilivideo.com"], "全在退避时先试最早解禁的");
});

test("一段只用最快的那个节点；隔一阵子留一块去试没测过的；热身时轮着撒", async () => {
  const BTR = await loadModules();
  const { assignPieces } = BTR.accelerator;
  const now = Date.now();
  const pool = ["fast.bilivideo.com", "near.bilivideo.com", "half.bilivideo.com", "crawl.bilivideo.com", "new.bilivideo.com"];
  const hosts = {
    "fast.bilivideo.com": { bps: 320000, measuredAt: now },
    "near.bilivideo.com": { bps: 260000, measuredAt: now },
    "half.bilivideo.com": { bps: 150000, measuredAt: now },
    "crawl.bilivideo.com": { bps: 40000, measuredAt: now }
  };

  // 刚试探过：整段都压给最快的那个，连第二快的都不带——一段的用时由最慢的那块决定。
  const health = { hosts, trialAt: now };
  assert.deepEqual(assignPieces(pool, health, 4), Array(4).fill("fast.bilivideo.com"));

  // 距上次试探过了一阵：最后一块去试没测过的节点，其余仍然全给最快的。
  const due = { hosts, trialAt: now - 60000 };
  const assignment = assignPieces(pool, due, 8);
  assert.deepEqual(assignment.slice(0, 7), Array(7).fill("fast.bilivideo.com"));
  assert.equal(assignment[7], "new.bilivideo.com");
  assert.ok(due.trialAt >= now, "试探的时间要记下来，免得每段都试");
  assert.deepEqual(assignPieces(pool, { hosts, trialAt: now - 60000 }, 2), Array(2).fill("fast.bilivideo.com"), "块太少时不试新节点");

  // 速度数据过期了也照样按它排，只是不算新鲜。
  const stale = { hosts: { "fast.bilivideo.com": { bps: 320000, measuredAt: now - 3600000 }, "near.bilivideo.com": { bps: 100000, measuredAt: now - 3600000 } } };
  assert.deepEqual(assignPieces(["fast.bilivideo.com", "near.bilivideo.com"], stale, 4), Array(4).fill("fast.bilivideo.com"));

  // 一个都没测过：撒一轮，把它们一次都量出来。
  const warm = assignPieces(pool, { hosts: {} }, 7);
  assert.deepEqual(warm, ["fast.bilivideo.com", "near.bilivideo.com", "half.bilivideo.com", "crawl.bilivideo.com", "new.bilivideo.com", "fast.bilivideo.com", "near.bilivideo.com"]);
});

test("整段成绩好的节点不会因为单块记录过期而掉出候选", async () => {
  const BTR = await loadModules();
  const { orderCandidates } = BTR.accelerator;
  const now = Date.now();
  const hosts = ["good.bilivideo.com", "thin.bilivideo.com", "new.bilivideo.com"];
  const health = { hosts: {
    // 整段实测很好，但单块的测速记录已经过期了。
    "good.bilivideo.com": { segBps: 9e6, segAt: now - 60000, bps: 9e6, measuredAt: now - 3600000 },
    "thin.bilivideo.com": { bps: 3e6, measuredAt: now }
  } };
  const ordered = orderCandidates(hosts, health, 6, "");
  assert.equal(ordered.pool[0], "good.bilivideo.com", "整段实测新鲜就该排在最前");
  assert.ok(ordered.pool.indexOf("thin.bilivideo.com") > 0);
});

test("领跑者：在位的不轻易换，明显更快的才换得掉", async () => {
  const BTR = await loadModules();
  const { chooseLeader, hostScore } = BTR.accelerator;
  const now = Date.now();
  const pool = ["akam.akamaized.net", "aliov.bilivideo.com", "cosov.bilivideo.com"];
  const seg = (bps) => ({ segBps: bps, segAt: now });

  // 在位的领跑者速度接近时留任：真机日志里五分钟换了 34 次，每次换错就是一段五六秒。
  const close = { leader: "akam.akamaized.net", hosts: {
    "akam.akamaized.net": seg(8e6), "aliov.bilivideo.com": seg(10e6), "cosov.bilivideo.com": seg(2e6) } };
  assert.equal(chooseLeader(pool, close, ""), "akam.akamaized.net", "只快 1.25 倍，不值得换");

  // 明显更快才换。
  const clear = { leader: "akam.akamaized.net", hosts: {
    "akam.akamaized.net": seg(2e6), "aliov.bilivideo.com": seg(9e6), "cosov.bilivideo.com": seg(1e6) } };
  assert.equal(chooseLeader(pool, clear, ""), "aliov.bilivideo.com");
  assert.equal(clear.leader, "aliov.bilivideo.com", "换了就要记下来");

  // 在位的被退避了，立刻换人。
  const blocked = { leader: "akam.akamaized.net", hosts: {
    "akam.akamaized.net": Object.assign(seg(9e6), { blockedUntil: now + 30000 }),
    "aliov.bilivideo.com": seg(1e6), "cosov.bilivideo.com": seg(2e6) } };
  assert.equal(chooseLeader(pool, blocked, ""), "cosov.bilivideo.com");

  // 只有单块测量的节点打对折，再加上 1.5 倍的门槛，等于要三倍才推得翻整段实测过的在位者。
  const thin = { leader: "akam.akamaized.net", hosts: {
    "akam.akamaized.net": seg(4e6), "aliov.bilivideo.com": { bps: 10e6, measuredAt: now } } };
  assert.equal(chooseLeader(pool, thin, ""), "akam.akamaized.net", "一次侥幸的快块不该改朝换代");
  assert.ok(hostScore(thin, "aliov.bilivideo.com", "") < hostScore(thin, "akam.akamaized.net", "") * 1.5,
    "10 MB/s 的单块打完对折也够不到整段实测 4 MB/s 的 1.5 倍");

  // App 自己那个节点加分：势均力敌时留在它上面。
  const tie = { leader: "", hosts: { "akam.akamaized.net": seg(5e6), "aliov.bilivideo.com": seg(6e6) } };
  assert.equal(chooseLeader(pool, tie, "akam.akamaized.net"), "akam.akamaized.net");
});

test("领跑位默认留给 App 自己的节点，一次抽风也打不垮它", async () => {
  const BTR = await loadModules();
  const { chooseLeader, markSlow, markSuccess } = BTR.accelerator;
  const now = Date.now();
  const app = "akam.akamaized.net";
  const pool = [app, "hk.bilivideo.com", "ali.bilivideo.com"];

  // 别人测得更快，但只是快一点：留在 App 的节点上。
  const better = { hosts: {
    [app]: { segBps: 3e6, segAt: now },
    "hk.bilivideo.com": { segBps: 7e6, segAt: now }
  } };
  assert.equal(chooseLeader(pool, better, app), app);

  // App 的节点还没有任何记录：也留在它身上，没有理由先怀疑它。
  const blank = { hosts: { "hk.bilivideo.com": { segBps: 9e6, segAt: now } } };
  assert.equal(chooseLeader(pool, blank, app), app);

  // 它自己实测很慢，别人快三倍以上：这才换。
  const slow = { hosts: {
    [app]: { segBps: 3e5, segAt: now },
    "hk.bilivideo.com": { segBps: 2e6, segAt: now }
  } };
  assert.equal(chooseLeader(pool, slow, app), "hk.bilivideo.com");

  // 它被退避时立刻换人。
  const blocked = { hosts: {
    [app]: { segBps: 9e6, segAt: now, blockedUntil: now + 30000 },
    "hk.bilivideo.com": { segBps: 1e6, segAt: now }
  } };
  assert.equal(chooseLeader(pool, blocked, app), "hk.bilivideo.com");

  // 整条链路抽风时每个节点都会吃到悲观采样，但一次最多打到四分之一，
  // 不至于把所有记忆变成废墟、让谁先侥幸成功谁就上位。
  const storm = { hosts: {} };
  markSuccess(storm, app, 1048576, 100);
  const peak = storm.hosts[app].bps;
  markSlow(storm, app, 174763, 2000);
  assert.ok(storm.hosts[app].bps >= peak / 4 - 1, "一次观测最多打到四分之一");
});

test("记分跌得快涨得慢，崩掉的节点一两段就让位", async () => {
  const BTR = await loadModules();
  const { markSuccess, markSegment, chooseLeader } = BTR.accelerator;
  const health = { hosts: {} };

  // 一个 10 MB/s 的节点，连续两块只有 30 KB/s：分数要掉到跟它现在的实力一个量级。
  markSuccess(health, "fast.bilivideo.com", 1048576, 100);
  const peak = health.hosts["fast.bilivideo.com"].bps;
  assert.ok(peak > 9e6);
  markSuccess(health, "fast.bilivideo.com", 174763, 5700);
  assert.ok(health.hosts["fast.bilivideo.com"].bps < peak * 0.35, "一次就要掉下来一大截");
  markSuccess(health, "fast.bilivideo.com", 174763, 5700);
  assert.ok(health.hosts["fast.bilivideo.com"].bps < 1e6);
  // 反过来，一次快样本只能把它抬回去一点点。
  const low = health.hosts["fast.bilivideo.com"].bps;
  markSuccess(health, "fast.bilivideo.com", 1048576, 100);
  assert.ok(health.hosts["fast.bilivideo.com"].bps < low + 10e6 * 0.35);

  // 整段实测记在「押给谁」头上：被副本救回来的慢段不能记成救场那个的成绩。
  const seg = { hosts: {} };
  assert.equal(markSegment(seg, "", 1048576, 1000), "", "没有领跑者就没有成绩");
  assert.equal(markSegment(seg, "a.bilivideo.com", 1048576, 100), "a.bilivideo.com");
  assert.ok(seg.hosts["a.bilivideo.com"].segBps > 9e6);
  // 同一个节点下一段崩了，整段实测同样跌得快。
  markSegment(seg, "a.bilivideo.com", 1048576, 5700);
  assert.ok(seg.hosts["a.bilivideo.com"].segBps < 3.5e6);
  seg.leader = "a.bilivideo.com";
  seg.hosts["b.bilivideo.com"] = { segBps: 9e6, segAt: Date.now() };
  assert.equal(chooseLeader(["a.bilivideo.com", "b.bilivideo.com"], seg, ""), "b.bilivideo.com", "崩了就该换人");
});

test("悲观采样：开副本那一刻就把「至少用了这么久」记进节点记忆", async () => {
  const BTR = await loadModules();
  const { markSlow, markSuccess, markFailure } = BTR.accelerator;
  const health = { hosts: {} };
  markSuccess(health, "fast.bilivideo.com", 1048576, 100);
  const peak = health.hosts["fast.bilivideo.com"].bps;

  // 还没回来的请求：174 KiB 已经等了 2 秒，速度至多 87 KB/s，记一笔。
  assert.equal(markSlow(health, "fast.bilivideo.com", 174763, 2000), true);
  assert.ok(health.hosts["fast.bilivideo.com"].bps < peak * 0.35);
  // 才等了 100 毫秒，判不出慢，不记。
  const before = health.hosts["fast.bilivideo.com"].bps;
  assert.equal(markSlow(health, "fast.bilivideo.com", 174763, 100), false);
  assert.equal(health.hosts["fast.bilivideo.com"].bps, before);
  // 上界比现有记录还宽松，说明这次还算快，也不记。
  assert.equal(markSlow(health, "fast.bilivideo.com", 1048576, 300), false);

  // 超时同样要掉分：以前这里只记退避不动分数，卡死的节点熬过退避又回来当领跑者。
  const stuck = { hosts: {} };
  markSuccess(stuck, "dead.bilivideo.com", 1048576, 100);
  const high = stuck.hosts["dead.bilivideo.com"].bps;
  markFailure(stuck, "dead.bilivideo.com", { name: "TimeoutError" }, 174763, 4000);
  assert.ok(stuck.hosts["dead.bilivideo.com"].bps < high * 0.35, "超时的节点必须掉分");
  assert.ok(stuck.hosts["dead.bilivideo.com"].blockedUntil > Date.now());
});

test("副本等待时间按这块派给的那个节点自己的块耗时来估", async () => {
  const BTR = await loadModules();
  const { markSuccess, hedgeDelayMs } = BTR.accelerator;
  const health = { hosts: {} };
  markSuccess(health, "quick.bilivideo.com", 174763, 90);
  markSuccess(health, "slow.bilivideo.com", 174763, 1500);
  const plan = { health, assignment: ["quick.bilivideo.com", "slow.bilivideo.com"] };
  const piece = { index: 0, length: 174763 };
  assert.equal(hedgeDelayMs(plan, piece), 400, "快节点：按它自己的 90 毫秒估，落到 400 毫秒下限");
  const other = hedgeDelayMs(plan, { index: 1, length: 174763 });
  assert.ok(other > 800 && other <= 1000, "慢节点：等久一点，但封顶在 1 秒，否则副本在 1.9 秒的时限里跑不完 " + other);
  // 试探块单独一档，最多拖半秒多一点。
  const trial = hedgeDelayMs(plan, { index: 1, length: 174763, trial: true });
  assert.ok(trial >= 300 && trial <= 700, "试探块 " + trial);
});

test("构建产物带有原作署名，且与 package.json 版本一致", () => {
  const bundle = fs.readFileSync(path.resolve(__dirname, "..", "shadowrocket", "bilibili-thread-ripper.js"), "utf8");
  assert.ok(bundle.startsWith("/*!"));
  assert.ok(bundle.includes("MrTangLuyao/Bilibili-thread-ripper"));
  assert.ok(bundle.includes(`const BTR = { VERSION: "${pkg.version}" };`));
  assert.ok(!/\$request\s*=/.test(bundle.replace(/typeof \$request/g, "")), "不要给环境变量赋值");
});

test("模块和配置文件里的脚本地址都带当前版本号，匹配规则覆盖所有 B 站 CDN 主机", () => {
  const dir = path.resolve(__dirname, "..", "shadowrocket");
  const files = fs.readdirSync(dir).filter((file) => /\.(sgmodule|conf)$/.test(file));
  assert.equal(files.length, 4);
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const scriptLines = text.split("\n").filter((line) => /^btr-(media|settings) = /.test(line));
    assert.equal(scriptLines.length, 2, file);
    for (const line of scriptLines) {
      const role = line.startsWith("btr-media") ? "media" : "settings";
      assert.ok(line.includes(`bilibili-thread-ripper.js?role=${role}&v=${pkg.version}`), `${file}: ${line}`);
      assert.ok(line.includes("engine=webview"), file);
      // 真机上发现同一个脚本地址的两条规则只有一条生效，所以两条的地址必须不同。
      assert.ok(!scriptLines.some((other) => other !== line && /script-path=(\S+)/.exec(other)[1] === /script-path=(\S+)/.exec(line)[1]), file);
    }
    const media = scriptLines.find((line) => line.startsWith("btr-media"));
    const patternText = /pattern=(\S+),/.exec(media)[1];
    assert.ok(!patternText.includes("(?:") && !patternText.endsWith("$"), "匹配规则保持最简单的写法：" + patternText);
    const pattern = new RegExp(patternText);
    assert.ok(pattern.test("http://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/3/3-1-30080.m4s?x=1"), file);
    assert.ok(pattern.test("http://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/34/75/41969257534/41969257534-1-30216.m4s?e=1&upsig=2"), file);
    assert.ok(pattern.test("http://xy1x2x3x4xy.mcdn.bilivideo.cn:8000/v1/resource/3-1-30080.m4s?x=1"), file);
    assert.ok(!pattern.test("http://api.bilibili.com/x/player/playurl"), file);
    assert.ok(!pattern.test("http://btr.settings/"), file);
    assert.equal(pattern.test("https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/3/3-1-30080.m4s"), file.includes("https"), file);
    if (file.includes("https")) assert.ok(/^\[MITM\]/m.test(text) && /hostname = .*akamaized\.net/.test(text), file);
    else assert.ok(!/hostname = /.test(text), file);
  }
});

test("过期的整段成绩压不住更新的单块证据：下了领跑位的节点能靠试探块回来", async () => {
  const BTR = await loadModules();
  const { hostScore, markSegment, markSuccess } = BTR.accelerator;
  const health = { hosts: {} };
  // 抽风时领跑过一段：整段成绩只有 130 KB/s，两分钟内都算「新鲜」。
  markSegment(health, "akam.akamaized.net", 1048576, 8000);
  const stale = hostScore(health, "akam.akamaized.net", "");
  assert.ok(stale < 2e5);
  // 之后一块试探块 170 KiB 只用了 50 毫秒：新证据要能把分抬上去（单块打对折）。
  await new Promise((resolve) => setTimeout(resolve, 5));
  markSuccess(health, "akam.akamaized.net", 174763, 50);
  const lifted = hostScore(health, "akam.akamaized.net", "");
  assert.ok(lifted > 1e6, "更新的快样本应当抬分 " + lifted);
  assert.ok(Math.abs(lifted - health.hosts["akam.akamaized.net"].bps * 0.5) < 1, "抬到单块速度的一半");
  // 反方向不走这条：整段成绩好、之后单块慢，仍按整段成绩（悲观采样另有一套往下压）。
  const good = { hosts: {} };
  markSegment(good, "a.bilivideo.com", 1048576, 100);
  await new Promise((resolve) => setTimeout(resolve, 5));
  markSuccess(good, "a.bilivideo.com", 174763, 3000);
  assert.equal(hostScore(good, "a.bilivideo.com", ""), good.hosts["a.bilivideo.com"].segBps);
});

test("App 自己的节点最多退避 6 秒，别的节点照旧翻倍到 48 秒", async () => {
  const BTR = await loadModules();
  const { markFailure } = BTR.accelerator;
  const health = { hosts: {} };
  const error = { name: "NetworkError" };
  for (let round = 0; round < 5; round += 1) {
    markFailure(health, "akam.akamaized.net", error, 174763, 2000, "akam.akamaized.net");
    markFailure(health, "other.bilivideo.com", error, 174763, 2000, "akam.akamaized.net");
  }
  const now = Date.now();
  assert.ok(health.hosts["akam.akamaized.net"].blockedUntil - now <= 6000, "App 的节点连败五次也只关 6 秒");
  assert.ok(health.hosts["other.bilivideo.com"].blockedUntil - now > 40000, "别的节点连败五次关 48 秒");
  // 4xx 拒绝不受这条影响，照旧五分钟。
  markFailure(health, "akam.akamaized.net", { name: "BadRange", status: 403 }, 0, 0, "akam.akamaized.net");
  assert.ok(health.hosts["akam.akamaized.net"].blockedUntil - now > 4 * 60 * 1000);
});

test("领跑位不在 App 自己的节点上时，每段都留最后一块去试它", async () => {
  const BTR = await loadModules();
  const { assignPieces } = BTR.accelerator;
  const now = Date.now();
  const seg = (bps) => ({ segBps: bps, segAt: now, bps, measuredAt: now, okAt: now });
  const pool = ["akam.akamaized.net", "ali.bilivideo.com", "cos.bilivideo.com"];
  // App 的节点整段成绩很差、ali 快四倍以上：领跑位在 ali。
  const health = { hosts: { "akam.akamaized.net": seg(1e6), "ali.bilivideo.com": seg(5e6), "cos.bilivideo.com": seg(2e6) } };
  const first = assignPieces(pool, health, 6, "akam.akamaized.net");
  assert.deepEqual(first.slice(0, 5), Array(5).fill("ali.bilivideo.com"));
  assert.equal(first[5], "akam.akamaized.net", "最后一块试 App 自己的节点");
  // 不受 45 秒间隔限制：紧接着的下一段照样试。
  const second = assignPieces(pool, health, 6, "akam.akamaized.net");
  assert.equal(second[5], "akam.akamaized.net");
  // 它在退避中就不试。
  health.hosts["akam.akamaized.net"].blockedUntil = now + 5000;
  const third = assignPieces(pool, health, 6, "akam.akamaized.net");
  assert.notEqual(third[5], "akam.akamaized.net");
  // 领跑位就在它身上时，走原来的 45 秒试探逻辑。
  const home = { hosts: { "akam.akamaized.net": seg(9e6), "ali.bilivideo.com": seg(5e6), "cos.bilivideo.com": seg(2e6) } };
  assert.deepEqual(assignPieces(pool, home, 6, "akam.akamaized.net"), Array(6).fill("akam.akamaized.net"));
});

test("节点记忆保存时按节点合并，慢运行结束时盖不掉别的运行学到的东西", async () => {
  const store = createStore();
  const env = createEnv({ server: null, store });
  const BTR = (await env.run(null)).exposed;
  const { loadHealth, saveHealth, markSuccess } = BTR.accelerator;
  // 运行 A 开头读到空记忆。
  const a = loadHealth();
  // 运行 B 在 A 还没结束时学到 ali 很快、akam 很慢，并先写回。
  const b = loadHealth();
  markSuccess(b, "ali.bilivideo.com", 1048576, 100);
  markSuccess(b, "akam.akamaized.net", 174763, 3000);
  b.leader = "ali.bilivideo.com";
  b.leaderAt = Date.now();
  saveHealth(b);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 运行 A 只学到 cos 的一笔，然后写回：ali、akam 和领跑者都得留着。
  markSuccess(a, "cos.bilivideo.com", 1048576, 200);
  saveHealth(a);
  const merged = loadHealth();
  assert.ok(merged.hosts["ali.bilivideo.com"].bps > 9e6, "B 学到的 ali 不能丢");
  assert.ok(merged.hosts["akam.akamaized.net"].bps < 1e5, "B 学到的 akam 不能丢");
  assert.ok(merged.hosts["cos.bilivideo.com"].bps > 4e6, "A 自己学到的 cos 要在");
  assert.equal(merged.leader, "ali.bilivideo.com", "更新的领跑者记录胜出");
  // 同一个节点两边都有：较新的那笔胜出。
  const c = loadHealth();
  await new Promise((resolve) => setTimeout(resolve, 5));
  markSuccess(c, "ali.bilivideo.com", 174763, 5000);
  saveHealth(c);
  assert.ok(loadHealth().hosts["ali.bilivideo.com"].bps < 5e6, "更新的慢样本要写进去");
  // 重置写的是空记忆，合并不该把旧记录带回来。
  store.setJson("btr.health", { hosts: {} });
  assert.deepEqual(loadHealth(), { hosts: {} });
});
