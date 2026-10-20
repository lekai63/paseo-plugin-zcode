import { registerHooks } from "node:module";
import path from "node:path";

// The daemon's plugin loader resolves extensionless relative specifiers
// (bundler-style); plain Node ESM does not. Register the same fallback before
// importing the TS entry, which Node evaluates with type stripping (the same
// way `npm test` evaluates the server modules).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".")) throw error;
      for (const suffix of [".ts", ".tsx"]) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          // try the next suffix
        }
      }
      throw error;
    }
  },
});

const entry = new URL("../index.server.ts", import.meta.url).pathname;

const mod = await import(entry);
const contribute = mod.default;

let registered;
let usageRegistered;
const fakeServer = {
  registerProvider(reg) {
    registered = reg;
  },
  registerUsageSource(reg) {
    usageRegistered = reg;
  },
  before() {
    return undefined;
  },
  handle() {},
};

const cleanup = contribute(fakeServer);
console.log("provider id:", registered.id);
console.log("label:", registered.label);
console.log("command:", registered.command);

const status = await registered.status({});
console.log("status:", status);

console.log("usage id:", usageRegistered?.id, "label:", usageRegistered?.label);
if (usageRegistered) {
  const accounts = await usageRegistered.discover({ kind: "global" });
  console.log("usage accounts:", accounts.length, accounts[0]?.label ?? "(none)");
  if (accounts[0]) {
    const report = await usageRegistered.fetch(accounts[0].input);
    console.log("usage report status:", report.status);
  }
}

// The ACP connection is what the daemon drives; verify the bridge actually
// speaks ACP over stdio through the resolved command. Capabilities are kept
// without session.subsession so the base (vendored adapter) connect runs.
const conn = await registered.connect({
  versions: [1],
  capabilities: ["session.list", "session.resume"],
});
console.log("connection version:", conn.version);
console.log("capabilities:", conn.capabilities.join(","));
await conn.close();
if (cleanup) await cleanup();
