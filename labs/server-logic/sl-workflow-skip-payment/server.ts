/**
 * RideShare — Confirmed Without Paying (workflow-step skipping)
 *
 * requested -> accepted -> paid -> completed. /rides/:id/complete only
 * checks that the ride isn't ALREADY completed or cancelled — never that it
 * specifically passed through "paid". Recorded only when a ride reaches
 * "completed" whose own record shows paidAt is still null.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "RideShare";

type Status = "requested" | "accepted" | "paid" | "completed" | "cancelled";
interface Ride { id: number; status: Status; paidAt: string | null; }
const rides = new Map<number, Ride>();
let nextId = 1;

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#5ec9e0", navLinks: [{ href: "/", label: "Book a ride" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Book a ride",
      `<div class="panel"><h1>Book a ride</h1>
        <form method="post" action="/rides"><button type="submit">Request a ride</button></form>
        <p class="muted">After requesting, use the ride id with /rides/:id/accept, /pay, and /complete.</p></div>`,
    );
  });

  app.post("/rides", async () => {
    const ride: Ride = { id: nextId++, status: "requested", paidAt: null };
    rides.set(ride.id, ride);
    return { ride };
  });

  app.post("/rides/:id/accept", async (req, reply) => {
    const ride = rides.get(Number((req.params as { id: string }).id));
    if (!ride) return reply.code(404).send({ error: "no such ride" });
    if (ride.status !== "requested") return reply.code(409).send({ error: `ride is ${ride.status}` });
    ride.status = "accepted";
    return { ride };
  });

  app.post("/rides/:id/pay", async (req, reply) => {
    const ride = rides.get(Number((req.params as { id: string }).id));
    if (!ride) return reply.code(404).send({ error: "no such ride" });
    if (ride.status !== "accepted") return reply.code(409).send({ error: `ride is ${ride.status}` });
    ride.status = "paid";
    ride.paidAt = new Date().toISOString();
    return { ride };
  });

  // --- The vulnerable handler: never checks that "paid" was actually reached. --
  app.post("/rides/:id/complete", async (req, reply) => {
    const ride = rides.get(Number((req.params as { id: string }).id));
    if (!ride) return reply.code(404).send({ error: "no such ride" });
    if (ride.status === "completed" || ride.status === "cancelled") {
      return reply.code(409).send({ error: `ride is already ${ride.status}` });
    }
    ride.status = "completed";
    if (!ride.paidAt) {
      await reportSolve(ctx, `ride ${ride.id} reached status "completed" although its paidAt field is still null — the paid step was skipped`);
    }
    return { ride };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[rideshare] fatal error:", err);
  process.exit(1);
});
