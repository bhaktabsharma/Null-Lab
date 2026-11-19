/**
 * Helix HR — Team Directory (GraphQL mutation authorization gap)
 *
 * Authentication happens once, at the HTTP layer. Role checks are a wrapper
 * (`guardAll`) applied to the Query resolvers in a loop. The Mutation resolvers
 * live in a separate object and were never wrapped, so a mutation that changes
 * someone's role runs for any signed-in employee. Introspection is switched off
 * (this lab is about the missing guard, not about discovering the schema); the
 * mutation is found the way real ones are — in the shipped front-end code, or
 * from graphql-js's "Did you mean ...?" suggestions. Recorded only when an
 * employee's role is actually changed by a caller who is not in HR.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";
import { buildSchema, parse, validate, execute, specifiedRules, NoSchemaIntrospectionCustomRule, type GraphQLError } from "graphql";

const ctx = loadLabContext();
const APP = "Helix HR";

type EmployeeRole = "employee" | "hr";
interface Employee {
  id: string;
  username: string;
  password: string;
  displayName: string;
  title: string;
  role: EmployeeRole;
  salaryBand: string;
}
const EMPLOYEES: Employee[] = [
  { id: "1", username: "alice", password: "practice123", displayName: "Alice Chen", title: "Support Specialist", role: "employee", salaryBand: "B2" },
  { id: "2", username: "hana", password: "Hr-Helix!2024", displayName: "Hana Okafor", title: "HR Business Partner", role: "hr", salaryBand: "C1" },
  { id: "3", username: "marcus", password: "Eng-Helix!2024", displayName: "Marcus Webb", title: "Staff Engineer", role: "employee", salaryBand: "D3" },
  { id: "4", username: "ivy", password: "Fin-Helix!2024", displayName: "Ivy Laurent", title: "Finance Analyst", role: "employee", salaryBand: "B3" },
];

const schema = buildSchema(`
  type Employee {
    id: ID!
    name: String!
    title: String!
    role: String!
    salaryBand: String
  }
  type Query {
    me: Employee!
    employees: [Employee!]!
    salaryBands: [String!]!
  }
  type Mutation {
    updateMyTitle(title: String!): Employee!
    setEmployeeRole(id: ID!, role: String!): Employee!
  }
`);

interface Ctx {
  user: Employee;
  /** Set by a resolver when it observes the security failure; reported after execution. Per request, never shared. */
  evidence: string | null;
}
const view = (e: Employee, viewer: Employee) => ({ id: e.id, name: e.displayName, title: e.title, role: e.role, salaryBand: viewer.role === "hr" ? e.salaryBand : null });

/** Authorization wrapper: HR-only resolvers throw for everyone else. */
type Resolver = (args: any, c: Ctx) => unknown;
function guard(level: "any" | "hr", fn: Resolver): Resolver {
  return (args, c) => {
    if (level === "hr" && c.user.role !== "hr") throw new Error("Forbidden: HR access required");
    return fn(args, c);
  };
}
function guardAll(entries: Record<string, [("any" | "hr"), Resolver]>): Record<string, Resolver> {
  return Object.fromEntries(Object.entries(entries).map(([name, [level, fn]]) => [name, guard(level, fn)]));
}

const QUERIES = guardAll({
  me: ["any", (_a, c) => view(c.user, c.user)],
  employees: ["any", (_a, c) => EMPLOYEES.map((e) => view(e, c.user))],
  salaryBands: ["hr", () => [...new Set(EMPLOYEES.map((e) => e.salaryBand))].sort()],
});

// The mutation resolvers sit in their own object — and nothing wraps them.
const MUTATIONS: Record<string, Resolver> = {
  updateMyTitle: ({ title }: { title: string }, c) => {
    c.user.title = String(title).slice(0, 60);
    return view(c.user, c.user);
  },
  setEmployeeRole: ({ id, role }: { id: string; role: string }, c) => {
    const target = EMPLOYEES.find((e) => e.id === id);
    if (!target) throw new Error("No such employee");
    if (role !== "employee" && role !== "hr") throw new Error('Role must be "employee" or "hr"');
    // Read the CALLER's role before mutating: when someone promotes themselves, target and
    // caller are the same record and the change below would otherwise hide that they were not HR.
    const callerRole = c.user.role;
    const before = target.role;
    target.role = role;
    c.evidence =
      before !== target.role && callerRole !== "hr"
        ? `"${c.user.username}" (role "${callerRole}") changed the role of employee ${target.id} ("${target.username}") from "${before}" to "${target.role}" via the setEmployeeRole mutation`
        : null;
    return view(target, c.user);
  },
};
const rootValue = { ...QUERIES, ...MUTATIONS };

const sessions = makeSessions<{ user: string }>(ctx, "helix_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ff79c6",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/directory", label: "Directory" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

// The whole front end is delivered to every user, whatever their role — including the HR tools.
const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
const OPS = {
  me: "{ me { id name title role } }",
  list: "{ employees { id name title role salaryBand } }",
  rename: "mutation ($t: String!) { updateMyTitle(title: $t) { id title } }",
  // HR tooling — only wired up for HR users
  setRole: "mutation ($id: ID!, $r: String!) { setEmployeeRole(id: $id, role: $r) { id role } }"
};
async function gql(query, variables) {
  const res = await fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: query, variables: variables || {} }) });
  return res.json();
}
async function load() {
  const me = (await gql(OPS.me)).data.me;
  const list = (await gql(OPS.list)).data.employees;
  document.getElementById("rows").innerHTML = list.map(function (e) {
    const hrTools = me.role === "hr" ? '<button onclick="toggleHr(' + e.id + ", '" + (e.role === "hr" ? "employee" : "hr") + "')\\">Make " + (e.role === "hr" ? "employee" : "HR") + "</button>" : "";
    return "<tr><td>" + esc(e.name) + "</td><td>" + esc(e.title) + "</td><td>" + esc(e.role) + "</td><td>" + esc(e.salaryBand || "—") + "</td><td>" + hrTools + "</td></tr>";
  }).join("");
}
async function toggleHr(id, role) { await gql(OPS.setRole, { id: String(id), r: role }); load(); }
async function rename() { await gql(OPS.rename, { t: document.getElementById("title").value }); load(); }
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (EMPLOYEES.find((e) => e.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: EMPLOYEES, sessions, shell, appName: APP, home: "/directory", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/directory" : "/login"));

  app.get("/directory", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Directory",
      `<div class="panel"><h1>Team directory</h1>
        <table><tr><th>Name</th><th>Title</th><th>Role</th><th>Band</th><th></th></tr><tbody id="rows"></tbody></table>
        <p style="margin-top:1rem;"><input id="title" placeholder="Update my title" /> <button onclick="rename()">Save</button></p></div>
      <script>${PAGE_SCRIPT}</script>`,
      u.displayName,
    );
  });

  // Authentication happens here, once, for the whole schema.
  app.post("/graphql", async (req, reply) => {
    const user = who(req);
    if (!user) return reply.code(401).send({ errors: [{ message: "Authentication required" }] });
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

    const requestCtx: Ctx = { user, evidence: null };
    const result = await execute({
      schema,
      document,
      rootValue,
      contextValue: requestCtx,
      variableValues: (body.variables ?? {}) as Record<string, unknown>,
      operationName: typeof body.operationName === "string" ? body.operationName : undefined,
    });
    if (requestCtx.evidence) await reportSolve(ctx, requestCtx.evidence);
    return reply.send({ data: result.data, errors: result.errors?.map((e) => ({ message: e.message })) });
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[helix-hr] fatal error:", err);
  process.exit(1);
});
