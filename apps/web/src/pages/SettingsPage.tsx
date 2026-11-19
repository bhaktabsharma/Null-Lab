import { useState } from "react";
import type { ThemePreset } from "@nulllab/shared";
import { useTheme } from "../lib/theme-context.js";
import { THEME_PALETTES, THEME_PRESET_LIST } from "../lib/theme.js";

export default function SettingsPage() {
  const { preset, customAccent, setTheme } = useTheme();
  const [customInput, setCustomInput] = useState(customAccent ?? "");

  function choosePreset(next: ThemePreset) {
    setTheme(next, null);
    setCustomInput("");
  }

  function applyCustomAccent() {
    if (/^#[0-9a-fA-F]{6}$/.test(customInput)) {
      setTheme(preset, customInput);
    }
  }

  return (
    <div className="nl-stack">
      <div className="nl-topbar">
        <h1>Settings</h1>
      </div>

      <div className="nl-panel nl-stack">
        <div>
          <strong>Color theme</strong>
          <p className="nl-muted">Pick a palette for the whole site. It applies instantly and is saved to your profile.</p>
        </div>

        <div className="nl-theme-grid">
          {THEME_PRESET_LIST.map((p) => {
            const palette = THEME_PALETTES[p];
            const active = preset === p && !customAccent;
            return (
              <button
                key={p}
                type="button"
                className={`nl-theme-swatch ${active ? "active" : ""}`}
                onClick={() => choosePreset(p)}
                style={{ color: palette.text, background: palette.panel }}
              >
                <div className="dot" style={{ background: palette.accent }} />
                {palette.label}
              </button>
            );
          })}
        </div>

        <div>
          <strong style={{ fontSize: "0.92rem" }}>Custom accent color</strong>
          <p className="nl-muted" style={{ marginBottom: "0.5rem" }}>
            Override just the accent color on top of your chosen palette.
          </p>
          <div className="nl-row">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(customInput) ? customInput : "#4fd1e8"}
              onChange={(e) => setCustomInput(e.target.value)}
              style={{ width: 48, padding: 2, height: 38 }}
            />
            <input
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              placeholder="#4fd1e8"
              style={{ maxWidth: 140 }}
            />
            <button className="secondary nl-btn" onClick={applyCustomAccent}>
              Apply
            </button>
            {customAccent && (
              <button className="secondary nl-btn" onClick={() => choosePreset(preset)}>
                Reset to palette default
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
