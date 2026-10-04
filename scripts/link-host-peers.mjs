// scripts/link-host-peers.mjs — 把宿主的内部 @deepseek-ai/* 包软链进本项目
// node_modules，让 `npm test` 在干净 checkout 里可运行。
//
// 背景：这些包是 peerDependencies（运行时由 DSH 宿主 profile 提供），
// 公共 npm 镜像装不到，本地测试又需要能 import 到。此脚本只建立软链，
// 不写 package.json，也不影响发布产物（node_modules 不入包）。
//
// 用法：node scripts/link-host-peers.mjs [dsh 安装根目录]
import { existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

const PEERS = [
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-typert-protocol",
  "@deepseek-ai/dsh-typert-registry",
  "@deepseek-ai/schemastery",
];

/** 找一个含 @deepseek-ai/dsh 的 node_modules 根。 */
function findHostRoot() {
  const explicit = process.argv[2];
  if (explicit !== undefined) return explicit;
  // 1) 全局 npm 安装位置
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const dshDir = join(globalRoot, "@deepseek-ai", "dsh");
    if (existsSync(dshDir)) return join(dshDir, "node_modules", "@deepseek-ai");
  } catch {
    /* npm 不可用时继续 */
  }
  // 2) 常见全局前缀
  const home = process.env.HOME ?? "";
  for (const candidate of [
    join(home, ".npm-global", "lib", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"),
    join(home, ".dsh", "profiles", "web", "node_modules", "@deepseek-ai"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const hostDir = findHostRoot();
if (hostDir === null || !existsSync(hostDir)) {
  console.error("❌ 找不到宿主的 @deepseek-ai 包目录。请传入 dsh 安装根，例如：");
  console.error("   node scripts/link-host-peers.mjs ~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai");
  process.exit(1);
}

const targetDir = join(projectRoot, "node_modules", "@deepseek-ai");
mkdirSync(targetDir, { recursive: true });

let linked = 0;
for (const spec of PEERS) {
  const bare = spec.replace("@deepseek-ai/", "");
  const from = join(hostDir, bare);
  if (!existsSync(from)) {
    console.log(`  跳过 ${spec}（宿主未安装）`);
    continue;
  }
  const to = join(targetDir, bare);
  rmSync(to, { recursive: true, force: true });
  symlinkSync(from, to, "dir");
  linked++;
}
console.log(`✅ 已软链 ${linked} 个宿主 peer 包到 node_modules/@deepseek-ai`);
