import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

// Paseo evaluates plugin bundles with an injected `require` and without
// `__dirname` or a usable `import.meta`. The daemon may be hosted by a node
// CLI install or by the desktop app (Electron), which changes where module
// resolution is anchored, so the bridge entry is found by scanning the
// well-known npm global roots — pairing each root with its own `node`
// binary so the bridge never launches through an Electron binary or a
// PATH-dependent lookup.

const RELATIVE_ENTRY = path.join("zcode-acp-server", "dist", "cli.js");

interface GlobalInstall {
  nodeBin: string;
  globalRoot: string;
  major: number;
}

function versionMajor(dir: string): number {
  const m = /^v?(\d+)/.exec(dir);
  return m ? Number(m[1]) : 0;
}

function compareVersionDirs(a: string, b: string): number {
  const ka = a.replace(/^v/, "").split(".").map(Number);
  const kb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function globalInstalls(): GlobalInstall[] {
  const home = os.homedir();
  const versionDirs: GlobalInstall[] = [];
  const scans: Array<{ versions: string; binSub: string; libSub: string }> = [
    {
      versions: path.join(home, "Library", "Application Support", "fnm", "node-versions"),
      binSub: path.join("installation", "bin"),
      libSub: path.join("installation", "lib", "node_modules"),
    },
    {
      versions: path.join(home, ".nvm", "versions", "node"),
      binSub: "bin",
      libSub: path.join("lib", "node_modules"),
    },
    {
      versions: path.join(home, ".local", "share", "mise", "installs", "node"),
      binSub: "bin",
      libSub: path.join("lib", "node_modules"),
    },
  ];
  for (const { versions, binSub, libSub } of scans) {
    try {
      const dirs = fs.readdirSync(versions).sort((a, b) => compareVersionDirs(b, a));
      for (const version of dirs) {
        versionDirs.push({
          nodeBin: path.join(versions, version, binSub, "node"),
          globalRoot: path.join(versions, version, libSub),
          major: versionMajor(version),
        });
      }
    } catch {
      // layout not present on this machine
    }
  }
  versionDirs.push(
    { nodeBin: "/usr/local/bin/node", globalRoot: "/usr/local/lib/node_modules", major: 0 },
    { nodeBin: "/opt/homebrew/bin/node", globalRoot: "/opt/homebrew/lib/node_modules", major: 0 },
  );
  return versionDirs;
}

function nodeForCli(cli: string): string {
  for (const install of globalInstalls()) {
    if (cli.startsWith(install.globalRoot + path.sep)) return install.nodeBin;
  }
  // Checkout-local copies have no owning global root. Pair them with the
  // newest installed node >= 18 (the bridge needs post-18 APIs such as
  // Writable.toWeb) instead of process.execPath, which is the Electron
  // binary when the daemon is app-hosted and breaks the ACP handshake.
  for (const install of globalInstalls()) {
    if (install.major >= 18 && fs.existsSync(install.nodeBin)) return install.nodeBin;
  }
  return process.execPath;
}

// The managed checkout may carry its own copy of the bridge, installed by the
// manifest `build` commands when the plugin is added or updated. Prefer it
// (newest first) so the bridge version stays pinned to the plugin release.
function checkoutInstalls(): string[] {
  const root = path.join(os.homedir(), ".paseo", "plugins", "paseo-plugin-zcode");
  try {
    return fs
      .readdirSync(root)
      // npm installs manifest `build` dependencies under checkout/node_modules/,
      // so the bridge lives one segment deeper than the global-root layout.
      .map((dir) => path.join(root, dir, "checkout", "node_modules", RELATIVE_ENTRY))
      .filter((cli) => fs.existsSync(cli))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

function resolveLaunch(): { command: readonly [string, string] } {
  for (const cli of checkoutInstalls()) {
    return { command: [nodeForCli(cli), cli] };
  }
  // When the daemon shares a node install with the bridge (CLI-hosted case),
  // the worker script's ancestor chain covers the global install directory.
  try {
    const { createRequire } = require("node:module");
    const cli = createRequire(process.argv[1]).resolve("zcode-acp-server/dist/cli.js");
    return { command: [nodeForCli(cli), cli] };
  } catch {
    // fall through to the well-known roots scan
  }
  for (const install of globalInstalls()) {
    const cli = path.join(install.globalRoot, RELATIVE_ENTRY);
    if (fs.existsSync(cli)) {
      return { command: [install.nodeBin, cli] };
    }
  }
  throw new Error(
    "zcode-acp-server was not found; install it with `npm i -g zcode-acp-server`",
  );
}

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    runAcpProvider({
      id: "zcode",
      label: "ZCode",
      icon: "icon.svg",
      description:
        "ZCode agent backend (Z.ai GLM) via the npm zcode-acp-server bridge",
      command: resolveLaunch().command,
      // First bridge start can take 30s+ while npm warms up; widen the
      // handshake window.
      acpOptions: { startupTimeoutMs: 180_000 },
    }),
  );
  return () => {};
}
