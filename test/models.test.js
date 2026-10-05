import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openBraindump, closeBraindump, addNote, addEntity } from "../src/db.js";
import { hybridSearch } from "../src/retrieval.js";
import { setModels } from "../src/embeddings.js";

// Real-model quality and latency check. Downloads ~130 MB on first run, so
// it only runs when asked:  BRAINDUMP_MODEL_TESTS=1 npx vitest run test/models.test.js
const enabled = process.env.BRAINDUMP_MODEL_TESTS === "1";

const NOTES = [
  ["gotcha", "Concurrent add_entity calls against the same Ladybug db can crash the native module mid-write and corrupt the file", ["ladybug"]],
  ["decision", "Serialize all writes per project with a promise-chain queue in tools.js", []],
  ["learning", "Unclosed QueryResults keep the database file lock held until garbage collection", ["locks"]],
  ["todo", "Add a README describing the MCP tools and CLI commands", []],
  ["preference", "User wants tests written first (TDD) and run red before implementing", []],
];
const ENTITIES = [
  ["openBraindump", "src/db.js", "function", "Opens the Ladybug database, applies the schema, retries while another process holds the lock"],
  ["hybridSearch", "src/retrieval.js", "function", "Keyword BM25 plus semantic embedding search fused with reciprocal rank fusion, then cross-encoder re-ranking"],
  ["dbPathFor", "src/project.js", "function", "Resolves the per-project database path under ~/.agents/braindump and rejects path traversal"],
  ["checkStaleTool", "src/tools.js", "function", "Compares each entity's file against the commit it was described at using git diff"],
  ["BraindumpError", "src/errors.js", "class", "Expected user-facing failure; CLI prints only its message"],
];

// Paraphrased questions: no keyword overlap needed to find the answer.
const QUESTIONS = [
  ["why does the database get corrupted", "Concurrent add_entity"],
  ["how are writes kept from overlapping", "Serialize all writes"],
  ["file stays locked after closing", "Unclosed QueryResults"],
  ["documentation still missing", "Add a README"],
  ["how should I work with this user", "tests written first"],
  ["where is the db opened", "openBraindump"],
  ["how does search rank results", "hybridSearch"],
  ["prevent writing outside the home folder", "dbPathFor"],
  ["detect outdated descriptions of code", "checkStaleTool"],
];

const label = (r) => r.notes[0]?.content ?? r.entities[0]?.name ?? "";
const top = (r) => {
  // The overall top hit is whichever list's first item scored higher.
  const n = r.notes[0];
  const e = r.entities[0];
  if (!n) return e?.name ?? "";
  if (!e) return n.content;
  return n.score >= e.score ? n.content : e.name;
};

describe.skipIf(!enabled)("real models", () => {
  let handle;
  const prevEnv = process.env.BRAINDUMP_MODELS;

  beforeAll(async () => {
    setModels(null);
    process.env.BRAINDUMP_MODELS = "on";
    handle = await openBraindump(":memory:", { bufferPoolSize: 128 * 1024 * 1024 });
    for (const [kind, content, tags] of NOTES) await addNote(handle.conn, { kind, content, tags });
    for (const [name, file, kind, description] of ENTITIES) {
      await addEntity(handle.conn, { name, file, kind, description });
    }
    await hybridSearch(handle.conn, "warm up"); // load models + backfill
  }, 180000);

  afterAll(async () => {
    process.env.BRAINDUMP_MODELS = prevEnv;
    await closeBraindump(handle);
  });

  it("puts the right answer first for paraphrased questions (>= 8 of 9)", async () => {
    const misses = [];
    for (const [q, want] of QUESTIONS) {
      const res = await hybridSearch(handle.conn, q, { limit: 5 });
      expect(res.mode).toBe("hybrid");
      if (!top(res).includes(want)) misses.push(`${q} -> ${top(res)}`);
    }
    expect(misses.length, misses.join("\n")).toBeLessThanOrEqual(1);
  });

  it("finds exact identifiers first", async () => {
    const res = await hybridSearch(handle.conn, "dbPathFor");
    expect(top(res)).toBe("dbPathFor");
  });

  it("returns nothing for clearly unrelated questions", async () => {
    for (const q of ["chocolate cake recipe", "weather in Amsterdam tomorrow"]) {
      const res = await hybridSearch(handle.conn, q);
      expect(res.notes.length + res.entities.length, `${q} -> ${label(res)}`).toBe(0);
    }
  });

  it("answers a warm hybrid search quickly", async () => {
    const t0 = performance.now();
    await hybridSearch(handle.conn, "why does the database get corrupted");
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it("stays fast with 2,000 nodes", async () => {
    const r = await handle.conn.query(
      `UNWIND range(1, 2000) AS i CREATE (:Note {id: "bulk-" + string(i), content: "bulk observation number " + string(i) + " about module " + string(i % 37), kind: "note", tags: [], createdAt: i})`
    );
    r.close();
    const tb = performance.now();
    await hybridSearch(handle.conn, "warm up backfill");
    const backfillMs = performance.now() - tb;
    const t0 = performance.now();
    await hybridSearch(handle.conn, "which module had observation 1234");
    const searchMs = performance.now() - t0;
    console.log(`backfill of 2,000 notes: ${backfillMs.toFixed(0)} ms; warm search over 2,010: ${searchMs.toFixed(0)} ms`);
    expect(searchMs).toBeLessThan(800);
  }, 180000);
});
