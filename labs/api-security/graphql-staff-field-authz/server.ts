/**
 * StaffDirectory GraphQL — Query What You Want (GraphQL field-level authorization)
 *
 * A REAL GraphQL schema (the `graphql` npm package — query parsing,
 * validation and execution all run for real; nothing here is mocked
 * protocol) exposes an `Employee` type whose `salary` and
 * `performanceRating` fields resolve directly from the record with no
 * check of the caller's role. The directory PAGE only ever asks for `name`
 * and `title`, but GraphQL lets any caller's own query ask for anything the
 * schema exposes. Recorded only when a response actually contains one of
 * the restricted fields.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml } from "@nulllab/lab-sdk";
import { graphql, buildSchema } from "graphql";

const ctx = loadLabContext();
const APP = "StaffDirectory";

const schema = buildSchema(`
  type Employee {
    id: ID!
    name: String!
    title: String!
    department: String!
    salary: Int!
    performanceRating: String!
  }
  type Query {
    employee(id: ID!): Employee
    employees: [Employee!]!
  }
`);

const EMPLOYEES = [
  { id: "1", name: "Alice Chen", title: "Support Specialist", department: "Support", salary: 52000, performanceRating: "Meets" },
  { id: "2", name: "Marcus Webb", title: "Staff Engineer", department: "Engineering", salary: 148000, performanceRating: "Exceeds" },
  { id: "3", name: "Priya Nair", title: "Controller", department: "Finance", salary: 117000, performanceRating: "Exceeds" },
];

// VULNERABLE: no role check in any resolver — every field is just returned.
const root = {
  employee: ({ id }: { id: string }) => EMPLOYEES.find((e) => e.id === id) ?? null,
  employees: () => EMPLOYEES,
};

const RESTRICTED = ["salary", "performanceRating"];

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#9be564", navLinks: [{ href: "/", label: "Directory" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Directory",
      `<div class="panel"><h1>Company directory</h1><table><tr><th>Name</th><th>Title</th></tr>${EMPLOYEES.map((e) => `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.title)}</td></tr>`).join("")}</table>
        <p class="muted">This page is backed by a GraphQL API at /graphql.</p></div>`,
    );
  });

  app.post("/graphql", async (req, reply) => {
    const body = (req.body ?? {}) as { query?: unknown; variables?: unknown };
    if (typeof body.query !== "string" || body.query.length > 2000) {
      return reply.code(400).send({ errors: [{ message: "query must be a string" }] });
    }
    const result = await graphql({
      schema,
      source: body.query,
      rootValue: root,
      variableValues: (body.variables ?? {}) as Record<string, unknown>,
    });

    const text = JSON.stringify(result.data ?? {});
    const requestedRestricted = RESTRICTED.filter((f) => text.includes(`"${f}"`));
    if (requestedRestricted.length > 0) {
      await reportSolve(ctx, `a GraphQL response included restricted field(s) ${requestedRestricted.join(", ")} with no role check in the resolver`);
    }
    return result;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[staffdirectory-graphql] fatal error:", err);
  process.exit(1);
});
