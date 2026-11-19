import net from "node:net";

export interface ForwarderOptions {
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  /** Hard cap on simultaneous client connections (resource bound). */
  maxConnections?: number;
  /** Idle timeout per connection, in ms. */
  idleTimeoutMs?: number;
}

/**
 * A minimal TCP relay. In Docker mode lab containers sit on an `--internal`
 * network (no route out, and Docker cannot publish ports from such a
 * network), so the control plane — which is attached to that network —
 * listens on the lab's public port and relays bytes to the lab container by
 * name. It is a dumb byte pipe: it never parses, logs, or modifies HTTP, so
 * Burp Suite, curl and browsers all see the lab's real responses.
 */
export class TcpForwarder {
  private readonly server = net.createServer();
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly opts: ForwarderOptions) {
    this.server.on("connection", (client) => this.onConnection(client));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.listenPort, this.opts.listenHost, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(client: net.Socket): void {
    const max = this.opts.maxConnections ?? 64;
    if (this.sockets.size >= max) {
      client.destroy();
      return;
    }
    const upstream = net.connect({ host: this.opts.targetHost, port: this.opts.targetPort });
    this.sockets.add(client);
    this.sockets.add(upstream);

    const idle = this.opts.idleTimeoutMs ?? 120_000;
    client.setTimeout(idle);
    upstream.setTimeout(idle);

    const teardown = () => {
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    client.on("error", teardown);
    upstream.on("error", teardown);
    client.on("close", teardown);
    upstream.on("close", teardown);
    client.on("timeout", teardown);
    upstream.on("timeout", teardown);

    client.pipe(upstream);
    upstream.pipe(client);
  }
}
