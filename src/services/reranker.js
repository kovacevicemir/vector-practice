const { RERANKER_URL, RERANK_PATHS, RERANKER_BATCH_SIZE } = require("../config/constants");

// Conservative estimation: numbers/symbols tokenize at ~1.5 chars/token,
// while plain English is ~4 chars/token. We use 1.5 as a safe floor.
// 5 tokens overhead per doc for separators like [CLS] [SEP]
const CHARS_PER_TOKEN = 1.5;
const OVERHEAD_TOKENS_PER_DOC = 5;

/**
 * Get the best available token count estimate for a row's content.
 * Uses metadata.tokens if available (stored from actual tokenization),
 * otherwise falls back to conservative char-based estimate.
 */
function getDocTokens(row) {
  if (row.metadata) {
    try {
      const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      if (meta.tokens && typeof meta.tokens === "number") {
        return meta.tokens;
      }
    } catch {}
  }
  return Math.ceil((row.content || "").length / CHARS_PER_TOKEN);
}

/**
 * Estimate how many tokens the query + one document pair will consume.
 * Used to fit batches within the reranker's physical batch size.
 */
function estimatePairTokens(query, row) {
  const qt = Math.ceil(query.length / CHARS_PER_TOKEN);
  const dt = getDocTokens(row);
  return qt + dt + OVERHEAD_TOKENS_PER_DOC;
}

/**
 * Split rows into batches where each batch fits within the reranker's
 * physical batch size limit. Returns an array of batch objects
 * ({ row, docText }).
 */
function buildBatches(query, rows) {
  const batches = [];
  let currentBatch = [];
  let currentBatchTokens = 0;

  for (const row of rows) {
    const docText = `${row.title}\n${row.content}`;
    const pairTokens = estimatePairTokens(query, row);

    // If this single pair already exceeds the batch size, truncate the doc
    // text aggressively so we can still process it.
    if (pairTokens > RERANKER_BATCH_SIZE) {
      const qt = Math.ceil(query.length / CHARS_PER_TOKEN);
      const maxDocTokens = RERANKER_BATCH_SIZE - qt - OVERHEAD_TOKENS_PER_DOC;
      // Use 1 char = 1 token as worst case (digits/symbols tokenize densely)
      const maxDocChars = Math.max(60, maxDocTokens);
      const truncated = `${row.title}\n${row.content}`.slice(0, maxDocChars);

      // If current batch is non-empty, flush it first
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchTokens = 0;
      }

      // Put the truncated doc in its own batch
      currentBatch.push({ row, docText: truncated });
      currentBatchTokens = RERANKER_BATCH_SIZE; // mark as full
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchTokens = 0;
      continue;
    }

    // Check if adding this doc would exceed the batch
    if (currentBatchTokens + pairTokens > RERANKER_BATCH_SIZE && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchTokens = 0;
    }

    currentBatch.push({ row, docText });
    currentBatchTokens += pairTokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Send one batch to the reranker and parse the results.
 * Returns the raw results array (each with .index, .relevance_score, etc.)
 * or null on failure.
 */
async function callReranker(query, batchItems, topN) {
  const documents = batchItems.map((item) => item.docText);

  for (const path of RERANK_PATHS) {
    let response;
    try {
      response = await fetch(`${RERANKER_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "ettin-reranker-150m-v1-q8_0",
          query,
          documents,
          top_n: topN,
          top_k: topN,
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      console.warn(`Reranker unreachable at ${RERANKER_URL}${path}: ${err.message}`);
      return null;
    }

    if (response.status === 404 || response.status === 501) continue;

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`Reranker returned ${response.status} (batch size ${documents.length}):`, errText);
      return null;
    }

    const data = await response.json();
    return data.results || data.data || [];
  }

  console.warn("Reranker has no supported /rerank endpoint");
  return null;
}

/**
 * Rerank rows with the cross-encoder. Returns null when the reranker is
 * unreachable so the caller can fall back to vector scores.
 *
 * Handles the physical batch size constraint by:
 * 1. Batching documents into groups that fit within RERANKER_BATCH_SIZE tokens
 * 2. Making separate API calls for each batch
 * 3. Merging and re-ranking the combined results
 */
async function rerank(question, rows, topK) {
  if (!rows || rows.length === 0) return [];

  const topN = Math.min(topK, rows.length);

  // Build batches that fit within the physical batch size
  const batches = buildBatches(question, rows);

  if (batches.length === 0) return null;

  // Collect all scored results across batches
  const allScored = [];

  for (const batch of batches) {
    const batchTopN = Math.min(topN, batch.length);
    const results = await callReranker(question, batch, batchTopN);

    if (!results || results.length === 0) {
      console.warn(`Reranker batch failed (${batch.length} docs), skipping`);
      continue;
    }

    for (const r of results) {
      const row = batch[r.index]?.row;
      if (!row) continue;

      const raw = r.relevance_score ?? r.score ?? 0;
      const normalized = 1 / (1 + Math.exp(-raw));

      allScored.push({
        ...row,
        rerank_score: raw,
        score: parseFloat(normalized.toFixed(3)),
        distance: parseFloat((1 - normalized).toFixed(3)),
      });
    }
  }

  if (allScored.length === 0) {
    console.warn("Reranker returned no results across all batches, falling back to vector scores");
    return null;
  }

  // Re-rank across all batches: sort by raw reranker score, take top N
  const ranked = allScored
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, topN);

  console.log(
    `Reranked ${rows.length} candidates in ${batches.length} batch(es) -> top ${ranked.length} ` +
    `(scores ${ranked[0]?.score.toFixed(3)} … ${ranked[ranked.length - 1]?.score.toFixed(3)})`
  );

  return ranked;
}

module.exports = { rerank };
