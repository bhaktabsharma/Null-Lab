/**
 * MockInternalNet — a fully SIMULATED internal network for SSRF labs.
 *
 * SAFETY: this module never opens a real socket and never performs real DNS
 * resolution. It parses URLs with the standard WHATWG `URL` class (which
 * does no I/O — it only canonicalizes strings) and looks the result up in an
 * in-memory table the lab itself defines. A host that isn't in the table
 * gets a simulated "connection refused" after a short synthetic delay —
 * there is no code path anywhere in this module that can reach the real
 * internet, cloud metadata, or the host machine, regardless of what a
 * learner's input says or how the LAB's own (deliberately flawed)
 * validation logic is bypassed. This matters because NULLLAB's default
 * "process" runtime has no network sandbox (see docs/architecture.md) — a
 * real outbound fetch here would be a vulnerability in the platform itself,
 * not just in the lab.
 *
 * Each lab defines its own small set of simulated internal services
 * (`registerService`) representing the kind of thing SSRF normally reaches:
 * an admin panel on a private IP, a cloud-metadata-style endpoint, an
 * internal API with no auth of its own. The canonical host NULLLAB uses for
 * "cloud metadata" examples is the documented, non-routable
 * `169.254.169.254` test address — the service behind it here is entirely
 * fictional and returns synthetic data.
 */

export interface MockResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface MockRedirect {
  redirectTo: string;
}

type ServiceHandler = (path: string) => MockResponse | MockRedirect;

interface ServiceKey {
  host: string; // exact hostname as URL.hostname would report it (already IP/case-normalized by URL)
  port: number;
}

export class MockInternalNet {
  private readonly services = new Map<string, ServiceHandler>();

  private key(host: string, port: number): string {
    return `${host.toLowerCase()}:${port}`;
  }

  /** Registers a simulated service. `handler` receives the request path and returns a canned response or redirect. */
  registerService(key: ServiceKey, handler: ServiceHandler): void {
    this.services.set(this.key(key.host, key.port), handler);
  }

  /** A fixed canned response for simple cases. */
  registerStatic(key: ServiceKey, body: string, opts: { status?: number; contentType?: string } = {}): void {
    this.registerService(key, () => ({ status: opts.status ?? 200, contentType: opts.contentType ?? "application/json", body }));
  }

  private defaultPort(protocol: string): number {
    return protocol === "https:" ? 443 : 80;
  }

  /**
   * Simulates ONE HTTP request. Never performs real I/O. `rawUrl` is parsed
   * with `new URL()` only — the same canonicalization a real HTTP client's
   * URL handling would apply (decimal/hex/octal IPv4 forms, userinfo vs
   * host, etc.), which is exactly what makes the host-validation-bypass labs
   * faithful without needing any real network access.
   */
  async fetch(rawUrl: string): Promise<{ ok: true; status: number; contentType: string; body: string; resolvedHost: string; resolvedPort: number } | { ok: false; error: string; resolvedHost?: string }> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, error: "invalid URL" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: `unsupported scheme "${url.protocol}"` };
    }
    const port = url.port ? Number(url.port) : this.defaultPort(url.protocol);
    const handler = this.services.get(this.key(url.hostname, port));
    // A tiny synthetic delay so "the request took time" feels real, with no actual network wait.
    await new Promise((r) => setTimeout(r, 15));
    if (!handler) {
      return { ok: false, error: `connection refused (simulated — ${url.hostname}:${port} is not a provisioned service in this lab)`, resolvedHost: url.hostname };
    }
    const result = handler(url.pathname + url.search);
    if ("redirectTo" in result) {
      return { ok: false, error: "redirect", resolvedHost: url.hostname };
    }
    return { ok: true, status: result.status, contentType: result.contentType, body: result.body, resolvedHost: url.hostname, resolvedPort: port };
  }

  /** Like fetch(), but follows at most `maxRedirects` simulated redirects — for labs about redirect-following mistakes. */
  async fetchFollowingRedirects(rawUrl: string, maxRedirects = 3): Promise<{ ok: true; status: number; contentType: string; body: string; finalHost: string; hops: string[] } | { ok: false; error: string; hops: string[] }> {
    let current = rawUrl;
    const hops: string[] = [];
    for (let i = 0; i <= maxRedirects; i++) {
      let url: URL;
      try {
        url = new URL(current);
      } catch {
        return { ok: false, error: "invalid URL", hops };
      }
      hops.push(url.hostname);
      if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: `unsupported scheme "${url.protocol}"`, hops };
      const port = url.port ? Number(url.port) : this.defaultPort(url.protocol);
      const handler = this.services.get(this.key(url.hostname, port));
      await new Promise((r) => setTimeout(r, 15));
      if (!handler) return { ok: false, error: `connection refused (simulated — ${url.hostname}:${port} is not provisioned)`, hops };
      const result = handler(url.pathname + url.search);
      if ("redirectTo" in result) {
        current = result.redirectTo;
        continue;
      }
      return { ok: true, status: result.status, contentType: result.contentType, body: result.body, finalHost: url.hostname, hops };
    }
    return { ok: false, error: "too many redirects", hops };
  }
}
