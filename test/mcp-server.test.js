import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBraindumpServer } from "../src/mcp-server.js";

let project;
let dbDir;
let client;
let server;

beforeEach(async () => {
  project = `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  dbDir = path.join(os.homedir(), ".agents", "braindump", project);

  server = createBraindumpServer();
  client = new Client({ name: "test-client", version: "0.0.1" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function parse(result) {
  return JSON.parse(result.content[0].text);
}

describe("braindump MCP server", () => {
  it("lists every registered tool", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "init",
        "add_entity",
        "add_link",
        "add_note",
        "delete_entity",
        "delete_link",
        "grep",
        "modify_entity",
        "modify_link",
        "search",
        "modify_note",
        "delete_note",
        "neighbors",
        "list",
        "check_stale",
        "export",
        "import",
      ].sort()
    );
  });

  it("init creates the db for the project", async () => {
    const result = await client.callTool({ name: "init", arguments: { project } });
    const parsed = parse(result);
    expect(parsed.project).toBe(project);
    expect(fs.existsSync(dbDir)).toBe(true);
  });

  it("add_note then search finds it", async () => {
    const added = await client.callTool({
      name: "add_note",
      arguments: { content: "Ladybug MCP works", kind: "learning", project },
    });
    expect(parse(added).id).toBeTruthy();

    const found = await client.callTool({
      name: "search",
      arguments: { query: "ladybug", project },
    });
    expect(parse(found).notes).toHaveLength(1);
  });

  it("add_entity, add_link, then grep finds the entity", async () => {
    const a = await client.callTool({
      name: "add_entity",
      arguments: { name: "foo", file: "a.js", kind: "function", description: "does foo", project },
    });
    const b = await client.callTool({
      name: "add_entity",
      arguments: { name: "bar", file: "a.js", kind: "function", description: "does bar", project },
    });

    await client.callTool({
      name: "add_link",
      arguments: {
        fromId: parse(a).id,
        fromKind: "Entity",
        toId: parse(b).id,
        toKind: "Entity",
        type: "CALLS",
        project,
      },
    });

    const grepped = await client.callTool({ name: "grep", arguments: { pattern: "^foo$", project } });
    expect(parse(grepped).entities.map((e) => e.name)).toEqual(["foo"]);
  });

  it("delete_entity removes it", async () => {
    const added = await client.callTool({
      name: "add_entity",
      arguments: { name: "toDelete", file: "a.js", kind: "function", description: "", project },
    });

    await client.callTool({ name: "delete_entity", arguments: { id: parse(added).id, project } });

    const grepped = await client.callTool({ name: "grep", arguments: { pattern: "toDelete", project } });
    expect(parse(grepped).entities).toHaveLength(0);
  });
});
