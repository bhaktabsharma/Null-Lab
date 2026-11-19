import { useState } from "react";
import { useAuth } from "../lib/auth.js";

type Mode = "login" | "register";

export default function LoginPage() {
  const { continueAsGuest, login, register, error } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "login") await login(username, password);
      else await register(username, password);
    } catch {
      /* error already captured in auth context */
    } finally {
      setBusy(false);
    }
  }

  async function guest() {
    setBusy(true);
    try {
      await continueAsGuest();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "1.5rem" }}>
      <div className="nl-panel" style={{ maxWidth: 400, width: "100%" }}>
        <div className="nl-brand" style={{ marginBottom: "1.25rem" }}>
          NULLLAB
          <small>Practice over theory</small>
        </div>

        <button style={{ width: "100%", marginBottom: "1.25rem" }} onClick={guest} disabled={busy}>
          Continue as guest
        </button>
        <p className="nl-muted" style={{ fontSize: "0.8rem", marginTop: "-0.75rem", marginBottom: "1.25rem" }}>
          No account needed — progress is saved to a local guest profile on this server.
        </p>

        <div className="nl-row" style={{ marginBottom: "1rem" }}>
          <div style={{ flex: 1, height: 1, background: "var(--nl-border)" }} />
          <span className="nl-muted" style={{ fontSize: "0.78rem" }}>
            or {mode === "login" ? "sign in" : "create a profile"}
          </span>
          <div style={{ flex: 1, height: 1, background: "var(--nl-border)" }} />
        </div>

        <form onSubmit={submit} className="nl-stack">
          {error && <div className="nl-alert">{error}</div>}
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
          <button type="submit" className="secondary nl-btn" disabled={busy || !username || !password}>
            {mode === "login" ? "Sign in" : "Create profile"}
          </button>
        </form>

        <p className="nl-muted" style={{ fontSize: "0.82rem", marginTop: "1rem", textAlign: "center" }}>
          {mode === "login" ? (
            <>
              New here?{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), setMode("register"))}>
                Create a profile
              </a>
            </>
          ) : (
            <>
              Already have a profile?{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), setMode("login"))}>
                Sign in
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
