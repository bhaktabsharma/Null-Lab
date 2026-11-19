import net from "node:net";

export class PortAllocator {
  private inUse = new Set<number>();

  constructor(
    private readonly start: number,
    private readonly end: number,
  ) {
    if (start >= end) throw new Error("LAB_PORT_RANGE_START must be less than LAB_PORT_RANGE_END");
  }

  markUsed(port: number): void {
    this.inUse.add(port);
  }

  release(port: number): void {
    this.inUse.delete(port);
  }

  async allocate(): Promise<number> {
    for (let port = this.start; port <= this.end; port++) {
      if (this.inUse.has(port)) continue;
      if (await isPortFree(port)) {
        this.inUse.add(port);
        return port;
      }
    }
    throw new Error(`[ports] no free port available in range ${this.start}-${this.end}`);
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, "127.0.0.1");
  });
}
