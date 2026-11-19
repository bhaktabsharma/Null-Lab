import type { LabContext } from "./context.js";

/**
 * Called from INSIDE a lab target's real request handler, at the exact
 * point where the server has honestly determined that the security
 * invariant for this lab was violated (e.g. a record owned by user B was
 * returned to a session authenticated as user A). This is never a
 * client-supplied flag — the evidence string should describe the concrete
 * server-side fact that was observed.
 *
 * The orchestrator independently re-validates the instance token server
 * side and is idempotent: calling this twice for an already-solved
 * instance does not award XP twice, but each call is still logged.
 */
export async function reportSolve(
  ctx: LabContext,
  evidence: string,
): Promise<{ accepted: boolean; firstSolve: boolean; xpAwarded?: number }> {
  // Never let a verifier/orchestrator outage — or any network error —
  // throw into the vulnerable handler's response path. The whole call is
  // wrapped: a failure here must change nothing about what the target
  // returns to the client that triggered it.
  try {
    const res = await fetch(`${ctx.orchestratorInternalUrl}/internal/instances/${ctx.instanceId}/solve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-instance-token": ctx.instanceToken,
      },
      body: JSON.stringify({ evidence }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[lab-sdk] reportSolve rejected: ${res.status} ${await res.text().catch(() => "")}`);
      return { accepted: false, firstSolve: false };
    }
    return (await res.json()) as { accepted: boolean; firstSolve: boolean; xpAwarded?: number };
  } catch (err) {
    console.error(`[lab-sdk] reportSolve network error: ${(err as Error).message}`);
    return { accepted: false, firstSolve: false };
  }
}

/** Non-solve lifecycle/audit events (e.g. a negative-test probe was seen). */
export async function reportEvent(
  ctx: LabContext,
  eventType: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${ctx.orchestratorInternalUrl}/internal/instances/${ctx.instanceId}/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-instance-token": ctx.instanceToken,
      },
      body: JSON.stringify({ eventType, detail: detail ?? {} }),
    });
  } catch {
    // best-effort
  }
}
