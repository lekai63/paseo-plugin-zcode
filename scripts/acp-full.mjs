import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const nodeBin = "/Users/lianxin/Library/Application Support/fnm/node-versions/v22.23.1/installation/bin/node";
const cli = "/Users/lianxin/.paseo/plugins/paseo-plugin-zcode/7f326bb8-2bed-41da-b475-87025699d869/checkout/node_modules/zcode-acp-server/dist/cli.js";
const link = path.join(os.tmpdir(), "zcode-acp-server");
try { fs.unlinkSync(link); } catch {}
fs.symlinkSync(cli, link);

const p = spawn(nodeBin, [link], { stdio: ["pipe", "pipe", "pipe"] });
const rl = readline.createInterface({ input: p.stdout });
let id = 0;
const pending = new Map();
function send(method, params) {
  const rid = ++id;
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  return new Promise((res, rej) => pending.set(rid, { res, rej }));
}
rl.on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
p.stderr.on("data", (d) => process.stderr.write("[bridge-stderr] " + d.toString()));

const init = await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
console.log("initialize ok; authMethods:", JSON.stringify(init.authMethods?.map(a=>a.id)));
if (init.authMethods?.length) {
  try { await send("authenticate", { methodId: init.authMethods[0].id }); console.log("authenticate ok"); }
  catch (e) { console.log("authenticate failed:", e.message); }
}
try {
  const s = await send("session/new", { cwd: os.homedir() + "/ZCodeProject", mcpServers: [] });
  console.log("session/new ok:", JSON.stringify(s).slice(0, 400));
} catch (e) {
  console.log("session/new FAILED:", e.message);
}
p.kill();
process.exit(0);
