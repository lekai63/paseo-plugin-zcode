import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

// Paseo evaluates plugin bundles with an injected `require` and without
// `__dirname` or a usable `import.meta`; the injected require also has no
// `.resolve`. Built-ins still load through it, so we grab node:module and
// build a resolver anchored at the plugin worker script (argv[1], inside the
// paseo server package). Its node_modules ancestor chain covers the npm
// global install directory, so `npm i -g zcode-acp-server` resolves reliably
// and nothing depends on PATH.
const { createRequire } = require("node:module");
const nodeRequire = createRequire(process.argv[1] || process.execPath);
const bridgeCli = nodeRequire.resolve("zcode-acp-server/dist/cli.js");

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    runAcpProvider({
      id: "zcode",
      label: "ZCode",
      icon: "icon.svg",
      description:
        "ZCode agent backend (Z.ai GLM) via the npm zcode-acp-server bridge",
      command: [process.execPath, bridgeCli],
      // First bridge start can take 30s+ while npm warms up; widen the
      // handshake window.
      acpOptions: { startupTimeoutMs: 180_000 },
    }),
  );
  return () => {};
}
