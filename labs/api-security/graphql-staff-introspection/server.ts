/**
 * StaffDirectory GraphQL — What Else Is In Here? (GraphQL introspection exposure)
 *
 * Introspection is left enabled (the `graphql` package's default — nothing
 * here disables it, as a production deployment normally would), and the
 * schema includes a `resetAllPerformanceRatings` mutation that no page in
 * the app ever calls or links to. Its existence, arguments and return type
 * are all discoverable purely through a standard `__schema` introspection
 * query. Recorded only when that mutation — found only through introspection
 * — is actually called successfully.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell } from "@nulllab/lab-sdk";
import { graphql, buildSchema } from "graphql";

const ctx = loadLabContext();
const APP = "StaffDirectory";

const schema = buildSchema(`
  type Employee {
    id: ID!
    name: String!
    title: String!
    performanceRating: String!
  }
  type Query {
    employees: [Employee!]!
  }
  type Mutation {
    """Administrative bulk-reset tool. Not linked from any page — introspection-only."""
    resetAllPerformanceRatings(to: String!): Int!
  }
`);

const EMPLOYEES = [
  { id: "1", name: "Alice Chen", title: "Support Specialist", performanceRating: "Meets" },
  { id: "2", name: "Marcus Webb", title: "Staff Engineer", performanceRating: "Exceeds" },
];
let mutationCalled = false;

const root = {
  employees: () => EMPLOYEES,
  resetAllPerformanceRatings: ({ to }: { to: string }) => {
    mutationCalled = true;
    for (const e of EMPLOYEES) e.performanceRating = to;
    return EMPLOYEES.length;
  },
};

// The app's own page only ever sends this ONE query.
const APP_QUERY = `{ employees { name title } }`;

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#9be564", navLinks: [{ href: "/", label: "Directory" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Directory",
      `<div class="panel"><h1>Company directory</h1><p class="muted">Backed by GraphQL at /graphql. This page only ever sends:</p><pre>${APP_QUERY}</pre></div>`,
    );
  });

  app.post("/graphql", async (req, reply) => {
    const body = (req.body ?? {}) as { query?: unknown; variables?: unknown };
    if (typeof body.query !== "string" || body.query.length > 4000) {
      return reply.code(400).send({ errors: [{ message: "query must be a string" }] });
    }
    const before = mutationCalled;
    const result = await graphql({ schema, source: body.query, rootValue: root, variableValues: (body.variables ?? {}) as Record<string, unknown> });
    if (!before && mutationCalled) {
      await reportSolve(ctx, `the "resetAllPerformanceRatings" mutation — never referenced by any app page — was called, discoverable only via __schema introspection`);
    }
    return result;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[staffdirectory-introspection] fatal error:", err);
  process.exit(1);
});
