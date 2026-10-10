import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * RPC contracts behind the plugin's Settings screens (Runtime, Diagnostics).
 * Shared by the server handlers and the client screens.
 */

/** What runs a zcode-acp session: the ZCode Desktop bundle, its agent CLI, the bridge. */
export const zcodeRuntimeInfoSchema = z.object({
  desktop: z.object({
    /** The Desktop app binary/bundle the bridge's agent CLI belongs to. */
    installPath: z.string().nullable(),
    /** `version` of the bundle's `app.asar` package.json. */
    version: z.string().nullable(),
    /** `ZCODE_APP_VERSION` from the daemon environment, which wins over detection. */
    versionOverride: z.string().nullable(),
  }),
  agent: z.object({
    path: z.string().nullable(),
    version: z.string().nullable(),
  }),
  bridge: z.object({
    path: z.string().nullable(),
    version: z.string().nullable(),
    commit: z.string().nullable(),
  }),
  node: z.object({
    path: z.string().nullable(),
    version: z.string().nullable(),
  }),
  bun: z.object({
    path: z.string().nullable(),
    version: z.string().nullable(),
    /** `ZCODE_ACP_RUNTIME` from the daemon environment (`node` forces Node). */
    runtimeOverride: z.string().nullable(),
  }),
  /**
   * Browser Use + Computer Use (official ZCode plugins). They cannot run on a
   * headless host, and while either is enabled every session also starts the
   * node_repl helper (about 200 MB).
   */
  desktopOnlyPlugins: z.object({
    enabled: z.boolean(),
    configPath: z.string(),
  }),
  error: z.string().nullable(),
});
export type ZcodeRuntimeInfo = z.output<typeof zcodeRuntimeInfoSchema>;

export const zcodeUpdateCheckSchema = z.object({
  checkedAt: z.string(),
  currentVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  channel: z.string().nullable(),
  platform: z.string().nullable(),
  files: z.array(z.object({ name: z.string(), url: z.string() })),
  error: z.string().nullable(),
});
export type ZcodeUpdateCheck = z.output<typeof zcodeUpdateCheckSchema>;

export const zcodeDiagnosticsSchema = z.object({
  checkedAt: z.string(),
  provider: z.object({ available: z.boolean(), detail: z.string().nullable() }),
  signing: z.object({
    state: z.enum(["enabled", "disabled", "unknown"]),
    at: z.string().nullable(),
    detail: z.string().nullable(),
  }),
  versions: z.object({
    desktop: z.string().nullable(),
    agent: z.string().nullable(),
    override: z.string().nullable(),
    /** False when a daemon-level `ZCODE_APP_VERSION` disagrees with the installed Desktop. */
    consistent: z.boolean(),
  }),
  sessions: z.object({
    supported: z.boolean(),
    totalMb: z.number(),
    items: z.array(
      z.object({
        pid: z.number(),
        rssMb: z.number(),
        ageSeconds: z.number().nullable(),
        nodeRepl: z.boolean(),
      }),
    ),
  }),
  credentials: z.object({
    pinnedProvider: z.string().nullable(),
    providers: z.array(z.object({ id: z.string(), enabled: z.boolean(), hasKey: z.boolean() })),
  }),
  recentErrors: z.object({
    windowMinutes: z.number(),
    count: z.number(),
    latest: z.array(z.object({ at: z.string(), event: z.string(), message: z.string() })),
  }),
  paths: z.array(z.object({ label: z.string(), path: z.string() })),
});
export type ZcodeDiagnostics = z.output<typeof zcodeDiagnosticsSchema>;

export const zcodeRuntimeInfoRpc = defineRpc({
  name: "zcode-acp.runtime",
  input: z.object({}),
  output: zcodeRuntimeInfoSchema,
});

export const zcodeUpdateCheckRpc = defineRpc({
  name: "zcode-acp.update-check",
  input: z.object({}),
  output: zcodeUpdateCheckSchema,
});

export const zcodeSetDesktopOnlyPluginsRpc = defineRpc({
  name: "zcode-acp.desktop-only-plugins",
  input: z.object({ enabled: z.boolean() }),
  output: zcodeRuntimeInfoSchema,
});

export const zcodeDiagnosticsRpc = defineRpc({
  name: "zcode-acp.diagnostics",
  input: z.object({}),
  output: zcodeDiagnosticsSchema,
});
