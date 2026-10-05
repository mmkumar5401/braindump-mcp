import MiniSearch from "minisearch";
import { BraindumpError } from "./errors.js";
import { loadSearchDocs, storeEmbeddings } from "./db.js";
import { embed, rerank, modelsDisabled, thresholds } from "./embeddings.js";

/**
 * Hybrid retrieval over notes and entities:
 *
 *   1. keyword  — BM25 (MiniSearch, prefix + light fuzzy, camelCase-aware)
 *                 plus plain substring matches, so nothing the old
 *                 CONTAINS search found is ever lost;
 *   2. semantic — cosine similarity against stored embeddings (local
 *                 bge-small model); missing embeddings are backfilled first;
 *   3. fusion   — reciprocal rank fusion (rank-based, so BM25 and cosine
 *                 scores never need calibrating against each other);
 *   4. re-rank  — a cross-encoder re-scores the top candidates.
 *
 * Any model failure degrades to keyword search; it never fails the call.
 */

const MODES = ["hybrid", "keyword", "semantic"];
const MAX_LIMIT = 100;
const CANDIDATES = 50; // per ranked list
const RERANK_TOP = 15;
const RRF_K = 60;

/** The text a node is embedded and keyword-indexed as. */
export function docText(d) {
  if (d.type === "note") {
    const tags = d.tags?.length ? ` (tags: ${d.tags.join(", ")})` : "";
    return `${d.kind ?? "note"}: ${d.content ?? ""}${tags}`;
  }
  return `${d.kind ?? "entity"} ${d.name ?? ""} (${d.file ?? ""}): ${d.description ?? ""}`;
}

const keyOf = (d) => `${d.type}:${d.id}`;

// Function words match almost every document; letting them count turns
// "weather in Amsterdam" into a hit on any note containing "in".
const STOPWORDS = new Set(
  ("a an and are as at be but by can do does for from has have how i if in into is it its of on or " +
    "should so than that the their then there these this to was we were what when where which who " +
    "why will with you your").split(" ")
);

function processTerm(term) {
  const t = term.toLowerCase();
  return STOPWORDS.has(t) ? null : t;
}

// openBraindump -> "openBraindump", "open", "Braindump"
function tokenize(text) {
  const base = MiniSearch.getDefault("tokenize")(text);
  const out = [];
  for (const tok of base) {
    out.push(tok);
    const parts = tok.split(/(?<=[a-z0-9])(?=[A-Z])|_/).filter(Boolean);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

function keywordRanking(docs, query) {
  const index = new MiniSearch({
    idField: "key",
    fields: ["name", "text"],
    tokenize,
    processTerm,
    searchOptions: {
      boost: { name: 2 },
      prefix: (term) => term.length >= 3,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
      tokenize,
      processTerm,
    },
  });
  index.addAll(docs.map((d) => ({ key: keyOf(d), name: d.name ?? "", text: docText(d) })));
  return index.search(query).slice(0, CANDIDATES).map((r) => r.id);
}

function substringRanking(docs, query) {
  const q = query.toLowerCase();
  return docs
    .filter((d) => docText(d).toLowerCase().includes(q))
    .slice(0, CANDIDATES)
    .map(keyOf);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Vectors are L2-normalised, so the dot product is the cosine similarity.
function semanticRanking(docs, queryVector) {
  return docs
    .filter((d) => d.embedding)
    .map((d) => ({ key: keyOf(d), sim: dot(d.embedding, queryVector) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, CANDIDATES);
}

/** Embed every doc that has no stored embedding yet, and store the vectors. */
export async function backfillEmbeddings(conn, docs = null) {
  const missing = (docs ?? (await loadSearchDocs(conn, { missingOnly: true }))).filter((d) => !d.embedding);
  if (missing.length === 0) return 0;
  const vectors = await embed(missing.map(docText));
  await storeEmbeddings(
    conn,
    missing.map((d, i) => ({ type: d.type, id: d.id, embedding: vectors[i] }))
  );
  missing.forEach((d, i) => {
    d.embedding = vectors[i];
  });
  return missing.length;
}

function strip({ embedding: _e, type: _t, ...rest }) {
  return rest;
}

export async function hybridSearch(conn, query, { mode = "hybrid", limit = 10, rerank: useRerank = true } = {}) {
  if (typeof query !== "string" || query.trim() === "") {
    throw new BraindumpError(`search query must not be empty (use grep "." to list everything)`);
  }
  if (!MODES.includes(mode)) {
    throw new BraindumpError(`mode must be one of ${MODES.join(", ")} (got ${mode})`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BraindumpError(`limit must be an integer from 1 to ${MAX_LIMIT} (got ${limit})`);
  }

  const { minSimilarity, minRerankScore } = thresholds();
  const docs = await loadSearchDocs(conn);
  const byKey = new Map(docs.map((d) => [keyOf(d), d]));
  let effectiveMode = mode;
  let degraded = null;

  const lists = [];
  const keywordHits = new Set();
  const semanticSim = new Map();

  const addKeywordLists = () => {
    for (const list of [keywordRanking(docs, query), substringRanking(docs, query)]) {
      lists.push(list);
      list.forEach((k) => keywordHits.add(k));
    }
  };

  if (mode !== "semantic") addKeywordLists();

  if (mode !== "keyword") {
    try {
      if (modelsDisabled()) throw new Error("models disabled (BRAINDUMP_MODELS=off)");
      await backfillEmbeddings(conn, docs);
      const [queryVector] = await embed([query], { query: true });
      const ranked = semanticRanking(docs, queryVector).filter(
        (r) => keywordHits.has(r.key) || r.sim >= minSimilarity
      );
      ranked.forEach((r) => semanticSim.set(r.key, r.sim));
      lists.push(ranked.map((r) => r.key));
    } catch (err) {
      effectiveMode = "keyword";
      degraded = `semantic search unavailable: ${err.message}`;
      if (mode === "semantic") addKeywordLists();
    }
  }

  // Reciprocal rank fusion.
  const fused = new Map();
  for (const list of lists) {
    list.forEach((key, rank) => fused.set(key, (fused.get(key) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  let ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([key, score]) => ({ key, score }));

  let reranked = false;
  if (useRerank && effectiveMode !== "keyword" && ranked.length > 1) {
    const head = ranked.slice(0, Math.max(RERANK_TOP, limit));
    try {
      const scores = await rerank(query, head.map((r) => docText(byKey.get(r.key))));
      const rescored = head
        .map((r, i) => ({ key: r.key, score: scores[i], fusedRank: i }))
        .filter((r) => keywordHits.has(r.key) || r.score >= minRerankScore)
        .sort((a, b) => b.score - a.score || a.fusedRank - b.fusedRank);
      ranked = [...rescored, ...ranked.slice(head.length)];
      reranked = true;
    } catch {
      // keep the fused order
    }
  }

  const notes = [];
  const entities = [];
  for (const { key, score } of ranked.slice(0, limit)) {
    const d = byKey.get(key);
    const item = { ...strip(d), score: Number(score.toFixed(4)) };
    if (semanticSim.has(key)) item.similarity = Number(semanticSim.get(key).toFixed(4));
    (d.type === "note" ? notes : entities).push(item);
  }

  const result = { mode: effectiveMode, reranked, notes, entities };
  if (degraded) result.degraded = degraded;
  return result;
}
