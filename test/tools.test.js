import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initTool,
  addNoteTool,
  addEntityTool,
  modifyEntityTool,
  deleteEntityTool,
  addLinkTool,
  modifyLinkTool,
  deleteLinkTool,
  searchTool,
  grepTool,
} from "../src/tools.js";

let project;
let dbDir;

beforeEach(() => {
  project = `tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  dbDir = path.join(os.homedir(), ".agents", "braindump", project);
});

afterEach(() => {
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("initTool", () => {
  it("creates the db directory and returns the project and dbPath", async () => {
    const result = await initTool({ project });
    expect(result.project).toBe(project);
    expect(result.dbPath).toBe(path.join(dbDir, "graph.lbdb"));
    expect(fs.existsSync(dbDir)).toBe(true);
  });

  it("is idempotent — can be called twice without error", async () => {
    await initTool({ project });
    await expect(initTool({ project })).resolves.toBeTruthy();
  });
});

describe("addNoteTool", () => {
  it("creates a note and returns its id", async () => {
    const result = await addNoteTool({ project, content: "hello", kind: "learning", tags: ["x"] });
    expect(result.id).toBeTruthy();

    const found = await searchTool({ project, query: "hello" });
    expect(found.notes).toHaveLength(1);
  });
});

describe("addEntityTool / modifyEntityTool / deleteEntityTool", () => {
  it("round-trips create, modify, delete", async () => {
    const { id } = await addEntityTool({
      project,
      name: "foo",
      file: "a.js",
      kind: "function",
      description: "orig",
    });
    expect(id).toBe("a.js::foo");

    await modifyEntityTool({ project, id, description: "updated" });
    let found = await searchTool({ project, query: "updated" });
    expect(found.entities).toHaveLength(1);

    await deleteEntityTool({ project, id });
    found = await searchTool({ project, query: "updated" });
    expect(found.entities).toHaveLength(0);
  });
});

describe("addLinkTool / modifyLinkTool / deleteLinkTool", () => {
  it("round-trips create, modify, delete of a link", async () => {
    const a = await addEntityTool({ project, name: "a", file: "x.js", kind: "function", description: "" });
    const b = await addEntityTool({ project, name: "b", file: "x.js", kind: "function", description: "" });

    await addLinkTool({
      project,
      fromId: a.id,
      fromKind: "Entity",
      toId: b.id,
      toKind: "Entity",
      type: "CALLS",
    });

    await modifyLinkTool({
      project,
      fromId: a.id,
      fromKind: "Entity",
      toId: b.id,
      toKind: "Entity",
      matchType: "CALLS",
      newType: "INVOKES",
    });

    const grepped = await grepTool({ project, pattern: "^a$", field: "name" });
    expect(grepped.entities).toHaveLength(1);

    await deleteLinkTool({
      project,
      fromId: a.id,
      fromKind: "Entity",
      toId: b.id,
      toKind: "Entity",
      type: "INVOKES",
    });
    // No direct way to assert link absence via tools yet; just confirm no throw.
  });
});

describe("grepTool", () => {
  it("matches entity names by regex", async () => {
    await addEntityTool({ project, name: "getUser", file: "a.js", kind: "function", description: "" });
    await addEntityTool({ project, name: "deleteAccount", file: "a.js", kind: "function", description: "" });

    const found = await grepTool({ project, pattern: "^get" });
    expect(found.entities.map((e) => e.name)).toEqual(["getUser"]);
  });
});
