import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBraindump, closeBraindump } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "bin", "cli.js");

let project;
let dbDir;

function run(args) {
  return execFileSync("node", [CLI, ...args, "--project", project], { encoding: "utf8" });
}

async function rows(cypher) {
  const handle = await openBraindump(path.join(dbDir, "graph.lbdb"));
  const res = await handle.conn.query(cypher);
  const results = Array.isArray(res) ? res : [res];
  const out = [];
  for (const r of results) out.push(...(await r.getAll()));
  await closeBraindump(handle);
  return out;
}

beforeEach(() => {
  project = `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  dbDir = path.join(os.homedir(), ".agents", "braindump", project);
});

afterEach(() => {
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("braindump entity add", () => {
  it("creates an entity and prints its id", () => {
    const out = run([
      "entity",
      "add",
      "--name",
      "foo",
      "--file",
      "src/a.js",
      "--kind",
      "function",
      "--description",
      "does foo",
    ]);
    expect(out).toContain("src/a.js::foo");
  });
});

describe("braindump entity modify", () => {
  it("patches the description of an existing entity", async () => {
    run(["entity", "add", "--name", "foo", "--file", "src/a.js", "--kind", "function", "--description", "orig"]);
    run(["entity", "modify", "src/a.js::foo", "--description", "updated"]);

    const found = await rows(`MATCH (e:Entity {id: "src/a.js::foo"}) RETURN e.description`);
    expect(found).toEqual([{ "e.description": "updated" }]);
  });
});

describe("braindump entity delete", () => {
  it("removes the entity", async () => {
    run(["entity", "add", "--name", "foo", "--file", "src/a.js", "--kind", "function", "--description", "x"]);
    run(["entity", "delete", "src/a.js::foo"]);

    const found = await rows(`MATCH (e:Entity {id: "src/a.js::foo"}) RETURN e.id`);
    expect(found).toEqual([]);
  });
});

describe("braindump link add", () => {
  it("links two entities", async () => {
    run(["entity", "add", "--name", "a", "--file", "x.js", "--kind", "function", "--description", ""]);
    run(["entity", "add", "--name", "b", "--file", "x.js", "--kind", "function", "--description", ""]);

    run([
      "link",
      "add",
      "--from",
      "x.js::a",
      "--from-kind",
      "Entity",
      "--to",
      "x.js::b",
      "--to-kind",
      "Entity",
      "--type",
      "CALLS",
    ]);

    const found = await rows(
      `MATCH (:Entity {id: "x.js::a"})-[r:Link]->(:Entity {id: "x.js::b"}) RETURN r.type`
    );
    expect(found).toEqual([{ "r.type": "CALLS" }]);
  });
});

describe("braindump link modify", () => {
  it("retypes an existing link", async () => {
    run(["entity", "add", "--name", "a", "--file", "x.js", "--kind", "function", "--description", ""]);
    run(["entity", "add", "--name", "b", "--file", "x.js", "--kind", "function", "--description", ""]);
    run([
      "link",
      "add",
      "--from",
      "x.js::a",
      "--from-kind",
      "Entity",
      "--to",
      "x.js::b",
      "--to-kind",
      "Entity",
      "--type",
      "CALLS",
    ]);

    run([
      "link",
      "modify",
      "--from",
      "x.js::a",
      "--from-kind",
      "Entity",
      "--to",
      "x.js::b",
      "--to-kind",
      "Entity",
      "--match-type",
      "CALLS",
      "--new-type",
      "INVOKES",
    ]);

    const found = await rows(
      `MATCH (:Entity {id: "x.js::a"})-[r:Link]->(:Entity {id: "x.js::b"}) RETURN r.type`
    );
    expect(found).toEqual([{ "r.type": "INVOKES" }]);
  });
});

describe("braindump search", () => {
  it("finds a matching note and prints its content", () => {
    run(["add", "Ladybug is fun to use", "--kind", "learning"]);
    const out = run(["search", "ladybug"]);
    expect(out).toContain("Ladybug is fun to use");
  });

  it("finds a matching entity and prints its name", () => {
    run(["entity", "add", "--name", "openBraindump", "--file", "src/db.js", "--kind", "function", "--description", "opens the db"]);
    const out = run(["search", "openBraindump"]);
    expect(out).toContain("openBraindump");
  });

  it("reports no results found", () => {
    const out = run(["search", "nothing-matches-this-xyz"]);
    expect(out).toContain("No results");
  });
});

describe("braindump grep", () => {
  it("matches entity names by regex", () => {
    run(["entity", "add", "--name", "getUser", "--file", "a.js", "--kind", "function", "--description", ""]);
    run(["entity", "add", "--name", "deleteAccount", "--file", "a.js", "--kind", "function", "--description", ""]);

    const out = run(["grep", "^get"]);
    expect(out).toContain("getUser");
    expect(out).not.toContain("deleteAccount");
  });

  it("restricts to a field with --field", () => {
    run(["entity", "add", "--name", "thing", "--file", "special/path.js", "--kind", "function", "--description", "no match"]);

    const out = run(["grep", "special", "--field", "file"]);
    expect(out).toContain("thing");
  });

  it("reports no results found", () => {
    const out = run(["grep", "zzz-nomatch-zzz"]);
    expect(out).toContain("No results");
  });
});

describe("braindump link delete", () => {
  it("removes the matching link", async () => {
    run(["entity", "add", "--name", "a", "--file", "x.js", "--kind", "function", "--description", ""]);
    run(["entity", "add", "--name", "b", "--file", "x.js", "--kind", "function", "--description", ""]);
    run([
      "link",
      "add",
      "--from",
      "x.js::a",
      "--from-kind",
      "Entity",
      "--to",
      "x.js::b",
      "--to-kind",
      "Entity",
      "--type",
      "CALLS",
    ]);

    run([
      "link",
      "delete",
      "--from",
      "x.js::a",
      "--from-kind",
      "Entity",
      "--to",
      "x.js::b",
      "--to-kind",
      "Entity",
      "--type",
      "CALLS",
    ]);

    const found = await rows(`MATCH (:Entity {id: "x.js::a"})-[r:Link]->() RETURN r.type`);
    expect(found).toEqual([]);
  });
});
