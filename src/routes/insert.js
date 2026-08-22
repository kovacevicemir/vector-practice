const { Router } = require("express");
const { getClient } = require("../config/database");
const { EMBED_MAX_TOKENS, EMBED_SAFETY_MARGIN } = require("../config/constants");
const { estimateTokens } = require("../utils/text");
const { embedDocument } = require("../services/embedder");
const { embedAndInsertChunks } = require("../services/db-service");

const router = Router();

// --------------------------------------------------
// INSERT
// --------------------------------------------------

router.post("/insert", async (req, res) => {
  try {
    const { title, content, chunked } = req.body;

    // Auto-detect: if content is large enough to need chunking or chunked is explicitly set
    const needsChunking = chunked || estimateTokens(content || "") > EMBED_MAX_TOKENS - EMBED_SAFETY_MARGIN;

    if (needsChunking) {
      // Chunked insert: splits content into overlapping chunks with metadata
      const sections = [{ text: content, pageNumber: null, sectionTitle: null }];
      const result = await embedAndInsertChunks(title || "untitled", sections);
      return res.json({
        message: "Inserted (chunked)",
        inserted: result.inserted,
        skipped: result.skipped,
        totalChunks: result.totalChunks,
      });
    }

    // Small content: single-document insert (no chunking needed)
    const db = getClient();
    const embedding = await embedDocument(title, content);

    const result = await db.query(
      `
      INSERT INTO documents (title, content, metadata, embedding)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [
        title,
        content,
        JSON.stringify({ documentName: title }),
        JSON.stringify(embedding),
      ]
    );

    res.json({
      id: result.rows[0].id,
      message: "Inserted",
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
