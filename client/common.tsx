import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text } from "react-native";

/** Load-on-mount RPC data with an explicit refresh; keeps the last good value while reloading. */
export function useResource<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await load();
      if (!mounted.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, setData, loading, error, refresh };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Tone = "default" | "muted" | "success" | "warning" | "danger";

/** A row's value, coloured from the host theme. */
export function Value({
  theme,
  tone = "default",
  selectable = false,
  children,
}: {
  theme: PluginTheme;
  tone?: Tone;
  selectable?: boolean;
  children: string;
}) {
  const color =
    tone === "muted"
      ? theme.colors.foregroundMuted
      : tone === "success"
        ? theme.colors.statusSuccess
        : tone === "warning"
          ? theme.colors.statusWarning
          : tone === "danger"
            ? theme.colors.statusDanger
            : theme.colors.foreground;
  return (
    <Text selectable={selectable} style={{ color }}>
      {children}
    </Text>
  );
}

export function formatTime(iso: string | null): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

/** Small accent-coloured text button for a section's `trailing` slot. */
export function RefreshButton({
  theme,
  busy,
  onPress,
}: {
  theme: PluginTheme;
  busy: boolean;
  onPress(): void;
}) {
  return (
    <Pressable accessibilityRole="button" disabled={busy} onPress={onPress} hitSlop={8}>
      <Text style={{ color: busy ? theme.colors.foregroundMuted : theme.colors.accent }}>
        {busy ? "Refreshing…" : "Refresh"}
      </Text>
    </Pressable>
  );
}
