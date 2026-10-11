import type { PluginClientContext } from "@getpaseo/plugin/client";

import { AccountScreen } from "./client/account";
import { DiagnosticsScreen } from "./client/diagnostics";
import { RuntimeScreen } from "./client/runtime";

export default function contribute(client: PluginClientContext) {
  // Settings → Plugins → ZCode (ACP).
  const removeRuntime = client.addSettingsScreen({
    id: "runtime",
    title: "Runtime",
    icon: "Cpu",
    Component: RuntimeScreen,
  });
  const removeDiagnostics = client.addSettingsScreen({
    id: "diagnostics",
    title: "Diagnostics",
    icon: "Activity",
    Component: DiagnosticsScreen,
  });
  const removeAccount = client.addSettingsScreen({
    id: "account",
    title: "Account",
    icon: "User",
    Component: AccountScreen,
  });
  return () => {
    removeRuntime();
    removeDiagnostics();
    removeAccount();
  };
}
