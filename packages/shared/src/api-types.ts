import type { Difficulty } from "./manifest.js";
import type { FamilyId } from "./taxonomy.js";

export interface PublicUser {
  id: string;
  username: string;
  isGuest: boolean;
  xp: number;
  createdAt: string;
}

export interface LabSummaryDTO {
  id: string;
  title: string;
  objective: string;
  family: FamilyId;
  subcategory: string;
  difficulty: Difficulty;
  tags: string[];
  estimatedMinutes: number;
  solved: boolean;
  saved: boolean;
  solvedAt: string | null;
}

export type InstanceStatus = "starting" | "running" | "stopping" | "stopped" | "expired" | "error";

export interface LabInstanceDTO {
  id: string;
  labId: string;
  status: InstanceStatus;
  baseUrl: string | null;
  credentials: { label: string; username: string; password: string; note?: string }[];
  createdAt: string;
  expiresAt: string;
  lastActivityAt: string;
  solved: boolean;
}

export interface SolveEventDTO {
  labId: string;
  labTitle: string;
  instanceId: string;
  xpAwarded: number;
  totalXp: number;
  firstSolve: boolean;
  evidence: string;
}

export const THEME_PRESETS = [
  "ice-cyan",
  "acid-green",
  "amber-forge",
  "violet-null",
  "crimson-rootkit",
  "mono-light",
] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];

export interface ThemeSettings {
  preset: ThemePreset;
  /** Optional custom accent override as a hex color; null = use preset accent. */
  customAccent: string | null;
}
