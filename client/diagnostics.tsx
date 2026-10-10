import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, type ReactNode } from "react";
import { View } from "react-native";

import { zcodeDiagnosticsRpc, type ZcodeDiagnostics } from "../shared/settings";
import { formatAge, formatTime, RefreshButton, useResource, Value } from "./common";

type Theme = PluginSurfaceProps["theme"];

/**
 * Settings → Plugins → ZCode (ACP) → Diagnostics. Read-only: provider health,
 * the official request-signing check, version consistency, what each open
 * session costs, which credentials exist (never their values), recent agent
 * errors and where the logs are.
 */
export function DiagnosticsScreen({ theme }: PluginSurfaceProps) {
  const diagnosticsRpc = useRpc(zcodeDiagnosticsRpc);
  const load = useCallback(() => diagnosticsRpc({}), [diagnosticsRpc]);
  const diagnostics = useResource(load);

  if (!diagnostics.data) {
    return (
      <SettingsSection title="Diagnostics">
        <SettingsCard>
          <SettingsRow
            label={diagnostics.loading ? "Collecting diagnostics…" : "Diagnostics unavailable"}
            error={diagnostics.error}
          />
          {diagnostics.loading ? null : (
            <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void diagnostics.refresh()} />
          )}
        </SettingsCard>
      </SettingsSection>
    );
  }
  const data = diagnostics.data;
  const refresh = (
    <RefreshButton theme={theme} busy={diagnostics.loading} onPress={() => void diagnostics.refresh()} />
  );
  return (
    <View>
      <StatusSection theme={theme} data={data} trailing={refresh} />
      <SessionsSection theme={theme} sessions={data.sessions} />
      <CredentialsSection theme={theme} credentials={data.credentials} />
      <ErrorsSection theme={theme} errors={data.recentErrors} />
      <PathsSection theme={theme} paths={data.paths} />
    </View>
  );
}

function StatusSection({
  theme,
  data,
  trailing,
}: {
  theme: Theme;
  data: ZcodeDiagnostics;
  trailing: ReactNode;
}) {
  const { provider, signing, versions } = data;
  const signingTone = signing.state === "enabled" ? "success" : signing.state === "disabled" ? "warning" : "muted";
  const signingLabel =
    signing.state === "enabled" ? "Enabled" : signing.state === "disabled" ? "Disabled" : "Unknown";
  return (
    <SettingsSection title="Status" trailing={trailing}>
      <SettingsCard>
        <SettingsRow label="Provider" error={provider.detail}>
          <Value theme={theme} tone={provider.available ? "success" : "danger"}>
            {provider.available ? "Ready" : "Unavailable"}
          </Value>
        </SettingsRow>
        <SettingsRow
          label="Official request signing"
          hint={
            signing.at
              ? `Last checked by an agent at ${formatTime(signing.at)}${signing.detail ? ` · ${signing.detail}` : ""}`
              : (signing.detail ?? undefined)
          }
        >
          <Value theme={theme} tone={signingTone}>{signingLabel}</Value>
        </SettingsRow>
        <SettingsRow
          label="Versions"
          hint={`Checked ${formatTime(data.checkedAt)}`}
          error={
            versions.consistent
              ? null
              : `ZCODE_APP_VERSION=${versions.override} in the daemon environment differs from the installed Desktop (${versions.desktop}). Remove it and restart the daemon.`
          }
        >
          <Value theme={theme}>
            {`Desktop ${versions.desktop ?? versions.override ?? "?"} · agent ${versions.agent ?? "?"}`}
          </Value>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function SessionsSection({ theme, sessions }: { theme: Theme; sessions: ZcodeDiagnostics["sessions"] }) {
  return (
    <SettingsSection title="Open sessions">
      <SettingsCard>
        {!sessions.supported ? (
          <SettingsRow label="Session memory" hint="Needs /proc (Linux).">
            <Value theme={theme} tone="muted">Not available here</Value>
          </SettingsRow>
        ) : (
          <>
            <SettingsRow
              label="Total"
              hint="Each open session keeps its bridge, agent CLI and helpers resident until the agent is archived or the plugin is reloaded."
            >
              <Value theme={theme}>
                {`${sessions.items.length} open · ${sessions.totalMb} MB`}
              </Value>
            </SettingsRow>
            {sessions.items.map((session) => (
              <SettingsRow
                key={session.pid}
                label={`Bridge PID ${session.pid}`}
                hint={`Open ${formatAge(session.ageSeconds)}${session.nodeRepl ? " · node_repl helper running" : ""}`}
              >
                <Value theme={theme}>{`${session.rssMb} MB`}</Value>
              </SettingsRow>
            ))}
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function CredentialsSection({
  theme,
  credentials,
}: {
  theme: Theme;
  credentials: ZcodeDiagnostics["credentials"];
}) {
  return (
    <SettingsSection title="Credentials">
      <SettingsCard>
        {credentials.pinnedProvider ? (
          <SettingsRow label="Pinned provider" hint="ZCODE_PROVIDER in the daemon environment">
            <Value theme={theme}>{credentials.pinnedProvider}</Value>
          </SettingsRow>
        ) : null}
        {credentials.providers.length === 0 ? (
          <SettingsRow label="Providers" hint="Sign in with ZCode Desktop to create ~/.zcode/v2/config.json.">
            <Value theme={theme} tone="warning">None configured</Value>
          </SettingsRow>
        ) : (
          credentials.providers.map((provider) => (
            <SettingsRow key={provider.id} label={provider.id} hint={provider.enabled ? "Enabled" : "Disabled"}>
              <Value theme={theme} tone={provider.hasKey ? "success" : "warning"}>
                {provider.hasKey ? "Key present" : "No key"}
              </Value>
            </SettingsRow>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function ErrorsSection({ theme, errors }: { theme: Theme; errors: ZcodeDiagnostics["recentErrors"] }) {
  return (
    <SettingsSection title={`Agent errors (last ${errors.windowMinutes} min)`}>
      <SettingsCard>
        <SettingsRow label="Errors" hint="Every ZCode agent on this host writes to the same log.">
          <Value theme={theme} tone={errors.count === 0 ? "success" : "warning"}>{String(errors.count)}</Value>
        </SettingsRow>
        {errors.latest.map((entry, index) => (
          <SettingsRow
            key={`${entry.at}-${index}`}
            label={entry.event || "error"}
            hint={`${formatTime(entry.at)} · ${entry.message}`}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function PathsSection({ theme, paths }: { theme: Theme; paths: ZcodeDiagnostics["paths"] }) {
  return (
    <SettingsSection title="Paths">
      <SettingsCard>
        {paths.map((entry) => (
          <SettingsRow key={entry.label} label={entry.label}>
            <Value theme={theme} tone="muted" selectable>{entry.path}</Value>
          </SettingsRow>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
