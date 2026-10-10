import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useState, type ReactNode } from "react";
import { View } from "react-native";

import {
  zcodeRuntimeInfoRpc,
  zcodeSetDesktopOnlyPluginsRpc,
  zcodeUpdateCheckRpc,
  type ZcodeRuntimeInfo,
  type ZcodeUpdateCheck,
} from "../shared/settings";
import { errorMessage, formatTime, RefreshButton, useResource, Value } from "./common";

/**
 * Settings → Plugins → ZCode (ACP) → Runtime.
 *
 * A zcode-acp session runs the agent CLI bundled with the installed ZCode
 * Desktop app through the zcode-acp-server bridge, so there is nothing to
 * install here: the screen shows what is in use, checks the official release
 * manifest for a newer Desktop, and holds the switch that matters on a
 * headless host (Desktop-only plugins, which cost every session ~200 MB).
 */
export function RuntimeScreen({ theme }: PluginSurfaceProps) {
  const runtimeRpc = useRpc(zcodeRuntimeInfoRpc);
  const load = useCallback(() => runtimeRpc({}), [runtimeRpc]);
  const runtime = useResource(load);

  if (!runtime.data) {
    return (
      <SettingsSection title="Runtime">
        <SettingsCard>
          <SettingsRow label={runtime.loading ? "Loading runtime details…" : "Runtime details unavailable"} error={runtime.error} />
          {runtime.loading ? null : (
            <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void runtime.refresh()} />
          )}
        </SettingsCard>
      </SettingsSection>
    );
  }
  const info = runtime.data;
  const refresh = (
    <RefreshButton theme={theme} busy={runtime.loading} onPress={() => void runtime.refresh()} />
  );
  return (
    <View>
      <DesktopSection theme={theme} info={info} trailing={refresh} />
      <BridgeSection theme={theme} info={info} />
      <MemorySection theme={theme} info={info} onChange={runtime.setData} />
    </View>
  );
}

function DesktopSection({
  theme,
  info,
  trailing,
}: {
  theme: PluginSurfaceProps["theme"];
  info: ZcodeRuntimeInfo;
  trailing: ReactNode;
}) {
  const { desktop, agent } = info;
  const overrideDiffers =
    desktop.versionOverride !== null && desktop.version !== null && desktop.versionOverride !== desktop.version;
  return (
    <SettingsSection title="ZCode Desktop" trailing={trailing}>
      <SettingsCard>
        {info.error ? <SettingsRow label="Runtime check incomplete" error={info.error} /> : null}
        <SettingsRow
          label="Installed version"
          hint={desktop.installPath ?? undefined}
          error={
            overrideDiffers
              ? `ZCODE_APP_VERSION=${desktop.versionOverride} in the daemon environment overrides this. Remove it and restart the daemon.`
              : null
          }
        >
          <Value theme={theme}>{desktop.version ?? desktop.versionOverride ?? "Not found"}</Value>
        </SettingsRow>
        <SettingsRow label="Agent CLI" hint={agent.path ?? undefined}>
          <Value theme={theme}>{agent.version ?? "Unknown"}</Value>
        </SettingsRow>
        <UpdateRows theme={theme} />
      </SettingsCard>
    </SettingsSection>
  );
}

function UpdateRows({ theme }: { theme: PluginSurfaceProps["theme"] }) {
  const updateRpc = useRpc(zcodeUpdateCheckRpc);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ZcodeUpdateCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setResult(await updateRpc({}));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }, [updateRpc]);
  const failure = error ?? result?.error ?? null;
  return (
    <>
      <SettingsAction
        label="Updates"
        hint="Reads the official ZCode release manifest. Installing needs root on this host."
        actionLabel={checking ? "Checking…" : "Check for updates"}
        disabled={checking}
        onPress={() => void check()}
      />
      {failure ? <SettingsRow label="Update check failed" error={failure} /> : null}
      {result && !failure && !result.updateAvailable ? (
        <SettingsRow label="Up to date" hint={`Checked ${formatTime(result.checkedAt)}`}>
          <Value theme={theme} tone="success">{result.latestVersion ?? result.currentVersion ?? "Latest"}</Value>
        </SettingsRow>
      ) : null}
      {result && !failure && result.updateAvailable ? (
        <SettingsRow
          label={`ZCode ${result.latestVersion} is available`}
          hint={`You have ${result.currentVersion}. Download the package for this host, install it with sudo (for example: sudo apt install ./<file>.deb), then restart the Paseo daemons.`}
        >
          <View>
            {result.files.map((file) => (
              <ExternalLink key={file.url} href={file.url}>
                {file.name}
              </ExternalLink>
            ))}
          </View>
        </SettingsRow>
      ) : null}
    </>
  );
}

function BridgeSection({ theme, info }: { theme: PluginSurfaceProps["theme"]; info: ZcodeRuntimeInfo }) {
  const { bridge, node, bun } = info;
  const bunValue = bun.runtimeOverride === "node"
    ? "Off (ZCODE_ACP_RUNTIME=node)"
    : bun.path
      ? `${bun.version ?? "installed"} (used when 1.4 or newer)`
      : "Not installed";
  return (
    <SettingsSection title="Bridge">
      <SettingsCard>
        <SettingsRow label="zcode-acp-server" hint={bridge.path ?? undefined}>
          <Value theme={theme}>
            {[bridge.version, bridge.commit].filter(Boolean).join(" · ") || "Unknown"}
          </Value>
        </SettingsRow>
        <SettingsRow label="Node.js" hint={node.path ?? undefined}>
          <Value theme={theme}>{node.version ?? "Unknown"}</Value>
        </SettingsRow>
        <SettingsRow
          label="Bun"
          hint={bun.path ?? "With Bun 1.4+ installed, the bridge itself runs on it and uses about 50 MB less per session."}
        >
          <Value theme={theme} tone={bun.path ? "default" : "muted"}>{bunValue}</Value>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function MemorySection({
  theme,
  info,
  onChange,
}: {
  theme: PluginSurfaceProps["theme"];
  info: ZcodeRuntimeInfo;
  onChange(info: ZcodeRuntimeInfo): void;
}) {
  const setRpc = useRpc(zcodeSetDesktopOnlyPluginsRpc);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      setError(null);
      try {
        onChange(await setRpc({ enabled }));
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setSaving(false);
      }
    },
    [setRpc, onChange],
  );
  return (
    <SettingsSection title="Memory">
      <SettingsCard>
        <SettingsSwitch
          label="Browser Use and Computer Use"
          hint="These official plugins only work inside ZCode Desktop. While either is on, every session also starts the node_repl helper (about 200 MB). Changes apply to sessions opened afterwards, and also to ZCode Desktop and the ZCode CLI on this machine."
          value={info.desktopOnlyPlugins.enabled}
          disabled={saving}
          error={error}
          onValueChange={(value) => void toggle(value)}
        />
        <SettingsRow label="Stored in" hint={info.desktopOnlyPlugins.configPath}>
          <Value theme={theme} tone="muted">ZCode CLI config</Value>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
