// scripts/check-i18n.mjs — 静态自检 lib/client.js 的 i18n 键集与占位符对齐。
//
// 检查项：
//   1. zh / en 键集完全一一对应（无单侧缺失）
//   2. 同一键在两个语言里的 {占位符} 集合一致
//   3. 代码里引用的每个 t("...") 键都存在于表中（防拼写漂移）
// 退出码非 0 表示不合格。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const block = src.match(/zh:\s*\{([\s\S]*?)\n\s*\},\s*\n\s*en:\s*\{([\s\S]*?)\n\s*\},/);
if (block === null) {
  console.error("❌ 无法在 lib/client.js 中定位 TABLES 的 zh/en 两个表");
  process.exit(1);
}

const entryRe = /"([^"]+)":\s*"([^"]*)"/g;
function parse(text) {
  const out = new Map();
  for (const m of text.matchAll(entryRe)) out.set(m[1], m[2]);
  return out;
}
const zh = parse(block[1]);
const en = parse(block[2]);

const problems = [];

const missingEn = [...zh.keys()].filter((k) => !en.has(k));
const missingZh = [...en.keys()].filter((k) => !zh.has(k));
for (const k of missingEn) problems.push(`en 缺少键: ${k}`);
for (const k of missingZh) problems.push(`zh 缺少键: ${k}`);

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
for (const k of zh.keys()) {
  if (!en.has(k)) continue;
  const a = placeholders(zh.get(k));
  const b = placeholders(en.get(k));
  if (a !== b) problems.push(`占位符不一致 ${k}: zh{${a}} vs en{${b}}`);
}

// 代码里 t("...") / t('...') 的引用必须都在表内
const used = new Set();
for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);
for (const k of used) {
  if (!zh.has(k)) problems.push(`代码引用了未定义的键: ${k}`);
}

if (problems.length > 0) {
  console.error("❌ i18n 自检失败:");
  for (const p of problems) console.error("   - " + p);
  process.exit(1);
}

console.log(`✅ i18n 自检通过：zh/en 各 ${zh.size} 键，对齐且占位符一致，代码引用 ${used.size} 键全部有效。`);
