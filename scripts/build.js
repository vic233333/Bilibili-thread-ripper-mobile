#!/usr/bin/env node
// 把 src/ 里的几个文件按顺序拼成一个脚本文件，供 Shadowrocket 通过 script-path 加载。
// 用法：node scripts/build.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const FILES = ["src/core.js", "src/env.js", "src/accelerator.js", "src/settings.js", "src/main.js"];
const OUTPUT = path.join(root, "shadowrocket", "bilibili-thread-ripper.js");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n").trimEnd();
}

const header = [
  "/*!",
  ` * Bilibili 线程撕裂者 · 移动端（Shadowrocket 脚本） v${pkg.version}`,
  " * https://github.com/vic233333/Bilibili-thread-ripper-mobile",
  " *",
  " * 原作：MrTangLuyao 的 Bilibili 线程撕裂者（MIT）",
  " * https://github.com/MrTangLuyao/Bilibili-thread-ripper",
  " * 本脚本移植了它的 CDN 节点列表、Range 切分与校验规则和节点健康策略，见仓库 upstream/README.md。",
  " *",
  " * 许可：MIT，版权声明见仓库 LICENSE。",
  ` * 这个文件由 scripts/build.js 生成，不要直接修改。`,
  " */"
].join("\n");

let output = `${header}\n(function () {\n"use strict";\nconst BTR = { VERSION: ${JSON.stringify(pkg.version)} };\n`;
for (const file of FILES) {
  if (file === "src/main.js") {
    // 本地测试用的钩子：把内部模块交出去。正式环境里没有这个函数，这一行什么都不做。
    output += "\nif (typeof __BTR_EXPOSE__ === \"function\") __BTR_EXPOSE__(BTR);\n";
  }
  output += `\n/* ${file} */\n${read(file)}\n`;
}
output += "})();\n";

new vm.Script(output, { filename: "bilibili-thread-ripper.js" });
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, output, "utf8");
console.log(`已生成 ${path.relative(root, OUTPUT)}（${output.length} 字节）`);
