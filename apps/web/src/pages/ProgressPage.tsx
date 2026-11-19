import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

type ProgressData = Awaited<ReturnType<typeof api.progress.get>>;

export default function ProgressPage() {
  const [data, setData] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.progress
      .get()
      .then(setData)
      .catch((err) => setError(err instanceof api.ApiError ? err.message : "Could not load progress."));
  }, []);

  if (error) return <div className="nl-alert">{error}</div>;
  if (!data) return <p className="nl-muted">Loading progress…</p>;

  const families = Object.entries(data.byFamily).filter(([, v]) => v.total > 0);

  return (
    <div className="nl-stack">
      <div className="nl-topbar">
        <h1>Progress</h1>
      </div>

      <div className="nl-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <div className="nl-panel">
          <div className="nl-muted">Total XP</div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700 }}>{data.xp}</div>
        </div>
        <div className="nl-panel">
          <div className="nl-muted">Labs Solved</div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700 }}>
            {data.totalSolved} / {data.totalLabs}
          </div>
        </div>
      </div>

      <div className="nl-panel nl-stack">
        <strong>Coverage by family</strong>
        {families.length === 0 && <p className="nl-muted">No labs loaded yet.</p>}
        {families.map(([family, v]) => (
          <div key={family}>
            <div className="nl-row" style={{ justifyContent: "space-between", marginBottom: "0.3rem" }}>
              <span style={{ fontSize: "0.88rem" }}>{family}</span>
              <span className="nl-muted" style={{ fontSize: "0.82rem" }}>
                {v.solved} / {v.total}
              </span>
            </div>
            <div className="nl-progress-track">
              <div className="nl-progress-fill" style={{ width: `${v.total ? (v.solved / v.total) * 100 : 0}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="nl-panel">
        <strong>Recent solves</strong>
        {data.recentSolves.length === 0 && <p className="nl-muted">Nothing solved yet — pick a lab from the catalogue.</p>}
        <div className="nl-stack" style={{ marginTop: data.recentSolves.length ? "0.75rem" : 0 }}>
          {data.recentSolves.map((s, i) => (
            <div key={i} className="nl-row" style={{ justifyContent: "space-between", borderTop: i ? "1px solid var(--nl-border)" : "none", paddingTop: i ? "0.6rem" : 0 }}>
              <div>
                <div>{s.labTitle}</div>
                <div className="nl-muted" style={{ fontSize: "0.8rem" }}>
                  {new Date(s.verifiedAt).toLocaleString()}
                </div>
              </div>
              <span className="nl-pill accent">+{s.xpAwarded} XP</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
