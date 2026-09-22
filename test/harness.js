// 假的 Shadowrocket 脚本环境。$httpClient 把所有请求都发到本地 RangeServer，Host 头保留原来
// 的节点名；$persistentStore 用一个 Map；$done 的参数就是测试要检查的结果。
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const BUNDLE = path.resolve(__dirname, "..", "shadowrocket", "bilibili-thread-ripper.js");
let bundleSource = null;
function loadBundle() {
  if (bundleSource === null) bundleSource = fs.readFileSync(BUNDLE, "utf8");
  return bundleSource;
}

const MEDIA_URL = "http://upos-hz-mirrorakam.akamaized.net/upgcxcode/12/34/123456/123456-1-30080.m4s"
  + "?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfq&deadline=1700000000&gen=playurlv2&os=akam&oi=0&trid=abc&platform=android"
  + "&upsig=deadbeef&uparams=e,deadline,gen,os,oi,trid,platform&mid=0&bvc=vod&nettype=0&orderid=0,3&build=7000000";
const AUDIO_URL = MEDIA_URL.replace("123456-1-30080.m4s", "123456-1-30280.m4s");
const APP_UA = "Bilibili Freedoooooom/MarkII";

function mediaRequest(overrides = {}) {
  const headers = Object.assign({
    Host: "upos-hz-mirrorakam.akamaized.net",
    "User-Agent": APP_UA,
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate",
    Connection: "keep-alive",
    Range: "bytes=1048576-3145727"
  }, overrides.headers || {});
  if (overrides.noRange) delete headers.Range;
  return { url: overrides.url || MEDIA_URL, method: overrides.method || "GET", headers };
}

function createStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    read(key) { return map.has(key) ? map.get(key) : null; },
    write(value, key) { map.set(key, String(value)); return true; },
    json(key) { return map.has(key) ? JSON.parse(map.get(key)) : null; },
    remove(key) { map.delete(key); },
    setJson(key, value) { map.set(key, JSON.stringify(value)); }
  };
}

// options: { server, request, store, noStore, binaryMode (default true), honorTimeout (default true), expose }
function createEnv(options) {
  const server = options.server;
  const store = options.store || createStore();
  const binaryMode = options.binaryMode !== false;
  const notifications = [];
  const logs = [];
  const clientCalls = [];

  const $httpClient = {
    get(requestOptions, callback) {
      // 模拟环境层面的故障：桥接函数本身抛出类型错误。
      if (options.brokenClient) throw new TypeError("Can only call Window.setTimeout on instances of Window");
      const url = new URL(requestOptions.url);
      clientCalls.push(requestOptions);
      const headers = Object.assign({}, requestOptions.headers || {});
      Object.keys(headers).forEach((key) => { if (key.toLowerCase() === "host") delete headers[key]; });
      headers.Host = url.host;
      if (!server) {
        callback(new Error("no server"), null, null);
        return;
      }
      const req = http.request({
        host: "127.0.0.1",
        port: server.port,
        method: "GET",
        path: url.pathname + url.search,
        headers
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const data = binaryMode && requestOptions["binary-mode"]
            ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
            : buffer.toString("utf8");
          callback(null, { status: res.statusCode, headers: res.headers }, data);
        });
      });
      let finished = false;
      const fail = (error) => {
        if (finished) return;
        finished = true;
        callback(error, null, null);
      };
      req.on("error", fail);
      if (options.honorTimeout !== false && requestOptions.timeout) {
        req.setTimeout(requestOptions.timeout * 1000, () => req.destroy(new Error("request timed out")));
      }
      req.end();
    }
  };

  // noStore: true 模仿没有持久存储的环境。
  const $persistentStore = options.noStore ? undefined : { read: (key) => store.read(key), write: (value, key) => store.write(value, key) };
  // 模仿 WebView：setTimeout 只能作为全局函数调用，this 必须是 undefined 或全局对象。
  const strictSetTimeout = function (callback, delayMs) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Can only call Window.setTimeout on instances of Window");
    return setTimeout(callback, delayMs);
  };
  const strictClearTimeout = function (timer) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Can only call Window.clearTimeout on instances of Window");
    return clearTimeout(timer);
  };
  const $notification = { post: (title, subtitle, body) => notifications.push({ title, subtitle, body }) };
  const fakeConsole = { log: (...args) => logs.push(args.join(" ")) };

  let exposed = null;
  function run(request) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("脚本没有在 60 秒内调用 $done")), 60000);
      const $done = (value) => {
        clearTimeout(timer);
        resolve({ value, elapsedMs: Date.now() - startedAt, exposed });
      };
      const expose = (BTR) => { exposed = BTR; };
      try {
        const factory = new Function(
          "$request", "$done", "$httpClient", "$persistentStore", "$notification", "console", "setTimeout", "clearTimeout", "__BTR_EXPOSE__", "$argument",
          loadBundle()
        );
        factory(request, $done, $httpClient, $persistentStore, $notification, fakeConsole, strictSetTimeout, strictClearTimeout, expose, options.argument);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  return { run, store, notifications, logs, clientCalls, server };
}

// 只加载内部模块（core、accelerator 等）而不处理请求：$request 为空时脚本立刻 $done({})。
async function loadModules() {
  const env = createEnv({ server: null });
  const result = await env.run(null);
  return result.exposed;
}

module.exports = { APP_UA, AUDIO_URL, MEDIA_URL, createEnv, createStore, loadModules, mediaRequest };
