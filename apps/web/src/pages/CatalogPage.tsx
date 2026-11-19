import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { LabSummaryDTO } from "@nulllab/shared";
import { api } from "../lib/api.js";
import LabCard from "../components/LabCard.js";

type Filter = "all" | "saved" | "solved" | "unsolved";

export default function CatalogPage() {
  const navigate = useNavigate();
  const [labs, setLabs] = useState<LabSummaryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState<string>("all");
  const [difficulty, setDifficulty] = useState<string>("all");
  const [filter, setFilter] = useState<Filter>("all");
  const [launchingId, setLaunchingId] = useState<string | null>(null);

  async function load() {
    try {
      const { labs } = await api.labs.list();
      setLabs(labs);
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : "Could not load the lab catalogue.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  const families = useMemo(() => {
    if (!labs) return [];
    return [...new Set(labs.map((l) => l.family))].sort();
  }, [labs]);

  // Only offer difficulties that actually exist in the catalogue, in learning order.
  const difficulties = useMemo(() => {
    if (!labs) return [];
    const order = ["beginner", "easy", "medium", "hard", "advanced"];
    const present = new Set(labs.map((l) => l.difficulty as string));
    return order.filter((d) => present.has(d));
  }, [labs]);

  const filtered = useMemo(() => {
    if (!labs) return [];
    return labs.filter((lab) => {
      if (family !== "all" && lab.family !== family) return false;
      if (difficulty !== "all" && lab.difficulty !== difficulty) return false;
      if (filter === "saved" && !lab.saved) return false;
      if (filter === "solved" && !lab.solved) return false;
      if (filter === "unsolved" && lab.solved) return false;
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const haystack = `${lab.title} ${lab.objective} ${lab.tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [labs, family, difficulty, filter, query]);

  async function launch(labId: string) {
    setLaunchingId(labId);
    try {
      const { instance } = await api.labs.launch(labId);
      navigate(`/workspace/${instance.id}`);
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : "Could not launch that lab.");
    } finally {
      setLaunchingId(null);
    }
  }

  async function toggleSave(labId: string, save: boolean) {
    setLabs((prev) => prev?.map((l) => (l.id === labId ? { ...l, saved: save } : l)) ?? prev);
    try {
      if (save) await api.labs.save(labId);
      else await api.labs.unsave(labId);
    } catch {
      load(); // resync on failure
    }
  }

  return (
    <div className="nl-stack">
      <div className="nl-topbar">
        <h1>Lab Catalogue</h1>
        <div className="nl-spacer" />
        {labs && (
          <span className="nl-muted" style={{ fontSize: "0.85rem" }}>
            {filtered.length} of {labs.length} labs
          </span>
        )}
      </div>

      <div className="nl-row" style={{ flexWrap: "wrap" }}>
        <input
          type="search"
          placeholder="Search labs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <select aria-label="Family" value={family} onChange={(e) => setFamily(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="all">All families</option>
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <select aria-label="Difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="all">All difficulties</option>
          {difficulties.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select aria-label="Status" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} style={{ maxWidth: 180 }}>
          <option value="all">All labs</option>
          <option value="saved">Saved</option>
          <option value="solved">Solved</option>
          <option value="unsolved">Unsolved</option>
        </select>
      </div>

      {error && <div className="nl-alert">{error}</div>}

      {!labs && !error && <p className="nl-muted">Loading labs…</p>}

      {labs && filtered.length === 0 && <div className="nl-empty">No labs match those filters yet.</div>}

      {labs && filtered.length > 0 && (
        <div className="nl-grid">
          {filtered.map((lab) => (
            <LabCard key={lab.id} lab={lab} onLaunch={launch} onToggleSave={toggleSave} launching={launchingId === lab.id} />
          ))}
        </div>
      )}
    </div>
  );
}
