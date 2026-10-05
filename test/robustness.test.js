import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  openBraindump,
  closeBraindump,
  addNote,
  addEntity,
  addLink,
  modifyEntity,
  deleteEntity,
  modifyLink,
  deleteLink,
  entityId,
  search,
  grep,
} from "../src/db.js";
import { dbPathFor } from "../src/project.js";
import { initTool, addNoteTool, addEntityTool, searchTool, __enqueueForTesting } from "../src/tools.js";
import { createBraindumpServer } from "../src/mcp-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");

// ---------------------------------------------------------------- db layer

describe("db layer: no silent no-ops, no duplicates, no bad values", () => {
  let handle;

  beforeAll(async () => {
    handle = await openBraindump(":memory:", { bufferPoolSize: 64 * 1024 * 1024 });
  });

  afterAll(async () => {
    await closeBraindump(handle);
  });

  beforeEach(async () => {
    await handle.conn.query("MATCH (n) DETACH DELETE n");
  });

  async function rows(cypher) {
    const res = await handle.conn.query(cypher);
    return res.getAll();
  }

  const fn = (name, file = "a.js") =>
    addEntity(handle.conn, { name, file, kind: "function", description: `${name} desc` });

  describe("addLink", () => {
    it("throws when the target node does not exist", async () => {
      const a = await fn("a");
      await expect(
        addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: "nope", toKind: "Entity", type: "CALLS" })
      ).rejects.toThrow(/Entity "nope" not found/);
    });

    it("throws when the source node does not exist", async () => {
      const a = await fn("a");
      await expect(
        addLink(handle.conn, { fromId: "ghost", fromKind: "Note", toId: a, toKind: "Entity", type: "documents" })
      ).rejects.toThrow(/Note "ghost" not found/);
    });
  });

  describe("modifyEntity", () => {
    it("throws for an id that does not exist", async () => {
      await expect(modifyEntity(handle.conn, "missing::x", { description: "x" })).rejects.toThrow(
        /Entity "missing::x" not found/
      );
    });

    it("re-keys the entity when name changes, keeping every link", async () => {
      const a = await fn("a");
      const b = await fn("b");
      const note = await addNote(handle.conn, { content: "about a" });
      await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });
      await addLink(handle.conn, { fromId: b, fromKind: "Entity", toId: a, toKind: "Entity", type: "CALLED_BY" });
      await addLink(handle.conn, { fromId: note, fromKind: "Note", toId: a, toKind: "Entity", type: "documents" });
      await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: a, toKind: "Entity", type: "RECURSES" });

      const newId = await modifyEntity(handle.conn, a, { name: "renamed" });
      expect(newId).toBe(entityId("a.js", "renamed"));

      const ents = await rows(`MATCH (e:Entity) RETURN e.id AS id, e.name AS name ORDER BY id`);
      expect(ents).toEqual([
        { id: "a.js::b", name: "b" },
        { id: "a.js::renamed", name: "renamed" },
      ]);

      const links = await rows(
        `MATCH (x)-[r:Link]->(y) RETURN x.id AS f, r.type AS t, y.id AS to ORDER BY t`
      );
      expect(links).toEqual([
        { f: "a.js::b", t: "CALLED_BY", to: "a.js::renamed" },
        { f: "a.js::renamed", t: "CALLS", to: "a.js::b" },
        { f: "a.js::renamed", t: "RECURSES", to: "a.js::renamed" },
        { f: note, t: "documents", to: "a.js::renamed" },
      ]);
    });

    it("does not create a duplicate when the renamed symbol is added again", async () => {
      const a = await fn("a");
      await modifyEntity(handle.conn, a, { name: "bar" });
      await fn("bar");
      const [{ n }] = await rows(`MATCH (e:Entity) RETURN count(e) AS n`);
      expect(n).toBe(1);
    });

    it("re-keys when file changes", async () => {
      const a = await fn("a");
      const newId = await modifyEntity(handle.conn, a, { file: "b.js" });
      expect(newId).toBe("b.js::a");
      const ents = await rows(`MATCH (e:Entity) RETURN e.id AS id, e.file AS file`);
      expect(ents).toEqual([{ id: "b.js::a", file: "b.js" }]);
    });

    it("refuses a rename onto an existing entity", async () => {
      const a = await fn("a");
      await fn("b");
      await expect(modifyEntity(handle.conn, a, { name: "b" })).rejects.toThrow(/already exists/);
      const [{ n }] = await rows(`MATCH (e:Entity) RETURN count(e) AS n`);
      expect(n).toBe(2);
    });

    it("rejects a non-integer line", async () => {
      const a = await fn("a");
      await expect(modifyEntity(handle.conn, a, { line: 1.5 })).rejects.toThrow(/line must be/);
      await expect(modifyEntity(handle.conn, a, { line: NaN })).rejects.toThrow(/line must be/);
    });
  });

  describe("addEntity", () => {
    it("rejects a non-integer line", async () => {
      await expect(
        addEntity(handle.conn, { name: "a", file: "a.js", kind: "function", description: "", line: 2.5 })
      ).rejects.toThrow(/line must be/);
    });
  });

  describe("deleteEntity", () => {
    it("throws for an id that does not exist", async () => {
      await expect(deleteEntity(handle.conn, "missing::x")).rejects.toThrow(/Entity "missing::x" not found/);
    });
  });

  describe("modifyLink / deleteLink", () => {
    it("modifyLink throws when the link does not exist", async () => {
      const a = await fn("a");
      const b = await fn("b");
      await expect(
        modifyLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", matchType: "CALLS", newType: "USES" })
      ).rejects.toThrow(/Link .* not found/);
    });

    it("modifyLink refuses to retype onto a link that already exists", async () => {
      const a = await fn("a");
      const b = await fn("b");
      await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });
      await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "USES" });
      await expect(
        modifyLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", matchType: "CALLS", newType: "USES" })
      ).rejects.toThrow(/already exists/);
    });

    it("deleteLink throws when the link does not exist", async () => {
      const a = await fn("a");
      const b = await fn("b");
      await expect(
        deleteLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" })
      ).rejects.toThrow(/Link .* not found/);
    });
  });

  describe("search", () => {
    it("rejects an empty query instead of silently matching nothing", async () => {
      await fn("a");
      await expect(search(handle.conn, "   ")).rejects.toThrow(/query must not be empty/);
    });
  });

  describe("grep", () => {
    it("throws a clear error for an unknown field", async () => {
      await expect(grep(handle.conn, "x", { field: "tagz" })).rejects.toThrow(/Unknown field "tagz"/);
    });

    it("throws a clear error for an invalid regex", async () => {
      await expect(grep(handle.conn, "(unclosed")).rejects.toThrow(/Invalid regex/);
    });
  });
});

// ---------------------------------------------------------------- project paths

describe("dbPathFor: project name cannot escape the braindump folder", () => {
  for (const bad of ["../../escape", "..", ".", "", "a/b", "a\\b", "nul\0byte"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => dbPathFor(bad)).toThrow(/Invalid project name/);
    });
  }

  it("accepts ordinary folder names, including spaces and dots", () => {
    const name = `ok name.v2-${Date.now()}`;
    const p = dbPathFor(name);
    expect(p).toBe(path.join(os.homedir(), ".agents", "braindump", name, "graph.lbdb"));
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- tools layer

describe("tools layer", () => {
  let project;
  let dbDir;

  beforeEach(() => {
    project = `robust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbDir = path.join(os.homedir(), ".agents", "braindump", project);
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("initTool waits its turn in the per-project queue", async () => {
    const order = [];
    const hold = __enqueueForTesting(project, async () => {
      await new Promise((r) => setTimeout(r, 100));
      order.push("held-call-done");
    });
    const init = initTool({ project }).then(() => order.push("init-done"));
    await Promise.all([hold, init]);
    expect(order).toEqual(["held-call-done", "init-done"]);
  });

  it("retries while another process holds the database lock", async () => {
    await initTool({ project });
    const dbPath = path.join(dbDir, "graph.lbdb");
    // A separate process opens the db and holds it for ~1.5 s.
    const holder = spawn(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { openBraindump, closeBraindump } from ${JSON.stringify(path.join(ROOT, "src", "db.js"))};
         const h = await openBraindump(${JSON.stringify(dbPath)});
         console.log("locked");
         await new Promise((r) => setTimeout(r, 1500));
         await closeBraindump(h);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    const exited = new Promise((resolve) => holder.once("exit", resolve));
    await new Promise((resolve) => holder.stdout.once("data", resolve));

    const { id } = await addNoteTool({ project, content: "written while locked" });
    expect(id).toBeTruthy();
    await exited;

    const found = await searchTool({ project, query: "written while locked" });
    expect(found.notes).toHaveLength(1);
  }, 20000);

  it("releases the file lock as soon as a handle is closed (every operation)", async () => {
    const dbPath = path.join(dbDir, "graph.lbdb");
    fs.mkdirSync(dbDir, { recursive: true });
    const h = await openBraindump(dbPath);
    const note = await addNote(h.conn, { content: "n", tags: ["t"] });
    const a = await addEntity(h.conn, { name: "a", file: "f.js", kind: "function", description: "d" });
    const b = await addEntity(h.conn, { name: "b", file: "f.js", kind: "function", description: "d" });
    await addLink(h.conn, { fromId: note, fromKind: "Note", toId: a, toKind: "Entity", type: "documents" });
    await addLink(h.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });
    await modifyLink(h.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", matchType: "CALLS", newType: "USES" });
    await modifyEntity(h.conn, a, { description: "d2" });
    const renamed = await modifyEntity(h.conn, a, { name: "a2" });
    await search(h.conn, "d");
    await grep(h.conn, "d");
    await deleteLink(h.conn, { fromId: renamed, fromKind: "Entity", toId: b, toKind: "Entity", type: "USES" });
    await deleteEntity(h.conn, b);
    await closeBraindump(h);

    // Another process must get the lock immediately — no waiting on GC.
    const out = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { openBraindump, closeBraindump } from ${JSON.stringify(path.join(ROOT, "src", "db.js"))};
         const h = await openBraindump(${JSON.stringify(dbPath)}, { lockTimeoutMs: 0 });
         await closeBraindump(h);
         console.log("opened");`,
      ],
      { encoding: "utf8" }
    );
    expect(out.trim()).toBe("opened");
  });

  it("gives up with a clear error once the lock wait times out, and can open again after", async () => {
    await initTool({ project });
    const dbPath = path.join(dbDir, "graph.lbdb");
    const holder = spawn(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { openBraindump } from ${JSON.stringify(path.join(ROOT, "src", "db.js"))};
         await openBraindump(${JSON.stringify(dbPath)});
         console.log("locked");
         process.stdin.resume();
         process.stdin.on("end", () => process.exit(0));`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] }
    );
    const exited = new Promise((resolve) => holder.once("exit", resolve));
    await new Promise((resolve) => holder.stdout.once("data", resolve));

    // Many failed attempts in a row must not leak native handles.
    for (let i = 0; i < 3; i++) {
      await expect(openBraindump(dbPath, { lockTimeoutMs: 300 })).rejects.toThrow(/locked by another process/);
    }

    holder.stdin.end();
    await exited;
    const handle = await openBraindump(dbPath);
    await closeBraindump(handle);
  }, 20000);

  it("does not stamp the server's commit SHA onto a different project", async () => {
    // Stand in a repo WITH a commit, then write to a different project.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "braindump-sha-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], {
      cwd: repo,
    });
    const prev = process.cwd();
    process.chdir(repo);
    let id;
    try {
      ({ id } = await addEntityTool({ project, name: "f", file: "x.js", kind: "function", description: "" }));
    } finally {
      process.chdir(prev);
      fs.rmSync(repo, { recursive: true, force: true });
    }
    const handle = await openBraindump(path.join(dbDir, "graph.lbdb"));
    const res = await handle.conn.query(`MATCH (e:Entity {id: "${id}"}) RETURN e.commitSha AS sha`);
    const [{ sha }] = await res.getAll();
    await closeBraindump(handle);
    expect(sha).toBeNull();
  });
});

// ---------------------------------------------------------------- MCP server

describe("MCP server", () => {
  let project;
  let dbDir;
  let client;

  beforeEach(async () => {
    project = `robust-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbDir = path.join(os.homedir(), ".agents", "braindump", project);
    const server = createBraindumpServer();
    client = new Client({ name: "t", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("rejects a fractional line number", async () => {
    const result = await client.callTool({
      name: "add_entity",
      arguments: { project, name: "f", file: "x.js", kind: "function", description: "", line: 1.5 },
    });
    expect(result.isError).toBe(true);
  });

  it("returns a tool error (not a crash) for a link to a missing node", async () => {
    const result = await client.callTool({
      name: "add_link",
      arguments: { project, fromId: "a", fromKind: "Note", toId: "b", toKind: "Note", type: "x" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });

  it("returns a tool error for a path-traversal project name", async () => {
    const result = await client.callTool({ name: "init", arguments: { project: "../../evil" } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid project name/);
  });

  it("modify_entity reports the new id after a rename", async () => {
    await client.callTool({
      name: "add_entity",
      arguments: { project, name: "old", file: "x.js", kind: "function", description: "" },
    });
    const result = await client.callTool({
      name: "modify_entity",
      arguments: { project, id: "x.js::old", name: "new" },
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ id: "x.js::new", previousId: "x.js::old" });
  });
});

// ---------------------------------------------------------------- CLI

describe("CLI", () => {
  let project;
  let dbDir;

  beforeEach(() => {
    project = `robust-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbDir = path.join(os.homedir(), ".agents", "braindump", project);
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function runExpectingFailure(args) {
    try {
      execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      return { status: err.status, stderr: err.stderr };
    }
    throw new Error("expected the CLI to fail");
  }

  it("prints a one-line error and exits 1 for a link to a missing node", () => {
    const { status, stderr } = runExpectingFailure([
      "link", "add", "--from", "a", "--from-kind", "Note", "--to", "b", "--to-kind", "Note",
      "--type", "x", "--project", project,
    ]);
    expect(status).toBe(1);
    expect(stderr.trim()).toMatch(/^braindump: Note "a" not found/);
    expect(stderr).not.toMatch(/\n\s+at /); // no stack trace
  });

  it("rejects a non-numeric --line with exit 1", () => {
    const { status, stderr } = runExpectingFailure([
      "entity", "add", "--name", "f", "--file", "x.js", "--kind", "function",
      "--line", "abc", "--project", project,
    ]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/line/i);
  });
});
