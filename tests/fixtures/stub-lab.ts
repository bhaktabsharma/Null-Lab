// A minimal "lab" used only by runtime tests: serves /healthz on the
// bind host/port the orchestrator passes in, so tests can exercise process
// lifecycle and networking without depending on any real lab.
import http from "node:http";

const port = Number(process.env.NULLLAB_LAB_PORT);
const host = process.env.NULLLAB_BIND_HOST ?? "127.0.0.1";

http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
      return;
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(port, host, () => console.log(`stub listening on ${host}:${port}`));

process.on("SIGTERM", () => process.exit(0));
