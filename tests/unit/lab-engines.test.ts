import { describe, expect, it } from "vitest";
import {
  DocCollection,
  runMockShell,
  renderTemplate,
  ldapSearch,
  parseFilter,
  LdapFilterError,
  parseXml,
  xpathElements,
  childText,
  boundedSleepMs,
  seededSecret,
  type LabContext,
  type LdapEntry,
} from "../../packages/lab-sdk/src/index.js";

describe("MiniDoc (NoSQL matcher)", () => {
  const users = new DocCollection([
    { username: "alice", password: "pw-a", role: "staff", age: 31 },
    { username: "admin", password: "S3cret!", role: "admin", age: 45 },
  ]);

  it("matches plain equality and refuses a wrong password", () => {
    expect(users.findOne({ username: "admin", password: "S3cret!" })?.role).toBe("admin");
    expect(users.findOne({ username: "admin", password: "nope" })).toBeNull();
  });

  it("evaluates comparison, set, existence and regex operators for real", () => {
    expect(users.findOne({ username: "admin", password: { $ne: "" } })?.role).toBe("admin"); // the classic bypass
    expect(users.find({ age: { $gt: 40 } }).map((u) => u.username)).toEqual(["admin"]);
    expect(users.find({ role: { $in: ["staff", "x"] } })).toHaveLength(1);
    expect(users.find({ password: { $regex: "^S3" } })).toHaveLength(1);
    expect(users.find({ password: { $regex: "^s3", $options: "i" } })).toHaveLength(1);
    expect(users.find({ $or: [{ username: "alice" }, { age: { $gte: 45 } }] })).toHaveLength(2);
    expect(users.find({ nickname: { $exists: false } })).toHaveLength(2);
  });

  it("rejects operators it does not support, including $where", () => {
    expect(() => users.find({ $where: "this.age > 1" })).toThrow(/unsupported/);
    expect(() => users.find({ age: { $where: "1" } })).toThrow(/unsupported/);
    expect(() => users.find("not an object")).toThrow(/must be an object/);
  });

  it("restricts $regex so it cannot cause catastrophic backtracking", () => {
    expect(() => users.find({ password: { $regex: "(a+)+$" } })).toThrow(/groups/);
    expect(() => users.find({ password: { $regex: "a".repeat(65) } })).toThrow(/at most 64/);
    expect(() => users.find({ password: { $regex: "a", $options: "g" } })).toThrow(/'i'/);
  });

  it("never reads prototype or inherited properties", () => {
    expect(users.find({ "__proto__.toString": { $exists: true } })).toHaveLength(0);
    expect(users.find({ constructor: { $exists: true } })).toHaveLength(0);
  });
});

describe("MockShell (simulated — never touches the host)", () => {
  const vfs = { "/opt/netops/config.ini": "api_token=TOKEN-1234\n", "/etc/motd": "hello\n" };
  const sh = (line: string) => runMockShell(line, vfs);

  it("runs a normal ping", () => {
    const r = sh("ping -c 1 gateway.lab");
    expect(r.output).toContain("1 packets transmitted, 1 received");
    expect(r.executed.map((c) => c.name)).toEqual(["ping"]);
  });

  it("honours ; && || | and substitutions like a shell", () => {
    expect(sh("ping -c 1 gateway.lab; cat /opt/netops/config.ini").output).toContain("TOKEN-1234");
    expect(sh("ping -c 1 nohost.invalid && echo SHOULD-NOT-RUN").output).not.toContain("SHOULD-NOT-RUN");
    expect(sh("ping -c 1 nohost.invalid || echo RAN").output).toContain("RAN");
    expect(sh("cat /opt/netops/config.ini | grep token").output).toContain("TOKEN-1234");
    expect(sh("echo $(whoami)").output).toBe("netops\n");
    expect(sh("echo `id`").output).toContain("uid=1001(netops)");
    expect(sh("echo 'a;b' \"c && d\"").output).toBe("a;b c && d\n");
  });

  it("only sees its virtual filesystem — the real host's files are unreachable", () => {
    // These paths exist on essentially every Linux host; here they must not resolve.
    for (const p of ["/etc/passwd", "/etc/hostname", "/proc/self/environ", "/home"]) {
      expect(sh(`cat ${p}`).output).toContain("No such file or directory");
    }
    expect(sh("ls /opt/netops").output).toBe("config.ini\n");
  });

  it("does not execute arbitrary programs: unknown commands just fail", () => {
    const r = sh("rm -rf / ; curl http://example.invalid ; node -e 1 ; sh -c id");
    expect(r.output).toContain("rm: not found");
    expect(r.output).toContain("curl: not found");
    expect(r.output).toContain("node: not found");
    expect(r.executed.map((c) => c.name)).toEqual(["rm", "curl", "node", "sh"]);
  });

  it("bounds input length, command count, and substitution depth", () => {
    expect(sh("echo " + "a".repeat(400)).output).toContain("too long");
    expect(sh(Array.from({ length: 30 }, () => "echo x").join("; ")).output).toContain("too many commands");
    expect(sh("echo $(echo $(echo $(echo deep)))").output.length).toBeLessThan(50); // depth-limited, no runaway
  });
});

describe("MiniTemplate (constrained SSTI engine)", () => {
  const ctx = { user: { name: "Sam" }, config: { SECRET_KEY: "SK-TEST", DEBUG: false }, items: ["a", "b"], fn: () => "boom" };

  it("renders paths, literals, indexing and filters", () => {
    expect(renderTemplate("Hi {{ user.name }}!", ctx)).toBe("Hi Sam!");
    expect(renderTemplate("{{ user.name | upper }} {{ 'x' | default('y') }} {{ missing | default('fallback') }}", ctx)).toBe("SAM x fallback");
    expect(renderTemplate("{{ items[1] }} {{ items | length }} {{ 41 }}", ctx)).toBe("b 2 41");
    expect(renderTemplate("{{ config.SECRET_KEY }}", ctx)).toBe("SK-TEST"); // the leak the lab teaches
  });

  it("cannot reach prototypes, constructors, or functions", () => {
    expect(renderTemplate("{{ config.__proto__ }}", ctx)).toContain("not allowed");
    expect(renderTemplate("{{ user.constructor }}", ctx)).toContain("not allowed");
    expect(renderTemplate("{{ fn }}", ctx)).toContain("not callable");
    expect(renderTemplate("{{ user.toString }}", ctx)).toBe(""); // inherited, not an own property
    expect(renderTemplate("{{ ''.constructor.constructor('return process')() }}", ctx)).toContain("template error");
  });

  it("reports errors in-band and enforces size limits", () => {
    expect(renderTemplate("{{ nope | bogus }}", ctx)).toContain('unknown filter "bogus"');
    expect(renderTemplate("x".repeat(2001), ctx)).toContain("too long");
    expect(renderTemplate("{{1}}".repeat(60), ctx)).toContain("too many expressions");
  });
});

describe("LdapMock (filter evaluator)", () => {
  const dir: LdapEntry[] = [
    { dn: "uid=alice,ou=people", attrs: { uid: ["alice"], cn: ["Alice Chen"], userPassword: ["pw-alice"], mail: ["alice@x.test"] } },
    { dn: "uid=admin,ou=people", attrs: { uid: ["admin"], cn: ["Directory Admin"], userPassword: ["S3cret!"] } },
  ];
  const uids = (f: string) => ldapSearch(dir, f).map((e) => e.attrs.uid![0]);

  it("evaluates equality, wildcards, presence, and/or/not", () => {
    expect(uids("(&(uid=admin)(userPassword=S3cret!))")).toEqual(["admin"]);
    expect(uids("(&(uid=admin)(userPassword=wrong))")).toEqual([]);
    expect(uids("(cn=*Chen)")).toEqual(["alice"]);
    expect(uids("(cn=Dir*Admin)")).toEqual(["admin"]);
    expect(uids("(mail=*)")).toEqual(["alice"]);
    expect(uids("(|(uid=alice)(uid=admin))")).toEqual(["alice", "admin"]);
    expect(uids("(!(uid=admin))")).toEqual(["alice"]);
    expect(uids("(UID=ALICE)")).toEqual(["alice"]); // case-insensitive
  });

  it("supports absolute true/false and escaped stars", () => {
    expect(uids("(&)")).toEqual(["alice", "admin"]);
    expect(uids("(|)")).toEqual([]);
    expect(uids("(cn=\\2a)")).toEqual([]); // a literal '*', not a wildcard
  });

  it("is lenient about trailing text — which is exactly what makes the classic injection work", () => {
    // username = admin)(&)   password = anything  ->  (&(uid=admin)(&))(userPassword=anything))
    const filter = `(&(uid=${"admin)(&)"})(userPassword=${"whatever"}))`;
    expect(uids(filter)).toEqual(["admin"]);
    // wildcard password
    expect(uids(`(&(uid=admin)(userPassword=*))`)).toEqual(["admin"]);
  });

  it("rejects malformed structure and bounds size/depth", () => {
    expect(() => parseFilter("uid=admin")).toThrow(LdapFilterError);
    expect(() => parseFilter("(&(uid=admin)")).toThrow(LdapFilterError);
    expect(() => parseFilter("(uid=ad(min)")).toThrow(LdapFilterError);
    expect(() => parseFilter("(" + "&(".repeat(40) + "uid=x" + ")".repeat(41))).toThrow(/too deeply/);
    expect(() => parseFilter("(uid=" + "a".repeat(500) + ")")).toThrow(/too long/);
  });
});

describe("XPath wrappers (real xpath + xmldom engines)", () => {
  const doc = parseXml(
    `<users><user><username>alice</username><password>pw-a</password><role>staff</role></user>` +
      `<user><username>admin</username><password>S3cret!</password><role>admin</role></user></users>`,
  );

  it("evaluates real XPath predicates", () => {
    const hit = xpathElements("//user[username='admin' and password='S3cret!']", doc);
    expect(hit).toHaveLength(1);
    expect(childText(hit[0]!, "role")).toBe("admin");
    expect(xpathElements("//user[username='admin' and password='nope']", doc)).toHaveLength(0);
  });

  it("is injectable the way real XPath is, and bounded", () => {
    const hit = xpathElements("//user[username='admin' or '1'='1' and password='x']", doc);
    expect(hit.map((e) => childText(e, "username"))).toContain("admin");
    expect(() => xpathElements("//user[" + "a".repeat(400) + "]", doc)).toThrow(/too long/);
    expect(() => xpathElements("//user[", doc)).toThrow();
  });
});

describe("small helpers", () => {
  it("boundedSleepMs really waits, ignores junk input, and caps a single call", () => {
    const t0 = Date.now();
    expect(boundedSleepMs(60)).toBe(60);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    expect(boundedSleepMs(-5)).toBe(0);
    expect(boundedSleepMs(Number.NaN)).toBe(0);
  });

  it("seededSecret is deterministic per token, differs between tokens, and uses the alphabet", () => {
    const a = { instanceToken: "token-a" } as unknown as LabContext;
    const b = { instanceToken: "token-b" } as unknown as LabContext;
    expect(seededSecret(a, "pin", 8)).toBe(seededSecret(a, "pin", 8));
    expect(seededSecret(a, "pin", 8)).not.toBe(seededSecret(b, "pin", 8));
    expect(seededSecret(a, "x", 12)).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{12}$/);
    expect(seededSecret(a, "pin", 6, "0123456789")).toMatch(/^\d{6}$/);
  });
});
