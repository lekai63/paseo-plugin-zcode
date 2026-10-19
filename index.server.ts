import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

import { zcodeUsageRegistration } from "./server/usage.js";

// Paseo evaluates plugin bundles with an injected `require` and without
// `__dirname` or a usable `import.meta`. The daemon may be hosted by a node
// CLI install or by the desktop app (Electron), which changes where module
// resolution is anchored, so the bridge entry is found by scanning the
// well-known npm global roots.
//
// The bridge is then launched through a tiny generated `zcode-acp-server`
// shim (see buildLauncher) rather than a bare `node cli.js`. Two reasons:
//   1. ZCode's app-bundle CLI is reached via an extensionless symlink
//      (`zcode` -> …/glm/zcode.cjs); the bridge only injects the provider
//      tables when the CLI entry it spawns ends in .cjs/.js, so a bare spawn
//      leaves the backend unable to locate its built-in provider config and
//      it dies at boot. The shim resolves the real path and sets ZCODE_BIN.
//   2. On Windows there is no /usr/bin/env, so an env-var wrapper would not
//      work; a shim file runs the same way on every platform.

const RELATIVE_ENTRY = path.join("zcode-acp-server", "dist", "cli.js");
const NODE_EXE = process.platform === "win32" ? "node.exe" : "node";
const MIN_NODE_MAJOR = 22;

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

interface ScanSpec {
  versions: string;
  // relative dir under each version directory that holds the node binary
  binSub: string[];
  // relative dir under each version directory that holds global node_modules
  libSub: string[];
  exe: string;
}

function posixScans(home: string): ScanSpec[] {
  return [
    {
      versions: path.join(home, "Library", "Application Support", "fnm", "node-versions"),
      binSub: [path.join("installation", "bin")],
      libSub: [path.join("installation", "lib", "node_modules")],
      exe: "node",
    },
    {
      versions: path.join(home, ".nvm", "versions", "node"),
      binSub: ["bin"],
      libSub: [path.join("lib", "node_modules")],
      exe: "node",
    },
    {
      versions: path.join(home, ".local", "share", "mise", "installs", "node"),
      binSub: ["bin"],
      libSub: [path.join("lib", "node_modules")],
      exe: "node",
    },
  ];
}

function winScans(home: string, appdata: string): ScanSpec[] {
  return [
    {
      // fnm on Windows: %APPDATA%\fnm\node-versions\<v>\installation
      versions: path.join(appdata, "fnm", "node-versions"),
      binSub: ["installation"],
      libSub: [path.join("installation", "node_modules")],
      exe: "node.exe",
    },
    {
      // nvm-windows: %APPDATA%\nvm\<v>
      versions: path.join(appdata, "nvm"),
      binSub: [""],
      libSub: ["node_modules"],
      exe: "node.exe",
    },
    {
      // scoop: %USERPROFILE%\scoop\apps\nodejs*\current
      versions: path.join(home, "scoop", "apps"),
      binSub: [path.join("current")],
      libSub: [path.join("current", "node_modules")],
      exe: "node.exe",
    },
  ];
}

function globalInstalls(): GlobalInstall[] {
  const home = os.homedir();
  const appdata = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const volta = path.join(appdata, "Volta");
  const results: GlobalInstall[] = [];
  const scans = process.platform === "win32" ? winScans(home, appdata) : posixScans(home);
  for (const spec of scans) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(spec.versions).sort((a, b) => compareVersionDirs(b, a));
    } catch {
      continue;
    }
    for (const version of dirs) {
      for (const binSub of spec.binSub) {
        const nodeBin = path.join(spec.versions, version, binSub, spec.exe);
        if (!fs.existsSync(nodeBin)) continue;
        const libSub = spec.libSub[spec.binSub.indexOf(binSub)] ?? "node_modules";
        results.push({
          nodeBin,
          globalRoot: path.join(spec.versions, version, libSub),
          major: versionMajor(version),
        });
        break;
      }
    }
  }
  // Single-location installs (no version-dir layout). probed for sqlite below.
  const fixed =
    process.platform === "win32"
      ? [
          { nodeBin: path.join(volta, "bin", "node.exe"), globalRoot: path.join(volta, "lib", "node_modules") },
          { nodeBin: path.join(programFiles, "nodejs", "node.exe"), globalRoot: path.join(programFiles, "nodejs", "node_modules") },
          { nodeBin: path.join(home, "AppData", "Local", "Volta", "bin", "node.exe"), globalRoot: path.join(home, "AppData", "Local", "Volta", "lib", "node_modules") },
        ]
      : [
          { nodeBin: "/usr/local/bin/node", globalRoot: "/usr/local/lib/node_modules" },
          { nodeBin: "/opt/homebrew/bin/node", globalRoot: "/opt/homebrew/lib/node_modules" },
          { nodeBin: "/usr/bin/node", globalRoot: "/usr/lib/node_modules" },
          { nodeBin: "/home/linuxbrew/.linuxbrew/bin/node", globalRoot: "/home/linuxbrew/.linuxbrew/lib/node_modules" },
        ];
  for (const entry of fixed) {
    if (fs.existsSync(entry.nodeBin)) {
      results.push({ ...entry, major: versionMajor(nodeVersionShort(entry.nodeBin) ?? "") });
    }
  }
  return results;
}

const versionCache = new Map<string, string | null>();
// Ask the binary itself so fixed-location installs get an accurate major,
// independent of directory naming.
function nodeVersionShort(nodeBin: string): string | null {
  const hit = versionCache.get(nodeBin);
  if (hit !== undefined) return hit;
  let out: string | null = null;
  try {
    out = execFileSync(nodeBin, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    out = null;
  }
  versionCache.set(nodeBin, out);
  return out;
}

const sqliteCache = new Map<string, boolean>();
// The bridge and the zcode backend both require node:sqlite (Node >= 22). A
// real `--version`+require probe beats trusting directory names, and rejects
// the Electron binary when the daemon is app-hosted.
function sqliteCapable(nodeBin: string): boolean {
  const hit = sqliteCache.get(nodeBin);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    execFileSync(nodeBin, ["-e", "require('node:sqlite'); require('node:worker_threads')"], {
      timeout: 6000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    ok = true;
  } catch {
    ok = false;
  }
  sqliteCache.set(nodeBin, ok);
  return ok;
}

function capableNodeCandidates(): string[] {
  const cands: string[] = [];
  for (const install of globalInstalls()) {
    if (install.major >= MIN_NODE_MAJOR || install.major === 0) cands.push(install.nodeBin);
  }
  // Also probe the ambient `node` (fnm/nvm/volta on PATH) last.
  const whichNode = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const hit = path.join(dir, whichNode);
    if (fs.existsSync(hit)) {
      cands.push(hit);
      break;
    }
  }
  return [...new Set(cands)];
}

// Pick the node to run the bridge: prefer the one that owns the install the
// bridge lives under, but only if it can actually load the bridge.
function nodeForCli(cli: string): string {
  const paired = globalInstalls().find((i) => cli.startsWith(i.globalRoot + path.sep));
  if (paired && sqliteCapable(paired.nodeBin)) return paired.nodeBin;
  for (const c of capableNodeCandidates()) {
    if (sqliteCapable(c)) return c;
  }
  // Last resort — the daemon's own node. This is the Electron binary when
  // app-hosted; better than crashing the plugin load, and status() flags it.
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

// Resolve the real ZCode CLI entry (a .cjs/.js file, not the extensionless
// launcher on PATH) so the shim can point the bridge at it. Returns undefined
// when nothing with a JS extension is found; the bridge then falls back to its
// own discovery (native CLIs work fine; only app-bundle symlinks need this).
function zcodeBinOverride(): string | undefined {
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) return process.env.ZCODE_BIN;
  const names =
    process.platform === "win32" ? ["zcode", "zcode.cmd", "zcode.exe"] : ["zcode"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const hit = path.join(dir, name);
      try {
        if (!fs.existsSync(hit)) continue;
        const real = fs.realpathSync(hit);
        if (/\.(cjs|mjs|js)$/.test(real)) return real;
      } catch {
        // unreadable PATH segment
      }
    }
  }
  // The ZCode desktop bundle is the most common Windows entry and never lands
  // on PATH. Mirror the bridge's own well-known candidates.
  const home = os.homedir();
  const bundled =
    process.platform === "win32"
      ? [path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "ZCode", "resources", "glm", "zcode.cjs")]
      : process.platform === "darwin"
        ? ["/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs", path.join(home, "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs")]
        : [];
  for (const c of bundled) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

// Launcher shims live under the daemon user's ~/.paseo (0700) rather than
// the shared /tmp so other users on a multi-host machine cannot swap the
// file. The shim directory is keyed by a hash of its target because the
// bridge's entry guard requires the filename to be exactly
// `zcode-acp-server` (no room to disambiguate in the basename), and two
// daemons under different --home resolve different checkout copies.
function launcherDir(cli: string, zcodeBin: string | undefined): string {
  const hash = createHash("sha256").update(`${cli}\n${zcodeBin ?? ""}`).digest("hex").slice(0, 12);
  return path.join(os.homedir(), ".paseo", "plugin-launch", "paseo-plugin-zcode", hash);
}

// Generate the `zcode-acp-server` shim. The bridge's entry guard keys off
// basename(process.argv[1]) === "zcode-acp-server" to select stdio-server
// mode, so the file must be named exactly that (no extension — Node runs an
// extensionless argv target as CommonJS, which the macOS test confirmed). It
// sets ZCODE_BIN/ZCODE_NODE then imports the real bridge entry.
function buildLauncher(cli: string, zcodeBin: string | undefined): string {
  const dir = launcherDir(cli, zcodeBin);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "zcode-acp-server");
  const lines = [
    "// generated by paseo-plugin-zcode — do not edit or invoke directly",
    zcodeBin ? `process.env.ZCODE_BIN = ${JSON.stringify(zcodeBin)};` : "",
    "process.env.ZCODE_NODE = process.execPath;",
    `import(${JSON.stringify(pathToFileURL(cli).href)});`,
  ].filter(Boolean);
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o700 });
  return file;
}

interface Launch {
  command: readonly [string, ...string[]];
  nodeBin: string;
  bridgeCli: string;
  zcodeBin?: string;
}

function resolveLaunch(): Launch | undefined {
  let bridgeCli: string | undefined;
  const prefer = checkoutInstalls();
  if (prefer.length) {
    bridgeCli = prefer[0];
  }
  if (!bridgeCli) {
    // When the daemon shares a node install with the bridge (CLI-hosted case),
    // the worker script's ancestor chain covers the global install directory.
    try {
      const { createRequire } = require("node:module");
      bridgeCli = createRequire(process.argv[1]).resolve("zcode-acp-server/dist/cli.js");
    } catch {
      // fall through to the well-known roots scan
    }
  }
  if (!bridgeCli) {
    for (const install of globalInstalls()) {
      const cli = path.join(install.globalRoot, RELATIVE_ENTRY);
      if (fs.existsSync(cli)) {
        bridgeCli = cli;
        break;
      }
    }
  }
  if (!bridgeCli) return undefined;
  const nodeBin = nodeForCli(bridgeCli);
  const zcodeBin = zcodeBinOverride();
  const launcher = buildLauncher(bridgeCli, zcodeBin);
  return { command: [nodeBin, launcher], nodeBin, bridgeCli, zcodeBin };
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
    // No workspaceOnlyCatalog: the model picker and `paseo provider models`
    // are fed by global discovery, which boots a bridge session here. That
    // boot is the price of a live catalog (hoplite opts out of it because it
    // is configuration-gated opt-in); skipping it would empty the catalog.
    acpOptions: { startupTimeoutMs: 180_000 },
  });
  // runAcpProvider only carries a command, so a resolution failure surfaces
  // through status instead of throwing during contribute and failing the
  // whole plugin load.
  server.registerProvider({
    ...registration,
    getCatalogCacheKey: async (options) => {
      // Distinct ZCODE_BIN values (including daemon command/env overrides)
      // can reach distinct model catalogs, so they must not share cache.
      const bin = options.launch?.env.ZCODE_BIN ?? launch?.zcodeBin ?? "none";
      return `zcode:${bin}`;
    },
    async status(request) {
      // The daemon resolves `agents.providers.zcode.command` overrides into
      // launch before calling status; probe what it will actually run.
      const overridden = request?.launch !== undefined;
      const command: readonly string[] = request?.launch
        ? [request.launch.command, ...request.launch.args]
        : launch?.command ?? [];
      const nodeBin = command[0];
      if (!nodeBin) return { available: false, diagnostic: NOT_FOUND };
      const major = await nodeMajor(nodeBin);
      if (major !== undefined && major < MIN_NODE_MAJOR) {
        return {
          available: false,
          diagnostic: `zcode-acp-server needs Node >= ${MIN_NODE_MAJOR}, but ${nodeBin} is v${major}.x`,
        };
      }
      // With a command override the daemon runs the user's own argv; the
      // local resolution and its ZCODE_BIN note no longer describe reality.
      if (overridden) {
        return { available: true, diagnostic: `command override via ${nodeBin}` };
      }
      if (!launch) return { available: false, diagnostic: NOT_FOUND };
      const version = bridgeVersion(launch.bridgeCli);
      if (!launch.zcodeBin && process.platform !== "linux") {
        // Only the app-bundle symlink layout needs ZCODE_BIN; native-CLI Linux
        // installs resolve it themselves.
        return {
          available: true,
          diagnostic:
            `zcode-acp-server ${version ?? "?"} via ${nodeBin}; ZCode CLI not detected — ` +
            "if sessions die at boot, set agents.providers.zcode.env.ZCODE_BIN to zcode.cjs",
        };
      }
      return { available: true, diagnostic: `zcode-acp-server ${version ?? "?"} via ${nodeBin}` };
    },
  });
  server.registerUsageSource(zcodeUsageRegistration());
  return () => {};
}
