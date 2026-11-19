import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { ThemePreset, ThemeSettings } from "@nulllab/shared";
import { api } from "./api.js";
import { applyTheme } from "./theme.js";
import { useAuth } from "./auth.js";

interface ThemeState {
  preset: ThemePreset;
  customAccent: string | null;
  setTheme: (preset: ThemePreset, customAccent: string | null) => Promise<void>;
}

const ThemeContext = createContext<ThemeState | null>(null);
const LOCAL_KEY = "nulllab-theme-fallback";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [preset, setPreset] = useState<ThemePreset>("ice-cyan");
  const [customAccent, setCustomAccent] = useState<string | null>(null);

  // Apply immediately on every change so it never flashes the wrong theme.
  useEffect(() => {
    applyTheme(preset, customAccent);
  }, [preset, customAccent]);

  // Before login: fall back to whatever was last applied on this browser.
  useEffect(() => {
    if (user) return;
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as ThemeSettings;
        setPreset(saved.preset);
        setCustomAccent(saved.customAccent);
      }
    } catch {
      /* ignore */
    }
  }, [user]);

  // After login: the account's saved preference is the source of truth.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api.preferences
      .getTheme()
      .then(({ theme }) => {
        if (cancelled) return;
        setPreset(theme.preset);
        setCustomAccent(theme.customAccent);
      })
      .catch(() => {
        /* keep whatever local fallback was already applied */
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const setTheme = useCallback(
    async (nextPreset: ThemePreset, nextCustomAccent: string | null) => {
      setPreset(nextPreset);
      setCustomAccent(nextCustomAccent);
      localStorage.setItem(LOCAL_KEY, JSON.stringify({ preset: nextPreset, customAccent: nextCustomAccent }));
      if (user) {
        try {
          await api.preferences.setTheme({ preset: nextPreset, customAccent: nextCustomAccent });
        } catch {
          /* best effort — theme already applied locally */
        }
      }
    },
    [user],
  );

  return <ThemeContext.Provider value={{ preset, customAccent, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
