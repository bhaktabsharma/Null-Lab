import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, CookieClient, type TestApp } from "./helpers.js";

const post = (client: CookieClient, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  client.json(path, {
    method: "POST",
    // Only declare a JSON body when there is one (Fastify rejects an empty JSON body).
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("CSRF / Origin guard on state-changing control-plane routes", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4123, labPortStart: 6650, labPortEnd: 6655 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  const LAB_ORIGIN = "http://127.0.0.1:5100"; // a page served by a lab target (runs attacker-controlled JS by design)

  it("rejects a state-changing request whose Origin is a lab target", async () => {
    const c = new CookieClient(t.baseUrl);
    expect((await post(c, "/api/auth/guest", { origin: LAB_ORIGIN })).status).toBe(403);
  });

  it('rejects "Origin: null" (sandboxed iframes, cross-origin redirects)', async () => {
    const c = new CookieClient(t.baseUrl);
    expect((await post(c, "/api/auth/guest", { origin: "null" })).status).toBe(403);
  });

  it("rejects a request a browser flags as cross-site even if Origin is absent", async () => {
    const c = new CookieClient(t.baseUrl);
    expect((await post(c, "/api/auth/guest", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(c, "/api/auth/guest", { "sec-fetch-site": "same-site" })).status).toBe(403);
  });

  it("allows the configured web origin (either loopback spelling) and the control plane's own origin", async () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4123", "http://127.0.0.1:4123"]) {
      const c = new CookieClient(t.baseUrl);
      expect((await post(c, "/api/auth/guest", { origin })).status, origin).toBe(200);
    }
  });

  it("allows non-browser clients (curl / Burp Repeater send no Origin) and same-origin fetches", async () => {
    const c = new CookieClient(t.baseUrl);
    expect((await post(c, "/api/auth/guest")).status).toBe(200);
    expect((await post(new CookieClient(t.baseUrl), "/api/auth/guest", { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("does not interfere with safe methods", async () => {
    const c = new CookieClient(t.baseUrl);
    const res = await c.fetch("/api/labs", { headers: { origin: LAB_ORIGIN } });
    expect(res.status).not.toBe(403);
  });

  it("a lab-origin page cannot launch, stop, or reset instances with a logged-in learner's cookie", async () => {
    const victim = new CookieClient(t.baseUrl);
    await post(victim, "/api/auth/guest"); // legitimate login: cookie now in the jar
    const launched = await post(victim, "/api/labs/idor-invoice-leak/instances");
    expect(launched.status).toBe(200);
    const id = (launched.body as { instance: { id: string } }).instance.id;

    // The "attack": same cookie jar, but the request carries the lab page's Origin.
    expect((await post(victim, `/api/instances/${id}/stop`, { origin: LAB_ORIGIN })).status).toBe(403);
    expect((await post(victim, `/api/instances/${id}/reset`, { origin: LAB_ORIGIN })).status).toBe(403);
    expect((await post(victim, "/api/labs/sqli-product-search/instances", { origin: LAB_ORIGIN })).status).toBe(403);

    // Instance is untouched.
    const still = await victim.json<{ instance: { status: string } }>(`/api/instances/${id}`);
    expect(still.body.instance.status).toBe("running");
    await post(victim, `/api/instances/${id}/stop`); // legit stop
  });

  it("leaves the internal solve route alone (token-authenticated, called by lab processes, no Origin)", async () => {
    const res = await fetch(`${t.baseUrl}/internal/instances/nope/solve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-instance-token": "wrong" },
      body: JSON.stringify({ evidence: "x" }),
    });
    expect(res.status).toBe(403); // rejected by the token check, not by the Origin guard
    expect(((await res.json()) as { error: string }).error).toBe("invalid instance token");
  });
});
