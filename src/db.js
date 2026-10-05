import { Database, Connection } from "@ladybugdb/core";
import { randomUUID } from "node:crypto";
import { BraindumpError } from "./errors.js";
import { EMBED_DIM } from "./embeddings.js";

/**
 * The braindump graph schema. Everything here is populated by agents as they
 * work — there is no static analysis pass. Knowledge accumulates the more a
 * model touches the code.
 *
 *  - Note: free-form agent memory (learnings, gotchas, decisions, todos).
 *  - Entity: a code symbol (function/class/module/...) an agent has looked at
 *    and described. Tagged with the commit SHA it was observed at, so a
 *    future agent can tell whether `file` has changed since and the
 *    description might be stale.
 *  - Link: one generic typed edge spanning every node-pair combination
 *    (Note-Note, Note-Entity, Entity-Note, Entity-Entity). A note can point
 *    at any node, an entity can point at any node — `type` is a free-form
 *    string the agent chooses (e.g. "CALLS", "caused-by", "documents",
 *    "supersedes"), tagged with the commit SHA it was observed at.
 */
const SCHEMA_STATEMENTS = [
  `CREATE NODE TABLE IF NOT EXISTS Note(
    id STRING PRIMARY KEY,
    content STRING,
    kind STRING,
    tags STRING[],
    createdAt INT64
  )`,
  `CREATE NODE TABLE IF NOT EXISTS Entity(
    id STRING PRIMARY KEY,
    name STRING,
    kind STRING,
    file STRING,
    line INT64,
    language STRING,
    description STRING,
    commitSha STRING,
    createdAt INT64,
    updatedAt INT64
  )`,
  `CREATE REL TABLE IF NOT EXISTS Link(
    FROM Note TO Note,
    FROM Note TO Entity,
    FROM Entity TO Note,
    FROM Entity TO Entity,
    type STRING,
    commitSha STRING,
    createdAt INT64
  )`,
  // Added after the first release: ALTER ... IF NOT EXISTS upgrades existing
  // databases in place. `embedding` is NULL until the text is (re-)embedded.
  `ALTER TABLE Note ADD IF NOT EXISTS updatedAt INT64`,
  `ALTER TABLE Note ADD IF NOT EXISTS embedding FLOAT[${EMBED_DIM}]`,
  `ALTER TABLE Entity ADD IF NOT EXISTS embedding FLOAT[${EMBED_DIM}]`,
];

/**
 * Open (creating if needed) the braindump database at dbPath and ensure the
 * schema exists. Returns { db, conn } — caller is responsible for closing.
 */
// Ladybug's default buffer pool reserves a huge virtual address space per
// Database instance. Repeatedly opening/closing within the same process
// (every CLI command, every MCP tool call) exhausts it quickly, so default
// to a modest cap instead of relying on the library default.
const DEFAULT_BUFFER_POOL_SIZE = 256 * 1024 * 1024;
const DEFAULT_MAX_DB_SIZE = 4 * 1024 * 1024 * 1024;

// Another process (the CLI, a second MCP server) holding the db file makes
// open fail with a lock error. Opens are short-lived, so wait for it.
const DEFAULT_LOCK_TIMEOUT_MS = 15000;

function isLockError(err) {
  return /Could not set lock on file/i.test(err?.message ?? "");
}

// A Database whose init failed (e.g. the lock is held elsewhere) rejects
// again on close(), so the library never frees its native handle — which
// holds the buffer pool and a maxDBSize address-space reservation. Every lock
// retry leaked one until the process crashed. Free it through the native
// handle directly (private field; guarded so a library change degrades to
// the old leak, not a crash).
async function releaseFailedOpen(db, conn) {
  await Promise.resolve()
    .then(() => conn.close())
    .catch(() => {});
  try {
    await db.close();
  } catch {
    try {
      db._database?.close();
    } catch {
      // nothing else we can do
    }
  }
}

async function openOnce(dbPath, bufferPoolSize, maxDBSize) {
  const db = new Database(dbPath, bufferPoolSize, undefined, undefined, maxDBSize);
  const conn = new Connection(db);
  try {
    await conn.init();
    for (const stmt of SCHEMA_STATEMENTS) {
      await rows(conn, stmt);
    }
    return { db, conn };
  } catch (err) {
    await releaseFailedOpen(db, conn);
    throw err;
  }
}

export async function openBraindump(
  dbPath,
  {
    bufferPoolSize = DEFAULT_BUFFER_POOL_SIZE,
    maxDBSize = DEFAULT_MAX_DB_SIZE,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  } = {}
) {
  const deadline = Date.now() + lockTimeoutMs;
  let delay = 25;
  for (;;) {
    try {
      return await openOnce(dbPath, bufferPoolSize, maxDBSize);
    } catch (err) {
      if (!isLockError(err)) throw err;
      if (Date.now() + delay > deadline) {
        throw new BraindumpError(
          `Database is locked by another process (waited ${lockTimeoutMs} ms): ${dbPath}`
        );
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 500);
    }
  }
}

export async function closeBraindump({ db, conn }) {
  await conn.close();
  await db.close();
}

// Every QueryResult must be closed: an open one keeps the native database —
// and its file lock — alive after close() until GC happens to run, blocking
// every other process (CLI, other agents' MCP servers) for an unpredictable
// time. All queries go through here so none can be missed.
async function rows(conn, cypher, params = null) {
  const res = params ? await conn.execute(await conn.prepare(cypher), params) : await conn.query(cypher);
  const results = Array.isArray(res) ? res : [res];
  try {
    const out = [];
    for (const r of results) out.push(...(await r.getAll()));
    return out;
  } finally {
    for (const r of results) r.close();
  }
}

// All-or-nothing for multi-statement writes (an entity re-key must never
// leave both the old and the new node behind).
async function inTransaction(conn, fn) {
  await rows(conn, "BEGIN TRANSACTION");
  try {
    const result = await fn();
    await rows(conn, "COMMIT");
    return result;
  } catch (err) {
    await rows(conn, "ROLLBACK").catch(() => {});
    throw err;
  }
}

const VALID_NODE_KINDS = new Set(["Note", "Entity"]);

function checkKinds(fromKind, toKind) {
  if (!VALID_NODE_KINDS.has(fromKind) || !VALID_NODE_KINDS.has(toKind)) {
    throw new BraindumpError(`fromKind/toKind must be one of Note, Entity (got ${fromKind}, ${toKind})`);
  }
}

function checkLine(line) {
  if (line === null || line === undefined) return;
  if (!Number.isSafeInteger(line)) {
    throw new BraindumpError(`line must be an integer (got ${line})`);
  }
}

async function nodeExists(conn, kind, id) {
  const [{ n }] = await rows(conn, `MATCH (x:${kind} {id: $id}) RETURN count(x) AS n`, { id });
  return n > 0;
}

async function requireNode(conn, kind, id) {
  if (!(await nodeExists(conn, kind, id))) {
    throw new BraindumpError(`${kind} "${id}" not found`);
  }
}

async function linkExists(conn, { fromId, fromKind, toId, toKind, type }) {
  const [{ n }] = await rows(
    conn,
    `MATCH (a:${fromKind} {id: $fromId})-[r:Link {type: $type}]->(b:${toKind} {id: $toId})
     RETURN count(r) AS n`,
    { fromId, toId, type }
  );
  return n > 0;
}

function describeLink({ fromId, fromKind, toId, toKind, type }) {
  return `Link ${fromKind} "${fromId}" -[${type}]-> ${toKind} "${toId}"`;
}

/**
 * Add a free-form memory note. `kind` is a free-form string the agent
 * chooses (e.g. "learning", "gotcha", "decision", "todo", "preference") —
 * there is no fixed enum. Returns the generated note id.
 */
export async function addNote(conn, { content, kind = "note", tags = [] }) {
  const id = randomUUID();
  const now = Date.now();

  await rows(
    conn,
    `CREATE (:Note {id: $id, content: $content, kind: $kind, tags: $tags, createdAt: $now, updatedAt: $now})`,
    { id, content, kind, tags, now }
  );

  return id;
}

/**
 * Link any two nodes (Note or Entity, in any combination) with a typed,
 * agent-chosen relation. Idempotent on (fromId, toId, type); the commitSha is
 * refreshed on repeat observation. Throws if either node does not exist.
 *
 * `fromKind`/`toKind` must each be "Note" or "Entity" — Ladybug's Link table
 * spans multiple node-pair combinations, so the label on each side must be
 * known to resolve which pairing to create the edge for.
 *
 * Examples: a Note documenting an Entity, an Entity CALLS another Entity, a
 * Note caused-by another Note.
 */
export async function addLink(conn, { fromId, fromKind, toId, toKind, type, commitSha = null }) {
  checkKinds(fromKind, toKind);
  await requireNode(conn, fromKind, fromId);
  await requireNode(conn, toKind, toId);

  const now = Date.now();

  await rows(
    conn,
    `MATCH (a:${fromKind} {id: $fromId}), (b:${toKind} {id: $toId})
     MERGE (a)-[r:Link {type: $type}]->(b)
     ON CREATE SET r.commitSha = $commitSha, r.createdAt = $now
     ON MATCH SET r.commitSha = $commitSha`,
    { fromId, toId, type, commitSha, now }
  );
}

/**
 * Case-insensitive keyword search over Notes (content, tags) and Entities
 * (name, description, file). Returns { notes: [...], entities: [...] } with
 * plain JS objects (not raw query rows).
 */
export async function search(conn, query) {
  // Ladybug evaluates `x CONTAINS ""` as false, so an empty query would
  // silently match nothing.
  if (typeof query !== "string" || query.trim() === "") {
    throw new BraindumpError(`search query must not be empty (use grep "." to list everything)`);
  }
  const term = query.toLowerCase();

  // Two separate queries merged in JS: parameters inside an ANY()/list
  // lambda predicate crash Ladybug's executor (UNREACHABLE_CODE), so tag
  // matching is done via UNWIND instead and de-duplicated here.
  const contentMatches = await rows(
    conn,
    `MATCH (n:Note) WHERE lower(n.content) CONTAINS $term
     RETURN n.id AS id, n.content AS content, n.kind AS kind, n.tags AS tags, n.createdAt AS createdAt`,
    { term }
  );

  const tagMatches = await rows(
    conn,
    `MATCH (n:Note) UNWIND n.tags AS tag WITH n, tag WHERE lower(tag) CONTAINS $term
     RETURN DISTINCT n.id AS id, n.content AS content, n.kind AS kind, n.tags AS tags, n.createdAt AS createdAt`,
    { term }
  );

  const seen = new Set();
  const notes = [];
  for (const note of [...contentMatches, ...tagMatches]) {
    if (!seen.has(note.id)) {
      seen.add(note.id);
      notes.push(note);
    }
  }

  const entities = await rows(
    conn,
    `MATCH (e:Entity)
     WHERE lower(e.name) CONTAINS $term OR lower(e.description) CONTAINS $term
        OR lower(e.file) CONTAINS $term
     RETURN e.id AS id, e.name AS name, e.kind AS kind, e.file AS file,
            e.description AS description, e.line AS line`,
    { term }
  );

  return { notes, entities };
}

const NOTE_GREP_FIELDS = ["content", "kind"];
const ENTITY_GREP_FIELDS = ["name", "file", "kind", "description"];

/**
 * Regex search over Notes and Entities — the graph-native equivalent of
 * grepping source. Matches `pattern` (a JS regex) against each entity's
 * name/file/kind/description (or a Note's content/kind), or a single `field`
 * when specified. Case-insensitive by default.
 */
export async function grep(conn, pattern, { field = null, ignoreCase = true } = {}) {
  if (field && !NOTE_GREP_FIELDS.includes(field) && !ENTITY_GREP_FIELDS.includes(field)) {
    const valid = [...new Set([...NOTE_GREP_FIELDS, ...ENTITY_GREP_FIELDS])].join(", ");
    throw new BraindumpError(`Unknown field "${field}" (valid: ${valid})`);
  }

  let re;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (err) {
    throw new BraindumpError(`Invalid regex: ${err.message}`);
  }

  const noteFields = field ? [field].filter((f) => NOTE_GREP_FIELDS.includes(f)) : NOTE_GREP_FIELDS;
  const entityFields = field
    ? [field].filter((f) => ENTITY_GREP_FIELDS.includes(f))
    : ENTITY_GREP_FIELDS;

  let notes = [];
  if (noteFields.length > 0) {
    const allNotes = await rows(
      conn,
      `MATCH (n:Note) RETURN n.id AS id, n.content AS content, n.kind AS kind, n.tags AS tags, n.createdAt AS createdAt`
    );
    notes = allNotes.filter((n) => noteFields.some((f) => re.test(n[f] ?? "")));
  }

  let entities = [];
  if (entityFields.length > 0) {
    const allEntities = await rows(
      conn,
      `MATCH (e:Entity) RETURN e.id AS id, e.name AS name, e.kind AS kind, e.file AS file,
              e.description AS description, e.line AS line`
    );
    entities = allEntities.filter((e) => entityFields.some((f) => re.test(e[f] ?? "")));
  }

  return { notes, entities };
}

/**
 * Derive a stable entity id from file + name (e.g. "src/db.js::openBraindump").
 * Same symbol name in the same file always resolves to the same node, so
 * repeated visits update it instead of creating duplicates.
 */
export function entityId(file, name) {
  return `${file}::${name}`;
}

/**
 * Upsert a code entity. If an entity with this id already exists (an agent
 * has looked at this symbol before), its description/kind/line are refreshed
 * and `updatedAt`/`commitSha` are bumped to the latest observation. Otherwise
 * a new Entity node is created.
 *
 * `kind` is a free-form string the agent chooses (e.g. "function", "class",
 * "cron-job", "react-hook") — there is no fixed enum.
 */
export async function addEntity(
  conn,
  { name, file, kind, description, line = null, language = null, commitSha = null }
) {
  checkLine(line);
  const id = entityId(file, name);
  const now = Date.now();

  await rows(
    conn,
    `MERGE (e:Entity {id: $id})
     ON CREATE SET
       e.name = $name, e.kind = $kind, e.file = $file, e.line = $line,
       e.language = $language, e.description = $description,
       e.commitSha = $commitSha, e.createdAt = $now, e.updatedAt = $now
     ON MATCH SET
       e.kind = $kind, e.line = $line, e.language = $language,
       e.description = $description, e.commitSha = $commitSha, e.updatedAt = $now,
       e.embedding = NULL`,
    { id, name, file, kind, line, language, description, commitSha, now }
  );

  return id;
}

const ENTITY_FIELDS = ["name", "kind", "file", "line", "language", "description", "commitSha"];
const EMBEDDED_ENTITY_FIELDS = ["name", "kind", "file", "description"];

/**
 * Patch specific fields on an existing entity without touching the rest.
 * Only the fields present in `fields` are updated; `updatedAt` always bumps.
 * Throws if no entity with this id exists. Returns the entity's id, which
 * changes when `name` or `file` changes (the id is derived from them): the
 * node is re-keyed and every link is carried over, atomically.
 */
export async function modifyEntity(conn, id, fields) {
  const patch = Object.fromEntries(
    Object.entries(fields).filter(([k, v]) => ENTITY_FIELDS.includes(k) && v !== undefined)
  );
  if ("line" in patch) checkLine(patch.line);

  const [current] = await rows(
    conn,
    `MATCH (e:Entity {id: $id})
     RETURN e.name AS name, e.kind AS kind, e.file AS file, e.line AS line, e.language AS language,
            e.description AS description, e.commitSha AS commitSha, e.createdAt AS createdAt`,
    { id }
  );
  if (!current) throw new BraindumpError(`Entity "${id}" not found`);

  const now = Date.now();
  const newId = entityId(patch.file ?? current.file, patch.name ?? current.name);

  if (newId === id) {
    const sets = Object.keys(patch).map((k) => `e.${k} = $${k}`);
    // The embedded text is kind/name/file/description; line etc. don't affect it.
    if (Object.keys(patch).some((k) => EMBEDDED_ENTITY_FIELDS.includes(k))) sets.push("e.embedding = NULL");
    if (sets.length > 0) {
      await rows(conn, `MATCH (e:Entity {id: $id}) SET ${sets.join(", ")}, e.updatedAt = $now`, {
        id,
        now,
        ...patch,
      });
    }
    return id;
  }

  // Primary keys can't be updated in place: insert the new node, copy every
  // link across, delete the old node.
  if (await nodeExists(conn, "Entity", newId)) {
    throw new BraindumpError(`Cannot rename "${id}": Entity "${newId}" already exists`);
  }

  return inTransaction(conn, async () => {
    const next = { ...current, ...patch };
    await rows(
      conn,
      `CREATE (:Entity {id: $newId, name: $name, kind: $kind, file: $file, line: $line,
                        language: $language, description: $description, commitSha: $commitSha,
                        createdAt: $createdAt, updatedAt: $now})`,
      { newId, now, ...next }
    );

    const linkFields = `label(x) AS kind, x.id AS id, r.type AS type, r.commitSha AS commitSha, r.createdAt AS createdAt`;
    const outgoing = await rows(conn, `MATCH (e:Entity {id: $id})-[r:Link]->(x) RETURN ${linkFields}`, { id });
    const incoming = await rows(conn, `MATCH (x)-[r:Link]->(e:Entity {id: $id}) RETURN ${linkFields}`, { id });

    const isSelf = (l) => l.kind === "Entity" && l.id === id;
    const copies = [
      // A self-link shows up in both lists; carry it over once, as new -> new.
      ...outgoing.map((l) => ({ ...l, fromKind: "Entity", fromId: newId, toKind: l.kind, toId: isSelf(l) ? newId : l.id })),
      ...incoming.filter((l) => !isSelf(l)).map((l) => ({ ...l, fromKind: l.kind, fromId: l.id, toKind: "Entity", toId: newId })),
    ];
    for (const l of copies) {
      checkKinds(l.fromKind, l.toKind);
      await rows(
        conn,
        `MATCH (a:${l.fromKind} {id: $fromId}), (b:${l.toKind} {id: $toId})
         CREATE (a)-[:Link {type: $type, commitSha: $commitSha, createdAt: $createdAt}]->(b)`,
        { fromId: l.fromId, toId: l.toId, type: l.type, commitSha: l.commitSha, createdAt: l.createdAt }
      );
    }

    await rows(conn, `MATCH (e:Entity {id: $id}) DETACH DELETE e`, { id });
    return newId;
  });
}

/**
 * Delete an entity and every Link edge touching it (in either direction).
 * Notes that referenced it are left in place, just unlinked. Throws if no
 * entity with this id exists.
 */
export async function deleteEntity(conn, id) {
  await requireNode(conn, "Entity", id);
  await rows(conn, `MATCH (e:Entity {id: $id}) DETACH DELETE e`, { id });
}

/**
 * Update the type/commitSha of an existing Link between two known nodes.
 * `matchType` identifies which existing link to modify (in case multiple
 * links exist between the same pair with different types); `newType` is
 * optional — if omitted, only commitSha is refreshed. Throws if the link
 * does not exist, or if retyping would duplicate an existing link.
 */
export async function modifyLink(
  conn,
  { fromId, fromKind, toId, toKind, matchType, newType = null, commitSha = null }
) {
  checkKinds(fromKind, toKind);
  const link = { fromId, fromKind, toId, toKind };

  if (!(await linkExists(conn, { ...link, type: matchType }))) {
    throw new BraindumpError(`${describeLink({ ...link, type: matchType })} not found`);
  }
  if (newType && newType !== matchType && (await linkExists(conn, { ...link, type: newType }))) {
    throw new BraindumpError(`${describeLink({ ...link, type: newType })} already exists`);
  }

  await rows(
    conn,
    `MATCH (a:${fromKind} {id: $fromId})-[r:Link {type: $matchType}]->(b:${toKind} {id: $toId})
     SET r.type = COALESCE($newType, r.type), r.commitSha = COALESCE($commitSha, r.commitSha)`,
    { fromId, toId, matchType, newType, commitSha }
  );
}

/**
 * Delete a specific Link edge between two known nodes. Throws if it does not
 * exist.
 */
export async function deleteLink(conn, { fromId, fromKind, toId, toKind, type }) {
  checkKinds(fromKind, toKind);
  if (!(await linkExists(conn, { fromId, fromKind, toId, toKind, type }))) {
    throw new BraindumpError(`${describeLink({ fromId, fromKind, toId, toKind, type })} not found`);
  }

  await rows(
    conn,
    `MATCH (a:${fromKind} {id: $fromId})-[r:Link {type: $type}]->(b:${toKind} {id: $toId})
     DELETE r`,
    { fromId, toId, type }
  );
}

// ---------------------------------------------------------------- notes

const NOTE_FIELDS = ["content", "kind", "tags"];

function checkNoteFields(fields) {
  if ("content" in fields && typeof fields.content !== "string") {
    throw new BraindumpError("content must be a string");
  }
  if ("kind" in fields && typeof fields.kind !== "string") {
    throw new BraindumpError("kind must be a string");
  }
  if ("tags" in fields && !(Array.isArray(fields.tags) && fields.tags.every((t) => typeof t === "string"))) {
    throw new BraindumpError("tags must be an array of strings");
  }
}

/**
 * Patch a note's content/kind/tags. Clears its embedding (the text changed)
 * and bumps updatedAt. Throws if the note does not exist.
 */
export async function modifyNote(conn, id, fields) {
  const patch = Object.fromEntries(
    Object.entries(fields).filter(([k, v]) => NOTE_FIELDS.includes(k) && v !== undefined)
  );
  checkNoteFields(patch);
  await requireNode(conn, "Note", id);
  if (Object.keys(patch).length === 0) return id;

  const sets = [...Object.keys(patch).map((k) => `n.${k} = $${k}`), "n.updatedAt = $now", "n.embedding = NULL"];
  await rows(conn, `MATCH (n:Note {id: $id}) SET ${sets.join(", ")}`, { id, now: Date.now(), ...patch });
  return id;
}

/** Delete a note and every link touching it. Throws if it does not exist. */
export async function deleteNote(conn, id) {
  await requireNode(conn, "Note", id);
  await rows(conn, `MATCH (n:Note {id: $id}) DETACH DELETE n`, { id });
}

// ---------------------------------------------------------------- reading the graph

const NOTE_COLUMNS =
  "n.id AS id, n.content AS content, n.kind AS kind, n.tags AS tags, n.createdAt AS createdAt, n.updatedAt AS updatedAt";
const ENTITY_COLUMNS =
  "e.id AS id, e.name AS name, e.kind AS kind, e.file AS file, e.line AS line, e.language AS language, " +
  "e.description AS description, e.commitSha AS commitSha, e.createdAt AS createdAt, e.updatedAt AS updatedAt";

async function getNode(conn, id) {
  const [note] = await rows(conn, `MATCH (n:Note {id: $id}) RETURN ${NOTE_COLUMNS}`, { id });
  if (note) return { type: "note", ...note };
  const [entity] = await rows(conn, `MATCH (e:Entity {id: $id}) RETURN ${ENTITY_COLUMNS}`, { id });
  if (entity) return { type: "entity", ...entity };
  return null;
}

const DIRECTIONS = ["out", "in", "both"];
const MAX_DEPTH = 3;

/**
 * Walk the graph from one node: its full record, every node reachable within
 * `depth` hops (1-3) along links in `direction` ("out", "in", "both"),
 * optionally only through links whose type is in `types`, and those links.
 * Stops after `limit` nodes (and says so).
 */
export async function neighbors(conn, id, { direction = "both", depth = 1, types = null, limit = 200 } = {}) {
  if (!DIRECTIONS.includes(direction)) {
    throw new BraindumpError(`direction must be one of ${DIRECTIONS.join(", ")} (got ${direction})`);
  }
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
    throw new BraindumpError(`depth must be an integer from 1 to ${MAX_DEPTH} (got ${depth})`);
  }
  if (types !== null && !(Array.isArray(types) && types.every((t) => typeof t === "string"))) {
    throw new BraindumpError("types must be an array of link types");
  }

  const node = await getNode(conn, id);
  if (!node) throw new BraindumpError(`Node "${id}" not found`);

  const found = new Set([id]);
  const order = [];
  const links = new Map();
  let truncated = false;
  let frontier = [id];

  for (let hop = 0; hop < depth && frontier.length > 0 && !truncated; hop++) {
    const next = [];
    for (const current of frontier) {
      const edges = [];
      if (direction !== "in") {
        edges.push(
          ...(await rows(
            conn,
            `MATCH (a {id: $id})-[r:Link]->(b) RETURN a.id AS from, r.type AS type, b.id AS to, r.commitSha AS commitSha, b.id AS other`,
            { id: current }
          ))
        );
      }
      if (direction !== "out") {
        edges.push(
          ...(await rows(
            conn,
            `MATCH (b)-[r:Link]->(a {id: $id}) RETURN b.id AS from, r.type AS type, a.id AS to, r.commitSha AS commitSha, b.id AS other`,
            { id: current }
          ))
        );
      }
      for (const { other, ...link } of edges) {
        if (types && !types.includes(link.type)) continue;
        links.set(`${link.from}\u0000${link.type}\u0000${link.to}`, link);
        if (found.has(other)) continue;
        if (order.length >= limit) {
          truncated = true;
          continue;
        }
        found.add(other);
        order.push(other);
        next.push(other);
      }
    }
    frontier = next;
  }

  const nodes = [];
  for (const nodeId of order) {
    const n = await getNode(conn, nodeId);
    if (n) nodes.push(n);
  }
  return { node, nodes, links: [...links.values()], truncated };
}

const LIST_TYPES = ["note", "entity"];
const MAX_LIST_LIMIT = 500;

/**
 * List nodes newest first (by updatedAt, else createdAt). Filters: `type`
 * ("note"/"entity"), `kind`, `tag` (notes only), `file` prefix (entities
 * only). `total` counts every match before paging.
 */
export async function listNodes(
  conn,
  { type = null, kind = null, tag = null, file = null, limit = 50, offset = 0 } = {}
) {
  if (type !== null && !LIST_TYPES.includes(type)) {
    throw new BraindumpError(`type must be one of ${LIST_TYPES.join(", ")} (got ${type})`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new BraindumpError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT} (got ${limit})`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new BraindumpError(`offset must be a non-negative integer (got ${offset})`);
  }

  // A tag only exists on notes and a file only on entities.
  const wantNotes = type !== "entity" && file === null;
  const wantEntities = type !== "note" && tag === null;

  let items = [];
  if (wantNotes) {
    const where = [];
    const params = {};
    if (kind !== null) {
      where.push("n.kind = $kind");
      params.kind = kind;
    }
    if (tag !== null) {
      where.push("list_contains(n.tags, $tag)");
      params.tag = tag;
    }
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const found = await rows(conn, `MATCH (n:Note) ${filter} RETURN ${NOTE_COLUMNS}`, where.length ? params : null);
    items.push(...found.map((n) => ({ type: "note", ...n })));
  }
  if (wantEntities) {
    const where = [];
    const params = {};
    if (kind !== null) {
      where.push("e.kind = $kind");
      params.kind = kind;
    }
    if (file !== null) {
      where.push("starts_with(e.file, $file)");
      params.file = file;
    }
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const found = await rows(conn, `MATCH (e:Entity) ${filter} RETURN ${ENTITY_COLUMNS}`, where.length ? params : null);
    items.push(...found.map((e) => ({ type: "entity", ...e })));
  }

  const time = (x) => x.updatedAt ?? x.createdAt ?? 0;
  items.sort((a, b) => time(b) - time(a));
  const page = items.slice(offset, offset + limit);
  return {
    notes: page.filter((x) => x.type === "note").map(({ type: _t, ...n }) => n),
    entities: page.filter((x) => x.type === "entity").map(({ type: _t, ...e }) => e),
    total: items.length,
  };
}

// ---------------------------------------------------------------- embeddings storage

/** Every note and entity with its search text fields and stored embedding (or null). */
export async function loadSearchDocs(conn, { missingOnly = false } = {}) {
  const noteFilter = missingOnly ? "WHERE n.embedding IS NULL" : "";
  const entityFilter = missingOnly ? "WHERE e.embedding IS NULL" : "";
  const notes = await rows(conn, `MATCH (n:Note) ${noteFilter} RETURN ${NOTE_COLUMNS}, n.embedding AS embedding`);
  const entities = await rows(
    conn,
    `MATCH (e:Entity) ${entityFilter} RETURN ${ENTITY_COLUMNS}, e.embedding AS embedding`
  );
  return [...notes.map((n) => ({ type: "note", ...n })), ...entities.map((e) => ({ type: "entity", ...e }))];
}

/** Store vectors for [{ type, id, embedding }] in one transaction. */
export async function storeEmbeddings(conn, items) {
  if (items.length === 0) return;
  for (const { embedding } of items) {
    if (!Array.isArray(embedding) || embedding.length !== EMBED_DIM) {
      throw new BraindumpError(`embedding must have ${EMBED_DIM} dimensions`);
    }
  }
  await inTransaction(conn, async () => {
    for (const { type, id, embedding } of items) {
      const label = type === "note" ? "Note" : "Entity";
      await rows(conn, `MATCH (x:${label} {id: $id}) SET x.embedding = $embedding`, { id, embedding });
    }
  });
}

/** Entities that carry a file (for the staleness check). */
export async function entitiesWithFiles(conn) {
  return rows(
    conn,
    `MATCH (e:Entity) WHERE e.file IS NOT NULL RETURN e.id AS id, e.name AS name, e.file AS file, e.commitSha AS commitSha`
  );
}

// ---------------------------------------------------------------- export / import

export const EXPORT_VERSION = 1;

/** The whole graph as plain JSON (embeddings excluded — they are recomputed). */
export async function exportGraph(conn) {
  const notes = await rows(conn, `MATCH (n:Note) RETURN ${NOTE_COLUMNS} ORDER BY n.createdAt`);
  const entities = await rows(conn, `MATCH (e:Entity) RETURN ${ENTITY_COLUMNS} ORDER BY e.createdAt`);
  const links = await rows(
    conn,
    `MATCH (a)-[r:Link]->(b)
     RETURN label(a) AS fromKind, a.id AS fromId, label(b) AS toKind, b.id AS toId,
            r.type AS type, r.commitSha AS commitSha, r.createdAt AS createdAt`
  );
  return { version: EXPORT_VERSION, exportedAt: Date.now(), notes, entities, links };
}

function validateImport(data) {
  const fail = (msg) => {
    throw new BraindumpError(`Invalid import: ${msg}`);
  };
  const str = (v) => typeof v === "string";
  const optStr = (v) => v === null || v === undefined || str(v);
  const optInt = (v) => v === null || v === undefined || Number.isSafeInteger(v);

  if (!data || typeof data !== "object") fail("expected a JSON object");
  if (data.version !== EXPORT_VERSION) fail(`unsupported version ${data.version} (expected ${EXPORT_VERSION})`);
  for (const key of ["notes", "entities", "links"]) {
    if (!Array.isArray(data[key])) fail(`"${key}" must be an array`);
  }
  data.notes.forEach((n, i) => {
    const at = `notes[${i}]`;
    if (!n || !str(n.id) || n.id === "") fail(`${at}.id must be a non-empty string`);
    if (!str(n.content)) fail(`${at}.content must be a string`);
    if (!optStr(n.kind)) fail(`${at}.kind must be a string`);
    if (n.tags !== undefined && n.tags !== null && !(Array.isArray(n.tags) && n.tags.every(str))) {
      fail(`${at}.tags must be an array of strings`);
    }
    if (!optInt(n.createdAt) || !optInt(n.updatedAt)) fail(`${at} timestamps must be integers`);
  });
  data.entities.forEach((e, i) => {
    const at = `entities[${i}]`;
    if (!e || !str(e.name) || !str(e.file)) fail(`${at}.name and .file must be strings`);
    if (e.id !== undefined && e.id !== entityId(e.file, e.name)) {
      fail(`${at}.id must be "${entityId(e.file, e.name)}" (file::name)`);
    }
    for (const k of ["kind", "language", "description", "commitSha"]) {
      if (!optStr(e[k])) fail(`${at}.${k} must be a string`);
    }
    if (!optInt(e.line) || !optInt(e.createdAt) || !optInt(e.updatedAt)) fail(`${at} line/timestamps must be integers`);
  });
  data.links.forEach((l, i) => {
    const at = `links[${i}]`;
    if (!l || !VALID_NODE_KINDS.has(l.fromKind) || !VALID_NODE_KINDS.has(l.toKind)) {
      fail(`${at}.fromKind/.toKind must be Note or Entity`);
    }
    if (!str(l.fromId) || !str(l.toId) || !str(l.type)) fail(`${at}.fromId/.toId/.type must be strings`);
    if (!optStr(l.commitSha) || !optInt(l.createdAt)) fail(`${at}.commitSha/.createdAt have the wrong type`);
  });
}

/**
 * Merge an export into this graph: nodes are upserted by id, links by
 * (from, type, to). All or nothing — any invalid record or a link to a node
 * that exists neither here nor in the import rolls everything back.
 */
export async function importGraph(conn, data) {
  validateImport(data);
  const now = Date.now();

  await inTransaction(conn, async () => {
    for (const n of data.notes) {
      await rows(
        conn,
        `MERGE (n:Note {id: $id})
         SET n.content = $content, n.kind = $kind, n.tags = $tags,
             n.createdAt = $createdAt, n.updatedAt = $updatedAt, n.embedding = NULL`,
        {
          id: n.id,
          content: n.content,
          kind: n.kind ?? "note",
          tags: n.tags ?? [],
          createdAt: n.createdAt ?? now,
          updatedAt: n.updatedAt ?? n.createdAt ?? now,
        }
      );
    }
    for (const e of data.entities) {
      await rows(
        conn,
        `MERGE (e:Entity {id: $id})
         SET e.name = $name, e.file = $file, e.kind = $kind, e.line = $line, e.language = $language,
             e.description = $description, e.commitSha = $commitSha,
             e.createdAt = $createdAt, e.updatedAt = $updatedAt, e.embedding = NULL`,
        {
          id: entityId(e.file, e.name),
          name: e.name,
          file: e.file,
          kind: e.kind ?? null,
          line: e.line ?? null,
          language: e.language ?? null,
          description: e.description ?? null,
          commitSha: e.commitSha ?? null,
          createdAt: e.createdAt ?? now,
          updatedAt: e.updatedAt ?? e.createdAt ?? now,
        }
      );
    }
    for (const l of data.links) {
      await requireNode(conn, l.fromKind, l.fromId);
      await requireNode(conn, l.toKind, l.toId);
      await rows(
        conn,
        `MATCH (a:${l.fromKind} {id: $fromId}), (b:${l.toKind} {id: $toId})
         MERGE (a)-[r:Link {type: $type}]->(b)
         ON CREATE SET r.commitSha = $commitSha, r.createdAt = $createdAt
         ON MATCH SET r.commitSha = $commitSha`,
        { fromId: l.fromId, toId: l.toId, type: l.type, commitSha: l.commitSha ?? null, createdAt: l.createdAt ?? now }
      );
    }
  });

  return { notes: data.notes.length, entities: data.entities.length, links: data.links.length };
}
