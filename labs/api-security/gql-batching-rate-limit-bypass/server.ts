/**
 * Loginly — Account Recovery (GraphQL batching bypasses a per-request rate limit)
 *
 * The recovery form locks an account out after 5 HTTP requests to this
 * endpoint, by incrementing a counter once per incoming POST. Array/batch
 * requests (a single POST carrying a JSON array of operations, which this
 * server executes in one call) are valid GraphQL and are never rejected — so
 * a single one of those 5 allowed requests can bundle far more than 5
 * operations. The code is 2 digits specifically so that one batch, under the
 * server's own 100-operations-per-batch cap, can cover every possibility.
 * Recorded only when a batch of more than 5 operations, sent as one HTTP
 * request, finds the correct code.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, seededSecret } from "@nulllab/lab-sdk";
import { buildSchema, parse, validate, execute, specifiedRules, NoSchemaIntrospectionCustomRule, type GraphQLError } from "graphql";

const ctx = loadLabContext();
const APP = "Loginly";
const RECOVERY_CODE = seededSecret(ctx, "recovery-code", 2, "0123456789");
const MAX_GUESSES_PER_REQUEST = 5;
let requestsUsed = 0; // a lockout counter: incremented once per incoming HTTP POST and NEVER reset — but it is
// blind to how many GraphQL operations that one POST actually contains

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const sessions = makeSessions<{ user: string }>(ctx, "loginly_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ff5555",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/recovery", label: "Recovery" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const schema = buildSchema(`
  type Query { checkRecoveryCode(code: String!): Boolean! }
`);

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/recovery", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/recovery" : "/login"));

  app.get("/recovery", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Account recovery", `<div class="panel"><h1>Account recovery</h1>
      <p class="muted">A 2-digit recovery code was sent to your backup email (synthetic — not actually sent). After ${MAX_GUESSES_PER_REQUEST} requests, this account is locked out.</p>
      <p><input id="code" maxlength="2" placeholder="00" /> <button onclick="go()">Check code</button> <span id="msg" class="muted"></span></p></div>
      <script>async function go(){ const r = await fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query($c: String!) { checkRecoveryCode(code: $c) }", variables: { c: document.getElementById("code").value } }) }); const d = await r.json(); document.getElementById("msg").textContent = r.ok ? (d.data.checkRecoveryCode ? "Correct!" : "Incorrect.") : d.errors[0].message; }</script>`, "Alice Chen");
  });

  app.post("/graphql", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ errors: [{ message: "login required" }] });
    const body = req.body;
    const operations = Array.isArray(body) ? body : [body];
    if (operations.length > 100) return reply.code(400).send({ errors: [{ message: "too many operations in one batch" }] });

    // The rate limit: incremented ONCE for the whole incoming HTTP request, not once per operation inside it.
    requestsUsed++;
    if (requestsUsed > MAX_GUESSES_PER_REQUEST) {
      return reply.code(429).send({ errors: [{ message: "too many guesses — try again later" }] });
    }

    let found = false;
    let guessesInThisBatch = 0;
    const results = [];
    for (const op of operations) {
      const opBody = (op ?? {}) as { query?: unknown; variables?: unknown };
      if (typeof opBody.query !== "string" || opBody.query.length > 2000) {
        results.push({ errors: [{ message: "query must be a string" }] });
        continue;
      }
      let document;
      try {
        document = parse(opBody.query);
      } catch (e) {
        results.push({ errors: [{ message: (e as Error).message }] });
        continue;
      }
      const problems: readonly GraphQLError[] = validate(schema, document, [...specifiedRules, NoSchemaIntrospectionCustomRule]);
      if (problems.length > 0) {
        results.push({ errors: problems.map((p) => ({ message: p.message })) });
        continue;
      }
      guessesInThisBatch++;
      const result = await execute({
        schema,
        document,
        rootValue: { checkRecoveryCode: ({ code }: { code: string }) => code === RECOVERY_CODE },
        variableValues: (opBody.variables ?? {}) as Record<string, unknown>,
      });
      if (result.data?.checkRecoveryCode === true) found = true;
      results.push({ data: result.data, errors: result.errors?.map((e) => ({ message: e.message })) });
    }
    if (found && guessesInThisBatch > MAX_GUESSES_PER_REQUEST) {
      await reportSolve(ctx, `a single HTTP request bundled ${guessesInThisBatch} checkRecoveryCode guesses as a GraphQL batch and found the correct code — the per-request rate limit of ${MAX_GUESSES_PER_REQUEST} was counted once for the whole batch`);
    }
    return reply.send(Array.isArray(body) ? results : results[0]);
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[loginly] fatal error:", err);
  process.exit(1);
});
