/**
 * Snaplift — Shared Photo Albums (public bucket allows directory listing)
 *
 * Photo files are served from a storage bucket meant to be read-only and
 * opaque: each photo has an unguessable key, and the app never links to
 * anything else in the bucket. The bucket's list operation, though, was left
 * enabled for anyone — a misconfiguration, independent of any individual
 * photo's permissions — so every key in the bucket, across every user, can be
 * enumerated without ever being linked from the app. Recorded only when a
 * private photo belonging to a different user is fetched using a key obtained
 * from the bucket listing rather than from the app itself.
 */
import { createHash, randomBytes } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Snaplift";

const USERS = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "dana", password: "Dana-Snap!71", displayName: "Dana Whitfield" },
];
interface Photo {
  key: string;
  owner: string;
  caption: string;
  bytes: string;
}
const keyFor = (owner: string, n: number) => createHash("sha1").update(`${owner}:${n}:${randomBytes(4).toString("hex")}`).digest("hex").slice(0, 24);
const BUCKET: Photo[] = [
  { key: keyFor("alice", 1), owner: "alice", caption: "Sunset over the harbor", bytes: "PNG-SYNTHETIC-alice-1" },
  { key: keyFor("alice", 2), owner: "alice", caption: "Hiking trip, day 2", bytes: "PNG-SYNTHETIC-alice-2" },
  { key: keyFor("dana", 1), owner: "dana", caption: "Family reunion — private", bytes: "PNG-SYNTHETIC-dana-1-PRIVATE" },
  { key: keyFor("dana", 2), owner: "dana", caption: "Medical appointment reminder screenshot — private", bytes: "PNG-SYNTHETIC-dana-2-PRIVATE" },
];

const sessions = makeSessions<{ user: string }>(ctx, "snaplift_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ff79c6",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/albums", label: "My albums" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const d = await (await fetch("/api/photos")).json();
  document.getElementById("rows").innerHTML = d.photos.map(function (p) { return "<li>" + esc(p.caption) + " — <code>" + esc(p.key) + "</code></li>"; }).join("");
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/albums", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/albums" : "/login"));

  app.get("/albums", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("My albums", `<div class="panel"><h1>Your photos</h1><ul id="rows"></ul></div><script>${PAGE_SCRIPT}</script>`, "Alice Chen");
  });

  app.get("/api/photos", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { photos: BUCKET.filter((p) => p.owner === u).map((p) => ({ key: p.key, caption: p.caption })) };
  });

  // Fetching a specific key needs no further permission check — the key itself is the capability,
  // by design, as for most object storage. That design is sound ONLY if keys cannot be enumerated.
  app.get("/storage/:key", async (req, reply) => {
    const photo = BUCKET.find((p) => p.key === (req.params as { key: string }).key);
    if (!photo) return reply.code(404).send({ error: "no such object" });
    const u = who(req);
    if (!u || u !== photo.owner) {
      await reportSolve(ctx, `photo ${photo.key} (owner "${photo.owner}", caption "${photo.caption}") was fetched by ${u ? `"${u}"` : "an unauthenticated request"} using a key obtained from the bucket listing`);
    }
    reply.type("text/plain");
    return photo.bytes;
  });

  // The misconfiguration: bucket listing left open, independent of the app and of any one photo's own access.
  app.get("/storage", async (_req, _reply) => {
    return { bucket: "snaplift-user-photos", objects: BUCKET.map((p) => ({ key: p.key, sizeBytes: p.bytes.length })) };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[snaplift] fatal error:", err);
  process.exit(1);
});
