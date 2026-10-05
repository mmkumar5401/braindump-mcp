import os from "node:os";
import path from "node:path";

/**
 * Local embedding + re-ranking models (transformers.js, ONNX on CPU). Both
 * load lazily on first use, once per process, and are cached on disk under
 * ~/.agents/braindump/.models after a one-time download (~80 MB).
 *
 * Nothing here is allowed to break braindump: callers treat any failure as
 * "models unavailable" and fall back to keyword search.
 *
 * Measured warm on an M-series Mac: embedding ~1.5 ms per text, re-ranking
 * 15 candidates ~60 ms. Models: bge-small-en-v1.5 (embeddings) and
 * mxbai-rerank-xsmall-v1 (re-ranking; best of four compared on top-1).
 */

export const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const RERANK_MODEL = "mixedbread-ai/mxbai-rerank-xsmall-v1";
export const EMBED_DIM = 384;

// bge models expect this instruction on queries (not on stored passages).
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

// Hits found only by meaning (no keyword match) must clear these bars, or
// they're noise. Calibrated on braindump-style notes (test/models.test.js):
// bge-small puts related pairs at 0.57-0.74 and unrelated ones mostly below
// 0.5; mxbai's scores overlap between related and unrelated, so the
// re-ranker orders results but only drops the clearly irrelevant.
const DEFAULT_THRESHOLDS = { minSimilarity: 0.5, minRerankScore: -5 };

/** Thresholds for the active models (fakes may supply their own). */
export function thresholds() {
  return { ...DEFAULT_THRESHOLDS, ...(override?.thresholds ?? {}) };
}

// After a failed load (e.g. offline first run), don't retry on every call —
// each attempt could stall on the network.
const RETRY_AFTER_MS = 5 * 60 * 1000;

let override = null;

/** Swap in fake models (tests) or `null` to restore the real ones. */
export function setModels(models) {
  override = models;
}

export function modelsDisabled() {
  return !override && process.env.BRAINDUMP_MODELS === "off";
}

function lazy(load) {
  let promise = null;
  let failedAt = 0;
  return () => {
    if (!promise) {
      if (Date.now() - failedAt < RETRY_AFTER_MS) {
        return Promise.reject(new Error("model failed to load recently; retrying later"));
      }
      promise = load().catch((err) => {
        promise = null;
        failedAt = Date.now();
        throw err;
      });
    }
    return promise;
  };
}

async function transformers() {
  const t = await import("@huggingface/transformers");
  t.env.cacheDir = path.join(os.homedir(), ".agents", "braindump", ".models");
  return t;
}

const loadEmbedder = lazy(async () => {
  const { pipeline } = await transformers();
  return pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" });
});

const loadReranker = lazy(async () => {
  const { AutoTokenizer, AutoModelForSequenceClassification } = await transformers();
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(RERANK_MODEL),
    AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: "q8" }),
  ]);
  return { tokenizer, model };
});

const BATCH = 32;

/** Embed passages (or a query, with `query: true`). Returns number[][] of EMBED_DIM, L2-normalised. */
export async function embed(texts, { query = false } = {}) {
  if (texts.length === 0) return [];
  if (override) return override.embed(texts, { query });
  if (modelsDisabled()) throw new Error("models disabled (BRAINDUMP_MODELS=off)");

  const extractor = await loadEmbedder();
  const inputs = query ? texts.map((t) => QUERY_PREFIX + t) : texts;
  const out = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const tensor = await extractor(inputs.slice(i, i + BATCH), { pooling: "cls", normalize: true });
    out.push(...tensor.tolist());
  }
  return out;
}

/** Relevance score per document for `query` (higher = more relevant). */
export async function rerank(query, docs) {
  if (docs.length === 0) return [];
  if (override) return override.rerank(query, docs);
  if (modelsDisabled()) throw new Error("models disabled (BRAINDUMP_MODELS=off)");

  const { tokenizer, model } = await loadReranker();
  const inputs = await tokenizer(new Array(docs.length).fill(query), {
    text_pair: docs,
    padding: true,
    truncation: true,
  });
  const { logits } = await model(inputs);
  return Array.from(logits.data);
}

/** Start loading both models in the background (long-lived server). Never throws. */
export function warmModels() {
  if (override || modelsDisabled()) return;
  loadEmbedder().catch(() => {});
  loadReranker().catch(() => {});
}
