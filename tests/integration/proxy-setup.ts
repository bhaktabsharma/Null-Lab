import { afterAll, expect } from "vitest";
import { finishLabProxy, getLabProxy } from "./proxy.js";

/**
 * Setup file for `npm run test:proxy` only (see vitest.proxy.config.ts).
 *
 * 1. Wraps the global fetch so that ANY request to a running lab — including the
 *    older tests' bare `fetch(...)` calls, not just CookieClient — goes through the
 *    local forward proxy. Anything else (the control-plane API, other hosts) is
 *    untouched. Browser-bot traffic (headless Chromium visiting a lab) is not
 *    proxied; it is the "victim" side of an exploit, not learner traffic.
 * 2. After each test file, writes which labs were exercised and solved through the
 *    proxy, then shuts the proxy down.
 */
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const proxy = await getLabProxy();
  return proxy?.handles(url) ? proxy.fetchLikeFetch(input, init) : realFetch(input, init);
}) as typeof fetch;

afterAll(async () => {
  await finishLabProxy(expect.getState().testPath ?? "unknown.test.ts");
});
