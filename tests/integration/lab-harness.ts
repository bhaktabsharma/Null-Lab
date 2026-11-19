import { expect } from "vitest";
import { CookieClient, type TestApp } from "./helpers.js";
import { getLabProxy } from "./proxy.js";
import { XP_BY_DIFFICULTY, type Difficulty } from "../../packages/shared/src/index.js";

/** A signed-in NULLLAB learner (guest account) with its own cookie jar. */
export async function newLearner(t: TestApp): Promise<CookieClient> {
  const cp = new CookieClient(t.baseUrl);
  const res = await cp.json("/api/auth/guest", { method: "POST" });
  expect(res.status).toBe(200);
  return cp;
}

export class LabSession {
  constructor(
    readonly cp: CookieClient,
    readonly id: string,
    readonly baseUrl: string,
    readonly port: number,
    readonly labId: string = "",
  ) {}

  /** A fresh "browser" talking to the lab target. */
  browser(): CookieClient {
    return new CookieClient(this.baseUrl);
  }

  async solved(): Promise<boolean> {
    const r = await this.cp.json<{ instance: { solved: boolean } }>(`/api/instances/${this.id}`);
    expect(r.status).toBe(200);
    // In proxy mode, remember that this lab was really solved while all of its
    // learner traffic was going through the proxy (used for the proxy status report).
    if (r.body.instance.solved) (await getLabProxy())?.markSolved(this.labId);
    return r.body.instance.solved;
  }

  async xp(): Promise<number> {
    return (await this.cp.json<{ xp: number }>("/api/progress")).body.xp;
  }

  async stop(): Promise<void> {
    await this.cp.fetch(`/api/instances/${this.id}/stop`, { method: "POST" });
  }
}

export async function launch(t: TestApp, labId: string, cp?: CookieClient): Promise<LabSession> {
  const learner = cp ?? (await newLearner(t));
  const res = await learner.json<{ instance: { id: string; baseUrl: string } }>(`/api/labs/${labId}/instances`, { method: "POST" });
  expect(res.status, `launching ${labId}`).toBe(200);
  const url = new URL(res.body.instance.baseUrl);
  return new LabSession(learner, res.body.instance.id, res.body.instance.baseUrl, Number(url.port), labId);
}

/** Form login to a lab target, like a browser submitting the login page. */
export async function formLogin(target: CookieClient, username: string, password: string): Promise<Response> {
  return target.fetch("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
  });
}

export function jsonPost<T = any>(target: CookieClient, path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) {
  return target.json<T>(path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

/**
 * Asserts the lab's solve was recorded, awarded exactly the difficulty's XP once,
 * and that repeating the exploit does not award it again.
 */
export async function expectSolvedOnce(lab: LabSession, difficulty: Difficulty, repeat: () => Promise<unknown>, xpBefore: number): Promise<void> {
  expect(await lab.solved()).toBe(true);
  expect(await lab.xp()).toBe(xpBefore + XP_BY_DIFFICULTY[difficulty]);
  await repeat();
  expect(await lab.xp()).toBe(xpBefore + XP_BY_DIFFICULTY[difficulty]);
}
