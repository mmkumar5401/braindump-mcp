import fs from "node:fs";
import path from "node:path";
import {
  dbPathFor,
  currentCommitSha,
  resolveProjectName,
  findRepoRoot,
  commitExists,
  changedSince,
} from "./project.js";
import { BraindumpError } from "./errors.js";
import { modelsDisabled } from "./embeddings.js";
import { hybridSearch, backfillEmbeddings } from "./retrieval.js";
import {
  openBraindump,
  closeBraindump,
  addNote,
  addEntity,
  modifyEntity,
  deleteEntity,
  addLink,
  modifyLink,
  deleteLink,
  grep,
  modifyNote,
  deleteNote,
  neighbors,
  listNodes,
  entitiesWithFiles,
  exportGraph,
  importGraph,
} from "./db.js";

/**
 * Thin wrappers around db.js that each open/close their own connection,
 * scoped to a project name. This is the layer the MCP server registers as
 * tools, and what the CLI commands delegate to — one place owning the
 * "open db, do the thing, close db" lifecycle per call.
 */

// Per-project write queue: overlapping calls to withDb() for the same
// project are serialized to one-at-a-time. Concurrent opens/writes against
// the same on-disk Ladybug db have been observed to crash the native module
// mid-write and permanently corrupt the file (every later open then
// segfaults) — this guarantees the MCP server (a single long-lived process
// fielding concurrent tool calls) never overlaps access to one db file.
const projectQueues = new Map();

function enqueue(project, fn) {
  const previous = projectQueues.get(project) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Always store a settled-tracking promise so one rejected call doesn't
  // permanently wedge the queue for later calls.
  projectQueues.set(
    project,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
}

// Exposed only for testing the serialization primitive directly.
export const __enqueueForTesting = enqueue;

async function withDb(project, fn) {
  return enqueue(project, async () => {
    const handle = await openBraindump(dbPathFor(project));
    try {
      return await fn(handle.conn);
    } finally {
      await closeBraindump(handle);
    }
  });
}

// The commit SHA is read from the server's cwd, so it only describes the
// project that cwd belongs to. Writes to any other project get no SHA rather
// than a wrong one.
function commitShaFor(project) {
  return project === resolveProjectName() ? currentCommitSha() : null;
}

export async function initTool({ project }) {
  const dbPath = dbPathFor(project);
  await withDb(project, async () => {});
  return { project, dbPath };
}

export async function addNoteTool({ project, content, kind = "note", tags = [] }) {
  const id = await withDb(project, (conn) => addNote(conn, { content, kind, tags }));
  scheduleEmbedding(project);
  return { id };
}

export async function addEntityTool({
  project,
  name,
  file,
  kind,
  description,
  line = null,
  language = null,
}) {
  const id = await withDb(project, (conn) =>
    addEntity(conn, { name, file, kind, description, line, language, commitSha: commitShaFor(project) })
  );
  scheduleEmbedding(project);
  return { id };
}

export async function modifyEntityTool({ project, id, ...fields }) {
  const newId = await withDb(project, (conn) => modifyEntity(conn, id, fields));
  scheduleEmbedding(project);
  return newId === id ? { id } : { id: newId, previousId: id };
}

export async function deleteEntityTool({ project, id }) {
  await withDb(project, (conn) => deleteEntity(conn, id));
  return { id };
}

export async function addLinkTool({ project, fromId, fromKind, toId, toKind, type }) {
  await withDb(project, (conn) =>
    addLink(conn, { fromId, fromKind, toId, toKind, type, commitSha: commitShaFor(project) })
  );
  return { fromId, toId, type };
}

export async function modifyLinkTool({
  project,
  fromId,
  fromKind,
  toId,
  toKind,
  matchType,
  newType = null,
}) {
  await withDb(project, (conn) =>
    modifyLink(conn, {
      fromId,
      fromKind,
      toId,
      toKind,
      matchType,
      newType,
      commitSha: commitShaFor(project),
    })
  );
  return { fromId, toId, type: newType ?? matchType };
}

export async function deleteLinkTool({ project, fromId, fromKind, toId, toKind, type }) {
  await withDb(project, (conn) => deleteLink(conn, { fromId, fromKind, toId, toKind, type }));
  return { fromId, toId, type };
}

export async function searchTool({ project, query, mode = "hybrid", limit = 10, rerank = true }) {
  return withDb(project, (conn) => hybridSearch(conn, query, { mode, limit, rerank }));
}

export async function grepTool({ project, pattern, field = null, ignoreCase = true }) {
  return withDb(project, (conn) => grep(conn, pattern, { field, ignoreCase }));
}

export async function modifyNoteTool({ project, id, content, kind, tags }) {
  await withDb(project, (conn) => modifyNote(conn, id, { content, kind, tags }));
  scheduleEmbedding(project);
  return { id };
}

export async function deleteNoteTool({ project, id }) {
  await withDb(project, (conn) => deleteNote(conn, id));
  return { id };
}

export async function neighborsTool({ project, id, direction, depth, types, limit }) {
  return withDb(project, (conn) => neighbors(conn, id, { direction, depth, types: types ?? null, limit }));
}

export async function listTool({ project, type = null, kind = null, tag = null, file = null, limit, offset }) {
  return withDb(project, (conn) => listNodes(conn, { type, kind, tag, file, limit, offset }));
}

// ---------------------------------------------------------------- staleness

const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Compare each entity's file against the commit it was described at:
 * "changed" (differs from that commit, uncommitted edits included),
 * "deleted" (file gone), fresh, or unknown (no/unknown SHA, file outside the
 * repo). Only meaningful from inside the project's own repo.
 */
export async function checkStaleTool({ project }) {
  if (project !== resolveProjectName()) {
    throw new BraindumpError(
      `check_stale compares files in the current git repo; run it from inside "${project}" (current: "${resolveProjectName()}")`
    );
  }
  const root = findRepoRoot();
  const entities = await withDb(project, (conn) => entitiesWithFiles(conn));

  const stale = [];
  const unknown = [];
  let fresh = 0;
  const bySha = new Map();

  for (const e of entities) {
    const rel = path.isAbsolute(e.file) ? path.relative(root, e.file) : e.file;
    if (!e.commitSha || !SHA_RE.test(e.commitSha) || rel.startsWith("..") || path.isAbsolute(rel)) {
      unknown.push(e.id);
      continue;
    }
    if (!bySha.has(e.commitSha)) bySha.set(e.commitSha, []);
    bySha.get(e.commitSha).push({ ...e, rel });
  }

  for (const [sha, group] of bySha) {
    if (!commitExists(root, sha)) {
      unknown.push(...group.map((e) => e.id));
      continue;
    }
    let changed;
    try {
      changed = changedSince(root, sha, [...new Set(group.map((e) => e.rel))]);
    } catch {
      unknown.push(...group.map((e) => e.id));
      continue;
    }
    for (const e of group) {
      const base = { id: e.id, name: e.name, file: e.file, commitSha: sha };
      if (!fs.existsSync(path.join(root, e.rel))) stale.push({ ...base, reason: "deleted" });
      else if (changed.has(e.rel)) stale.push({ ...base, reason: "changed" });
      else fresh++;
    }
  }

  return { stale, fresh, unknown };
}

// ---------------------------------------------------------------- export / import

function backupPath(project) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(path.dirname(dbPathFor(project)), "backups", `${project}-${stamp}.json`);
}

/** Write the project's graph as JSON (default: a timestamped backup). Atomic. */
export async function exportTool({ project, path: out = null }) {
  const data = await withDb(project, (conn) => exportGraph(conn));
  const file = path.resolve(out ?? backupPath(project));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return {
    path: file,
    counts: { notes: data.notes.length, entities: data.entities.length, links: data.links.length },
  };
}

/** Merge a JSON export into the project (all or nothing). */
export async function importTool({ project, path: file }) {
  if (typeof file !== "string" || file === "") throw new BraindumpError("path is required");
  const resolved = path.resolve(file);
  let text;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    throw new BraindumpError(`Cannot read ${resolved}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new BraindumpError(`${resolved} is not valid JSON: ${err.message}`);
  }
  const counts = await withDb(project, (conn) => importGraph(conn, data));
  scheduleEmbedding(project);
  return { path: resolved, counts };
}

// ---------------------------------------------------------------- background embedding

// In a long-lived server, embed new/changed text shortly after a write so
// the write returns immediately and the next search has nothing to backfill.
// One-shot processes (the CLI) leave it off: search backfills instead.
let backgroundEmbedding = false;
const EMBED_DEBOUNCE_MS = 200;
const timers = new Map(); // project -> pending debounce timer
const running = new Set();

export function setBackgroundEmbedding(on) {
  backgroundEmbedding = on;
}

function runEmbedding(project) {
  timers.delete(project);
  const job = withDb(project, (conn) => backfillEmbeddings(conn))
    .catch((err) => console.error(`braindump: background embedding failed for "${project}": ${err.message}`))
    .finally(() => running.delete(job));
  running.add(job);
}

function scheduleEmbedding(project) {
  if (!backgroundEmbedding || modelsDisabled()) return;
  clearTimeout(timers.get(project));
  const timer = setTimeout(() => runEmbedding(project), EMBED_DEBOUNCE_MS);
  timer.unref?.();
  timers.set(project, timer);
}

/** Run any scheduled embedding now and wait for all of it (tests, shutdown). */
export async function flushBackgroundEmbeddings() {
  for (const [project, timer] of timers) {
    clearTimeout(timer);
    runEmbedding(project);
  }
  await Promise.all([...running]);
}
