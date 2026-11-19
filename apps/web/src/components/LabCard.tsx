import type { LabSummaryDTO } from "@nulllab/shared";

export default function LabCard({
  lab,
  onLaunch,
  onToggleSave,
  launching,
}: {
  lab: LabSummaryDTO;
  onLaunch: (labId: string) => void;
  onToggleSave: (labId: string, save: boolean) => void;
  launching: boolean;
}) {
  return (
    <div className="nl-card">
      <div className="nl-row" style={{ justifyContent: "space-between" }}>
        <h3>{lab.title}</h3>
        <button
          className="nl-btn secondary small"
          title={lab.saved ? "Remove from saved" : "Save for later"}
          onClick={() => onToggleSave(lab.id, !lab.saved)}
        >
          {lab.saved ? "★" : "☆"}
        </button>
      </div>
      <p>{lab.objective}</p>
      <div className="nl-card-tags">
        <span className="nl-pill accent">{lab.family}</span>
        <span className="nl-pill">{lab.difficulty}</span>
        <span className="nl-pill">{lab.estimatedMinutes} min</span>
        {lab.solved && <span className="nl-pill ok">solved</span>}
      </div>
      <button onClick={() => onLaunch(lab.id)} disabled={launching}>
        {launching ? "Launching…" : "Launch lab"}
      </button>
    </div>
  );
}
