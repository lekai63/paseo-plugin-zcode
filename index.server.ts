import { execFile } from "node:child_process";
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

const MIN_NODE_MAJOR = 22;

function nodeForCli(cli: string): string {
  for (const install of globalInstalls()) {
    if (cli.startsWith(install.globalRoot + path.sep)) return install.nodeBin;
  }
  // Checkout-local copies have no owning global root. Pair them with the
  // newest installed node >= 22 (the bridge uses node:sqlite and other
  // post-22 APIs) instead of process.execPath, which is the Electron binary
  // when the daemon is app-hosted and breaks the ACP handshake.
  for (const install of globalInstalls()) {
    if (install.major >= MIN_NODE_MAJOR && fs.existsSync(install.nodeBin)) return install.nodeBin;
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

// The bridge injects the ZCode provider tables only when the CLI entry it
// resolves ends in .cjs/.mjs/.js. Homebrew-style installs put an extensionless
// symlink on PATH (`zcode` -> ZCode.app/…/glm/zcode.cjs), that check fails,
// and the spawned backend dies at boot with "无法定位 CLI ZCode Built-in
// Provider Config". Resolving the symlink and passing the real path as
// ZCODE_BIN keeps the injection active. POSIX: wrap through /usr/bin/env so
// no daemon config is needed; Windows users need the same value under
// agents.providers.zcode.env.
function zcodeBinOverride(): string | undefined {
  if (process.platform === "win32") return undefined;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const hit = path.join(dir, "zcode");
    try {
      if (!fs.existsSync(hit)) continue;
      const real = fs.realpathSync(hit);
      if (/\.(cjs|mjs|js)$/.test(real)) return real;
    } catch {
      // unreadable PATH segment
    }
  }
  return undefined;
}

interface Launch {
  command: readonly [string, ...string[]];
  zcodeBin?: string;
}

function resolveLaunch(): Launch | undefined {
  let inner: [string, string] | undefined;
  for (const cli of checkoutInstalls()) {
    inner = [nodeForCli(cli), cli];
    break;
  }
  if (!inner) {
    // When the daemon shares a node install with the bridge (CLI-hosted case),
    // the worker script's ancestor chain covers the global install directory.
    try {
      const { createRequire } = require("node:module");
      const cli = createRequire(process.argv[1]).resolve("zcode-acp-server/dist/cli.js");
      inner = [nodeForCli(cli), cli];
    } catch {
      // fall through to the well-known roots scan
    }
  }
  if (!inner) {
    for (const install of globalInstalls()) {
      const cli = path.join(install.globalRoot, RELATIVE_ENTRY);
      if (fs.existsSync(cli)) {
        inner = [install.nodeBin, cli];
        break;
      }
    }
  }
  if (!inner) return undefined;
  const zcodeBin = zcodeBinOverride();
  if (zcodeBin) {
    return { command: ["/usr/bin/env", `ZCODE_BIN=${zcodeBin}`, inner[0], inner[1]], zcodeBin };
  }
  return { command: inner };
}

const NOT_FOUND =
  "zcode-acp-server was not found; install it with `npm i -g zcode-acp-server@0.72.0` or later";

function bridgeVersion(cliPath: string): string | undefined {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(path.dirname(cliPath)), "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function nodeMajor(nodeBin: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(nodeBin, ["--version"], { timeout: 5000 }, (error, stdout) => {
      resolve(error ? undefined : versionMajor(stdout.trim()));
    });
  });
}

export default function contribute(server: PluginServerContext) {
  const launch = resolveLaunch();
  const registration = runAcpProvider({
    id: "zcode",
    label: "ZCode",
    icon: "icon.svg",
    description:
      "ZCode agent backend (Z.ai GLM) via the npm zcode-acp-server bridge",
    // If the bridge is missing, status() reports unavailable; this fallback
    // keeps the registration valid and gives a clear message if something
    // connects anyway.
    command: launch?.command ?? [
      "node",
      "-e",
      "process.stderr.write('zcode-acp-server is not installed'); process.exit(1)",
    ],
    // First bridge start can take 30s+ while npm warms up; widen the
    // handshake window.
    acpOptions: { startupTimeoutMs: 180_000 },
  });
  // runAcpProvider only carries a command, so a resolution failure surfaces
  // through status instead of throwing during contribute and failing the
  // whole plugin load.
  server.registerProvider({
    ...registration,
    async status(request) {
      // The daemon resolves `agents.providers.zcode.command` overrides into
      // launch before calling status; probe what it will actually run.
      const command: readonly string[] = request?.launch
        ? [request.launch.command, ...request.launch.args]
        : launch?.command ?? [];
      // Accept both launch shapes: [node, cli.js] and
      // [/usr/bin/env, ZCODE_BIN=…, node, cli.js].
      const cliPath = command.filter((arg) => arg.endsWith(".js")).pop();
      if (!cliPath || !fs.existsSync(cliPath)) {
        return { available: false, diagnostic: NOT_FOUND };
      }
      const nodeBin = command[command.indexOf(cliPath) - 1];
      const major = await nodeMajor(nodeBin);
      const version = bridgeVersion(cliPath);
      if (major !== undefined && major < MIN_NODE_MAJOR) {
        return {
          available: false,
          diagnostic: `zcode-acp-server needs Node >= ${MIN_NODE_MAJOR}, but ${nodeBin} is v${major}.x`,
        };
      }
      if (!command.some((arg) => arg.startsWith("ZCODE_BIN="))) {
        return {
          available: true,
          diagnostic:
            `zcode-acp-server ${version ?? "?"} via ${nodeBin}; ZCode CLI not found on PATH — ` +
            "if sessions die with 'built-in provider config' errors, set agents.providers.zcode.env.ZCODE_BIN to zcode.cjs",
        };
      }
      return { available: true, diagnostic: `zcode-acp-server ${version ?? "?"} via ${nodeBin}` };
    },
  });
  return () => {};
}
