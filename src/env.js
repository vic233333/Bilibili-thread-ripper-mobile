// Shadowrocket / Surge 脚本 API 的适配层。脚本里只有这个文件碰 $request、$done、$httpClient、
// $persistentStore 和 $notification；本地测试时把它们换成假的即可。
(function (BTR) {
  "use strict";

  /* global $request, $done, $httpClient, $persistentStore, $notification */
  const api = {
    request: typeof $request !== "undefined" ? $request : null,
    done: typeof $done === "function" ? $done : null,
    httpClient: typeof $httpClient !== "undefined" ? $httpClient : null,
    persistentStore: typeof $persistentStore !== "undefined" ? $persistentStore : null,
    notification: typeof $notification !== "undefined" ? $notification : null,
    console: typeof console !== "undefined" ? console : null,
    // WebView 引擎里 setTimeout 是 Window 的方法，只能作为全局函数直接调用；存进对象再调
    // 会报 "Can only call Window.setTimeout on instances of Window"。所以包一层。
    setTimeout: typeof setTimeout === "function" ? function (callback, delayMs) { return setTimeout(callback, delayMs); } : null,
    clearTimeout: typeof clearTimeout === "function" ? function (timer) { return clearTimeout(timer); } : null
  };

  let debugEnabled = false;
  function setDebug(enabled) {
    debugEnabled = enabled === true;
  }

  function safeString(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.name + ": " + value.message;
    try { return JSON.stringify(value); }
    catch (_error) { return String(value); }
  }

  // 这次运行写下的日志，运行结束时由 main 追加到持久存储，在设置页的 /log.txt 里能看到。
  const logLines = [];
  function log(level, message, detail) {
    if (level === "debug" && !debugEnabled) return;
    const suffix = detail === undefined ? "" : " " + safeString(detail);
    const line = "[" + level + "] " + message + suffix;
    logLines.push(line);
    if (!api.console || typeof api.console.log !== "function") return;
    try { api.console.log("[BTR] " + line); }
    catch (_error) {}
  }

  function makeError(name, message, extra) {
    const error = new Error(message || name);
    error.name = name;
    if (extra && typeof extra === "object") Object.keys(extra).forEach(function (key) { error[key] = extra[key]; });
    return error;
  }

  // $persistentStore.read(key) / write(value, key)。每个分片请求都是一次新的脚本运行，
  // 设置、统计和节点健康都靠它跨运行保存。
  const store = {
    read(key) {
      try {
        const value = api.persistentStore && typeof api.persistentStore.read === "function" ? api.persistentStore.read(key) : null;
        return typeof value === "string" ? value : null;
      } catch (_error) {
        return null;
      }
    },
    write(key, value) {
      try {
        if (!api.persistentStore || typeof api.persistentStore.write !== "function") return false;
        return api.persistentStore.write(String(value), key) !== false;
      } catch (_error) {
        return false;
      }
    },
    readJson(key, fallback) {
      const text = store.read(key);
      if (!text) return fallback;
      try {
        const value = JSON.parse(text);
        return value && typeof value === "object" ? value : fallback;
      } catch (_error) {
        return fallback;
      }
    },
    writeJson(key, value) {
      try { return store.write(key, JSON.stringify(value)); }
      catch (_error) { return false; }
    },
    available() {
      return Boolean(api.persistentStore && typeof api.persistentStore.read === "function" && typeof api.persistentStore.write === "function");
    }
  };

  function notify(title, subtitle, body) {
    try {
      if (api.notification && typeof api.notification.post === "function") api.notification.post(title, subtitle || "", body || "");
    } catch (_error) {}
  }

  // 不同环境把二进制响应体交给脚本的方式不一样：Uint8Array、ArrayBuffer、别的 TypedArray，
  // 甚至数字数组。字符串说明这个环境没有给出二进制，返回 null。
  function toBytes(value) {
    if (!value || typeof value !== "object") return null;
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object ArrayBuffer]") return new Uint8Array(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (typeof value[index] !== "number") return null;
      }
      return Uint8Array.from(value);
    }
    return null;
  }

  // 脚本自己的错误（类型错误、引用错误等）原样抛出，好在日志里看到真实原因；
  // 别的都是 $httpClient 报回来的网络问题，归为超时或网络错误，可以换节点重试。
  function isScriptError(error) {
    return error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError || error instanceof RangeError;
  }

  function wrapError(error) {
    if (isScriptError(error)) return error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "NetworkError")) return error;
    const message = safeString(error) || "请求失败";
    const wrapped = makeError(/time/i.test(message) ? "TimeoutError" : "NetworkError", message);
    if (error && typeof error === "object" && error.status) wrapped.status = error.status;
    return wrapped;
  }

  // 一次 GET。回调式的 $httpClient 包成 Promise；即使环境不理会 timeout 参数，
  // 这里也用自己的计时器兜底，超时的连接留给环境自己收拾。
  function httpGet(options) {
    return new Promise(function (resolve, reject) {
      if (!api.httpClient || typeof api.httpClient.get !== "function") {
        reject(makeError("HttpClientMissing", "$httpClient 不可用"));
        return;
      }
      const timeoutSec = Math.max(1, Number(options.timeoutSec) || 8);
      let settled = false;
      let timer = null;
      const finish = function (callback, value) {
        if (settled) return;
        settled = true;
        if (timer !== null && api.clearTimeout) api.clearTimeout(timer);
        callback(value);
      };
      if (api.setTimeout) {
        timer = api.setTimeout(function () {
          finish(reject, makeError("TimeoutError", "请求超过 " + timeoutSec + " 秒没有完成"));
        }, timeoutSec * 1000 + 500);
      }
      const request = {
        url: options.url,
        headers: options.headers || {},
        timeout: timeoutSec,
        "binary-mode": true
      };
      try {
        api.httpClient.get(request, function (error, response, data) {
          if (error) {
            finish(reject, wrapError(error));
            return;
          }
          const status = Number(response && (response.status != null ? response.status : response.statusCode)) || 0;
          const headers = BTR.core.lowerHeaders(response && response.headers);
          const body = toBytes(data) || toBytes(response && response.bodyBytes) || toBytes(response && response.body);
          const text = typeof data === "string" ? data : response && typeof response.body === "string" ? response.body : null;
          finish(resolve, { status, headers, body, text });
        });
      } catch (error) {
        finish(reject, wrapError(error));
      }
    });
  }

  // $done 只能调一次，而且无论出什么错都必须调，否则这个请求会一直挂着。
  let finished = false;
  function finish(value) {
    if (finished) return false;
    finished = true;
    try {
      if (api.done) api.done(value === undefined ? {} : value);
    } catch (error) {
      log("error", "$done 调用失败", error);
    }
    return true;
  }

  function capabilities() {
    return {
      request: Boolean(api.request),
      httpClient: Boolean(api.httpClient && typeof api.httpClient.get === "function"),
      persistentStore: store.available(),
      notification: Boolean(api.notification && typeof api.notification.post === "function"),
      timers: Boolean(api.setTimeout)
    };
  }

  BTR.env = Object.freeze({
    api,
    capabilities,
    finish,
    httpGet,
    log,
    logLines,
    makeError,
    notify,
    safeString,
    setDebug,
    store,
    toBytes
  });
})(BTR);
