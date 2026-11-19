import { describe, expect, it } from "vitest";
import { PortAllocator } from "../../runtime/orchestrator/src/ports.js";

describe("PortAllocator", () => {
  it("allocates distinct ports within range and never reuses a still-held one", async () => {
    const allocator = new PortAllocator(7100, 7110);
    const a = await allocator.allocate();
    const b = await allocator.allocate();
    const c = await allocator.allocate();
    expect(new Set([a, b, c]).size).toBe(3);
    for (const p of [a, b, c]) expect(p).toBeGreaterThanOrEqual(7100);
    for (const p of [a, b, c]) expect(p).toBeLessThanOrEqual(7110);
  });

  it("releases a port so it can be allocated again", async () => {
    const allocator = new PortAllocator(7200, 7201); // only 2 ports available
    const a = await allocator.allocate();
    const b = await allocator.allocate();
    expect(new Set([a, b]).size).toBe(2);
    await expect(allocator.allocate()).rejects.toThrow(/no free port/i);

    allocator.release(a);
    const c = await allocator.allocate();
    expect(c).toBe(a);
  });

  it("rejects a backwards range at construction", () => {
    expect(() => new PortAllocator(8000, 7000)).toThrow();
  });
});
