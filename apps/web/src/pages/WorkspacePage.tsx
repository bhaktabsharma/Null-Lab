import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { LabInstanceDTO, PublicLabManifest } from "@nulllab/shared";
import { api } from "../lib/api.js";

export default function WorkspacePage() {
  const { instanceId } = useParams<{ instanceId: string }>();
  const navigate = useNavigate();
  const [instance, setInstance] = useState<LabInstanceDTO | null>(null);
  const [manifest, setManifest] = useState<PublicLabManifest | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [hintBusy, setHintBusy] = useState(false);
  // Which (lab, solved) combination the current manifest was fetched for — the debrief only exists once solved.
  const manifestKeyRef = useRef("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [visitPath, setVisitPath] = useState("/");
  const [visitStatus, setVisitStatus] = useState<string | null>(null);
  const [justSolved, setJustSolved] = useState(false);
  // Bookkeeping only — never read during render, so a plain ref is fine here.
  const previousSolvedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!instanceId) return;
    try {
      const { instance: next } = await api.instances.get(instanceId);
      if (!previousSolvedRef.current && next.solved) setJustSolved(true);
      previousSolvedRef.current = next.solved;
      setInstance(next);
      const key = `${next.labId}:${next.solved}`;
      if (manifestKeyRef.current !== key) {
        const detail = await api.labs.get(next.labId);
        manifestKeyRef.current = key;
        setManifest(detail.manifest);
      }
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : "Could not load this lab instance.");
    }
  }, [instanceId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  async function doReset() {
    if (!instanceId) return;
    setBusy(true);
    setJustSolved(false);
    previousSolvedRef.current = false;
    try {
      const { instance } = await api.instances.reset(instanceId);
      navigate(`/workspace/${instance.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : "Reset failed.");
    } finally {
      setBusy(false);
    }
  }

  async function doStop() {
    if (!instanceId) return;
    setBusy(true);
    try {
      await api.instances.stop(instanceId);
      await refresh();
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : "Stop failed.");
    } finally {
      setBusy(false);
    }
  }

  async function simulateVisit() {
    if (!instanceId) return;
    setVisitStatus("Launching the admin bot…");
    try {
      await api.instances.simulateAdminVisit(instanceId, visitPath);
      setVisitStatus("Visit complete. Checking for a solve…");
      await refresh();
    } catch (err) {
      setVisitStatus(err instanceof api.ApiError ? err.message : "The admin bot visit failed.");
    }
  }

  if (error) {
    return (
      <div className="nl-stack">
        <div className="nl-alert">{error}</div>
        <button className="nl-btn secondary" onClick={() => navigate("/catalog")}>
          Back to catalogue
        </button>
      </div>
    );
  }

  const revealHint = async () => {
    if (!manifest) return;
    setHintBusy(true);
    try {
      const next = await api.labs.hint(manifest.id, hints.length + 1);
      setHints((prev) => [...prev, next.hint]);
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : "Could not load that hint.");
    } finally {
      setHintBusy(false);
    }
  };

  if (!instance || !manifest) {
    return <p className="nl-muted">Loading workspace…</p>;
  }

  return (
    <div className="nl-stack">
      <div className="nl-topbar">
        <h1>{manifest.title}</h1>
        <div className="nl-spacer" />
        <span className={`nl-pill ${instance.status === "running" ? "accent" : ""}`}>{instance.status}</span>
        {instance.solved && <span className="nl-pill ok">solved</span>}
      </div>

      {justSolved && instance.solved && (
        <div className="nl-panel" style={{ borderColor: "var(--nl-ok)" }}>
          <strong style={{ color: "var(--nl-ok)" }}>Solved!</strong>{" "}
          <span className="nl-muted">The server independently verified the exploit. XP has been awarded.</span>
        </div>
      )}

      <div className="nl-panel nl-stack">
        <div>
          <strong>Objective</strong>
          <p className="nl-muted">{manifest.objective}</p>
        </div>

        {instance.status === "running" && instance.baseUrl && (
          <div className="nl-row" style={{ flexWrap: "wrap" }}>
            <a className="nl-btn" href={instance.baseUrl} target="_blank" rel="noreferrer">
              Open target in new tab
            </a>
            <button className="secondary nl-btn" onClick={() => navigator.clipboard?.writeText(instance.baseUrl ?? "")}>
              Copy target URL
            </button>
            <button className="secondary nl-btn" onClick={doReset} disabled={busy}>
              Reset lab
            </button>
            <button className="danger nl-btn" onClick={doStop} disabled={busy}>
              Stop
            </button>
          </div>
        )}
        {instance.status !== "running" && (
          <div className="nl-row">
            <span className="nl-muted">This instance is {instance.status}.</span>
            <button className="secondary nl-btn" onClick={doReset} disabled={busy}>
              Start a fresh instance
            </button>
          </div>
        )}
      </div>

      {instance.credentials.length > 0 && (
        <div className="nl-panel">
          <strong>Demo credentials</strong>
          <table style={{ width: "100%", marginTop: "0.5rem", fontSize: "0.88rem" }}>
            <tbody>
              {instance.credentials.map((c) => (
                <tr key={c.username}>
                  <td className="nl-muted">{c.label}</td>
                  <td>
                    <code className="nl-code">{c.username}</code> / <code className="nl-code">{c.password}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="nl-panel">
        <strong>Use Burp Suite instead</strong>
        <p className="nl-muted">
          Point your browser's proxy at Burp, then browse to{" "}
          <code className="nl-code">{instance.baseUrl ?? "(start the instance first)"}</code>. Every request — through the
          built-in browser, Burp Repeater, curl, or anything else — hits the same real target and is verified the same
          way.
        </p>
        {manifest.burpNotes && <p className="nl-muted">{manifest.burpNotes}</p>}
      </div>

      {manifest.verifier.requiresBrowserBot && (
        <div className="nl-panel nl-stack">
          <strong>Simulate an admin visit</strong>
          <p className="nl-muted">
            This lab is verified by proving real script execution. Craft your payload, then tell the simulated admin
            which path to visit — e.g. a reflected payload in a query string, or a page where you've already stored
            one.
          </p>
          <div className="nl-row">
            <input type="text" value={visitPath} onChange={(e) => setVisitPath(e.target.value)} placeholder="/search?q=..." />
            <button onClick={simulateVisit} disabled={instance.status !== "running"}>
              Simulate admin visit
            </button>
          </div>
          {visitStatus && <p className="nl-muted">{visitStatus}</p>}
        </div>
      )}

      {manifest.hintCount > 0 && (
        <div className="nl-panel nl-stack">
          <strong>Hints</strong>
          <p className="nl-muted">Stuck? Hints are revealed one at a time — try each idea before asking for the next.</p>
          {hints.map((h, i) => (
            <p key={i} className="nl-muted">
              <strong>Hint {i + 1}:</strong> {h}
            </p>
          ))}
          {hints.length < manifest.hintCount && (
            <div className="nl-row">
              <button className="secondary nl-btn" onClick={revealHint} disabled={hintBusy}>
                Reveal hint {hints.length + 1} of {manifest.hintCount}
              </button>
            </div>
          )}
        </div>
      )}

      {manifest.debrief && (
        <div className="nl-panel nl-stack">
          <strong>Debrief</strong>
          {manifest.debrief.weakness && <p className="nl-muted">{manifest.debrief.weakness}</p>}
          <p className="nl-muted">
            <strong>What the server verified:</strong> {manifest.debrief.whatWasVerified}
          </p>
        </div>
      )}
    </div>
  );
}
