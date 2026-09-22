// 本地假 CDN：一个支持 Range 的 HTTP 服务器。按请求的 Host 头区分“节点”，每个节点可以
// 单独设置故障：拒绝（403）、报错的 Content-Range、截断、挂起不回、延迟。
"use strict";

const http = require("node:http");

function makeFile(size, seed) {
  const bytes = new Uint8Array(size);
  let state = (seed >>> 0) || 0x9e3779b9;
  for (let index = 0; index < size; index += 1) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

class RangeServer {
  constructor(options = {}) {
    this.size = options.size || 4 * 1024 * 1024;
    this.file = makeFile(this.size, options.seed || 1);
    this.behaviors = {};
    this.requests = [];
    this.sockets = new Set();
    this.server = http.createServer((request, response) => this.handle(request, response));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  start() {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  setBehavior(host, behavior) {
    this.behaviors[host] = behavior;
  }

  requestsFor(host) {
    return this.requests.filter((item) => item.host === host);
  }

  handle(request, response) {
    const host = String(request.headers.host || "").split(":")[0];
    const behavior = this.behaviors[host] || {};
    const record = {
      host,
      path: request.url,
      method: request.method,
      range: request.headers.range || null,
      headers: request.headers,
      at: Date.now()
    };
    this.requests.push(record);
    if (behavior.hang) return;
    const respond = () => {
      if (behavior.status) {
        response.writeHead(behavior.status, { "Content-Type": "text/html" });
        response.end("<html>denied</html>");
        return;
      }
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || "");
      if (!match || (match[1] === "" && match[2] === "")) {
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(this.size),
          "Accept-Ranges": "bytes"
        });
        response.end(Buffer.from(this.file));
        return;
      }
      let start = match[1] === "" ? Math.max(0, this.size - Number(match[2])) : Number(match[1]);
      let end = match[2] === "" || match[1] === "" ? this.size - 1 : Math.min(Number(match[2]), this.size - 1);
      if (start > end || start >= this.size) {
        response.writeHead(416, { "Content-Range": `bytes */${this.size}` });
        response.end();
        return;
      }
      let body = Buffer.from(this.file.subarray(start, end + 1));
      let reportedStart = start;
      if (behavior.wrongRange) reportedStart += 1;
      if (behavior.truncate) body = body.subarray(0, Math.max(0, body.length - 100));
      response.writeHead(206, {
        "Content-Type": behavior.contentType || "video/mp4",
        "Content-Range": `bytes ${reportedStart}-${end}/${this.size}`,
        "Content-Length": String(body.length),
        "Accept-Ranges": "bytes",
        "X-Fake-Node": host
      });
      response.end(body);
    };
    if (behavior.delayMs) setTimeout(respond, behavior.delayMs);
    else respond();
  }
}

module.exports = { RangeServer, makeFile };
