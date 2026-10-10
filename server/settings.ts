/**
 * Data behind the plugin's Settings screens (Runtime, Diagnostics).
 *
 * The ACP path has no runtime of its own to install: a session runs the
 * agent CLI bundled with the installed ZCode Desktop app, through the
 * zcode-acp-server bridge from this plugin's checkout. The Runtime screen
 * therefore reports what is installed and offers the switches that matter on
 * a headless host; Diagnostics is read-only.
 *
 * Wherever the bridge already owns the logic (which agent CLI it launches, the
 * Desktop version it reports, the official update manifest, ZCode's CLI config
 * writer), these handlers run the bridge's own `dist/` modules in a
 * short-lived `node` child instead of re-implementing them. Plugin bundles are
 * evaluated without `import.meta`, so importing the bridge's ESM modules into
 * the plugin itself is not an option; a child also keeps their module-level
 * state out of the plugin process.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ZcodeDiagnostics, ZcodeRuntimeInfo, ZcodeUpdateCheck } from "../shared/settings.ts";
import { resolveBridge } from "./launch.ts";
import { zcodeLoginFromEnv } from "./quota.ts";

type Env = Readonly<Record<string, string | undefined>>;
type Bridge = NonNullable<ReturnType<typeof resolveBridge>>;

/**
 * Official plugins that only work inside ZCode Desktop (they drive its
 * browser and its signed Computer Use helper). While either is enabled, every
 * agent also starts the built-in node_repl MCP host
 * (bootstrap/src/app/built-in-node-repl.ts), measured at ~200 MB per session.
 */
export const DESKTOP_ONLY_PLUGINS = [
  "browser-use@zcode-plugins-official",
  "computer-use@zcode-plugins-official",
] as const;

const RECENT_ERROR_WINDOW_MINUTES = 60;
const LOG_TAIL_BYTES = 4 * 1024 * 1024;

/** `<ZCODE_HOME>` (else `~/.zcode`), derived the same way as the usage source. */
export function zcodeHome(env: Env = process.env): string {
  return path.dirname(path.dirname(zcodeLoginFromEnv(env).configPath));
}

function run(
  file: string,
  args: readonly string[],
  env: Env = process.env,
  timeoutMs = 30_000,
): Promise<string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { env: childEnv, cwd: os.tmpdir(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}

/**
 * Run `body` as an ES module in a `node` child next to the bridge's `dist/`.
 * `load(rel)` imports a bridge module; `ARGS` is the JSON passed in `args` (no
 * value is ever spliced into the source). The body's return value is the
 * last stdout line, so bridge logging on stderr never corrupts it.
 */
async function runBridgeScript<T>(
  bridge: Bridge,
  body: string,
  args: unknown = null,
  env: Env = process.env,
): Promise<T> {
  const script = [
    'import { pathToFileURL } from "node:url";',
    'const load = (rel) => import(pathToFileURL(process.env.ZCODE_ACP_DIST + "/" + rel).href);',
    "const ARGS = JSON.parse(process.env.ZCODE_ACP_ARGS);",
    `const result = await (async () => { ${body} })();`,
    'process.stdout.write("\\n" + JSON.stringify(result) + "\\n");',
  ].join("\n");
  const stdout = await run(
    bridge.nodeBin,
    ["--input-type=module", "-e", script],
    { ...env, ZCODE_ACP_DIST: bridge.distDir, ZCODE_ACP_ARGS: JSON.stringify(args) },
    90_000,
  );
  const line = stdout.trimEnd().split("\n").at(-1) ?? "null";
  return JSON.parse(line) as T;
}

// ---------- runtime ----------

interface BridgeProbe {
  agentPath: string | null;
  agentNode: string | null;
  desktopVersion: string | null;
  versionOverride: string | null;
  installPath: string | null;
}

/**
 * Ask the bridge which agent CLI it would launch and which Desktop version it
 * would report for it. `ZCODE_APP_VERSION` is removed first, because an
 * explicit value short-circuits the bridge's detection; it is reported back
 * as the override.
 */
function probeBridge(bridge: Bridge): Promise<BridgeProbe> {
  return runBridgeScript<BridgeProbe>(
    bridge,
    `const resolve = await load("backend/resolve.js");
     const update = await load("settings/app-update.js");
     const versionOverride = process.env.ZCODE_APP_VERSION?.trim() || null;
     delete process.env.ZCODE_APP_VERSION;
     const argv = resolve.resolveZcodeCommand();
     const script = argv.find((a) => /\\.(cjs|mjs|js)$/.test(a)) ?? null;
     const agentPath = script ?? argv[0] ?? null;
     const desktopVersion = agentPath ? (resolve.desktopAppVersionEnv(agentPath).ZCODE_APP_VERSION ?? null) : null;
     return { agentPath, agentNode: script ? argv[0] : null, desktopVersion, versionOverride, installPath: update.appBundlePath() };`,
  );
}

const versionCache = new Map<string, string | null>();

/** `<bin> --version` (through `node` for a JS entry), cached per file + mtime. */
async function binaryVersion(file: string, viaNode: string | null = null): Promise<string | null> {
  let key: string;
  try {
    key = `${viaNode ?? ""}|${file}|${fs.statSync(file).mtimeMs}`;
  } catch {
    return null;
  }
  if (versionCache.has(key)) return versionCache.get(key) ?? null;
  let version: string | null = null;
  try {
    const out = await run(viaNode ?? file, viaNode ? [file, "--version"] : ["--version"]);
    version = out.trim().split("\n").at(-1)?.trim().replace(/^v/, "") || null;
  } catch {
    version = null;
  }
  versionCache.set(key, version);
  return version;
}

/** The pinned bridge commit, from the checkout's lockfile `resolved` URL (`…#<sha>`). */
export function commitFromLock(lock: unknown): string | null {
  const entry = (lock as { packages?: Record<string, { resolved?: unknown }> } | null)?.packages?.[
    "node_modules/zcode-acp-server"
  ];
  const resolved = typeof entry?.resolved === "string" ? entry.resolved : "";
  const sha = resolved.split("#")[1] ?? "";
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function bridgeInfo(bridge: Bridge): ZcodeRuntimeInfo["bridge"] {
  const pkg = readJson(path.join(bridge.distDir, "..", "package.json")) as { version?: unknown } | null;
  // <checkout>/node_modules/zcode-acp-server/dist → <checkout>/package-lock.json
  const lock = readJson(path.join(bridge.distDir, "..", "..", "..", "package-lock.json"));
  return {
    path: bridge.cli,
    version: typeof pkg?.version === "string" ? pkg.version : null,
    commit: commitFromLock(lock),
  };
}

function findBun(env: Env): string | null {
  const home = env.HOME || os.homedir();
  const onPath = (env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "bun"));
  for (const candidate of [path.join(home, ".bun", "bin", "bun"), ...onPath]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** True when either Desktop-only plugin is enabled (absent = enabled, ZCode's default). */
export function desktopOnlyPluginsEnabled(cliConfig: unknown): boolean {
  const enabled =
    (cliConfig as { plugins?: { enabledPlugins?: Record<string, unknown> } } | null)?.plugins
      ?.enabledPlugins ?? {};
  return DESKTOP_ONLY_PLUGINS.some((key) => enabled[key] !== false);
}

export async function collectRuntimeInfo(env: Env = process.env): Promise<ZcodeRuntimeInfo> {
  const cliConfigPath = path.join(zcodeHome(env), "cli", "config.json");
  const bunPath = findBun(env);
  const info: ZcodeRuntimeInfo = {
    desktop: { installPath: null, version: null, versionOverride: null },
    agent: { path: null, version: null },
    bridge: { path: null, version: null, commit: null },
    node: { path: null, version: null },
    bun: {
      path: bunPath,
      version: bunPath ? await binaryVersion(bunPath) : null,
      runtimeOverride: env.ZCODE_ACP_RUNTIME?.trim() || null,
    },
    desktopOnlyPlugins: {
      enabled: desktopOnlyPluginsEnabled(readJson(cliConfigPath)),
      configPath: cliConfigPath,
    },
    error: null,
  };
  const bridge = resolveBridge();
  if (!bridge) {
    info.error = "zcode-acp-server bridge not found in the plugin checkout or a global npm root";
    return info;
  }
  info.bridge = bridgeInfo(bridge);
  info.node = { path: bridge.nodeBin, version: await binaryVersion(bridge.nodeBin) };
  try {
    const probe = await probeBridge(bridge);
    info.desktop = {
      installPath: probe.installPath,
      version: probe.desktopVersion,
      versionOverride: probe.versionOverride,
    };
    info.agent = {
      path: probe.agentPath,
      version: probe.agentPath ? await binaryVersion(probe.agentPath, probe.agentNode) : null,
    };
  } catch (error) {
    info.error = `bridge probe failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return info;
}

export async function checkDesktopUpdate(env: Env = process.env): Promise<ZcodeUpdateCheck> {
  const checkedAt = new Date().toISOString();
  const empty = {
    checkedAt,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    channel: null,
    platform: null,
    files: [],
  };
  const bridge = resolveBridge();
  if (!bridge) return { ...empty, error: "zcode-acp-server bridge not found" };
  try {
    const runtime = await collectRuntimeInfo(env);
    const current = runtime.desktop.version ?? runtime.desktop.versionOverride;
    // The bridge's update check reads the installed version from
    // ZCODE_APP_VERSION on Linux (no version inside the bundle there).
    const result = await runBridgeScript<Omit<ZcodeUpdateCheck, "checkedAt" | "error">>(
      bridge,
      `const update = await load("settings/app-update.js");
       const r = await update.checkForAppUpdate({ env: process.env });
       const files = (r.release?.files ?? []).map((f) => ({ name: decodeURIComponent(String(f.url).split("/").pop() ?? f.url), url: String(f.url) }));
       return { currentVersion: r.currentVersion, latestVersion: r.latestVersion, updateAvailable: r.updateAvailable, channel: r.channel, platform: r.platform, files };`,
      null,
      { ...env, ...(current ? { ZCODE_APP_VERSION: current } : {}) },
    );
    return { ...result, checkedAt, error: null };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Enable or disable the Desktop-only plugins through the bridge's own writer
 * for ZCode's `cli/config.json` (read-modify-write, unknown keys preserved,
 * timestamped backups). Agents read the file at start, so this applies to
 * sessions opened afterwards.
 */
export async function setDesktopOnlyPlugins(
  enabled: boolean,
  env: Env = process.env,
): Promise<ZcodeRuntimeInfo> {
  const bridge = resolveBridge();
  if (!bridge) throw new Error("zcode-acp-server bridge not found");
  await runBridgeScript<boolean>(
    bridge,
    `const config = await load("settings/cli-config.js");
     for (const key of ARGS.keys) await config.setPluginEnabled(key, ARGS.enabled);
     return true;`,
    { keys: DESKTOP_ONLY_PLUGINS, enabled },
    env,
  );
  return collectRuntimeInfo(env);
}

// ---------- diagnostics ----------

interface LogLine {
  timestamp?: string;
  level?: string;
  event?: string;
  message?: string;
  context?: Record<string, unknown>;
}

function parseLine(line: string): LogLine | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? (value as LogLine) : null;
  } catch {
    return null;
  }
}

/** The newest `model.client_signing.feature_gate` verdict in agent log lines (oldest first). */
export function latestSigningGate(lines: readonly string[]): ZcodeDiagnostics["signing"] {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes("model.client_signing.feature_gate")) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    const context = entry.context ?? {};
    const enabled = context.enabled === true;
    const detail = [
      typeof context.httpStatus === "number" ? `HTTP ${context.httpStatus}` : null,
      typeof context.failure === "string" ? context.failure : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      state: enabled ? "enabled" : "disabled",
      at: entry.timestamp ?? null,
      detail: detail || null,
    };
  }
  return { state: "unknown", at: null, detail: "no signing check in the recent agent logs" };
}

/** Error-level agent log entries within `windowMinutes` of `now`, newest first. */
export function recentErrors(
  lines: readonly string[],
  now: Date,
  windowMinutes = RECENT_ERROR_WINDOW_MINUTES,
): ZcodeDiagnostics["recentErrors"] {
  const since = now.getTime() - windowMinutes * 60_000;
  const hits: ZcodeDiagnostics["recentErrors"]["latest"] = [];
  for (const line of lines) {
    if (!line.includes('"level":"error"')) continue;
    const entry = parseLine(line);
    const at = entry?.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!entry || !(at >= since)) continue;
    hits.push({
      at: entry.timestamp!,
      event: String(entry.event ?? ""),
      message: String(entry.message ?? "").slice(0, 160),
    });
  }
  hits.reverse();
  return { windowMinutes, count: hits.length, latest: hits.slice(0, 5) };
}

/** The last `maxBytes` of a file as whole lines (the first, partial line is dropped). */
function tailLines(file: string, maxBytes = LOG_TAIL_BYTES): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((line) => line.trim());
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Agent log files (`zcode-*.jsonl`), newest first. */
function agentLogs(logDir: string): string[] {
  try {
    return fs
      .readdirSync(logDir)
      .filter((name) => /^zcode-.*\.jsonl$/.test(name))
      .map((name) => path.join(logDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  cmdline: readonly string[];
  rssKb: number;
  /** Start time in clock ticks after boot (`/proc/<pid>/stat` field 22). */
  startTicks: number;
}

/**
 * One entry per bridge process launched from `cli` (this daemon's checkout),
 * with the RSS of its whole process tree: bridge, agent CLI, node_repl host,
 * watchdog.
 */
export function summarizeSessions(
  procs: readonly ProcInfo[],
  cli: string,
  uptimeSeconds: number | null,
  ticksPerSecond = 100,
): ZcodeDiagnostics["sessions"] {
  const children = new Map<number, ProcInfo[]>();
  for (const proc of procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc);
    children.set(proc.ppid, siblings);
  }
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const roots = new Set(procs.filter((proc) => proc.cmdline.includes(cli)).map((proc) => proc.pid));
  // A bridge that re-execs itself (e.g. into Bun) matches twice; count the outer one.
  const nestedInRoot = (proc: ProcInfo): boolean => {
    for (let parent = byPid.get(proc.ppid); parent; parent = byPid.get(parent.ppid)) {
      if (roots.has(parent.pid)) return true;
      if (parent.pid === parent.ppid) break;
    }
    return false;
  };
  const items: ZcodeDiagnostics["sessions"]["items"] = [];
  for (const root of procs) {
    if (!roots.has(root.pid) || nestedInRoot(root)) continue;
    let rssKb = 0;
    let nodeRepl = false;
    const stack = [root];
    while (stack.length > 0) {
      const proc = stack.pop()!;
      rssKb += proc.rssKb;
      if (proc.comm.startsWith("zcode-node-repl") || proc.cmdline.some((a) => a.includes("node-repl"))) {
        nodeRepl = true;
      }
      stack.push(...(children.get(proc.pid) ?? []));
    }
    items.push({
      pid: root.pid,
      rssMb: Math.round(rssKb / 1024),
      ageSeconds:
        uptimeSeconds === null ? null : Math.max(0, Math.round(uptimeSeconds - root.startTicks / ticksPerSecond)),
      nodeRepl,
    });
  }
  items.sort((a, b) => b.rssMb - a.rssMb);
  return {
    supported: true,
    totalMb: items.reduce((sum, item) => sum + item.rssMb, 0),
    items,
  };
}

/** Process table from `/proc` (Linux); null where it is not available. */
function readProcTable(): ProcInfo[] | null {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const procs: ProcInfo[] = [];
  for (const name of entries) {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      // comm is parenthesised and may contain spaces; fields resume after ") ".
      const close = stat.lastIndexOf(")");
      const comm = stat.slice(stat.indexOf("(") + 1, close);
      const fields = stat.slice(close + 2).split(" ");
      const status = fs.readFileSync(`/proc/${name}/status`, "utf8");
      const rss = /VmRSS:\s+(\d+)/.exec(status);
      procs.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        comm,
        cmdline: fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean),
        rssKb: rss ? Number(rss[1]) : 0,
        startTicks: Number(fields[19]),
      });
    } catch {
      // the process exited while scanning
    }
  }
  return procs;
}

function readUptimeSeconds(): number | null {
  try {
    return Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  } catch {
    return null;
  }
}

/** Which providers in `<ZCODE_HOME>/v2/config.json` carry a key — never the key itself. */
export function credentialsFrom(
  config: unknown,
  pinnedProvider: string | null,
): ZcodeDiagnostics["credentials"] {
  const providers = Object.entries(
    (config as { provider?: Record<string, { enabled?: unknown; options?: { apiKey?: unknown } }> } | null)
      ?.provider ?? {},
  )
    .map(([id, entry]) => ({
      id,
      enabled: entry?.enabled === true,
      hasKey: typeof entry?.options?.apiKey === "string" && entry.options.apiKey.length > 0,
    }))
    .filter((provider) => provider.hasKey || provider.enabled);
  return { pinnedProvider, providers };
}

export async function collectDiagnostics(env: Env = process.env): Promise<ZcodeDiagnostics> {
  const now = new Date();
  const home = zcodeHome(env);
  const logDir = path.join(home, "cli", "log");
  const runtime = await collectRuntimeInfo(env);
  const bridge = resolveBridge();

  const logs = agentLogs(logDir);
  const newest = logs[0] ? tailLines(logs[0]) : [];
  let signing = latestSigningGate(newest);
  if (signing.state === "unknown" && logs[1]) signing = latestSigningGate(tailLines(logs[1]));

  const procs = bridge ? readProcTable() : null;
  const sessions =
    bridge && procs
      ? summarizeSessions(procs, bridge.cli, readUptimeSeconds())
      : { supported: false, totalMb: 0, items: [] };

  const providerProblem =
    runtime.error ??
    (runtime.agent.path && !fs.existsSync(runtime.agent.path)
      ? `agent CLI not found at ${runtime.agent.path}`
      : null);
  const override = runtime.desktop.versionOverride;

  return {
    checkedAt: now.toISOString(),
    provider: { available: providerProblem === null, detail: providerProblem },
    signing,
    versions: {
      desktop: runtime.desktop.version,
      agent: runtime.agent.version,
      override,
      consistent: !override || !runtime.desktop.version || override === runtime.desktop.version,
    },
    sessions,
    credentials: credentialsFrom(
      readJson(path.join(home, "v2", "config.json")),
      env.ZCODE_PROVIDER?.trim() || null,
    ),
    recentErrors: recentErrors(newest, now),
    paths: [
      { label: "Agent and bridge logs", path: logDir },
      { label: "ZCode config", path: path.join(home, "v2", "config.json") },
      { label: "Model providers", path: path.join(home, "v2", "provider_config.json") },
      { label: "CLI config (plugins, MCP, skills)", path: path.join(home, "cli", "config.json") },
      ...(runtime.bridge.path ? [{ label: "Bridge", path: runtime.bridge.path }] : []),
      ...(runtime.agent.path ? [{ label: "Agent CLI", path: runtime.agent.path }] : []),
    ],
  };
}
