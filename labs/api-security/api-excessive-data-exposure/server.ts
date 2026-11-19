/**
 * ReportAPI — Everything, By Default (API excessive data exposure)
 *
 * The dashboard UI only renders a customer's name and plan, but
 * GET /api/customers/:id — the API the dashboard actually calls — returns
 * the ENTIRE internal record with no response-shape filtering at all,
 * trusting the frontend to be selective. Recorded only when a response
 * actually contains the internal cost/margin fields.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "ReportAPI";

const CUSTOMERS = [
  { id: 1, name: "Northwind Foods", plan: "Enterprise", internalCostUsd: 2100, marginPercent: 61, accountOwnerEmail: "sales-internal@reportapi.test" },
  { id: 2, name: "Contoso Logistics", plan: "Business", internalCostUsd: 980, marginPercent: 44, accountOwnerEmail: "sales-internal@reportapi.test" },
];

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#5ec98f", navLinks: [{ href: "/", label: "Dashboard" }] });
}

const DASHBOARD_SCRIPT = `
(async function () {
  const rows = await Promise.all([1,2].map(id => fetch("/api/customers/" + id).then(r => r.json())));
  document.getElementById("rows").innerHTML = rows.map(function (c) {
    return "<tr><td>" + c.name + "</td><td>" + c.plan + "</td></tr>";
  }).join("");
})();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Dashboard",
      `<div class="panel"><h1>Customers</h1><table><tr><th>Name</th><th>Plan</th></tr><tbody id="rows"></tbody></table></div>
       <script>${DASHBOARD_SCRIPT}</script>`,
    );
  });

  // --- The vulnerable handler: the full internal record, every time. ----------
  app.get("/api/customers/:id", async (req, reply) => {
    const customer = CUSTOMERS.find((c) => c.id === Number((req.params as { id: string }).id));
    if (!customer) return reply.code(404).send({ error: "no such customer" });
    await reportSolve(ctx, `GET /api/customers/${customer.id} returned internalCostUsd and marginPercent, fields no part of the UI ever renders`);
    return customer;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[reportapi] fatal error:", err);
  process.exit(1);
});
