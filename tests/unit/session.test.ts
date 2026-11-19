import { describe, expect, it } from "vitest";
import { signSession, verifySession, parseCookies } from "../../packages/lab-sdk/src/session.js";

describe("signSession / verifySession", () => {
  it("round-trips a payload with the correct secret", () => {
    const token = signSession("secret-a", { user: "alice", role: "customer" });
    const result = verifySession<{ user: string; role: string }>("secret-a", token);
    expect(result).toEqual({ user: "alice", role: "customer" });
  });

  it("rejects a token signed with a different secret (no cross-instance forgery)", () => {
    const token = signSession("secret-a", { user: "alice" });
    const result = verifySession("secret-b", token);
    expect(result).toBeNull();
  });

  it("rejects a tampered payload even with a structurally valid signature format", () => {
    const token = signSession("secret-a", { user: "alice", role: "customer" });
    const [, sig] = token.split(".");
    const tamperedBody = Buffer.from(JSON.stringify({ user: "alice", role: "admin" })).toString("base64url");
    const tampered = `${tamperedBody}.${sig}`;
    expect(verifySession("secret-a", tampered)).toBeNull();
  });

  it("returns null for missing or malformed tokens", () => {
    expect(verifySession("secret-a", undefined)).toBeNull();
    expect(verifySession("secret-a", "")).toBeNull();
    expect(verifySession("secret-a", "not-a-valid-token")).toBeNull();
  });
});

describe("parseCookies", () => {
  it("parses a standard Cookie header into key/value pairs", () => {
    expect(parseCookies("a=1; b=2; c=hello%20world")).toEqual({ a: "1", b: "2", c: "hello world" });
  });

  it("returns an empty object for an undefined header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });
});
