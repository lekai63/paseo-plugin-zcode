import type { PluginServerContext } from "@getpaseo/plugin/server";
// Vendored fork of @getpaseo/plugin/server/acp (paseo v0.11.2) carrying
// prompt.steer support — see server/acp-adapter/connection.ts for the local
// changes. Upstream refuses steer prompts outright (the daemon's default
// sendBehavior is "steer", so mid-turn sends to ACP agents error out).
import { runAcpProvider } from "./server/acp-adapter/acp";

import {
  collectAccountView,
  createProvider,
  deleteProvider,
  readResetCards,
  updateProvider,
  useResetCard,
} from "./server/account";
import { bridgeStatus, resolveLaunch } from "./server/launch";
import {
  catalogCacheKey,
  checkDesktopUpdate,
  collectDiagnostics,
  collectRuntimeInfo,
  setDesktopOnlyPlugins,
} from "./server/settings";
import { createZcodeSubagentTransformer } from "./server/subagents";
import { wrapWithSubsessions, zcodeSubagentHub } from "./server/subsessions";
import { createZcodeToolCallTransformer } from "./server/tool-calls";
import { createZcodeUsageSource } from "./server/usage";
import {
  zcodeAccountViewRpc,
  zcodeCreateProviderRpc,
  zcodeDeleteProviderRpc,
  zcodeResetCardsRpc,
  zcodeUpdateProviderRpc,
  zcodeUseResetCardRpc,
} from "./shared/account";
import {
  zcodeDiagnosticsRpc,
  zcodeRuntimeInfoRpc,
  zcodeSetDesktopOnlyPluginsRpc,
  zcodeUpdateCheckRpc,
} from "./shared/settings";

// `zcode-acp`, not `zcode`: the bare id belongs to ZCode providers that drive
// the official Services Server directly (e.g. supermomonga/zcode-provider), so
// both can run on one daemon.
const PROVIDER_ID = "zcode-acp";

export default function contribute(server: PluginServerContext) {
  // Sub-agent activity has two surfaces, both fed by the same `_zcode/subagent`
  // vendor notifications from zcode-acp:
  //   - the inline `sub_agent` card inside the parent's Agent dispatch row
  //     (the transformer below), and
  //   - Paseo's native sub-agent TABS, driven by the subsession wrapper, which
  //     negotiates `session.subsession` and opens a child provider session per
  //     zcode sub-agent (see server/subsessions.ts).
  server.registerProvider(
    wrapWithSubsessions({
      ...runAcpProvider({
        id: PROVIDER_ID,
        label: "ZCode (ACP)",
        icon: "icon.svg",
        description:
          "ZCode agent backend (Z.ai GLM) via the npm zcode-acp-server bridge",
        command: resolveLaunch().command,
        // First bridge start can take 30s+ while npm warms up; widen the
        // handshake window.
        acpOptions: { startupTimeoutMs: 180_000 },
        transformers: [
          createZcodeToolCallTransformer(),
          createZcodeSubagentTransformer((boundarySessionId, snapshot) => {
            zcodeSubagentHub.handleSnapshot(boundarySessionId, snapshot);
          }),
        ],
      }),
      status: bridgeStatus,
      // Re-discover models when ZCode's provider stores change (see catalogCacheKey).
      getCatalogCacheKey: async () => catalogCacheKey(),
    }),
  );
  // GLM Coding Plan quota windows for Paseo's Usage modal and sidebar.
  server.registerUsageSource(createZcodeUsageSource(PROVIDER_ID));
  // Settings → Plugins → ZCode (ACP): Runtime, Diagnostics and Account screens.
  server.handle(zcodeRuntimeInfoRpc, () => collectRuntimeInfo());
  server.handle(zcodeUpdateCheckRpc, () => checkDesktopUpdate());
  server.handle(zcodeSetDesktopOnlyPluginsRpc, ({ enabled }) => setDesktopOnlyPlugins(enabled));
  server.handle(zcodeDiagnosticsRpc, () => collectDiagnostics());
  // Account: sign-in and plans, Coding Plan reset cards, model providers.
  server.handle(zcodeAccountViewRpc, () => collectAccountView());
  server.handle(zcodeResetCardsRpc, ({ providerId }) => readResetCards(providerId));
  server.handle(zcodeUseResetCardRpc, (input) => useResetCard(input));
  server.handle(zcodeCreateProviderRpc, (input) => createProvider(input));
  server.handle(zcodeUpdateProviderRpc, (input) => updateProvider(input));
  server.handle(zcodeDeleteProviderRpc, ({ providerId }) => deleteProvider(providerId));
  return () => {};
}
