/**
 * Run code against the bridge's own `dist/` modules in a short-lived `node`
 * child. Plugin bundles are evaluated without `import.meta`, so the bridge's
 * ESM modules cannot be imported into the plugin; a child also keeps their
 * module-level state out of the plugin process.
 */

import { execFile } from "node:child_process";
import os from "node:os";

import type { resolveBridge } from "./launch.ts";

export type Env = Readonly<Record<string, string | undefined>>;
export type Bridge = NonNullable<ReturnType<typeof resolveBridge>>;

export function run(
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
      (error, stdout, stderr) =>
        error ? reject(new Error(childErrorMessage(String(stderr), error))) : resolve(String(stdout)),
    );
  });
}

/**
 * The child's own error, not the command line and stack trace `execFile`
 * wraps it in: the last `<Name>Error: …` line on stderr, else the first
 * stderr line, else the spawn error itself (e.g. a timeout).
 */
export function childErrorMessage(stderr: string, error: Error): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  const thrown = lines.filter((line) => /^[A-Za-z]*Error: /.test(line)).at(-1);
  if (thrown) return thrown.replace(/^[A-Za-z]*Error: /, "");
  if ((error as { killed?: boolean }).killed) return "The bridge did not answer in time.";
  return lines[0] ?? error.message.split("\n")[0] ?? "bridge call failed";
}

/**
 * Run `body` as an ES module in a `node` child next to the bridge's `dist/`.
 * `load(rel)` imports a bridge module; `ARGS` is the JSON passed in `args` (no
 * value is ever spliced into the source). The body's return value is the
 * last stdout line, so bridge logging on stderr never corrupts it.
 */
export async function runBridgeScript<T>(
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
