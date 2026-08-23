const { Router } = require("express");
const { getClient } = require("../config/database");
const { sanitizeSearchQuery } = require("../utils/text");
const { embedQuery } = require("../services/embedder");
const { rerank } = require("../services/reranker");

const router = Router();

// --------------------------------------------------
// SEARCH — hybrid ranking: vector similarity + cross-encoder reranker
// --------------------------------------------------

const VECTOR_WEIGHT = 0.4;
const RERANKER_WEIGHT = 0.6;

router.get("/search", async (req, res) => {
  try {
    const question = req.query.q;
    const maxResults = Number(req.query.limit) || 100;
    const rerankTopK = Number(req.query.rerankTopK) || 10;
    const maxDistance = Number(req.query.maxDistance) || 0.7;

    if (!question) {
      return res.status(400).json({
        error: "Missing ?q= search query",
      });
    }

    // Step 1: Sanitize the query for embedding (strip question words, stop words, punctuation)
    // The full original query is still used for the response and combine-and-answer
    const searchQuery = sanitizeSearchQuery(question);
    const embedding = await embedQuery(searchQuery);

    // Step 2: Retrieve up to 40 candidates from vector store
    const db = getClient();
    const candidatesLimit = Math.min(maxResults, 40);
    const result = await db.query(
      `
      SELECT
        id,
        title,
        content,
        metadata,
        embedding <=> $1 AS distance
      FROM documents
      WHERE embedding <=> $1 < $2
      ORDER BY embedding <=> $1
      LIMIT $3
      `,
      [
        JSON.stringify(embedding),
        maxDistance,
        candidatesLimit
      ]
    );

    // Step 3: Rerank with cross-encoder model, then blend with vector scores
    let scored;
    if (result.rows.length > 0) {
      // Build vector-score map: id → normalized vector score (1 = best match)
      const vectorScoreByDoc = new Map();
      for (const row of result.rows) {
        vectorScoreByDoc.set(row.id, 1 - Number(row.distance));
      }

      const reranked = await rerank(question, result.rows, rerankTopK);

      if (reranked) {
        // Blend vector + reranker scores so strong vector matches aren't lost
        scored = reranked.map((r) => ({
          ...r,
          score: parseFloat(
            (
              (vectorScoreByDoc.get(r.id) || 0) * VECTOR_WEIGHT +
              r.score * RERANKER_WEIGHT
            ).toFixed(3)
          ),
        })).sort((a, b) => b.score - a.score);
      } else {
        // Reranker unavailable — fall back to vector scores
        scored = [...vectorScoreByDoc.entries()]
          .map(([id, vs]) => {
            const row = result.rows.find((r) => r.id === id);
            return row ? { ...row, score: parseFloat(vs.toFixed(3)) } : null;
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score)
          .slice(0, rerankTopK);
      }
    } else {
      scored = [];
    }

    res.json(scored);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message,
    });
  }
});

// --------------------------------------------------
// GET ALL CHUNKS FROM SAME DOCUMENT
// --------------------------------------------------

router.get("/search/chunks", async (req, res) => {
  try {
    const docTitle = req.query.docTitle;

    if (!docTitle) {
      return res.status(400).json({ error: "Missing ?docTitle= parameter" });
    }

    const db = getClient();
    const result = await db.query(
      `
      SELECT id, title, content, metadata
      FROM documents
      WHERE title = $1 OR title LIKE $1 || ' | %'
      ORDER BY
        COALESCE((metadata->>'chunkNumber')::INTEGER,
                 CAST(SUBSTRING(title FROM 'chunk([0-9]+)') AS INTEGER),
                 0) ASC,
        id ASC
      `,
      [docTitle]
    );

    res.json(result.rows);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
