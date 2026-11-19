/**
 * MockShell — a SIMULATED command interpreter for command-injection labs.
 *
 * Nothing here ever starts a process, touches the host filesystem, or opens
 * a socket: commands are implemented in JavaScript over a small in-memory
 * virtual filesystem. It models just enough shell grammar — `;`, `&&`, `||`,
 * `|`, newlines, quotes, `$(...)` and backticks — for the injection to behave
 * like the real thing, and a handful of harmless commands. Input length,
 * command count, substitution depth and output size are all bounded.
 */
export interface ExecutedCommand {
  name: string;
  args: string[];
}
export interface ShellResult {
  output: string;
  executed: ExecutedCommand[];
}

const MAX_LINE = 300;
const MAX_COMMANDS = 20;
const MAX_DEPTH = 2;
const MAX_OUTPUT = 4000;

type Op = ";" | "&&" | "||" | "|";
interface Piece {
  words: string[];
  op: Op | null; // operator that FOLLOWS this command
}

export function runMockShell(line: string, vfs: Record<string, string>): ShellResult {
  const executed: ExecutedCommand[] = [];
  const output = runLine(line, vfs, executed, 0);
  return { output: output.slice(0, MAX_OUTPUT), executed };
}

function runLine(line: string, vfs: Record<string, string>, executed: ExecutedCommand[], depth: number): string {
  if (line.length > MAX_LINE) return "sh: command line too long\n";
  const pieces = tokenize(line, vfs, executed, depth);
  let out = "";
  let status = 0;
  let stdin: string | null = null;
  let count = 0;
  let skipNext = false;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (!skipNext && piece.words.length > 0) {
      if (++count > MAX_COMMANDS) return out + "sh: too many commands\n";
      const r = runCommand(piece.words, stdin, vfs, executed);
      status = r.status;
      if (piece.op === "|") {
        stdin = r.stdout;
      } else {
        out += r.stdout;
        stdin = null;
      }
    } else if (piece.op === "|") {
      stdin = "";
    }
    // Decide whether the NEXT command runs.
    if (piece.op === "&&") skipNext = status !== 0;
    else if (piece.op === "||") skipNext = status === 0;
    else skipNext = false;
  }
  return out;
}

function tokenize(line: string, vfs: Record<string, string>, executed: ExecutedCommand[], depth: number): Piece[] {
  const pieces: Piece[] = [];
  let words: string[] = [];
  let cur = "";
  let inWord = false;
  let single = false;
  let double = false;

  const endWord = () => {
    if (inWord) words.push(cur);
    cur = "";
    inWord = false;
  };
  const endCommand = (op: Op | null) => {
    endWord();
    pieces.push({ words, op });
    words = [];
  };
  const substitute = (inner: string) => {
    if (depth >= MAX_DEPTH) return;
    const text = runLine(inner, vfs, executed, depth + 1).replace(/\n+$/g, "").replace(/\n/g, " ");
    cur += text;
    inWord = true;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (single) {
      if (c === "'") single = false;
      else cur += c;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      const end = line.indexOf(")", i + 2);
      if (end !== -1) {
        substitute(line.slice(i + 2, end));
        i = end;
        continue;
      }
    }
    if (c === "`") {
      const end = line.indexOf("`", i + 1);
      if (end !== -1) {
        substitute(line.slice(i + 1, end));
        i = end;
        continue;
      }
    }
    if (double) {
      if (c === '"') double = false;
      else if (c === "\\" && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === "'") { single = true; inWord = true; continue; }
    if (c === '"') { double = true; inWord = true; continue; }
    if (c === "\\" && i + 1 < line.length) { cur += line[++i]; inWord = true; continue; }
    if (c === ";" || c === "\n") { endCommand(";"); continue; }
    if (c === "&" && line[i + 1] === "&") { endCommand("&&"); i++; continue; }
    if (c === "|" && line[i + 1] === "|") { endCommand("||"); i++; continue; }
    if (c === "|") { endCommand("|"); continue; }
    if (c === " " || c === "\t") { endWord(); continue; }
    cur += c;
    inWord = true;
  }
  endCommand(null);
  return pieces;
}

function runCommand(words: string[], stdin: string | null, vfs: Record<string, string>, executed: ExecutedCommand[]): { stdout: string; status: number } {
  const [name = "", ...args] = words;
  executed.push({ name, args });
  const ok = (stdout: string) => ({ stdout, status: 0 });
  const fail = (stdout: string, status = 1) => ({ stdout, status });
  const readFile = (p: string) => (Object.prototype.hasOwnProperty.call(vfs, p) ? vfs[p] : undefined);

  switch (name) {
    case "echo": return ok(args.join(" ") + "\n");
    case "whoami": return ok("netops\n");
    case "id": return ok("uid=1001(netops) gid=1001(netops) groups=1001(netops)\n");
    case "pwd": return ok("/opt/netops\n");
    case "hostname": return ok("netops-lab\n");
    case "uname": return ok("Linux netops-lab 6.1.0-lab x86_64\n");
    case "cat": {
      if (args.length === 0) return ok(stdin ?? "");
      let out = "";
      let status = 0;
      for (const a of args) {
        const body = readFile(a);
        if (body === undefined) { out += `cat: ${a}: No such file or directory\n`; status = 1; }
        else out += body.endsWith("\n") ? body : body + "\n";
      }
      return { stdout: out, status };
    }
    case "ls": {
      const dir = (args[0] ?? "/opt/netops").replace(/\/+$/, "") || "/";
      const prefix = dir === "/" ? "/" : dir + "/";
      const names = new Set<string>();
      for (const p of Object.keys(vfs)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0]!);
      return names.size ? ok([...names].sort().join("\n") + "\n") : fail(`ls: cannot access '${args[0] ?? dir}': No such file or directory\n`, 2);
    }
    case "head": {
      const n = args[0] === "-n" ? Math.max(0, Math.min(100, Number(args[1]) || 10)) : 10;
      return ok((stdin ?? "").split("\n").slice(0, n).join("\n") + "\n");
    }
    case "wc": return ok(String((stdin ?? "").split("\n").filter((l) => l.length).length) + "\n");
    case "grep": {
      const ci = args[0] === "-i";
      const pat = ci ? args[1] : args[0];
      if (pat === undefined) return fail("grep: missing pattern\n", 2);
      const lines = (stdin ?? "").split("\n").filter((l) => (ci ? l.toLowerCase().includes(pat.toLowerCase()) : l.includes(pat)));
      return lines.length ? ok(lines.join("\n") + "\n") : fail("", 1);
    }
    case "ping": {
      const countIdx = args.indexOf("-c");
      const n = countIdx >= 0 ? Math.max(1, Math.min(4, Number(args[countIdx + 1]) || 1)) : 1;
      const host = args.filter((a, i) => !a.startsWith("-") && i !== countIdx + 1).pop();
      if (!host) return fail("ping: usage error: Destination address required\n", 2);
      const known = /^(localhost|127\.0\.0\.1|gateway\.lab|10\.0\.0\.\d{1,3})$/;
      if (!known.test(host)) return fail(`ping: ${host}: Name or service not known\n`, 2);
      let out = `PING ${host} (${host}) 56(84) bytes of data.\n`;
      for (let i = 1; i <= n; i++) out += `64 bytes from ${host}: icmp_seq=${i} ttl=64 time=0.${40 + i} ms\n`;
      out += `\n--- ${host} ping statistics ---\n${n} packets transmitted, ${n} received, 0% packet loss\n`;
      return ok(out);
    }
    case "": return ok("");
    default: return fail(`sh: 1: ${name}: not found\n`, 127);
  }
}
