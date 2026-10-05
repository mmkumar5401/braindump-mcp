#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { resolveProjectName } from "../src/project.js";
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
} from "../src/tools.js";

// Every command goes through tools.js, so the CLI gets the same per-project
// queue, lock retry and validation as the MCP server.

function projectOf(opts) {
  return opts.project || resolveProjectName();
}

function parseIntOption(name) {
  return (value) => {
    const n = Number(value);
    if (value.trim() === "" || !Number.isSafeInteger(n)) {
      throw new InvalidArgumentError(`${name} must be an integer.`);
    }
    return n;
  };
}

function splitList(value) {
  return value.split(",").map((t) => t.trim()).filter(Boolean);
}

function parseLine(value) {
  const n = Number(value);
  if (value.trim() === "" || !Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("line must be an integer.");
  }
  return n;
}

function printResults({ notes, entities }) {
  if (notes.length === 0 && entities.length === 0) {
    console.log("No results.");
    return;
  }

  if (notes.length > 0) {
    console.log("Notes:");
    for (const n of notes) console.log(`  [${n.kind}] ${n.content} (${n.id})`);
  }
  if (entities.length > 0) {
    console.log("Entities:");
    for (const e of entities) console.log(`  [${e.kind}] ${e.name} — ${e.description} (${e.id})`);
  }
}

const program = new Command();

program.name("braindump").description("Global brain dump for agents, backed by Ladybug");

program
  .command("mcp")
  .description("Start the braindump MCP server over stdio")
  .action(async () => {
    const { startStdioServer } = await import("../src/mcp-server.js");
    await startStdioServer();
  });

program
  .command("init")
  .description("Initialize an empty brain dump database for the current project")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (opts) => {
    const { project, dbPath } = await initTool({ project: projectOf(opts) });
    console.log(`Initialized brain dump for project "${project}" at ${dbPath}`);
  });

program
  .command("add <content>")
  .description("Add a free-form memory note")
  .option("-k, --kind <kind>", "Note kind (learning, gotcha, decision, todo, preference, ...)", "note")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (content, opts) => {
    const project = projectOf(opts);
    const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const { id } = await addNoteTool({ project, content, kind: opts.kind, tags });
    console.log(`Added note ${id} (${opts.kind}) to project "${project}"`);
  });

program
  .command("search <query>")
  .description("Hybrid (keyword + semantic, re-ranked) search over notes and entities")
  .option("--mode <mode>", "hybrid, keyword or semantic", "hybrid")
  .option("--limit <n>", "Max results", parseIntOption("limit"), 10)
  .option("--no-rerank", "Skip the cross-encoder re-ranking")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (query, opts) => {
    const result = await searchTool({
      project: projectOf(opts),
      query,
      mode: opts.mode,
      limit: opts.limit,
      rerank: opts.rerank,
    });
    if (result.degraded) console.error(`braindump: ${result.degraded} (used keyword search)`);
    printResults(result);
  });

program
  .command("list")
  .description("List notes and entities, newest first")
  .option("--type <type>", "note or entity")
  .option("--kind <kind>", "Only this kind")
  .option("--tag <tag>", "Notes with this tag")
  .option("--file <prefix>", "Entities whose file starts with this")
  .option("--limit <n>", "Page size", parseIntOption("limit"), 50)
  .option("--offset <n>", "Skip this many", parseIntOption("offset"), 0)
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (opts) => {
    const { notes, entities, total } = await listTool({
      project: projectOf(opts),
      type: opts.type ?? null,
      kind: opts.kind ?? null,
      tag: opts.tag ?? null,
      file: opts.file ?? null,
      limit: opts.limit,
      offset: opts.offset,
    });
    printResults({ notes, entities });
    console.log(`(${notes.length + entities.length} of ${total})`);
  });

program
  .command("neighbors <id>")
  .description("Show a node and the nodes linked to it")
  .option("--direction <dir>", "out, in or both", "both")
  .option("--depth <n>", "Hops to walk (1-3)", parseIntOption("depth"), 1)
  .option("--types <types>", "Only follow these link types (comma-separated)", splitList)
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (id, opts) => {
    const { node, nodes, links, truncated } = await neighborsTool({
      project: projectOf(opts),
      id,
      direction: opts.direction,
      depth: opts.depth,
      types: opts.types ?? null,
    });
    const label = (n) => (n.type === "note" ? `[${n.kind}] ${n.content}` : `[${n.kind}] ${n.name} (${n.file})`);
    console.log(label(node));
    for (const l of links) console.log(`  ${l.from} -[${l.type}]-> ${l.to}`);
    for (const n of nodes) console.log(`  ${n.id}: ${label(n)}`);
    if (truncated) console.log("  (truncated)");
  });

program
  .command("stale")
  .description("Entities whose file changed since the commit they were described at")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (opts) => {
    const { stale, fresh, unknown } = await checkStaleTool({ project: projectOf(opts) });
    for (const s of stale) console.log(`${s.reason.padEnd(8)} ${s.id}`);
    console.log(`${stale.length} stale, ${fresh} fresh, ${unknown.length} unknown`);
  });

program
  .command("export [path]")
  .description("Export the graph to JSON (default: a timestamped backup)")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (file, opts) => {
    const { path: written, counts } = await exportTool({ project: projectOf(opts), path: file ?? null });
    console.log(`Exported ${counts.notes} notes, ${counts.entities} entities, ${counts.links} links to ${written}`);
  });

program
  .command("import <path>")
  .description("Merge a JSON export into the graph (all or nothing)")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (file, opts) => {
    const { path: read, counts } = await importTool({ project: projectOf(opts), path: file });
    console.log(`Imported ${counts.notes} notes, ${counts.entities} entities, ${counts.links} links from ${read}`);
  });

const note = program.command("note").description("Manage notes");

note
  .command("modify <id>")
  .description("Edit a note")
  .option("--content <content>")
  .option("--kind <kind>")
  .option("--tags <tags>", "Comma-separated tags (replaces the existing ones)", splitList)
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (id, opts) => {
    await modifyNoteTool({ project: projectOf(opts), id, content: opts.content, kind: opts.kind, tags: opts.tags });
    console.log(`Modified note ${id}`);
  });

note
  .command("delete <id>")
  .description("Delete a note and its links")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (id, opts) => {
    await deleteNoteTool({ project: projectOf(opts), id });
    console.log(`Deleted note ${id}`);
  });

program
  .command("grep <pattern>")
  .description("Regex search over notes and entities")
  .option("--field <field>", "Restrict matching to a single field")
  .option("--case-sensitive", "Match case-sensitively", false)
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (pattern, opts) => {
    printResults(
      await grepTool({
        project: projectOf(opts),
        pattern,
        field: opts.field ?? null,
        ignoreCase: !opts.caseSensitive,
      })
    );
  });

const entity = program.command("entity").description("Manage code entities");

entity
  .command("add")
  .description("Add or upsert a code entity")
  .requiredOption("--name <name>", "Entity name")
  .requiredOption("--file <file>", "File the entity lives in")
  .requiredOption("--kind <kind>", "Free-form entity kind (function, class, ...)")
  .option("--description <description>", "What this entity does", "")
  .option("--line <line>", "Line number", parseLine)
  .option("--language <language>", "Source language")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (opts) => {
    const { id } = await addEntityTool({
      project: projectOf(opts),
      name: opts.name,
      file: opts.file,
      kind: opts.kind,
      description: opts.description,
      line: opts.line ?? null,
      language: opts.language ?? null,
    });
    console.log(id);
  });

entity
  .command("modify <id>")
  .description("Patch fields on an existing entity")
  .option("--name <name>")
  .option("--file <file>")
  .option("--kind <kind>")
  .option("--description <description>")
  .option("--line <line>", "Line number", parseLine)
  .option("--language <language>")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (id, opts) => {
    const { project: _p, ...fields } = opts;
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const result = await modifyEntityTool({ project: projectOf(opts), id, ...patch });
    console.log(
      result.previousId ? `Modified entity ${id} (renamed to ${result.id})` : `Modified entity ${id}`
    );
  });

entity
  .command("delete <id>")
  .description("Delete an entity and its links")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (id, opts) => {
    await deleteEntityTool({ project: projectOf(opts), id });
    console.log(`Deleted entity ${id}`);
  });

const link = program.command("link").description("Manage links between notes/entities");

link
  .command("add")
  .description("Link two nodes (Note or Entity) with a typed relation")
  .requiredOption("--from <id>")
  .requiredOption("--from-kind <kind>", "Note or Entity")
  .requiredOption("--to <id>")
  .requiredOption("--to-kind <kind>", "Note or Entity")
  .requiredOption("--type <type>", "Free-form relation type")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (opts) => {
    await addLinkTool({
      project: projectOf(opts),
      fromId: opts.from,
      fromKind: opts.fromKind,
      toId: opts.to,
      toKind: opts.toKind,
      type: opts.type,
    });
    console.log(`Linked ${opts.from} -[${opts.type}]-> ${opts.to}`);
  });

link
  .command("modify")
  .description("Change the type of an existing link")
  .requiredOption("--from <id>")
  .requiredOption("--from-kind <kind>", "Note or Entity")
  .requiredOption("--to <id>")
  .requiredOption("--to-kind <kind>", "Note or Entity")
  .requiredOption("--match-type <type>", "Existing type to match")
  .option("--new-type <type>", "New type")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (opts) => {
    await modifyLinkTool({
      project: projectOf(opts),
      fromId: opts.from,
      fromKind: opts.fromKind,
      toId: opts.to,
      toKind: opts.toKind,
      matchType: opts.matchType,
      newType: opts.newType ?? null,
    });
    console.log(`Modified link ${opts.from} -> ${opts.to}`);
  });

link
  .command("delete")
  .description("Delete a specific link")
  .requiredOption("--from <id>")
  .requiredOption("--from-kind <kind>", "Note or Entity")
  .requiredOption("--to <id>")
  .requiredOption("--to-kind <kind>", "Note or Entity")
  .requiredOption("--type <type>", "Type of the link to delete")
  .option("-p, --project <name>", "Project/repo name (auto-detected if omitted)")
  .action(async (opts) => {
    await deleteLinkTool({
      project: projectOf(opts),
      fromId: opts.from,
      fromKind: opts.fromKind,
      toId: opts.to,
      toKind: opts.toKind,
      type: opts.type,
    });
    console.log(`Deleted link ${opts.from} -[${opts.type}]-> ${opts.to}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`braindump: ${err?.message ?? err}`);
  process.exitCode = 1;
});
