import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database, Connection } from "@ladybugdb/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  openBraindump,
  closeBraindump,
  addNote,
  addEntity,
  addLink,
  modifyEntity,
  modifyNote,
  deleteNote,
  neighbors,
  listNodes,
  exportGraph,
  importGraph,
} from "../src/db.js";
import { hybridSearch } from "../src/retrieval.js";
import { setModels, EMBED_DIM } from "../src/embeddings.js";
import {
  addNoteTool,
  addEntityTool,
  searchTool,
  checkStaleTool,
  exportTool,
  importTool,
  setBackgroundEmbedding,
  flushBackgroundEmbeddings,
} from "../src/tools.js";
import { createBraindumpServer } from "../src/mcp-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "bin", "cli.js");

// ---------------------------------------------------------------- fake models
// Deterministic stand-ins so tests never download anything. The embedder
// maps a few synonyms onto one token, so "automobile" is semantically close
// to "car" while sharing no keyword with it.

const SYNONYMS = { automobile: "car", vehicle: "car", corrupted: "corrupt", corruption: "corrupt" };

function fakeVector(text) {
  const v = new Array(EMBED_DIM).fill(0);
  for (const raw of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const w = SYNONYMS[raw] ?? raw;
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % EMBED_DIM] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

let embedCalls = 0;
const fakeModels = {
  embed: async (texts) => {
    embedCalls += texts.length;
    return texts.map(fakeVector);
  },
  // Prefers documents mentioning "priority", so tests can see re-ranking.
  rerank: async (query, docs) => docs.map((d) => (d.includes("priority") ? 10 : 0)),
  // Bag-of-words cosine runs lower than a real model's.
  thresholds: { minSimilarity: 0.2, minRerankScore: -1 },
};

beforeAll(() => setModels(fakeModels));
afterAll(() => setModels(null));
beforeEach(() => {
  embedCalls = 0;
});

// ---------------------------------------------------------------- db-level features

describe("db features", () => {
  let handle;

  beforeAll(async () => {
    handle = await openBraindump(":memory:", { bufferPoolSize: 64 * 1024 * 1024 });
  });

  afterAll(async () => {
    await closeBraindump(handle);
  });

  beforeEach(async () => {
    const r = await handle.conn.query("MATCH (n) DETACH DELETE n");
    r.close();
  });

  async function rows(cypher) {
    const res = await handle.conn.query(cypher);
    const out = await res.getAll();
    res.close();
    return out;
  }

  const ent = (name, extra = {}) =>
    addEntity(handle.conn, { name, file: "src/a.js", kind: "function", description: `${name} desc`, ...extra });

  describe("modifyNote / deleteNote", () => {
    it("updates content, kind and tags and clears the stale embedding", async () => {
      const id = await addNote(handle.conn, { content: "old", kind: "todo", tags: ["x"] });
      await hybridSearch(handle.conn, "old"); // embeds it
      await modifyNote(handle.conn, id, { content: "new text", kind: "decision", tags: ["y", "z"] });
      const [n] = await rows(
        `MATCH (n:Note {id: "${id}"}) RETURN n.content AS content, n.kind AS kind, n.tags AS tags, n.embedding AS e, n.updatedAt AS u`
      );
      expect(n).toMatchObject({ content: "new text", kind: "decision", tags: ["y", "z"], e: null });
      expect(n.u).toBeGreaterThan(0);
    });

    it("throws for a missing note", async () => {
      await expect(modifyNote(handle.conn, "nope", { content: "x" })).rejects.toThrow(/Note "nope" not found/);
      await expect(deleteNote(handle.conn, "nope")).rejects.toThrow(/Note "nope" not found/);
    });

    it("deleteNote removes the note and its links", async () => {
      const id = await addNote(handle.conn, { content: "x" });
      const e = await ent("f");
      await addLink(handle.conn, { fromId: id, fromKind: "Note", toId: e, toKind: "Entity", type: "documents" });
      await deleteNote(handle.conn, id);
      expect(await rows(`MATCH (n:Note) RETURN count(n) AS n`)).toEqual([{ n: 0 }]);
      expect(await rows(`MATCH ()-[r:Link]->() RETURN count(r) AS n`)).toEqual([{ n: 0 }]);
    });
  });

  describe("embedding invalidation", () => {
    it("re-adding an entity with new text clears its embedding", async () => {
      const id = await ent("f");
      await hybridSearch(handle.conn, "f");
      await ent("f", { description: "changed" });
      expect(await rows(`MATCH (e:Entity {id: "${id}"}) RETURN e.embedding AS e`)).toEqual([{ e: null }]);
    });

    it("modifyEntity description change clears it; line change keeps it", async () => {
      const id = await ent("f");
      await hybridSearch(handle.conn, "f");
      await modifyEntity(handle.conn, id, { line: 42 });
      const [{ e }] = await rows(`MATCH (e:Entity {id: "${id}"}) RETURN e.embedding AS e`);
      expect(e).toHaveLength(EMBED_DIM);
      await modifyEntity(handle.conn, id, { description: "other" });
      expect(await rows(`MATCH (e:Entity {id: "${id}"}) RETURN e.embedding AS e`)).toEqual([{ e: null }]);
    });
  });

  describe("hybridSearch", () => {
    it("finds a semantically related note that shares no keyword", async () => {
      await addNote(handle.conn, { content: "the car engine overheats on long trips" });
      await addNote(handle.conn, { content: "unrelated cooking recipe" });
      const res = await hybridSearch(handle.conn, "automobile");
      expect(res.mode).toBe("hybrid");
      expect(res.notes[0].content).toMatch(/car engine/);
    });

    it("still finds exact identifiers inside longer names (substring)", async () => {
      await ent("openBraindump");
      const res = await hybridSearch(handle.conn, "Braindump");
      expect(res.entities.map((e) => e.name)).toContain("openBraindump");
    });

    it("re-ranks candidates with the cross-encoder", async () => {
      await addNote(handle.conn, { content: "database note one" });
      await addNote(handle.conn, { content: "database note two priority" });
      const res = await hybridSearch(handle.conn, "database");
      expect(res.notes[0].content).toMatch(/priority/);
      expect(res.reranked).toBe(true);
    });

    it("can skip re-ranking", async () => {
      await addNote(handle.conn, { content: "database note" });
      const res = await hybridSearch(handle.conn, "database", { rerank: false });
      expect(res.reranked).toBe(false);
    });

    it("backfills missing embeddings once and stores them", async () => {
      await addNote(handle.conn, { content: "a" });
      await addNote(handle.conn, { content: "b" });
      await hybridSearch(handle.conn, "a");
      const first = embedCalls;
      expect(await rows(`MATCH (n:Note) WHERE n.embedding IS NULL RETURN count(n) AS n`)).toEqual([{ n: 0 }]);
      await hybridSearch(handle.conn, "a");
      expect(embedCalls - first).toBe(1); // only the query this time
    });

    it("keyword mode never touches the models", async () => {
      await addNote(handle.conn, { content: "keyword only" });
      const res = await hybridSearch(handle.conn, "keyword", { mode: "keyword" });
      expect(res.mode).toBe("keyword");
      expect(res.notes).toHaveLength(1);
      expect(embedCalls).toBe(0);
    });

    it("falls back to keyword search when the embedder fails", async () => {
      await addNote(handle.conn, { content: "fallback works" });
      setModels({ ...fakeModels, embed: async () => { throw new Error("model download failed"); } });
      try {
        const res = await hybridSearch(handle.conn, "fallback");
        expect(res.mode).toBe("keyword");
        expect(res.degraded).toMatch(/model download failed/);
        expect(res.notes).toHaveLength(1);
      } finally {
        setModels(fakeModels);
      }
    });

    it("keeps results when the re-ranker fails", async () => {
      await addNote(handle.conn, { content: "rerank failure" });
      setModels({ ...fakeModels, rerank: async () => { throw new Error("boom"); } });
      try {
        const res = await hybridSearch(handle.conn, "rerank");
        expect(res.notes).toHaveLength(1);
        expect(res.reranked).toBe(false);
      } finally {
        setModels(fakeModels);
      }
    });

    it("respects limit and filters out unrelated noise", async () => {
      for (let i = 0; i < 30; i++) await addNote(handle.conn, { content: `database fact ${i}` });
      await addNote(handle.conn, { content: "zebra" });
      const res = await hybridSearch(handle.conn, "database", { limit: 5 });
      expect(res.notes).toHaveLength(5);
      expect(res.notes.every((n) => n.content.includes("database"))).toBe(true);
    });

    it("ignores stopwords in keyword matching", async () => {
      await addNote(handle.conn, { content: "serialize writes in tools.js" });
      const res = await hybridSearch(handle.conn, "weather in amsterdam", { mode: "keyword" });
      expect(res.notes).toHaveLength(0);
    });

    it("rejects an unknown mode", async () => {
      await expect(hybridSearch(handle.conn, "x", { mode: "magic" })).rejects.toThrow(/mode must be/);
    });

    it("searches 2,000 nodes quickly", async () => {
      const r = await handle.conn.query(
        `UNWIND range(1, 2000) AS i CREATE (:Note {id: "bulk-" + string(i), content: "bulk note number " + string(i), kind: "note", tags: [], createdAt: i})`
      );
      r.close();
      await hybridSearch(handle.conn, "warm up backfill");
      const t0 = performance.now();
      await hybridSearch(handle.conn, "bulk note 1234");
      expect(performance.now() - t0).toBeLessThan(1000);
    }, 60000);
  });

  describe("neighbors", () => {
    it("returns the node, its neighbours and links in both directions", async () => {
      const a = await ent("a");
      const b = await ent("b");
      const n = await addNote(handle.conn, { content: "about a" });
      await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });
      await addLink(handle.conn, { fromId: n, fromKind: "Note", toId: a, toKind: "Entity", type: "documents" });

      const res = await neighbors(handle.conn, a);
      expect(res.node).toMatchObject({ id: a, type: "entity", name: "a" });
      expect(res.nodes.map((x) => x.id).sort()).toEqual([b, n].sort());
      expect(res.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: a, to: b, type: "CALLS" }),
          expect.objectContaining({ from: n, to: a, type: "documents" }),
        ])
      );
      expect(res.node.embedding).toBeUndefined();
    });

    it("filters by direction and link type, and walks deeper", async () => {
      const a = await ent("a");
      const b = await ent("b");
      const c = await ent("c");
      await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });
      await addLink(handle.conn, { fromId: b, fromKind: "Entity", toId: c, toKind: "Entity", type: "CALLS" });
      await addLink(handle.conn, { fromId: c, fromKind: "Entity", toId: a, toKind: "Entity", type: "USES" });

      expect((await neighbors(handle.conn, a, { direction: "out" })).nodes.map((x) => x.id)).toEqual([b]);
      expect((await neighbors(handle.conn, a, { direction: "in" })).nodes.map((x) => x.id)).toEqual([c]);
      expect((await neighbors(handle.conn, a, { types: ["USES"] })).nodes.map((x) => x.id)).toEqual([c]);
      const deep = await neighbors(handle.conn, a, { direction: "out", depth: 2 });
      expect(deep.nodes.map((x) => x.id).sort()).toEqual([b, c].sort());
    });

    it("throws for a missing node and a bad depth", async () => {
      await expect(neighbors(handle.conn, "nope")).rejects.toThrow(/"nope" not found/);
      const a = await ent("a");
      await expect(neighbors(handle.conn, a, { depth: 9 })).rejects.toThrow(/depth must be/);
    });
  });

  describe("listNodes", () => {
    it("lists newest first with filters and paging", async () => {
      await addNote(handle.conn, { content: "n1", kind: "todo", tags: ["db"] });
      await new Promise((r) => setTimeout(r, 2));
      await addNote(handle.conn, { content: "n2", kind: "gotcha" });
      await ent("f", { file: "src/x.js" });
      await ent("g", { file: "lib/y.js" });

      const all = await listNodes(handle.conn);
      expect(all.total).toBe(4);
      expect(all.notes.map((n) => n.content)).toEqual(["n2", "n1"]);

      expect((await listNodes(handle.conn, { type: "note", kind: "todo" })).notes.map((n) => n.content)).toEqual(["n1"]);
      expect((await listNodes(handle.conn, { tag: "db" })).notes).toHaveLength(1);
      expect((await listNodes(handle.conn, { type: "entity", file: "src/" })).entities.map((e) => e.name)).toEqual(["f"]);
      const page = await listNodes(handle.conn, { type: "note", limit: 1, offset: 1 });
      expect(page.notes.map((n) => n.content)).toEqual(["n1"]);
      expect(page.total).toBe(2);
    });
  });

  describe("export / import", () => {
    it("round-trips notes, entities and links, without embeddings", async () => {
      const a = await ent("a");
      const b = await ent("b");
      const n = await addNote(handle.conn, { content: "x", tags: ["t"] });
      await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });
      await addLink(handle.conn, { fromId: n, fromKind: "Note", toId: a, toKind: "Entity", type: "documents" });
      await hybridSearch(handle.conn, "x");

      const data = await exportGraph(handle.conn);
      expect(data.version).toBe(1);
      expect(JSON.stringify(data)).not.toMatch(/embedding/);

      await (await handle.conn.query("MATCH (n) DETACH DELETE n")).close();
      const counts = await importGraph(handle.conn, data);
      expect(counts).toEqual({ notes: 1, entities: 2, links: 2 });
      await importGraph(handle.conn, data); // idempotent
      expect(await rows(`MATCH (n) RETURN count(n) AS n`)).toEqual([{ n: 3 }]);
      expect(await rows(`MATCH ()-[r:Link]->() RETURN count(r) AS n`)).toEqual([{ n: 2 }]);
    });

    it("rejects malformed data without writing anything", async () => {
      await expect(importGraph(handle.conn, { version: 1, notes: [{ id: 1 }], entities: [], links: [] })).rejects.toThrow(
        /Invalid import/
      );
      await expect(importGraph(handle.conn, { version: 2 })).rejects.toThrow(/Invalid import/);
      const good = { version: 1, notes: [{ id: "n", content: "c", kind: "note", tags: [], createdAt: 1 }], entities: [], links: [
        { fromKind: "Note", fromId: "n", toKind: "Entity", toId: "missing::x", type: "X" },
      ] };
      await expect(importGraph(handle.conn, good)).rejects.toThrow(/not found/);
      expect(await rows(`MATCH (n) RETURN count(n) AS n`)).toEqual([{ n: 0 }]); // rolled back
    });
  });
});

// ---------------------------------------------------------------- schema migration

describe("schema migration", () => {
  it("adds the new columns to a database created by the old schema, keeping data", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "braindump-migrate-"));
    const dbPath = path.join(dir, "graph.lbdb");
    const db = new Database(dbPath, 64 * 1024 * 1024);
    const conn = new Connection(db);
    await conn.init();
    for (const q of [
      `CREATE NODE TABLE Note(id STRING PRIMARY KEY, content STRING, kind STRING, tags STRING[], createdAt INT64)`,
      `CREATE NODE TABLE Entity(id STRING PRIMARY KEY, name STRING, kind STRING, file STRING, line INT64, language STRING, description STRING, commitSha STRING, createdAt INT64, updatedAt INT64)`,
      `CREATE REL TABLE Link(FROM Note TO Note, FROM Note TO Entity, FROM Entity TO Note, FROM Entity TO Entity, type STRING, commitSha STRING, createdAt INT64)`,
      `CREATE (:Note {id: "old", content: "legacy note", kind: "note", tags: [], createdAt: 1})`,
    ]) {
      (await conn.query(q)).close();
    }
    await conn.close();
    await db.close();

    const h = await openBraindump(dbPath);
    try {
      const res = await hybridSearch(h.conn, "legacy");
      expect(res.notes.map((n) => n.id)).toEqual(["old"]);
      await modifyNote(h.conn, "old", { content: "legacy note edited" });
    } finally {
      await closeBraindump(h);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- tools-level features

describe("tools features", () => {
  let project;
  let dbDir;

  beforeEach(() => {
    project = `features-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbDir = path.join(os.homedir(), ".agents", "braindump", project);
  });

  afterEach(() => {
    setBackgroundEmbedding(false);
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("background embedding fills embeddings after a write, without delaying it", async () => {
    setBackgroundEmbedding(true);
    await addNoteTool({ project, content: "embedded later" });
    expect(embedCalls).toBe(0); // the write itself did not embed
    await flushBackgroundEmbeddings();
    expect(embedCalls).toBe(1);
    const before = embedCalls;
    await searchTool({ project, query: "embedded" });
    expect(embedCalls - before).toBe(1); // just the query
  });

  it("export defaults to a timestamped backup file and import restores it", async () => {
    await addNoteTool({ project, content: "keep me" });
    const { path: file, counts } = await exportTool({ project });
    expect(file.startsWith(path.join(dbDir, "backups"))).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(counts.notes).toBe(1);

    const other = `${project}-restored`;
    try {
      const res = await importTool({ project: other, path: file });
      expect(res.counts).toEqual({ notes: 1, entities: 0, links: 0 });
      expect((await searchTool({ project: other, query: "keep", mode: "keyword" })).notes).toHaveLength(1);
    } finally {
      fs.rmSync(path.join(os.homedir(), ".agents", "braindump", other), { recursive: true, force: true });
    }
  });

  it("import reports a clear error for a missing or invalid file", async () => {
    await expect(importTool({ project, path: "/nonexistent/x.json" })).rejects.toThrow(/Cannot read/);
    const bad = path.join(os.tmpdir(), `bd-bad-${Date.now()}.json`);
    fs.writeFileSync(bad, "{not json");
    await expect(importTool({ project, path: bad })).rejects.toThrow(/not valid JSON/);
    fs.rmSync(bad);
  });

  describe("checkStaleTool", () => {
    let repo;
    let prev;

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), "bd-stale-"));
      const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo });
      git("init", "-q");
      fs.mkdirSync(path.join(repo, "src"));
      for (const f of ["a.js", "b.js", "c.js"]) fs.writeFileSync(path.join(repo, "src", f), `// ${f}\n`);
      git("add", ".");
      git("commit", "-q", "-m", "init");
      prev = process.cwd();
      process.chdir(repo);
      project = path.basename(repo);
      dbDir = path.join(os.homedir(), ".agents", "braindump", project);
    });

    afterEach(() => {
      process.chdir(prev);
      fs.rmSync(repo, { recursive: true, force: true });
    });

    it("classifies entities as stale (changed/deleted), fresh, or unknown", async () => {
      for (const f of ["a", "b", "c"]) {
        await addEntityTool({ project, name: f, file: `src/${f}.js`, kind: "function", description: "" });
      }
      fs.appendFileSync(path.join(repo, "src", "a.js"), "changed\n");
      fs.rmSync(path.join(repo, "src", "b.js"));
      // An entity recorded from another project's cwd has no SHA.
      await addEntityTool({ project, name: "z", file: "src/z.js", kind: "function", description: "" }).then(() =>
        modifyEntityShaToNull(project, "src/z.js::z")
      );

      const res = await checkStaleTool({ project });
      expect(res.stale).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "src/a.js::a", reason: "changed" }),
          expect.objectContaining({ id: "src/b.js::b", reason: "deleted" }),
        ])
      );
      expect(res.stale).toHaveLength(2);
      expect(res.fresh).toBe(1);
      expect(res.unknown).toEqual(["src/z.js::z"]);
    });

    it("refuses to check a project that is not the current repo", async () => {
      await expect(checkStaleTool({ project: "some-other-project" })).rejects.toThrow(/run it from inside/);
    });
  });
});

async function modifyEntityShaToNull(project, id) {
  const h = await openBraindump(path.join(os.homedir(), ".agents", "braindump", project, "graph.lbdb"));
  try {
    const r = await h.conn.query(`MATCH (e:Entity {id: "${id}"}) SET e.commitSha = NULL`);
    r.close();
  } finally {
    await closeBraindump(h);
  }
}

// ---------------------------------------------------------------- MCP + CLI surface

describe("MCP surface", () => {
  let client;
  let project;

  beforeEach(async () => {
    project = `features-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const server = createBraindumpServer();
    client = new Client({ name: "t", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(path.join(os.homedir(), ".agents", "braindump", project), { recursive: true, force: true });
  });

  it("exposes the new tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["modify_note", "delete_note", "neighbors", "list", "check_stale", "export", "import"]) {
      expect(names).toContain(t);
    }
  });

  it("search takes mode/limit and reports how it ran", async () => {
    await client.callTool({ name: "add_note", arguments: { project, content: "the car engine" } });
    const res = await client.callTool({ name: "search", arguments: { project, query: "automobile", limit: 3 } });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.mode).toBe("hybrid");
    expect(parsed.notes[0].content).toBe("the car engine");
  });
});

describe("CLI surface", () => {
  let project;

  beforeEach(() => {
    project = `features-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    fs.rmSync(path.join(os.homedir(), ".agents", "braindump", project), { recursive: true, force: true });
  });

  const run = (...args) =>
    execFileSync("node", [CLI, ...args, "--project", project], {
      encoding: "utf8",
      env: { ...process.env, BRAINDUMP_MODELS: "off" },
    });

  it("note modify/delete, list, neighbors, export and import work end to end", () => {
    const id = run("add", "first note").match(/Added note (\S+)/)[1];
    run("entity", "add", "--name", "f", "--file", "a.js", "--kind", "function");
    run("link", "add", "--from", id, "--from-kind", "Note", "--to", "a.js::f", "--to-kind", "Entity", "--type", "documents");

    expect(run("note", "modify", id, "--content", "edited note")).toMatch(/Modified note/);
    expect(run("list")).toMatch(/edited note/);
    expect(run("neighbors", "a.js::f")).toMatch(/documents/);

    const out = run("export");
    const file = out.match(/Exported .* to (\S+\.json)/)[1];
    expect(fs.existsSync(file)).toBe(true);

    expect(run("note", "delete", id)).toMatch(/Deleted note/);
    expect(run("import", file)).toMatch(/Imported 1 notes, 1 entities, 1 links/);
    expect(run("search", "edited")).toMatch(/edited note/);
  });
});
