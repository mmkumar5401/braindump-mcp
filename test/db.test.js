import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

let handle;

beforeAll(async () => {
  // Opening a fresh in-memory Database per test exhausts virtual address
  // space (each instance reserves a large mmap region) — share one instance
  // for the whole file and wipe its contents between tests instead.
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
  const results = Array.isArray(res) ? res : [res];
  const out = [];
  for (const r of results) out.push(...(await r.getAll()));
  return out;
}

describe("addNote", () => {
  it("creates a Note node with the given fields and returns its id", async () => {
    const id = await addNote(handle.conn, {
      content: "test note",
      kind: "learning",
      tags: ["a", "b"],
    });

    const found = await rows(`MATCH (n:Note {id: "${id}"}) RETURN n.content, n.kind, n.tags`);
    expect(found).toEqual([{ "n.content": "test note", "n.kind": "learning", "n.tags": ["a", "b"] }]);
  });

  it("defaults kind to 'note' and tags to empty array", async () => {
    const id = await addNote(handle.conn, { content: "minimal" });
    const found = await rows(`MATCH (n:Note {id: "${id}"}) RETURN n.kind, n.tags`);
    expect(found).toEqual([{ "n.kind": "note", "n.tags": [] }]);
  });
});

describe("addEntity", () => {
  it("creates an Entity with a deterministic id derived from file+name", async () => {
    const id = await addEntity(handle.conn, {
      name: "foo",
      file: "src/a.js",
      kind: "function",
      description: "does foo",
    });

    expect(id).toBe(entityId("src/a.js", "foo"));
    const found = await rows(`MATCH (e:Entity {id: "${id}"}) RETURN e.name, e.description`);
    expect(found).toEqual([{ "e.name": "foo", "e.description": "does foo" }]);
  });

  it("upserts on repeated calls for the same file+name instead of duplicating", async () => {
    await addEntity(handle.conn, { name: "foo", file: "src/a.js", kind: "function", description: "v1" });
    await addEntity(handle.conn, { name: "foo", file: "src/a.js", kind: "function", description: "v2" });

    const found = await rows(`MATCH (e:Entity) WHERE e.name = "foo" RETURN e.description`);
    expect(found).toHaveLength(1);
    expect(found[0]["e.description"]).toBe("v2");
  });
});

describe("addLink", () => {
  it("links two entities with a free-form type", async () => {
    const a = await addEntity(handle.conn, { name: "a", file: "x.js", kind: "function", description: "" });
    const b = await addEntity(handle.conn, { name: "b", file: "x.js", kind: "function", description: "" });

    await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });

    const found = await rows(
      `MATCH (:Entity {id: "${a}"})-[r:Link]->(:Entity {id: "${b}"}) RETURN r.type`
    );
    expect(found).toEqual([{ "r.type": "CALLS" }]);
  });

  it("links a Note to an Entity", async () => {
    const note = await addNote(handle.conn, { content: "doc" });
    const entity = await addEntity(handle.conn, { name: "b", file: "x.js", kind: "function", description: "" });

    await addLink(handle.conn, { fromId: note, fromKind: "Note", toId: entity, toKind: "Entity", type: "documents" });

    const found = await rows(
      `MATCH (:Note {id: "${note}"})-[r:Link]->(:Entity {id: "${entity}"}) RETURN r.type`
    );
    expect(found).toEqual([{ "r.type": "documents" }]);
  });

  it("rejects an invalid fromKind/toKind", async () => {
    await expect(
      addLink(handle.conn, { fromId: "x", fromKind: "Bogus", toId: "y", toKind: "Entity", type: "CALLS" })
    ).rejects.toThrow(/fromKind\/toKind must be one of/);
  });

  it("does not duplicate an edge on repeat calls with the same type", async () => {
    const a = await addEntity(handle.conn, { name: "a", file: "x.js", kind: "function", description: "" });
    const b = await addEntity(handle.conn, { name: "b", file: "x.js", kind: "function", description: "" });

    await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });
    await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });

    const found = await rows(`MATCH (:Entity {id: "${a}"})-[r:Link]->(:Entity {id: "${b}"}) RETURN r.type`);
    expect(found).toHaveLength(1);
  });
});

describe("modifyEntity", () => {
  it("patches only the given fields, leaving others untouched", async () => {
    const id = await addEntity(handle.conn, {
      name: "foo",
      file: "a.js",
      kind: "function",
      description: "orig",
    });

    await modifyEntity(handle.conn, id, { description: "updated" });

    const found = await rows(`MATCH (e:Entity {id: "${id}"}) RETURN e.name, e.description`);
    expect(found).toEqual([{ "e.name": "foo", "e.description": "updated" }]);
  });
});

describe("deleteEntity", () => {
  it("removes the entity and any links touching it", async () => {
    const a = await addEntity(handle.conn, { name: "a", file: "x.js", kind: "function", description: "" });
    const b = await addEntity(handle.conn, { name: "b", file: "x.js", kind: "function", description: "" });
    await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });

    await deleteEntity(handle.conn, b);

    expect(await rows(`MATCH (e:Entity {id: "${b}"}) RETURN e.id`)).toEqual([]);
    expect(await rows(`MATCH (:Entity {id: "${a}"})-[r:Link]->() RETURN r.type`)).toEqual([]);
  });
});

describe("modifyLink", () => {
  it("updates the type of an existing link", async () => {
    const a = await addEntity(handle.conn, { name: "a", file: "x.js", kind: "function", description: "" });
    const b = await addEntity(handle.conn, { name: "b", file: "x.js", kind: "function", description: "" });
    await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });

    await modifyLink(handle.conn, {
      fromId: a,
      fromKind: "Entity",
      toId: b,
      toKind: "Entity",
      matchType: "CALLS",
      newType: "INVOKES",
    });

    const found = await rows(`MATCH (:Entity {id: "${a}"})-[r:Link]->(:Entity {id: "${b}"}) RETURN r.type`);
    expect(found).toEqual([{ "r.type": "INVOKES" }]);
  });
});

describe("search", () => {
  it("finds notes whose content matches, case-insensitively", async () => {
    await addNote(handle.conn, { content: "Ladybug needs prepare+execute for params", kind: "gotcha" });
    await addNote(handle.conn, { content: "unrelated note about pizza", kind: "note" });

    const found = await search(handle.conn, "ladybug");
    expect(found.notes).toHaveLength(1);
    expect(found.notes[0].content).toContain("Ladybug");
  });

  it("finds notes by tag", async () => {
    await addNote(handle.conn, { content: "tagged note", kind: "note", tags: ["special-tag"] });
    const found = await search(handle.conn, "special-tag");
    expect(found.notes).toHaveLength(1);
  });

  it("finds entities whose name, description, or file matches", async () => {
    await addEntity(handle.conn, { name: "openBraindump", file: "src/db.js", kind: "function", description: "opens the db" });
    await addEntity(handle.conn, { name: "unrelatedThing", file: "src/other.js", kind: "function", description: "does nothing related" });

    const byName = await search(handle.conn, "openBraindump");
    expect(byName.entities).toHaveLength(1);
    expect(byName.entities[0].name).toBe("openBraindump");

    const byDescription = await search(handle.conn, "opens the db");
    expect(byDescription.entities).toHaveLength(1);
  });

  it("returns empty results for no matches", async () => {
    const found = await search(handle.conn, "nothing-matches-this-xyz");
    expect(found).toEqual({ notes: [], entities: [] });
  });
});

describe("grep", () => {
  it("matches entity names by regex pattern", async () => {
    await addEntity(handle.conn, { name: "getUser", file: "a.js", kind: "function", description: "" });
    await addEntity(handle.conn, { name: "setUser", file: "a.js", kind: "function", description: "" });
    await addEntity(handle.conn, { name: "deleteAccount", file: "a.js", kind: "function", description: "" });

    const found = await grep(handle.conn, "^get|^set");
    expect(found.entities.map((e) => e.name).sort()).toEqual(["getUser", "setUser"]);
  });

  it("matches note content by regex pattern", async () => {
    await addNote(handle.conn, { content: "TODO: fix the parser", kind: "todo" });
    await addNote(handle.conn, { content: "unrelated learning", kind: "learning" });

    const found = await grep(handle.conn, "^TODO:");
    expect(found.notes).toHaveLength(1);
    expect(found.notes[0].content).toMatch(/^TODO:/);
  });

  it("restricts matching to a single field when specified", async () => {
    await addEntity(handle.conn, { name: "thing", file: "special/path.js", kind: "function", description: "no match here" });

    const byFile = await grep(handle.conn, "special", { field: "file" });
    expect(byFile.entities).toHaveLength(1);

    const byDescription = await grep(handle.conn, "special", { field: "description" });
    expect(byDescription.entities).toHaveLength(0);
  });

  it("is case-insensitive by default", async () => {
    await addEntity(handle.conn, { name: "MyEntity", file: "a.js", kind: "function", description: "" });
    const found = await grep(handle.conn, "myentity");
    expect(found.entities).toHaveLength(1);
  });

  it("respects ignoreCase: false", async () => {
    await addEntity(handle.conn, { name: "MyEntity", file: "a.js", kind: "function", description: "" });
    const found = await grep(handle.conn, "myentity", { ignoreCase: false });
    expect(found.entities).toHaveLength(0);
  });

  it("returns empty results for no matches", async () => {
    const found = await grep(handle.conn, "zzz-nomatch-zzz");
    expect(found).toEqual({ notes: [], entities: [] });
  });
});

describe("deleteLink", () => {
  it("removes the matching link only", async () => {
    const a = await addEntity(handle.conn, { name: "a", file: "x.js", kind: "function", description: "" });
    const b = await addEntity(handle.conn, { name: "b", file: "x.js", kind: "function", description: "" });
    await addLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });

    await deleteLink(handle.conn, { fromId: a, fromKind: "Entity", toId: b, toKind: "Entity", type: "CALLS" });

    expect(await rows(`MATCH (:Entity {id: "${a}"})-[r:Link]->() RETURN r.type`)).toEqual([]);
  });
});
