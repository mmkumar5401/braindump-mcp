import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveProjectName } from "./project.js";
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
  modifyNoteTool,
  deleteNoteTool,
  neighborsTool,
  listTool,
  checkStaleTool,
  exportTool,
  importTool,
  setBackgroundEmbedding,
} from "./tools.js";
import { warmModels } from "./embeddings.js";

const projectField = z
  .string()
  .optional()
  .describe("Project/repo name; auto-detected from cwd if omitted");

function withProject(args) {
  return { ...args, project: args.project || resolveProjectName() };
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Build an McpServer with every braindump tool registered. Exported
 * separately from the stdio wiring so it can be constructed and inspected
 * without actually connecting a transport (e.g. in tests).
 */
export function createBraindumpServer() {
  const server = new McpServer({ name: "braindump", version: "0.1.0" });

  server.registerTool(
    "init",
    {
      description: "Initialize the brain dump database for a project (idempotent)",
      inputSchema: { project: projectField },
    },
    async (args) => textResult(await initTool(withProject(args)))
  );

  server.registerTool(
    "add_note",
    {
      description:
        "Add a free-form memory note (learning, gotcha, decision, todo, preference — any kind you choose)",
      inputSchema: {
        content: z.string(),
        kind: z.string().optional().describe("Free-form note kind, e.g. learning/gotcha/decision"),
        tags: z.array(z.string()).optional(),
        project: projectField,
      },
    },
    async (args) => textResult(await addNoteTool(withProject(args)))
  );

  server.registerTool(
    "add_entity",
    {
      description: "Add or upsert a code entity (function/class/module/...) you've looked at",
      inputSchema: {
        name: z.string(),
        file: z.string(),
        kind: z.string().describe("Free-form entity kind, e.g. function/class/module"),
        description: z.string(),
        line: z.number().int().optional(),
        language: z.string().optional(),
        project: projectField,
      },
    },
    async (args) => textResult(await addEntityTool(withProject(args)))
  );

  server.registerTool(
    "modify_entity",
    {
      description: "Patch fields on an existing entity by id",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        file: z.string().optional(),
        kind: z.string().optional(),
        description: z.string().optional(),
        line: z.number().int().optional(),
        language: z.string().optional(),
        project: projectField,
      },
    },
    async (args) => textResult(await modifyEntityTool(withProject(args)))
  );

  server.registerTool(
    "delete_entity",
    {
      description: "Delete an entity and every link touching it",
      inputSchema: { id: z.string(), project: projectField },
    },
    async (args) => textResult(await deleteEntityTool(withProject(args)))
  );

  const kindEnum = z.enum(["Note", "Entity"]);

  server.registerTool(
    "add_link",
    {
      description:
        "Link any two nodes (Note or Entity, in any combination) with a free-form typed relation",
      inputSchema: {
        fromId: z.string(),
        fromKind: kindEnum,
        toId: z.string(),
        toKind: kindEnum,
        type: z.string().describe("Free-form relation type, e.g. CALLS/documents/caused-by"),
        project: projectField,
      },
    },
    async (args) => textResult(await addLinkTool(withProject(args)))
  );

  server.registerTool(
    "modify_link",
    {
      description: "Change the type of an existing link",
      inputSchema: {
        fromId: z.string(),
        fromKind: kindEnum,
        toId: z.string(),
        toKind: kindEnum,
        matchType: z.string(),
        newType: z.string().optional(),
        project: projectField,
      },
    },
    async (args) => textResult(await modifyLinkTool(withProject(args)))
  );

  server.registerTool(
    "delete_link",
    {
      description: "Delete a specific link between two nodes",
      inputSchema: {
        fromId: z.string(),
        fromKind: kindEnum,
        toId: z.string(),
        toKind: kindEnum,
        type: z.string(),
        project: projectField,
      },
    },
    async (args) => textResult(await deleteLinkTool(withProject(args)))
  );

  server.registerTool(
    "search",
    {
      description:
        "Search notes and entities. Default 'hybrid' combines keyword (BM25 + substring) and semantic " +
        "(local embeddings) matching, then re-ranks with a cross-encoder. Falls back to keyword " +
        "search if the models are unavailable (the result says so in 'degraded').",
      inputSchema: {
        query: z.string(),
        mode: z.enum(["hybrid", "keyword", "semantic"]).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 10)"),
        rerank: z.boolean().optional().describe("Re-rank with the cross-encoder (default true)"),
        project: projectField,
      },
    },
    async (args) => textResult(await searchTool(withProject(args)))
  );

  server.registerTool(
    "grep",
    {
      description: "Regex search over notes and entities (name/file/kind/description/content)",
      inputSchema: {
        pattern: z.string(),
        field: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        project: projectField,
      },
    },
    async (args) => textResult(await grepTool(withProject(args)))
  );

  server.registerTool(
    "modify_note",
    {
      description: "Edit a note's content, kind or tags",
      inputSchema: {
        id: z.string(),
        content: z.string().optional(),
        kind: z.string().optional(),
        tags: z.array(z.string()).optional(),
        project: projectField,
      },
    },
    async (args) => textResult(await modifyNoteTool(withProject(args)))
  );

  server.registerTool(
    "delete_note",
    {
      description: "Delete a note and every link touching it",
      inputSchema: { id: z.string(), project: projectField },
    },
    async (args) => textResult(await deleteNoteTool(withProject(args)))
  );

  server.registerTool(
    "neighbors",
    {
      description:
        "Read the graph around a node (note or entity id): its full record, the nodes linked to it " +
        "within `depth` hops, and the links. Use to answer 'what calls X', 'what documents X', etc.",
      inputSchema: {
        id: z.string(),
        direction: z.enum(["out", "in", "both"]).optional().describe("Follow outgoing, incoming or both (default both)"),
        depth: z.number().int().min(1).max(3).optional().describe("Hops to walk (default 1)"),
        types: z.array(z.string()).optional().describe("Only follow links of these types"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max nodes returned (default 200)"),
        project: projectField,
      },
    },
    async (args) => textResult(await neighborsTool(withProject(args)))
  );

  server.registerTool(
    "list",
    {
      description: "List notes and entities, newest first, with optional filters and paging",
      inputSchema: {
        type: z.enum(["note", "entity"]).optional(),
        kind: z.string().optional(),
        tag: z.string().optional().describe("Notes with this tag"),
        file: z.string().optional().describe("Entities whose file starts with this prefix"),
        limit: z.number().int().min(1).max(500).optional().describe("Default 50"),
        offset: z.number().int().min(0).optional(),
        project: projectField,
      },
    },
    async (args) => textResult(await listTool(withProject(args)))
  );

  server.registerTool(
    "check_stale",
    {
      description:
        "Find entities whose file changed (or was deleted) since the commit they were described at. " +
        "Run from inside the project's repo.",
      inputSchema: { project: projectField },
    },
    async (args) => textResult(await checkStaleTool(withProject(args)))
  );

  server.registerTool(
    "export",
    {
      description: "Export the project's graph to JSON. Without a path, writes a timestamped backup.",
      inputSchema: { path: z.string().optional(), project: projectField },
    },
    async (args) => textResult(await exportTool(withProject(args)))
  );

  server.registerTool(
    "import",
    {
      description: "Merge a JSON export into the project (all or nothing)",
      inputSchema: { path: z.string(), project: projectField },
    },
    async (args) => textResult(await importTool(withProject(args)))
  );

  return server;
}

export async function startStdioServer() {
  // A long-lived server must outlive any one bad call: log stray async
  // failures to stderr (stdout is the MCP channel) instead of exiting.
  process.on("unhandledRejection", (err) => {
    console.error("braindump: unhandled rejection:", err);
  });
  process.on("uncaughtException", (err) => {
    console.error("braindump: uncaught exception:", err);
  });

  // Long-lived: embed in the background after writes, and load the models
  // now so the first search doesn't pay for it.
  setBackgroundEmbedding(true);
  warmModels();

  const server = createBraindumpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
