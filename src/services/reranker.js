const { RERANKER_URL, RERANK_PATHS } = require("../config/constants");

/**
 * Rerank rows with the cross-encoder. Returns null when the reranker is
 * unreachable so the caller can fall back to vector scores.
 */
async function rerank(question, rows, topK) {
  // Query + document must fit the reranker's physical batch (512 tokens).
  // ~3 chars/token is a safe floor, leaving room for the query and separators.
  const docCharBudget = Math.max(200, (450 - Math.ceil(question.length / 3)) * 3);
  const documents = rows.map((row) =>
    `${row.title}\n${row.content}`.slice(0, docCharBudget)
  );
  const topN = Math.min(topK, rows.length);

  for (const path of RERANK_PATHS) {
    let response;
    try {
      response = await fetch(`${RERANKER_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "ettin-reranker-150m-v1-q8_0",
          query: question,
          documents,
          top_n: topN,
          top_k: topN,
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      // Connection-level failure: server down or wrong port — no point trying other paths
      console.warn(`Reranker unreachable at ${RERANKER_URL}${path}: ${err.message}`);
      return null;
    }

    if (response.status === 404 || response.status === 501) continue;

    if (!response.ok) {
      console.warn(`Reranker returned ${response.status}:`, await response.text());
      return null;
    }

    const data = await response.json();
    const results = data.results || data.data || [];
    if (!results.length) {
      console.warn("Reranker returned no results, falling back to vector scores");
      return null;
    }

    const ranked = results
      .map((r) => {
        const row = rows[r.index];
        if (!row) return null;
        // Cross-encoder scores are raw logits, squash to 0..1 for display
        const raw = r.relevance_score ?? r.score ?? 0;
        const normalized = 1 / (1 + Math.exp(-raw));
        return {
          ...row,
          rerank_score: raw,
          score: parseFloat(normalized.toFixed(3)),
          distance: parseFloat((1 - normalized).toFixed(3)),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.rerank_score - a.rerank_score)
      .slice(0, topN);

    console.log(
      `Reranked ${rows.length} candidates via ${path} -> top ${ranked.length} ` +
      `(scores ${ranked[0]?.score} … ${ranked[ranked.length - 1]?.score})`
    );

    return ranked;
  }

  console.warn("Reranker has no supported /rerank endpoint (start llama-server with --reranking)");
  return null;
}

module.exports = { rerank };
