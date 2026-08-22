const {
  EMBED_MAX_TOKENS,
  EMBED_SAFETY_MARGIN,
  MAX_TITLE_CHARS,
  MAX_TITLE_TOKENS,
} = require("../config/constants");
const { getClient } = require("../config/database");
const { estimateTokens } = require("../utils/text");
const { runWithConcurrency } = require("../utils/concurrency");
const { chunkText, mergeSections } = require("./chunker");
const { embedBatch, embedDocumentSafe } = require("./embedder");

/**
 * Process a file into chunks, embed each chunk, and insert into DB.
 * Each chunk gets its own embedding with metadata.
 */
function buildDocumentChunks(docName, rawSections) {
  const chunks = [];

  for (const section of mergeSections(rawSections)) {
    for (const chunk of chunkText(section.text, docName, section.sectionTitle, section.pageNumber)) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

/**
 * Ask the embedding server for the real token count. The chars/4 heuristic is
 * wildly inaccurate on PDFs (numbers, tables, OCR artefacts), so anything that
 * must respect the server batch size has to be measured, not estimated.
 */
async function countTokens(text) {
  const { EMBEDDING_URL } = require("../config/constants");
  try {
    const response = await fetch(`${EMBEDDING_URL}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    return (data.tokens || []).length;
  } catch (err) {
    // Fall back to a conservative estimate. Special characters (math, symbols)
    // tokenize at ~1 char/token, so 1.5 chars/token is a safe middle ground.
    return Math.ceil(text.length / 1.5);
  }
}

/**
 * Split text until every part fits the token limit, halving at word boundaries.
 * Returns [{ text, tokens }].
 */
async function splitToTokenLimit(text, limit) {
  // Use a tighter limit to leave room for the "title: … | text: " prefix
  const effectiveLimit = limit - EMBED_SAFETY_MARGIN;

  // Fast path: use local tiktoken estimate to avoid HTTP round-trip.
  // estimateTokens runs locally (no HTTP) and uses a proper BPE tokenizer.
  // BUT: the embedding model uses a different tokenizer (Gemma/BGE vs cl100k_base)
  // which can count 30-50% more tokens for the same text. So we add a safety buffer.
  const TOKENIZER_SAFETY_BUFFER = 96;
  const localEstimate = estimateTokens(text);
  if (localEstimate + TOKENIZER_SAFETY_BUFFER <= effectiveLimit) {
    return [{ text, tokens: localEstimate }];
  }

  const tokens = await countTokens(text);
  if (tokens <= effectiveLimit) return [{ text, tokens }];

  let cut = text.lastIndexOf(" ", Math.floor(text.length / 2));
  if (cut <= 0) cut = Math.floor(text.length / 2);

  const left = text.slice(0, cut).trim();
  const right = text.slice(cut).trim();
  if (!left || !right) return [{ text, tokens }];

  const [leftParts, rightParts] = await Promise.all([
    splitToTokenLimit(left, limit),
    splitToTokenLimit(right, limit),
  ]);
  return [...leftParts, ...rightParts];
}

/**
 * Full pipeline: chunk → token-limit → embed → insert.
 */
async function embedAndInsertChunks(docName, rawSections, { concurrency = 6, batchSize = 8, logInterval = 50, onProgress } = {}) {
  const rawChunks = buildDocumentChunks(docName, rawSections);

  // Reserve headroom for the "title: … | text: " prefix added at embed time.
  const { EMBEDDING_URL } = require("../config/constants");
  // Use local estimate for the title prefix to avoid yet another HTTP call
  const prefixTokens = estimateTokens(`title: ${docName} | text: `);
  const textBudget = EMBED_MAX_TOKENS - prefixTokens - MAX_TITLE_TOKENS - 24;

  // Process splitToTokenLimit concurrently for all raw chunks
  const splitTasks = rawChunks.map((chunk) => async () => {
    const parts = await splitToTokenLimit(chunk.text, textBudget);
    return parts.map((part) => ({
      text: part.text,
      metadata: { ...chunk.metadata, tokens: part.tokens },
    }));
  });

  const nestedChunks = await runWithConcurrency(splitTasks, concurrency);
  const chunks = nestedChunks.flat();

  // Chunk numbers must be unique per document, not per section
  chunks.forEach((chunk, index) => {
    chunk.metadata.chunkNumber = index + 1;
    chunk.metadata.totalChunks = chunks.length;
  });

  if (chunks.length === 0) {
    return { inserted: 0, skipped: 0, totalChunks: 0 };
  }

  // Build titles for all chunks upfront
  // Truncate section titles to 150 chars so the full title fits the embedding prefix budget
  const chunkTitles = chunks.map((chunk) => {
    const parts = [docName];
    if (chunk.metadata.sectionTitle) {
      const st = String(chunk.metadata.sectionTitle);
      parts.push(st.length > MAX_TITLE_CHARS ? st.slice(0, MAX_TITLE_CHARS) + "…" : st);
    }
    if (chunk.metadata.pageNumber) parts.push(`p${chunk.metadata.pageNumber}`);
    parts.push(`chunk${chunk.metadata.chunkNumber}`);
    return parts.join(" | ");
  });

  const db = getClient();

  // Batch duplicate check: query all existing titles for this document in one go
  const existingResult = await db.query(
    `SELECT title FROM documents WHERE title = $1 OR title LIKE $1 || ' | %'`,
    [docName]
  );
  const existingTitles = new Set(existingResult.rows.map((r) => r.title));

  // Filter out duplicates and build the work queue
  const workItems = [];
  for (let i = 0; i < chunks.length; i++) {
    const title = chunkTitles[i];
    if (existingTitles.has(title)) {
      console.log(`Skipping duplicate chunk: ${title}`);
      continue;
    }
    workItems.push({ chunk: chunks[i], title });
  }

  const totalWork = workItems.length;
  const totalSkipped = chunks.length - totalWork;

  if (totalWork === 0) {
    console.log(`All ${chunks.length} chunk(s) already exist, skipping`);
    return { inserted: 0, skipped: totalSkipped, totalChunks: chunks.length };
  }

  console.log(`Processing ${totalWork}/${chunks.length} chunk(s) with batch embedding...`);

  // Batch items into groups for parallel embedding + insertion
  let inserted = 0;
  let failed = 0;
  let completed = 0;

  // Build batches
  const batches = [];
  for (let i = 0; i < workItems.length; i += batchSize) {
    batches.push(workItems.slice(i, i + batchSize));
  }

  // Process batches with concurrency limit (multiple batches at once)
  const batchTasks = batches.map((batch, batchIdx) => async () => {
    // Prepare all embed texts for this batch
    const embedTexts = batch.map((item) =>
      `title: ${item.title} | text: ${item.chunk.text}`
    );

    // Assign insertion date
    for (const item of batch) {
      item.chunk.metadata.insertedDate = new Date().toISOString();
    }

    try {
      const embeddings = await embedBatch(embedTexts);

      // Insert sequentially within each batch — batch-level concurrency
      // already gives parallelism, and pg.Client doesn't support concurrent queries.
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        try {
          await db.query(
            `INSERT INTO documents (title, content, metadata, embedding)
             VALUES ($1, $2, $3, $4)`,
            [item.title, item.chunk.text, JSON.stringify(item.chunk.metadata), JSON.stringify(embeddings[i])]
          );
          inserted++;
        } catch (err) {
          console.error(`Failed to insert chunk: ${item.title}`, err.message);
          failed++;
        }
        completed++;
      }
    } catch (err) {
      console.error(`Batch ${batchIdx + 1}/${batches.length} failed:`, err.message);
      // Fall back to individual embedding for this batch
      for (const item of batch) {
        try {
          const embedding = await embedDocumentSafe(item.title, item.chunk.text);
          await db.query(
            `INSERT INTO documents (title, content, metadata, embedding)
             VALUES ($1, $2, $3, $4)`,
            [item.title, item.chunk.text, JSON.stringify(item.chunk.metadata), JSON.stringify(embedding)]
          );
          inserted++;
        } catch (err2) {
          console.error(`Failed to embed/insert chunk: ${item.title}`, err2.message);
          failed++;
        }
        completed++;
      }
    }

    // Report progress
    if (onProgress) onProgress(completed, totalWork);

    // Log progress after each batch
    const pct = ((completed / totalWork) * 100).toFixed(1);
    console.log(
      `  Batch ${batchIdx + 1}/${batches.length}: ${completed}/${totalWork} (${pct}%) — ${inserted} inserted, ${failed} failed`
    );
  });

  await runWithConcurrency(batchTasks, Math.max(1, Math.min(concurrency, batches.length)));

  console.log(
    `Finished ${docName}: ${inserted} inserted, ${totalSkipped} skipped, ${failed} failed (${totalWork} attempted)`
  );

  return { inserted, skipped: totalSkipped, totalChunks: chunks.length };
}

module.exports = {
  buildDocumentChunks,
  countTokens,
  splitToTokenLimit,
  embedAndInsertChunks,
};
