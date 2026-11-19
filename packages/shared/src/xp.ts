import type { Difficulty } from "./manifest.js";

export const XP_BY_DIFFICULTY: Record<Difficulty, number> = {
  beginner: 50,
  easy: 75,
  medium: 125,
  hard: 200,
  advanced: 300,
};
