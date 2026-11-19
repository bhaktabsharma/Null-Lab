import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LabProxy } from "./proxy.js";

/**
 * Tests for the proxy harness itself (tests/integration/proxy.ts). If the
 * harness silently mangled requests, "passes through the proxy" would mean
 * nothing — so these pin down what it must preserve, and what it must refuse.
 * Uses its own LabProxy and a throwaway origin server; no labs are involved.
 */

interface Echo {
  method: string;
  url: string;
  host: string | undefined;
  headers: http.IncomingHttpHeaders;
  bodyBase64: string;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("local forward-proxy harness", () => {
  let proxy: LabProxy;
  let origin: http.Server;
  let originPort: number;
  const base = () => `http://127.0.0.1:${originPort}`;

  beforeAll(async () => {
    proxy = new LabProxy();
    await proxy.start();
    origin = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        switch (req.url!.split("?")[0]) {
          case "/echo": {
            const echo: Echo = { method: req.method!, url: req.url!, host: req.headers.host, headers: req.headers, bodyBase64: body.toString("base64") };
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(echo));
            return;
          }
          case "/cookies":
            res.writeHead(200, { "set-cookie": ["a=1; Path=/; HttpOnly", "b=2; Path=/; SameSite=Lax"], "content-type": "text/plain" }).end("cookies set");
            return;
          case "/redirect":
            res.writeHead(302, { location: "/landing" }).end();
            return;
          case "/landing":
            res.writeHead(200).end("landed");
            return;
          case "/post-then-redirect":
            res.writeHead(req.url!.includes("code=307") ? 307 : req.url!.includes("code=303") ? 303 : 302, { location: "/echo?after=redirect" }).end();
            return;
          case "/loop":
            res.writeHead(302, { location: "/loop" }).end();
            return;
          case "/leave":
            res.writeHead(302, { location: "http://example.com/elsewhere" }).end();
            return;
          case "/nocontent":
            res.writeHead(204).end();
            return;
          case "/notmodified":
            res.writeHead(304).end();
            return;
          case "/big":
            res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.alloc(1_000_000, 0x61));
            return;
          default:
            res.writeHead(404).end("nope");
        }
      });
    });
    originPort = await listen(origin);
    proxy.registerLab(originPort, "__harness-origin__");
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  });

  // -- fidelity -------------------------------------------------------------

  it("sends proxy-form requests but the origin sees an ordinary origin-form request", async () => {
    const r = await proxy.fetch(`${base()}/echo?x=1&x=2`);
    const echo = (await r.json()) as Echo;
    expect(r.status).toBe(200);
    expect(echo.url).toBe("/echo?x=1&x=2"); // not the absolute URI
    expect(echo.host).toBe(`127.0.0.1:${originPort}`);
    expect(echo.headers["proxy-connection"]).toBeUndefined();
  });

  it("preserves a Host header chosen by the client (what forged-Host / Host-injection tests need)", async () => {
    const r = await proxy.fetch(`${base()}/echo`, { headers: { host: "attacker.example" } });
    expect(((await r.json()) as Echo).host).toBe("attacker.example");
  });

  it("drops hop-by-hop proxy headers a client may send", async () => {
    const res = await new Promise<Echo>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxy.port, path: `${base()}/echo`, headers: { host: `127.0.0.1:${originPort}`, "proxy-connection": "keep-alive", "proxy-authorization": "Basic Zm9vOmJhcg==" }, agent: false },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.headers["proxy-connection"]).toBeUndefined();
    expect(res.headers["proxy-authorization"]).toBeUndefined();
  });

  it("keeps multiple Set-Cookie headers separate", async () => {
    const r = await proxy.fetch(`${base()}/cookies`);
    const cookies = r.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("a=1");
    expect(cookies[1]).toContain("b=2");
  });

  it("does not follow redirects and keeps Location intact", async () => {
    const r = await proxy.fetch(`${base()}/redirect`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/landing");
  });

  it("relays JSON, urlencoded and multipart bodies byte-for-byte", async () => {
    const json = await (await proxy.fetch(`${base()}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: [1, 2], b: "é✓" }) })).json() as Echo;
    expect(json.method).toBe("POST");
    expect(JSON.parse(Buffer.from(json.bodyBase64, "base64").toString())).toEqual({ a: [1, 2], b: "é✓" });

    const form = await (await proxy.fetch(`${base()}/echo`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ q: "a b&c", n: "1" }).toString() })).json() as Echo;
    expect(Buffer.from(form.bodyBase64, "base64").toString()).toBe("q=a+b%26c&n=1");

    const fd = new FormData();
    fd.set("note", "hello");
    fd.set("file", new Blob(["<svg>payload</svg>"], { type: "image/svg+xml" }), "pic.svg");
    const multi = await (await proxy.fetch(`${base()}/echo`, { method: "POST", body: fd })).json() as Echo;
    expect(multi.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const raw = Buffer.from(multi.bodyBase64, "base64").toString();
    expect(raw).toContain('name="note"');
    expect(raw).toContain('filename="pic.svg"');
    expect(raw).toContain("<svg>payload</svg>");
  });

  it("handles HEAD, 204 and 304 without a body, and a 1 MB response intact", async () => {
    expect((await proxy.fetch(`${base()}/echo`, { method: "HEAD" })).status).toBe(200);
    const nc = await proxy.fetch(`${base()}/nocontent`);
    expect(nc.status).toBe(204);
    expect(await nc.text()).toBe("");
    expect((await proxy.fetch(`${base()}/notmodified`)).status).toBe(304);
    const big = await proxy.fetch(`${base()}/big`);
    expect((await big.arrayBuffer()).byteLength).toBe(1_000_000);
  });

  it("passes upstream errors through unchanged (404) and reports a dead lab as 502", async () => {
    expect((await proxy.fetch(`${base()}/missing`)).status).toBe(404);

    const tmp = http.createServer();
    const deadPort = await listen(tmp);
    await new Promise<void>((resolve) => tmp.close(() => resolve())); // now nothing listens there
    proxy.registerLab(deadPort, "__harness-dead__");
    const r = await proxy.fetch(`http://127.0.0.1:${deadPort}/`);
    expect(r.status).toBe(502);
  });

  // -- isolation: it must not be an open proxy -------------------------------

  it("refuses ports that were never registered as labs (403) and records the attempt", async () => {
    const stray = http.createServer((_req, res) => res.end("should never be reached"));
    const strayPort = await listen(stray);
    try {
      const before = proxy.log.filter((e) => e.kind === "blocked").length;
      const r = await proxy.fetch(`http://127.0.0.1:${strayPort}/`);
      expect(r.status).toBe(403);
      expect(await r.text()).not.toContain("should never be reached");
      expect(proxy.log.filter((e) => e.kind === "blocked").length).toBe(before + 1);
    } finally {
      await new Promise<void>((resolve) => stray.close(() => resolve()));
    }
  });

  it("refuses non-loopback hosts without resolving or contacting them", async () => {
    const r = await proxy.fetch("http://example.com:80/");
    expect(r.status).toBe(403);
    const r2 = await proxy.fetch("http://169.254.169.254/latest/meta-data/");
    expect(r2.status).toBe(403);
  });

  it("rejects a non-absolute request target with 400 (it is a forward proxy, not a web server)", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxy.port, path: "/echo", agent: false }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  it("only treats registered loopback labs as proxyable", () => {
    expect(proxy.handles(`http://127.0.0.1:${originPort}/x`)).toBe(true);
    expect(proxy.handles(`http://localhost:${originPort}/x`)).toBe(true);
    expect(proxy.handles(`http://127.0.0.1:${originPort + 1}/x`)).toBe(false);
    expect(proxy.handles("http://example.com/")).toBe(false);
    expect(proxy.handles("https://127.0.0.1/")).toBe(false);
  });

  // -- CONNECT / WebSocket ---------------------------------------------------

  it("refuses CONNECT to an unregistered port", async () => {
    await expect(proxy.tunnel("127.0.0.1", originPort + 7)).rejects.toThrow(/403/);
  });

  it("tunnels a raw HTTP request over CONNECT to a registered lab", async () => {
    const sock = await proxy.tunnel("127.0.0.1", originPort);
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      sock.on("data", (c: Buffer) => chunks.push(c));
      sock.on("end", () => resolve(Buffer.concat(chunks).toString()));
      sock.on("error", reject);
      sock.write(`GET /landing HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`);
    });
    expect(text).toContain("200 OK");
    expect(text).toContain("landed");
  });

  it("carries a WebSocket handshake and frames through a CONNECT tunnel and records the tunnel", async () => {
    const { WebSocketServer, WebSocket } = await import("ws");
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    const wsPort = (wss.address() as AddressInfo).port;
    wss.on("connection", (s) => s.on("message", (m) => s.send(`echo:${m.toString()}`)));
    proxy.registerLab(wsPort, "__harness-ws__");

    const sock: net.Socket = await proxy.tunnel("127.0.0.1", wsPort);
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/`, { createConnection: () => sock });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("hi"));
      ws.on("message", (m: Buffer) => resolve(m.toString()));
      ws.on("error", reject);
    });
    expect(reply).toBe("echo:hi");
    ws.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    // The tunnel entry is written when the connection closes.
    for (let i = 0; i < 40 && !proxy.log.some((e) => e.kind === "connect" && e.port === wsPort); i++) await new Promise((r) => setTimeout(r, 50));
    const entry = proxy.log.find((e) => e.kind === "connect" && e.port === wsPort);
    expect(entry, "tunnel was not recorded").toBeTruthy();
    expect(entry!.reqBytes).toBeGreaterThan(0);
    expect(entry!.resBytes).toBeGreaterThan(0);
  });

  // -- recorder --------------------------------------------------------------

  it("attributes traffic to the registered lab and summarises it (and excludes blocked traffic)", async () => {
    const p = new LabProxy();
    await p.start();
    try {
      p.registerLab(originPort, "demo-lab");
      await p.fetch(`${base()}/echo`);
      await p.fetch(`${base()}/echo`, { method: "POST", body: "x" });
      await p.fetch("http://example.com/"); // blocked, must not count
      let s = p.summary()["demo-lab"]!;
      expect(s.requests).toBe(2);
      expect(s.nonGetRequests).toBe(1);
      expect(s.statuses).toEqual({ "200": 2 });
      expect(s.solved).toBe(false);
      p.markSolved("demo-lab");
      s = p.summary()["demo-lab"]!;
      expect(s.solved).toBe(true);
      expect(p.log.filter((e) => e.kind === "blocked")).toHaveLength(1);
    } finally {
      await p.stop();
    }
  });

  it("discovers labs through a resolver (used to cover tests that launch via the API directly) and stops once the lab is gone", async () => {
    const p = new LabProxy();
    await p.start();
    try {
      let live: string | undefined = "resolved-lab";
      p.addResolver((port) => (port === originPort ? live : undefined));
      expect(p.handles(`${base()}/`)).toBe(true);
      expect((await p.fetch(`${base()}/echo`)).status).toBe(200);
      expect(p.summary()["resolved-lab"]!.requests).toBe(1);
      live = undefined; // instance stopped
      expect(p.handles(`${base()}/`)).toBe(false);
      expect((await p.fetch(`${base()}/echo`)).status).toBe(403);
      // a throwing resolver (e.g. closed DB) must not crash the proxy
      p.addResolver(() => {
        throw new Error("db closed");
      });
      expect(p.handles(`${base()}/`)).toBe(false);
    } finally {
      await p.stop();
    }
  });

  it("fetchLikeFetch follows redirects like fetch(): 302 to a lab page, Response.url updated", async () => {
    const r = await proxy.fetchLikeFetch(`${base()}/redirect`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("landed");
    expect(r.url).toBe(`${base()}/landing`);
  });

  it("fetchLikeFetch rewrites POST to GET (no body) on 302/303 but keeps POST + body on 307", async () => {
    for (const code of ["302", "303"]) {
      const r = await proxy.fetchLikeFetch(`${base()}/post-then-redirect?code=${code}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
      const echo = (await r.json()) as Echo;
      expect(echo.method, `after ${code}`).toBe("GET");
      expect(echo.bodyBase64).toBe("");
    }
    const r307 = await proxy.fetchLikeFetch(`${base()}/post-then-redirect?code=307`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    const e307 = (await r307.json()) as Echo;
    expect(e307.method).toBe("POST");
    expect(Buffer.from(e307.bodyBase64, "base64").toString()).toBe('{"a":1}');
  });

  it("fetchLikeFetch honours redirect:'manual', stops at a redirect that leaves the lab, and bails out of loops", async () => {
    expect((await proxy.fetchLikeFetch(`${base()}/redirect`, { redirect: "manual" })).status).toBe(302);
    const leave = await proxy.fetchLikeFetch(`${base()}/leave`);
    expect(leave.status).toBe(302);
    expect(leave.headers.get("location")).toBe("http://example.com/elsewhere");
    await expect(proxy.fetchLikeFetch(`${base()}/loop`)).rejects.toThrow(/too many redirects/);
  });

  it("keeps per-lab counts correct when a lab port is recycled by a later lab (regression: summary used the live port map)", async () => {
    const p = new LabProxy();
    await p.start();
    try {
      p.registerLab(originPort, "first-lab");
      await p.fetch(`${base()}/echo`);
      p.registerLab(originPort, "second-lab"); // same port, new lab — as after stop + relaunch
      await p.fetch(`${base()}/echo`);
      await p.fetch(`${base()}/echo`);
      const sum = p.summary();
      expect(sum["first-lab"]!.requests).toBe(1);
      expect(sum["second-lab"]!.requests).toBe(2);
    } finally {
      await p.stop();
    }
  });
});
