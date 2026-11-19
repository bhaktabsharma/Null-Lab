/**
 * QuoteVault — Stock Quotes (GraphQL alias abuse bypasses a per-query cost limit)
 *
 * Premium quotes cost money upstream, so the free tier is capped at 3 premium
 * lookups per GraphQL operation. The cap is enforced by counting the DISTINCT
 * FIELD NAMES in the query's selection set before running it — which is always
 * 1 for a query that only asks for `premiumQuote`, no matter how many times.
 * GraphQL aliasing lets the same field be selected any number of times under
 * different response keys, each one a real, separately executed call.
 * Recorded only when a single operation actually executes `premiumQuote` more
 * than 3 times.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";
import { buildSchema, parse, validate, execute, specifiedRules, NoSchemaIntrospectionCustomRule, Kind, type GraphQLError, type OperationDefinitionNode } from "graphql";

const ctx = loadLabContext();
const APP = "QuoteVault";
const MAX_PREMIUM_PER_OPERATION = 3;

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const sessions = makeSessions<{ user: string }>(ctx, "quotevault_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#50fa7b",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/quotes", label: "Quotes" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const schema = buildSchema(`
  type Quote { symbol: String!, priceCents: Int! }
  type Query { freeQuote(symbol: String!): Quote!, premiumQuote(symbol: String!): Quote! }
`);
const priceFor = (symbol: string, premium: boolean) => {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (premium ? 10000 : 9000) + (h % 5000);
};

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/quotes", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/quotes" : "/login"));

  app.get("/quotes", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Quotes", `<div class="panel"><h1>Stock quotes</h1>
      <p class="muted">Free tier: unlimited free quotes, up to ${MAX_PREMIUM_PER_OPERATION} premium quotes per request.</p>
      <p><input id="sym" placeholder="Symbol, e.g. ACME" value="ACME" /> <button onclick="go()">Get premium quote</button> <span id="msg" class="muted"></span></p></div>
      <script>async function go(){ const sym = document.getElementById("sym").value; const r = await fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: 'query($s: String!) { premiumQuote(symbol: $s) { priceCents } }', variables: { s: sym } }) }); const d = await r.json(); document.getElementById("msg").textContent = r.ok ? ("$" + (d.data.premiumQuote.priceCents / 100).toFixed(2)) : d.errors[0].message; }</script>`, "Alice Chen");
  });

  app.post("/graphql", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ errors: [{ message: "login required" }] });
    const body = (req.body ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof body.query !== "string" || body.query.length > 4000) return reply.code(400).send({ errors: [{ message: "query must be a string" }] });

    let document;
    try {
      document = parse(body.query);
    } catch (e) {
      return reply.send({ errors: [{ message: (e as Error).message }] });
    }
    const problems: readonly GraphQLError[] = validate(schema, document, [...specifiedRules, NoSchemaIntrospectionCustomRule]);
    if (problems.length > 0) return reply.send({ errors: problems.map((p) => ({ message: p.message })) });

    // The cost limit: counts DISTINCT FIELD NAMES in the operation's top-level selection
    // set. Aliased selections of the same field all share one field name, so this is
    // always 1 for a query that only ever asks for "premiumQuote" — whatever its alias.
    const opDef = document.definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
    const distinctFieldNames = new Set((opDef?.selectionSet.selections ?? []).flatMap((s) => (s.kind === Kind.FIELD ? [s.name.value] : [])));
    if (distinctFieldNames.has("premiumQuote") && distinctFieldNames.size > MAX_PREMIUM_PER_OPERATION) {
      return reply.code(429).send({ errors: [{ message: `too many distinct fields in one request` }] });
    }

    let premiumCallsThisOperation = 0;
    const result = await execute({
      schema,
      document,
      rootValue: {
        freeQuote: ({ symbol }: { symbol: string }) => ({ symbol, priceCents: priceFor(symbol, false) }),
        premiumQuote: ({ symbol }: { symbol: string }) => {
          premiumCallsThisOperation++;
          return { symbol, priceCents: priceFor(symbol, true) };
        },
      },
      variableValues: (body.variables ?? {}) as Record<string, unknown>,
      operationName: typeof body.operationName === "string" ? body.operationName : undefined,
    });
    if (premiumCallsThisOperation > MAX_PREMIUM_PER_OPERATION) {
      await reportSolve(ctx, `a single GraphQL operation actually executed premiumQuote ${premiumCallsThisOperation} times (limit ${MAX_PREMIUM_PER_OPERATION}) by aliasing the field — the cost check only counted 1 distinct field name`);
    }
    return reply.send({ data: result.data, errors: result.errors?.map((e) => ({ message: e.message })) });
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[quotevault] fatal error:", err);
  process.exit(1);
});
