import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";

import {
  zcodeAccountViewRpc,
  zcodeCreateProviderRpc,
  zcodeDeleteProviderRpc,
  zcodeResetCardsRpc,
  zcodeUpdateProviderRpc,
  zcodeUseResetCardRpc,
  type ZcodeAccountView,
  type ZcodeResetCards,
  type ZcodeResetType,
} from "../shared/account";
import { errorMessage, formatTime, RefreshButton, useResource, Value } from "./common";

type Theme = PluginSurfaceProps["theme"];

/** How long an armed two-step action waits for its confirming tap. */
const CONFIRM_WINDOW_MS = 10_000;

/**
 * Settings → Plugins → ZCode (ACP) → Account: what the stored ZCode
 * credentials allow, Coding Plan reset cards, and the providers the model
 * picker offers. Sign-in itself happens in ZCode Desktop.
 */
export function AccountScreen({ theme }: PluginSurfaceProps) {
  const accountRpc = useRpc(zcodeAccountViewRpc);
  const load = useCallback(() => accountRpc({}), [accountRpc]);
  const account = useResource(load);

  if (!account.data) {
    return (
      <SettingsSection title="Account">
        <SettingsCard>
          <SettingsRow label={account.loading ? "Loading account…" : "Account unavailable"} error={account.error} />
          {account.loading ? null : (
            <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void account.refresh()} />
          )}
        </SettingsCard>
      </SettingsSection>
    );
  }
  const view = account.data;
  const refresh = <RefreshButton theme={theme} busy={account.loading} onPress={() => void account.refresh()} />;
  return (
    <View>
      <SignInSection theme={theme} view={view} trailing={refresh} />
      {view.resetCardProviders.map((plan) => (
        <ResetCardsSection key={plan.providerId} theme={theme} providerId={plan.providerId} label={plan.label} />
      ))}
      <ProvidersSection theme={theme} view={view} onChange={account.setData} />
    </View>
  );
}

function planStatus(plan: ZcodeAccountView["plans"][number]): string {
  if (plan.available) return "Available";
  if (plan.reason === "coding_plan_not_authenticated") return "Not signed in";
  return plan.reason ?? "Unavailable";
}

function SignInSection({ theme, view, trailing }: { theme: Theme; view: ZcodeAccountView; trailing: ReactNode }) {
  const signedIn = view.signIn.state === "signed-in";
  return (
    <SettingsSection title="Account" trailing={trailing}>
      <SettingsCard>
        {view.error ? <SettingsRow label="Account check incomplete" error={view.error} /> : null}
        <SettingsRow
          label="ZCode sign-in"
          hint={
            signedIn
              ? "Read from ZCode's credential store on this machine."
              : view.signIn.state === "no-credentials"
                ? "No readable ZCode credentials. Sign in with ZCode Desktop on this machine."
                : `Credentials are incomplete (${view.signIn.detail ?? "unknown"}). Sign in again with ZCode Desktop.`
          }
        >
          <Value theme={theme} tone={signedIn ? "success" : "warning"}>{signedIn ? "Signed in" : "Not signed in"}</Value>
        </SettingsRow>
        {view.plans.map((plan) => (
          <SettingsRow
            key={plan.id}
            label={plan.label}
            hint={view.plansUpdatedAt ? `As last checked by ZCode Desktop, ${formatTime(view.plansUpdatedAt)}` : undefined}
          >
            <Value theme={theme} tone={plan.available ? "success" : "muted"}>{planStatus(plan)}</Value>
          </SettingsRow>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function formatEpoch(ms: number | null, empty: string): string {
  return ms === null ? empty : new Date(ms).toLocaleString();
}

/** A press that must be confirmed by a second press within {@link CONFIRM_WINDOW_MS}. */
function useArmed(): { armed: boolean; arm(): void; disarm(): void } {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  }, []);
  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return { armed, arm, disarm };
}

function ResetCardsSection({ theme, providerId, label }: { theme: Theme; providerId: string; label: string }) {
  const cardsRpc = useRpc(zcodeResetCardsRpc);
  const load = useCallback(() => cardsRpc({ providerId }), [cardsRpc, providerId]);
  const cards = useResource(load);
  const refresh = <RefreshButton theme={theme} busy={cards.loading} onPress={() => void cards.refresh()} />;
  return (
    <SettingsSection title={`Reset cards · ${label}`} trailing={refresh}>
      <SettingsCard>
        {!cards.data ? (
          <SettingsRow label={cards.loading ? "Loading reset cards…" : "Reset cards unavailable"} error={cards.error} />
        ) : (
          <ResetCardRows theme={theme} cards={cards.data} onChange={cards.setData} />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function ResetCardRows({
  theme,
  cards,
  onChange,
}: {
  theme: Theme;
  cards: ZcodeResetCards;
  onChange(cards: ZcodeResetCards): void;
}) {
  const usage = cards.windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}% used`).join(" · ");
  const resets = cards.windows
    .filter((w) => w.resetAt !== null)
    .map((w) => `${w.label} resets ${formatEpoch(w.resetAt, "")}`)
    .join(" · ");
  return (
    <>
      {cards.windows.length ? (
        <SettingsRow label="Current usage" hint={resets || undefined}>
          <Value theme={theme}>{usage}</Value>
        </SettingsRow>
      ) : null}
      <SpendRow theme={theme} cards={cards} resetType="FIVE_HOUR" label="5-hour window" onChange={onChange} />
      <SpendRow theme={theme} cards={cards} resetType="WEEK" label="Weekly window" onChange={onChange} />
    </>
  );
}

function SpendRow({
  theme,
  cards,
  resetType,
  label,
  onChange,
}: {
  theme: Theme;
  cards: ZcodeResetCards;
  resetType: ZcodeResetType;
  label: string;
  onChange(cards: ZcodeResetCards): void;
}) {
  const spendCard = useRpc(zcodeUseResetCardRpc);
  const { armed, arm, disarm } = useArmed();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const pool = resetType === "FIVE_HOUR" ? cards.fiveHour : cards.week;
  const spend = useCallback(async () => {
    disarm();
    setBusy(true);
    setMessage(null);
    try {
      const result = await spendCard({ providerId: cards.providerId, resetType, nonce: cards.nonce });
      onChange(result.cards);
      setMessage(
        result.used
          ? { text: `${label} reset. One card used.`, error: false }
          : {
              text: `Not reset${result.nextTryAt ? `: try again after ${formatEpoch(result.nextTryAt, "")}` : ""}. No card was used.`,
              error: true,
            },
      );
    } catch (error) {
      setMessage({ text: errorMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  }, [cards.nonce, cards.providerId, disarm, label, onChange, resetType, spendCard]);
  return (
    <>
      <SettingsRow
        label={`${label} cards`}
        hint={`Next to expire ${formatEpoch(pool.nextExpireAt, "—")} · last used ${formatEpoch(pool.lastUsedAt, "never")}`}
      >
        <Value theme={theme} tone={pool.available ? "default" : "muted"}>{`${pool.available} left`}</Value>
      </SettingsRow>
      <SettingsAction
        label={armed ? `Spend 1 of ${pool.available} ${label.toLowerCase()} cards? This cannot be undone.` : `Reset the ${label.toLowerCase()}`}
        actionLabel={busy ? "Resetting…" : armed ? "Confirm" : "Use a card"}
        disabled={busy || pool.available === 0}
        onPress={armed ? () => void spend() : arm}
      />
      {message ? <SettingsRow label={message.text} error={message.error ? message.text : null} /> : null}
    </>
  );
}

function ProvidersSection({
  theme,
  view,
  onChange,
}: {
  theme: Theme;
  view: ZcodeAccountView;
  onChange(view: ZcodeAccountView): void;
}) {
  return (
    <SettingsSection title="Model providers">
      <SettingsCard>
        {view.builtinProviders.map((provider) => (
          <SettingsRow
            key={provider.id}
            label={provider.id}
            hint={`${provider.enabled ? "Enabled" : "Disabled"} · managed by ZCode Desktop`}
          >
            <Value theme={theme} tone={provider.hasKey ? "success" : "muted"}>
              {provider.hasKey ? "Key present" : "No key"}
            </Value>
          </SettingsRow>
        ))}
        {view.personalProviders.map((provider) => (
          <PersonalProvider key={provider.providerId} theme={theme} provider={provider} onChange={onChange} />
        ))}
      </SettingsCard>
      <AddProvider theme={theme} view={view} onChange={onChange} />
    </SettingsSection>
  );
}

function PersonalProvider({
  theme,
  provider,
  onChange,
}: {
  theme: Theme;
  provider: ZcodeAccountView["personalProviders"][number];
  onChange(view: ZcodeAccountView): void;
}) {
  const updateRpc = useRpc(zcodeUpdateProviderRpc);
  const deleteRpc = useRpc(zcodeDeleteProviderRpc);
  const { armed, arm, disarm } = useArmed();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [key, setKey] = useState("");
  const act = useCallback(
    async (action: () => Promise<ZcodeAccountView>) => {
      setBusy(true);
      setError(null);
      try {
        onChange(await action());
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );
  const details = [
    provider.templateName,
    `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`,
    provider.baseUrl,
    provider.hasKey ? null : "no key",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <SettingsSwitch
        label={provider.name}
        hint={details}
        value={provider.enabled}
        disabled={busy}
        error={error}
        onValueChange={(enabled) => void act(() => updateRpc({ providerId: provider.providerId, enabled }))}
      />
      {provider.models.length ? (
        <SettingsRow label="Models" hint={provider.models.join(", ")} />
      ) : null}
      {editingKey ? (
        <>
          <SettingsInput label={`New key for ${provider.name}`} secureTextEntry onChangeText={setKey} disabled={busy} />
          <SettingsAction
            label="Replace the stored key"
            actionLabel={busy ? "Saving…" : "Save key"}
            disabled={busy || !key.trim()}
            onPress={() =>
              void act(() => updateRpc({ providerId: provider.providerId, apiKey: key })).then((ok) => {
                if (ok) {
                  setEditingKey(false);
                  setKey("");
                }
              })
            }
          />
        </>
      ) : (
        <SettingsAction label="API key" actionLabel="Replace key" disabled={busy} onPress={() => setEditingKey(true)} />
      )}
      <SettingsAction
        label={armed ? `Delete ${provider.name} and its model settings?` : "Remove this provider"}
        actionLabel={armed ? "Confirm delete" : "Delete"}
        disabled={busy}
        onPress={
          armed
            ? () => {
                disarm();
                void act(() => deleteRpc({ providerId: provider.providerId }));
              }
            : arm
        }
      />
    </>
  );
}

function AddProvider({
  theme,
  view,
  onChange,
}: {
  theme: Theme;
  view: ZcodeAccountView;
  onChange(view: ZcodeAccountView): void;
}) {
  const createRpc = useRpc(zcodeCreateProviderRpc);
  const options = useMemo(
    () => view.templates.map((t) => ({ label: t.name, value: t.templateId })),
    [view.templates],
  );
  const [templateId, setTemplateId] = useState<string>(options[0]?.value ?? "");
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const keyInput = useRef<SettingsInputHandle>(null);
  const nameInput = useRef<SettingsInputHandle>(null);
  const template = view.templates.find((t) => t.templateId === templateId);
  const add = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      const next = await createRpc({ templateId, apiKey, ...(name.trim() ? { providerName: name.trim() } : {}) });
      onChange(next);
      keyInput.current?.replaceText("");
      nameInput.current?.replaceText("");
      setApiKey("");
      setName("");
      setResult({ text: "Added. Its models appear in the ZCode (ACP) model picker within a few seconds.", error: false });
    } catch (error) {
      setResult({ text: errorMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  }, [apiKey, createRpc, name, onChange, templateId]);
  if (!options.length) {
    return (
      <SettingsCard>
        <SettingsRow label="Add a provider" hint="The bundled provider templates were not found." />
      </SettingsCard>
    );
  }
  return (
    <SettingsCard>
      <SettingsSelect
        label="Add a provider"
        hint={
          template
            ? [template.baseUrl, `${template.modelIds.length} models`, template.accessType === "zhipu-coding-plan-api-key" ? "Coding Plan key" : "API key"]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
        value={templateId}
        options={options}
        disabled={busy}
        onValueChange={setTemplateId}
      />
      {template?.apiKeyManagementUrl ? (
        <SettingsRow label="Get a key">
          <ExternalLink href={template.apiKeyManagementUrl}>{template.apiKeyManagementUrl}</ExternalLink>
        </SettingsRow>
      ) : null}
      <SettingsInput ref={keyInput} label="API key" secureTextEntry onChangeText={setApiKey} disabled={busy} />
      <SettingsInput
        ref={nameInput}
        label="Name (optional)"
        placeholder={template?.name}
        onChangeText={setName}
        disabled={busy}
      />
      <SettingsAction
        label="Stored in ZCode's provider config, shared with ZCode Desktop on this machine"
        actionLabel={busy ? "Adding…" : "Add provider"}
        disabled={busy || !apiKey.trim() || !templateId}
        onPress={() => void add()}
      />
      {result ? <SettingsRow label={result.text} error={result.error ? result.text : null} /> : null}
    </SettingsCard>
  );
}
