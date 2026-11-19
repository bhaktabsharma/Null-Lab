import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { AddressInfo } from "node:net";

/**
 * A small intercepting-style forward proxy for tests.
 *
 * Why this exists: NULLLAB is meant to be attacked from Burp Suite (or curl -x,
 * or a browser pointed at an intercepting proxy). Plain Node `fetch` against
 * the lab port proves the lab works over HTTP, but says nothing about how it
 * behaves when every request is rewritten into proxy form: absolute-URI
 * request lines, a client-chosen Host header, multiple Set-Cookie headers,
 * un-followed redirects, multipart bodies, CONNECT tunnels for WebSocket.
 *
 * With NULLLAB_TEST_PROXY=1 the integration suite sends ALL lab traffic (the
 * traffic a learner would send from Burp) through this proxy, so the existing
 * exploit tests double as proxy tests, and the proxy records which labs were
 * exercised and solved that way.
 *
 * What this is NOT: Burp Suite. It is a generic HTTP/1.1 forward proxy that
 * behaves like Burp's plain-HTTP proxy listener. A lab it passes is
 * "proxy-compatible", not "verified in Burp" — the docs use that wording.
 *
 * Safety: this is not an open proxy. It only forwards to loopback hosts and
 * only to ports that a test has registered as a launched lab; anything else
 * gets a 403 (tests below prove it).
 */

export interface ProxyEntry {
  ts: number;
  kind: "http" | "connect" | "blocked";
  method: string;
  host: string;
  port: number;
  path: string;
  status: number;
  labId?: string;
  reqBytes: number;
  resBytes: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
/** Hop-by-hop / proxy-only headers a proxy must not forward. */
const DROP_HEADERS = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive"]);

function filterRawHeaders(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (DROP_HEADERS.has(raw[i]!.toLowerCase())) continue;
    out.push(raw[i]!, raw[i + 1]!);
  }
  return out;
}

export class LabProxy {
  readonly log: ProxyEntry[] = [];
  port = 0;
  private readonly server: http.Server;
  private readonly labPorts = new Map<number, string>();
  private readonly resolvers = new Set<(port: number) => string | undefined>();
  private readonly solvedLabs = new Set<string>();
  private readonly sockets = new Set<net.Socket>();

  constructor() {
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on("connect", (req, socket, head) => this.onConnect(req, socket as net.Socket, head));
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Allow the proxy to forward to this loopback port; `labId` attributes traffic. */
  registerLab(port: number, labId: string): void {
    this.labPorts.set(port, labId);
  }

  /**
   * Lets the proxy discover running labs on its own (e.g. from the control
   * plane's instance table), so tests that launch labs through the API directly
   * are proxied too. Returns a function that removes the resolver.
   */
  addResolver(fn: (port: number) => string | undefined): () => void {
    this.resolvers.add(fn);
    return () => this.resolvers.delete(fn);
  }

  /** The lab currently served on this loopback port, if the proxy knows one. */
  labFor(port: number): string | undefined {
    const explicit = this.labPorts.get(port);
    if (explicit) return explicit;
    for (const r of this.resolvers) {
      try {
        const id = r(port);
        if (id) return id;
      } catch {
        // a resolver backed by a closed database must not break forwarding
      }
    }
    return undefined;
  }

  markSolved(labId: string): void {
    this.solvedLabs.add(labId);
  }

  /** True when `url` targets a registered lab on loopback, i.e. should be sent through the proxy. */
  handles(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && this.labFor(Number(u.port)) !== undefined;
    } catch {
      return false;
    }
  }

  private allowed(host: string, port: number): boolean {
    return LOOPBACK_HOSTS.has(host) && this.labFor(port) !== undefined;
  }

  private record(e: Omit<ProxyEntry, "ts" | "labId">): void {
    this.log.push({ ts: Date.now(), labId: this.labFor(e.port), ...e });
  }

  private onRequest(creq: http.IncomingMessage, cres: http.ServerResponse): void {
    let target: URL;
    try {
      target = new URL(creq.url ?? "");
    } catch {
      cres.writeHead(400, { "content-type": "text/plain" }).end("proxy: expected an absolute-form request target\n");
      return;
    }
    const port = Number(target.port || 80);
    const method = creq.method ?? "GET";
    const pathAndQuery = target.pathname + target.search;
    if (target.protocol !== "http:" || !this.allowed(target.hostname, port)) {
      this.record({ kind: "blocked", method, host: target.hostname, port, path: pathAndQuery, status: 403, reqBytes: 0, resBytes: 0 });
      cres.writeHead(403, { "content-type": "text/plain" }).end("proxy: target not allowed (loopback lab ports only)\n");
      return;
    }

    let reqBytes = 0;
    let resBytes = 0;
    const upstream = http.request(
      { host: target.hostname, port, method, path: pathAndQuery, headers: filterRawHeaders(creq.rawHeaders) as any, agent: false },
      (ures) => {
        cres.writeHead(ures.statusCode ?? 502, ures.statusMessage, filterRawHeaders(ures.rawHeaders) as any);
        ures.on("data", (c: Buffer) => (resBytes += c.length));
        ures.on("end", () => {
          this.record({ kind: "http", method, host: target.hostname, port, path: pathAndQuery, status: ures.statusCode ?? 0, reqBytes, resBytes });
        });
        ures.pipe(cres);
      },
    );
    upstream.on("error", () => {
      this.record({ kind: "http", method, host: target.hostname, port, path: pathAndQuery, status: 502, reqBytes, resBytes });
      if (!cres.headersSent) cres.writeHead(502, { "content-type": "text/plain" });
      cres.end("proxy: upstream connection failed\n");
    });
    creq.on("data", (c: Buffer) => (reqBytes += c.length));
    creq.pipe(upstream);
  }

  /** CONNECT host:port — what a browser/Burp does for WebSocket (RFC 6455 §4.1) and TLS. */
  private onConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    const [host = "", portStr = "0"] = (req.url ?? "").split(":");
    const port = Number(portStr);
    if (!this.allowed(host, port)) {
      this.record({ kind: "blocked", method: "CONNECT", host, port, path: "", status: 403, reqBytes: 0, resBytes: 0 });
      clientSocket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    let reqBytes = 0;
    let resBytes = 0;
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      clientSocket.on("data", (c: Buffer) => (reqBytes += c.length));
      upstream.on("data", (c: Buffer) => (resBytes += c.length));
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    const done = () => {
      this.record({ kind: "connect", method: "CONNECT", host, port, path: "", status: 200, reqBytes, resBytes });
    };
    upstream.on("close", () => {
      done();
      clientSocket.destroy();
    });
    upstream.on("error", () => {
      if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
    });
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", () => upstream.destroy());
  }

  /**
   * fetch()-compatible request that goes through this proxy in proxy form
   * (absolute-URI request line), the way `curl -x` or Burp's listener sees it.
   * Unlike Node's fetch, a Host header set by the caller is preserved —
   * which is how forged-Host (Host-header injection) tests work through Burp.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const req = new Request(url, init); // normalises method/body/default content-type like fetch does
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
    const target = new URL(url);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => (headers[key] = value));
    if (!("host" in headers)) headers.host = target.host;
    if (body && !("content-length" in headers)) headers["content-length"] = String(body.length);

    return new Promise<Response>((resolve, reject) => {
      const preq = http.request({ host: "127.0.0.1", port: this.port, method: req.method, path: url, headers, agent: false }, (pres) => {
        const chunks: Buffer[] = [];
        pres.on("data", (c: Buffer) => chunks.push(c));
        pres.on("end", () => {
          const out = new Headers();
          for (let i = 0; i < pres.rawHeaders.length; i += 2) out.append(pres.rawHeaders[i]!, pres.rawHeaders[i + 1]!);
          const status = pres.statusCode ?? 502;
          const noBody = [101, 204, 205, 304].includes(status) || req.method === "HEAD";
          resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, statusText: pres.statusMessage ?? "", headers: out }));
        });
      });
      preq.on("error", reject);
      if (body) preq.end(body);
      else preq.end();
    });
  }

  /**
   * Drop-in for the global fetch() when the target is a lab: same default
   * redirect-following (301/302/303/307/308, with the standard method rewrite),
   * `redirect: "manual"` honoured, and `Response.url` set — but every hop goes
   * through the proxy. Used to route the older tests' bare `fetch(...)` calls.
   */
  async fetchLikeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    let url = input instanceof Request ? input.url : String(input);
    let method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: RequestInit["body"] = init.body;
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const manual = init.redirect === "manual";
    for (let hop = 0; hop < 20; hop++) {
      const res = await this.fetch(url, { ...init, method, body, headers, redirect: "manual" });
      const location = res.headers.get("location");
      const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
      if (manual || !isRedirect || !location) {
        Object.defineProperty(res, "url", { value: url });
        return res;
      }
      const next = new URL(location, url).href;
      if (!this.handles(next)) {
        Object.defineProperty(res, "url", { value: url });
        return res; // leaves the lab (e.g. an open-redirect lab pointing elsewhere): do not follow
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      url = next;
    }
    throw new TypeError("fetch failed: too many redirects through the proxy");
  }

  /** Opens a CONNECT tunnel to a registered lab port and resolves with the raw, already-tunnelled socket. */
  tunnel(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const creq = http.request({ host: "127.0.0.1", port: this.port, method: "CONNECT", path: `${host}:${port}`, agent: false });
      creq.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`proxy refused CONNECT ${host}:${port}: ${res.statusCode}`));
          return;
        }
        resolve(socket);
      });
      creq.on("error", reject);
      creq.end();
    });
  }

  /**
   * Per-lab summary of what went through the proxy (labs only; blocked traffic
   * excluded). Built from the recorded entries, not from the live port map:
   * lab ports are recycled between launches, so a port can map to a different
   * lab by the time the summary is read.
   */
  summary(): Record<string, { requests: number; nonGetRequests: number; tunnels: number; solved: boolean; statuses: Record<string, number> }> {
    type Row = { requests: number; nonGetRequests: number; tunnels: number; solved: boolean; statuses: Record<string, number> };
    const out: Record<string, Row> = {};
    const row = (labId: string): Row => (out[labId] ??= { requests: 0, nonGetRequests: 0, tunnels: 0, solved: this.solvedLabs.has(labId), statuses: {} });
    for (const labId of this.labPorts.values()) row(labId);
    for (const labId of this.solvedLabs) row(labId);
    for (const e of this.log) {
      if (!e.labId || e.kind === "blocked") continue;
      const s = row(e.labId);
      if (e.kind === "connect") s.tunnels++;
      else {
        s.requests++;
        if (e.method !== "GET" && e.method !== "HEAD") s.nonGetRequests++;
        s.statuses[String(e.status)] = (s.statuses[String(e.status)] ?? 0) + 1;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Process-wide switch used by the integration helpers

export function proxyModeEnabled(): boolean {
  return process.env.NULLLAB_TEST_PROXY === "1";
}

let singleton: LabProxy | null = null;

/** The shared proxy for this test file, or null when proxy mode is off. */
export async function getLabProxy(): Promise<LabProxy | null> {
  if (!proxyModeEnabled()) return null;
  if (!singleton) {
    singleton = new LabProxy();
    await singleton.start();
  }
  return singleton;
}

export const PROXY_REPORT_DIR = path.resolve(process.cwd(), "proxy-report");

/** Writes this test file's per-lab proxy summary and shuts the proxy down. */
export async function finishLabProxy(testPath: string): Promise<void> {
  if (!singleton) return;
  const labs = singleton.summary();
  fs.mkdirSync(PROXY_REPORT_DIR, { recursive: true });
  const name = path.basename(testPath).replace(/[^a-zA-Z0-9_.-]/g, "_");
  fs.writeFileSync(
    path.join(PROXY_REPORT_DIR, `${name}.json`),
    JSON.stringify({ file: path.basename(testPath), blocked: singleton.log.filter((e) => e.kind === "blocked").length, labs }, null, 2) + "\n",
  );
  await singleton.stop();
  singleton = null;
}

/**
 * Raw HTTP request with full control of the request line and headers (incl.
 * Host), sent through the proxy in proxy mode and straight to the lab
 * otherwise. Equivalent of Burp Repeater for tests that need a forged Host.
 */
export async function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const proxy = await getLabProxy();
  const viaProxy = !!proxy && proxy.handles(`http://127.0.0.1:${opts.port}/`);
  const headers = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
    headers["content-length"] = String(Buffer.byteLength(opts.body));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: viaProxy ? proxy!.port : opts.port,
        method: opts.method ?? "GET",
        path: viaProxy ? `http://127.0.0.1:${opts.port}${opts.path}` : opts.path,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

/**
 * Options to spread into `new WebSocket(url, { ...opts })` (from `ws`): in
 * proxy mode the connection is a CONNECT tunnel through the proxy (what a
 * browser or Burp does for ws://), otherwise a normal direct connection.
 */
export async function wsConnectOptions(port: number): Promise<{ createConnection?: () => net.Socket }> {
  const proxy = await getLabProxy();
  if (!proxy || !proxy.handles(`http://127.0.0.1:${port}/`)) return {};
  const socket = await proxy.tunnel("127.0.0.1", port);
  return { createConnection: () => socket };
}
