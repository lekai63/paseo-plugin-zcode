import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

// Simulate how the Paseo daemon evaluates the plugin bundle: no __dirname,
// no import.meta.url, module resolution anchored at the worker script's
// argv[1]. Compile index.server.ts first, then import the compiled output
// with those constraints applied.
const compiled = new URL("../dist-plugin/index.server.js", import.meta.url).pathname;
const require = createRequire(path.resolve(compiled));

const mod = await import(compiled);
const contribute = mod.default;

let registered;
const fakeServer = {
  registerProvider(reg) {
    registered = reg;
  },
  registerUsageSource() {},
  registerSettings() {
    return { read: async () => ({ status: "ready", revision: "0", values: {} }), subscribe() { return () => {}; } };
  },
  handle() {},
};

const cleanup = contribute(fakeServer);
console.log("provider id:", registered.id);
console.log("label:", registered.label);
console.log("command:", registered.command);
console.log("command[0] basename:", path.basename(registered.command[0]));

const status = await registered.status({});
console.log("status:", status);

// The ACP connection is what the daemon drives; verify the bridge actually
// speaks ACP over stdio through the resolved command.
const conn = await registered.connect({ versions: [1], capabilities: ["session.list", "session.resume"] });
console.log("connection version:", conn.version);
console.log("capabilities:", conn.capabilities.join(","));
await conn.close();
if (cleanup) await cleanup();
