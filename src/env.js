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
    setTimeout: typeof setTimeout === "function" ? setTimeout : null,
    clearTimeout: typeof clearTimeout === "function" ? clearTimeout : null
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

  function log(level, message, detail) {
    if (level === "debug" && !debugEnabled) return;
    if (!api.console || typeof api.console.log !== "function") return;
    const suffix = detail === undefined ? "" : " " + safeString(detail);
    try { api.console.log("[BTR " + level + "] " + message + suffix); }
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

  function wrapError(error) {
    if (error instanceof Error) return error;
    const message = safeString(error) || "请求失败";
    return makeError(/time/i.test(message) ? "TimeoutError" : "NetworkError", message);
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
    makeError,
    notify,
    safeString,
    setDebug,
    store,
    toBytes
  });
})(BTR);
