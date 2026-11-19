import { THEME_PRESETS, type ThemePreset } from "@nulllab/shared";

export interface ThemePalette {
  label: string;
  accent: string;
  accentText: string;
  bg: string;
  panel: string;
  panelAlt: string;
  border: string;
  text: string;
  muted: string;
  isLight?: boolean;
}

export const THEME_PALETTES: Record<ThemePreset, ThemePalette> = {
  "ice-cyan": {
    label: "Ice Cyan",
    accent: "#4fd1e8",
    accentText: "#04171b",
    bg: "#0a0e13",
    panel: "#121821",
    panelAlt: "#0d1218",
    border: "#1f2a35",
    text: "#e7edf2",
    muted: "#8294a3",
  },
  "acid-green": {
    label: "Acid Green",
    accent: "#9dfa4c",
    accentText: "#0c1403",
    bg: "#0a0d08",
    panel: "#12170e",
    panelAlt: "#0d1109",
    border: "#232c1b",
    text: "#eaf2e3",
    muted: "#8a957e",
  },
  "amber-forge": {
    label: "Amber Forge",
    accent: "#f0a93f",
    accentText: "#1a1004",
    bg: "#100d09",
    panel: "#1a150d",
    panelAlt: "#130f0a",
    border: "#2c2416",
    text: "#f2ebdf",
    muted: "#9c8f78",
  },
  "violet-null": {
    label: "Violet Null",
    accent: "#a98cf0",
    accentText: "#140a1f",
    bg: "#0c0a13",
    panel: "#16121f",
    panelAlt: "#110e19",
    border: "#271f38",
    text: "#ebe6f5",
    muted: "#8d82a3",
  },
  "crimson-rootkit": {
    label: "Crimson Rootkit",
    accent: "#f0576f",
    accentText: "#1a0509",
    bg: "#120a0b",
    panel: "#1c1113",
    panelAlt: "#160d0e",
    border: "#301c1f",
    text: "#f2e6e8",
    muted: "#a3838a",
  },
  "mono-light": {
    label: "Mono Light",
    accent: "#2563eb",
    accentText: "#ffffff",
    bg: "#f7f8fa",
    panel: "#ffffff",
    panelAlt: "#f0f2f5",
    border: "#dde1e7",
    text: "#14181f",
    muted: "#5b6472",
    isLight: true,
  },
};

export function applyTheme(preset: ThemePreset, customAccent: string | null): void {
  const palette = THEME_PALETTES[preset] ?? THEME_PALETTES["ice-cyan"];
  const root = document.documentElement;
  const accent = customAccent || palette.accent;
  root.style.setProperty("--nl-accent", accent);
  root.style.setProperty("--nl-accent-text", customAccent ? pickReadableText(customAccent) : palette.accentText);
  root.style.setProperty("--nl-bg", palette.bg);
  root.style.setProperty("--nl-panel", palette.panel);
  root.style.setProperty("--nl-panel-alt", palette.panelAlt);
  root.style.setProperty("--nl-border", palette.border);
  root.style.setProperty("--nl-text", palette.text);
  root.style.setProperty("--nl-muted", palette.muted);
  root.dataset.theme = preset;
  root.dataset.themeMode = palette.isLight ? "light" : "dark";
}

/** Picks black or white text over an arbitrary custom accent color for contrast. */
function pickReadableText(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#111111";
  const value = m[1];
  if (!value) return "#111111";
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111111" : "#ffffff";
}

export const THEME_PRESET_LIST = THEME_PRESETS;
