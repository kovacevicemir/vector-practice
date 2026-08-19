const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const cheerio = require("cheerio");

// Configure multer for file uploads (memory storage)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100 MB limit

const app = express();
app.use(express.json());

// Allow all CORS origins
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --------------------------------------------------
// CHUNKING CONFIGURATION
// --------------------------------------------------

// Hard ceiling enforced by the embedding server's physical batch size (llama-server -ub).
// Chunks are verified against the real tokenizer and split if they exceed this.
const EMBED_MAX_TOKENS = Number(process.env.EMBED_MAX_TOKENS) || 480;

const CHUNK_MAX_TOKENS = Number(process.env.CHUNK_MAX_TOKENS) || 400;
const CHUNK_OVERLAP_TOKENS = Math.round(CHUNK_MAX_TOKENS * 0.15);
const ESTIMATE_TOKENS_PER_CHAR = 4; // rough: 1 token ≈ 4 chars for English text
const CHUNK_MAX_CHARS = CHUNK_MAX_TOKENS * ESTIMATE_TOKENS_PER_CHAR;
const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * ESTIMATE_TOKENS_PER_CHAR;

// --------------------------------------------------
// UNIFIED FILE PARSER
// --------------------------------------------------

function sanitizeText(text) {
  return text
    // Remove null bytes and other invalid UTF-8 characters
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n?/g, "\n")
    // PDF/XLSX extraction pads with runs of spaces used purely for layout
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    // Keep one blank line: paragraph breaks are the chunker's preferred split point
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Estimate token count from character count.
 * Conservative: ~4 chars per token for English text.
 */
function estimateTokens(text) {
  return Math.ceil(text.length / ESTIMATE_TOKENS_PER_CHAR);
}

/**
 * Smart text chunker that splits text into overlapping chunks
 * respecting word boundaries and title/heading boundaries.
 *
 * Returns array of { text, metadata }
 */
function chunkText(text, docName, sectionTitle, pageNumber) {
  const cleaned = sanitizeText(text).trim();
  if (!cleaned) return [];

  const chunks = [];
  let position = 0;
  let chunkNumber = 0;

  while (position < cleaned.length) {
    // Determine the end of this chunk
    let chunkEnd = Math.min(position + CHUNK_MAX_CHARS, cleaned.length);

    // If we're not at the end, try to break at a sentence/paragraph boundary
    if (chunkEnd < cleaned.length) {
      // First try: break at double newline (paragraph boundary)
      const paraBreak = cleaned.indexOf("\n\n", position + CHUNK_MAX_CHARS * 0.5);
      if (paraBreak > position + CHUNK_MAX_CHARS * 0.5 && paraBreak < chunkEnd + CHUNK_OVERLAP_CHARS) {
        chunkEnd = paraBreak;
      } else {
        // Second try: break at sentence boundary (.!?)
        const sentBreak = findSentenceBreak(cleaned, chunkEnd);
        if (sentBreak > position + CHUNK_MAX_CHARS * 0.5 && sentBreak < chunkEnd + 200) {
          chunkEnd = sentBreak;
        } else {
          // Third try: break at last space
          const spaceBreak = cleaned.lastIndexOf(" ", chunkEnd);
          if (spaceBreak > position + CHUNK_MAX_CHARS * 0.5) {
            chunkEnd = spaceBreak;
          }
        }
      }
    }

    const chunkText = cleaned.substring(position, chunkEnd).trim();

    if (chunkText.length > 10) { // skip tiny fragments
      chunkNumber++;
      chunks.push({
        text: chunkText,
        metadata: {
          documentName: docName,
          sectionTitle: sectionTitle || null,
          pageNumber: pageNumber || null,
          chunkNumber: chunkNumber,
          totalChunks: Math.ceil(cleaned.length / (CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS)),
          tokens: estimateTokens(chunkText),
        },
      });
    }

    // Advance: chunk size minus overlap for sliding window
    const next = chunkEnd - CHUNK_OVERLAP_CHARS;
    position = next > position ? next : chunkEnd;
  }

  return chunks;
}

/**
 * Merge consecutive small sections (e.g. markdown headings with a line or two
 * under them) into groups close to CHUNK_MAX_CHARS so chunks carry real context.
 */
function mergeSections(sections) {
  const merged = [];
  let current = null;

  for (const section of sections) {
    const text = (section.text || "").trim();
    if (!text) continue;

    const samePage = current && current.pageNumber === (section.pageNumber || null);
    if (current && samePage && current.text.length + text.length + 2 <= CHUNK_MAX_CHARS) {
      current.text += `\n\n${text}`;
      continue;
    }

    if (current) merged.push(current);
    current = {
      text,
      pageNumber: section.pageNumber || null,
      sectionTitle: section.sectionTitle || null,
    };
  }

  if (current) merged.push(current);
  return merged;
}

/**
 * Find the nearest sentence break after a position.
 */
function findSentenceBreak(text, start) {
  const windowStart = Math.max(0, start - 200);
  const searchWindow = text.substring(windowStart, start + 500);
  const matches = searchWindow.match(/[.!?]+[\s\n]+/g);
  if (matches && matches.length > 0) {
    const last = matches[matches.length - 1];
    return windowStart + searchWindow.lastIndexOf(last) + last.length;
  }
  return text.lastIndexOf(" ", start + 500);
}

/**
 * Extract headings from text and return as { heading, position } pairs.
 */
function extractHeadings(text) {
  const headings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        title: match[2].trim(),
        position: i,
      });
    }
  }
  return headings;
}

// --------------------------------------------------
// PAGE/SECTION EXTRACTION (Apache Tika)
// --------------------------------------------------

// Tika server: podman run -d --name tika -p 9998:9998 docker.io/apache/tika:latest-full
const TIKA_URL = process.env.TIKA_URL || "http://127.0.0.1:9998";
const TIKA_OCR_LANG = process.env.TIKA_OCR_LANG || "eng";
const TIKA_OCR_TIMEOUT_SECONDS = Number(process.env.TIKA_OCR_TIMEOUT_SECONDS) || 180;

/** Send the raw file to Tika and get structured XHTML back. */
async function tikaToHtml(filePath) {
  const response = await fetch(`${TIKA_URL}/tika`, {
    method: "PUT",
    headers: {
      Accept: "text/html",
      "Content-Type": "application/octet-stream",
      // Filename is only a detection hint; Tika sniffs the actual type
      "Content-Disposition": `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`,
    },
    body: fs.readFileSync(filePath),
    signal: AbortSignal.timeout(300000),
  });

  if (!response.ok) {
    throw new Error(`Tika ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.text();
}

/**
 * Ask Tika for plain text with OCR-oriented headers.
 */
async function tikaToText(filePath) {
  const response = await fetch(`${TIKA_URL}/tika`, {
    method: "PUT",
    headers: {
      Accept: "text/plain",
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`,
      "X-Tika-OCRLanguage": TIKA_OCR_LANG,
      "X-Tika-OCRTimeoutSeconds": String(TIKA_OCR_TIMEOUT_SECONDS),
      "X-Tika-PDFOcrStrategy": "auto",
      "X-Tika-PDFextractInlineImages": "true",
    },
    body: fs.readFileSync(filePath),
    signal: AbortSignal.timeout(300000),
  });

  if (!response.ok) {
    throw new Error(`Tika ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.text();
}

function isLowSignalText(text) {
  const cleaned = sanitizeText(text || "");
  if (!cleaned) return true;

  const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  const symbolRatio = ((cleaned.match(/[^A-Za-z0-9\s]/g) || []).length) / Math.max(1, cleaned.length);

  return letters < 30 || words < 8 || symbolRatio > 0.45;
}

function sectionsFromPlainText(text) {
  const cleaned = sanitizeText(text || "");
  if (!cleaned) return [];

  const mdHeadings = extractHeadings(cleaned);
  if (mdHeadings.length) {
    const lines = cleaned.split("\n");
    return mdHeadings.map((h, i) => ({
      text: lines.slice(h.position, mdHeadings[i + 1] ? mdHeadings[i + 1].position : lines.length).join("\n"),
      pageNumber: null,
      sectionTitle: h.title,
    }));
  }

  const blocks = cleaned.split(/\n\s*\n/).filter((b) => b.trim());
  return blocks.length
    ? blocks.map((b, i) => ({ text: b, pageNumber: null, sectionTitle: `Section ${i + 1}` }))
    : [{ text: cleaned, pageNumber: null, sectionTitle: null }];
}

/**
 * Flatten Tika's XHTML into plain text while keeping block structure:
 * tables become pipe-separated rows, block elements become line breaks.
 */
function flattenHtml($) {
  $("br").replaceWith("\n");

  $("table").each((_, table) => {
    const rows = [];
    $(table)
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr)
          .find("th, td")
          .map((___, cell) => $(cell).text().trim())
          .get()
          .filter(Boolean);
        if (cells.length) rows.push(cells.join(" | "));
      });
    $(table).replaceWith(`\n${rows.join("\n")}\n`);
  });

  $("p, div, li, h1, h2, h3, h4, h5, h6").append("\n");
}

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

function sectionFrom($, el, pageNumber) {
  const $el = $(el);
  const heading = $el.find(HEADING_SELECTOR).first().text().trim();
  return {
    text: sanitizeText($el.text()),
    pageNumber,
    sectionTitle: heading || null,
  };
}

async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"].includes(ext);

  // Image-only files benefit more from plain OCR than HTML flattening.
  if (isImage) {
    const ocrText = await tikaToText(filePath);
    const imageSections = sectionsFromPlainText(ocrText);
    if (imageSections.length) return imageSections;
  }

  const html = await tikaToHtml(filePath);
  const $ = cheerio.load(html);
  flattenHtml($);

  let sections = [];

  // PDFs: Tika emits one <div class="page"> per page
  const pages = $("body div.page");
  if (pages.length) {
    sections = pages
      .map((i, el) => sectionFrom($, el, i + 1))
      .get()
      .filter((s) => s.text);
  }

  // Spreadsheets and presentations: one <div class="sheet"|"slide"> per unit
  if (!sections.length) {
    const units = $("body div.sheet, body div.slide");
    if (units.length) {
      sections = units
        .map((i, el) => {
          const section = sectionFrom($, el, null);
          return { ...section, sectionTitle: section.sectionTitle || `Sheet ${i + 1}` };
        })
        .get()
        .filter((s) => s.text);
    }
  }

  const text = sanitizeText($("body").text());

  // Word/HTML documents: split on headings Tika preserved
  if (!sections.length) {
    const headings = $("body").find(HEADING_SELECTOR);
    if (headings.length) {
      const titles = headings.map((_, el) => $(el).text().trim()).get().filter(Boolean);
      const headingSections = [];
      let rest = text;

      for (let i = 0; i < titles.length; i++) {
        const start = rest.indexOf(titles[i]);
        if (start < 0) continue;
        const nextStart = i + 1 < titles.length ? rest.indexOf(titles[i + 1], start + titles[i].length) : -1;
        const end = nextStart > start ? nextStart : rest.length;
        const body = rest.slice(start, end).trim();
        if (body) headingSections.push({ text: body, pageNumber: null, sectionTitle: titles[i] });
      }
      if (headingSections.length) sections = headingSections;
    }
  }

  if (!sections.length) {
    sections = sectionsFromPlainText(text);
  }

  const mergedText = sanitizeText(sections.map((s) => s.text).join("\n\n"));
  if (isLowSignalText(mergedText)) {
    try {
      const ocrText = await tikaToText(filePath);
      const ocrSections = sectionsFromPlainText(ocrText);
      const ocrMergedText = sanitizeText(ocrSections.map((s) => s.text).join("\n\n"));

      if (!isLowSignalText(ocrMergedText) || ocrMergedText.length > mergedText.length * 1.4) {
        console.log(`Using OCR fallback text for ${path.basename(filePath)}`);
        return ocrSections;
      }
    } catch (err) {
      console.warn(`OCR fallback failed for ${path.basename(filePath)}: ${err.message}`);
    }
  }

  return sections;
}

// --------------------------------------------------
// CHUNKED EMBED & INSERT
// --------------------------------------------------

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
    // Fall back to a deliberately pessimistic estimate
    return Math.ceil(text.length / 2);
  }
}

/**
 * Split text until every part fits the token limit, halving at word boundaries.
 * Returns [{ text, tokens }].
 */
async function splitToTokenLimit(text, limit) {
  const tokens = await countTokens(text);
  if (tokens <= limit) return [{ text, tokens }];

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

async function embedAndInsertChunks(docName, rawSections) {
  let inserted = 0;
  let skipped = 0;

  const rawChunks = buildDocumentChunks(docName, rawSections);

  // Reserve headroom for the "title: … | text: " prefix added at embed time
  const textBudget = EMBED_MAX_TOKENS - (await countTokens(`title: ${docName} | text: `)) - 24;

  const chunks = [];
  for (const chunk of rawChunks) {
    for (const part of await splitToTokenLimit(chunk.text, textBudget)) {
      chunks.push({
        text: part.text,
        metadata: { ...chunk.metadata, tokens: part.tokens },
      });
    }
  }

  // Chunk numbers must be unique per document, not per section
  chunks.forEach((chunk, index) => {
    chunk.metadata.chunkNumber = index + 1;
    chunk.metadata.totalChunks = chunks.length;
  });

  for (const chunk of chunks) {
    // Build a title that includes metadata for traceability
    const parts = [docName];
    if (chunk.metadata.sectionTitle) parts.push(chunk.metadata.sectionTitle);
    if (chunk.metadata.pageNumber) parts.push(`p${chunk.metadata.pageNumber}`);
    parts.push(`chunk${chunk.metadata.chunkNumber}`);
    const title = parts.join(" | ");

    // Check for duplicate
    const existing = await db.query(
      `SELECT id FROM documents WHERE title = $1`,
      [title]
    );
    if (existing.rows.length > 0) {
      console.log(`Skipping duplicate chunk: ${title}`);
      skipped++;
      continue;
    }

    chunk.metadata.insertedDate = new Date().toISOString();

    console.log(
      `Embedding [${chunk.metadata.chunkNumber}/${chunk.metadata.totalChunks}]: ${title} (${chunk.metadata.tokens} tokens)`
    );

    try {
      const embedding = await embedDocument(title, chunk.text);
      await db.query(
        `INSERT INTO documents (title, content, metadata, embedding)
         VALUES ($1, $2, $3, $4)`,
        [title, chunk.text, JSON.stringify(chunk.metadata), JSON.stringify(embedding)]
      );
      inserted++;
    } catch (err) {
      console.error(`Failed to embed chunk: ${title}`, err.message);
    }
  }

  return { inserted, skipped, totalChunks: chunks.length };
}

// Helper to generate page-based titles: baseName_1, baseName_2, ...
function getPageTitles(baseName, numPages) {
  return Array.from({ length: numPages }, (_, i) => `${baseName}_${i + 1}`);
}

// llama.cpp embedding server
// Start with: llama-server --model <path-to-embeddinggemma-300M-Q8_0.gguf> --embedding --host 127.0.0.1 --port 8081
const EMBEDDING_URL = "http://127.0.0.1:8081";

// llama.cpp reranker server
// Start with: llama-server --model <path-to-ettin-reranker-150m-v1-q8_0.gguf> --reranking --host 127.0.0.1 --port 8082
const RERANKER_URL = "http://127.0.0.1:8082";

// llama.cpp answer model (Qwen 4B)
const ANSWER_URL = "http://127.0.0.1:8083";
const ANSWER_MAX_TOKENS = 2048;

// PostgreSQL / pgvector
const db = new Client({
  host: "127.0.0.1",
  port: 5434,
  database: "vectordb",
  user: "postgres",
  password: "postgres",
});


// --------------------------------------------------
// TEXT → VECTOR
// --------------------------------------------------

async function embed(text) {
  const response = await fetch(`${EMBEDDING_URL}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();

  return data.data[0].embedding;
}

// EmbeddingGemma is prefix-trained: documents and queries must use different
// prompt prefixes or retrieval quality collapses.
function embedDocument(title, text) {
  return embed(`title: ${title || "none"} | text: ${text}`);
}

function embedQuery(query) {
  return embed(`task: search result | query: ${query}`);
}


// --------------------------------------------------
// RERANK
// --------------------------------------------------

// llama.cpp exposes the rerank endpoint under different paths depending on build
const RERANK_PATHS = ["/v1/rerank", "/rerank", "/reranking"];

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


// --------------------------------------------------
// INSERT
// --------------------------------------------------

app.post("/insert", async (req, res) => {
  try {
    const { title, content, chunked } = req.body;

    if (chunked) {
      // Chunked insert: splits content into ~700 token chunks with overlap
      const sections = [{ text: content, pageNumber: null, sectionTitle: null }];
      const result = await embedAndInsertChunks(title || "untitled", sections);
      return res.json({
        message: "Inserted (chunked)",
        inserted: result.inserted,
        skipped: result.skipped,
        totalChunks: result.totalChunks,
      });
    }

    // Legacy single-document insert
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


// --------------------------------------------------
// SEARCH
// --------------------------------------------------

app.get("/search", async (req, res) => {
  try {
    const question = req.query.q;
    const maxResults = Number(req.query.limit) || 100;
    const rerankTopK = Number(req.query.rerankTopK) || 10;
    const maxDistance = Number(req.query.maxDistance) || 0.40;

    if (!question) {
      return res.status(400).json({
        error: "Missing ?q= search query",
      });
    }

    // Step 1: Embed the query
    const embedding = await embedQuery(question);

    // Step 2: Retrieve up to 40 candidates from vector store
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

    // Step 3: Rerank with cross-encoder model on localhost:8082
    let scored;
    if (result.rows.length > 0) {
      const vectorScored = result.rows.map((row) => ({
        ...row,
        score: parseFloat(Math.max(0, Math.min(1, 1 - row.distance)).toFixed(3)),
      }));

      const reranked = await rerank(question, result.rows, rerankTopK);
      scored = reranked || vectorScored.slice(0, rerankTopK);
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

app.get("/search/chunks", async (req, res) => {
  try {
    const docTitle = req.query.docTitle;

    if (!docTitle) {
      return res.status(400).json({ error: "Missing ?docTitle= parameter" });
    }

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


// --------------------------------------------------
// LIST DOCS FILES (for "Open file" button)
// --------------------------------------------------

app.get("/docs-files", (req, res) => {
  try {
    const folder = process.env.DOCS_FOLDER || "./docs";
    const files = fs.readdirSync(folder).filter(f => !f.startsWith("."));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------
// START
// --------------------------------------------------

async function main() {
  await db.connect();

  // Create table if it doesn't exist
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS documents (
      id BIGSERIAL PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL,
      metadata JSONB,
      embedding VECTOR(768)
    );

    -- Add metadata column if table already existed (migration)
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata JSONB;
  `);

  app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
  });
}

async function importJson() {
  const fs = require("fs");

  const documents = JSON.parse(
    fs.readFileSync("./data.json", "utf8")
  );

  for (const document of documents) {

    console.log(`Embedding ${document.id}: ${document.title}`);

    const embedding = await embedDocument(document.title, document.body);

    await db.query(
      `
      INSERT INTO documents (title, content, embedding)
      VALUES ($1, $2, $3)
      `,
      [
        document.title,
        document.body,
        JSON.stringify(embedding),
      ]
    );
  }

  console.log(`Imported ${documents.length} documents`);
}

app.post("/import-folder", async (req, res) => {
  try {
    const folder = (req.body && req.body.folder) || "./docs";

    // Tika sniffs content types itself, so no extension whitelist is needed
    const files = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => entry.name);

    let imported = 0;
    let skipped = 0;
    let failed = [];

    for (const file of files) {
      const filePath = path.join(folder, file);

      try {
        const baseName = file.replace(/\.[^.]+$/, ""); // remove extension
        const rawSections = await extractTextFromFile(filePath);
        const result = await embedAndInsertChunks(baseName, rawSections);
        imported += result.inserted;
        skipped += result.skipped;
        if (result.totalChunks > 0) {
          console.log(`  ${file}: ${result.totalChunks} chunks (${result.inserted} inserted, ${result.skipped} skipped)`);
        }
      } catch (err) {
        console.error(`Failed to import ${file}:`, err.message);
        failed.push({ file, error: err.message });
      }
    }

    res.json({
      message: "Folder imported",
      imported,
      skipped,
      failed,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});



// --------------------------------------------------
// UPLOAD FILE (drag & drop)
// --------------------------------------------------

app.post("/upload-file", upload.single("file"), async (req, res) => {
  try {
    const folder = process.env.DOCS_FOLDER || path.join(__dirname, "docs");

    // Multer v2 uses req.file (singular); v1 used req.files
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const file = req.file;
    const destPath = path.join(folder, file.originalname);

    // Ensure destination directory exists
    fs.mkdirSync(folder, { recursive: true });

    // Read buffer from the uploaded file (multer stores in memory for small uploads)
    const buffer = file.buffer || fs.readFileSync(file.path);

    // Write to docs folder
    fs.writeFileSync(destPath, buffer);

    console.log(`Uploaded file: ${file.originalname} -> ${destPath}`);

    // Embed only this newly added file
    const baseName = file.originalname.replace(/\.[^.]+$/, "");
    const rawSections = await extractTextFromFile(destPath);

    if (rawSections.length === 0) {
      console.log(`  ${file.originalname}: no text extracted, skipping embedding`);
      return res.json({ inserted: 0, skipped: 0, totalChunks: 0 });
    }

    const result = await embedAndInsertChunks(baseName, rawSections);
    console.log(`  ${file.originalname}: ${result.totalChunks} chunks (${result.inserted} inserted, ${result.skipped} skipped)`);

    res.json({
      message: "File uploaded and embedded",
      file: file.originalname,
      inserted: result.inserted,
      skipped: result.skipped,
      totalChunks: result.totalChunks,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// --------------------------------------------------
// COMBINE & ANSWER
// --------------------------------------------------

let answerContextSize = null;

/** Read the answer model's context window from llama-server, cached. */
async function getAnswerContextSize() {
  if (answerContextSize) return answerContextSize;
  try {
    const response = await fetch(`${ANSWER_URL}/props`, { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const props = await response.json();
      const ctx = props.default_generation_settings?.n_ctx || props.n_ctx;
      if (ctx) answerContextSize = ctx;
    }
  } catch (err) {
    console.warn("Could not read model context size:", err.message);
  }
  return answerContextSize || 16384;
}

async function countAnswerTokens(text) {
  try {
    const response = await fetch(`${ANSWER_URL}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    return (data.tokens || []).length;
  } catch (err) {
    return Math.ceil(text.length / 2);
  }
}

/**
 * Remove high-noise lines before sending context to the answer model.
 * Keeps this conservative to avoid deleting potentially useful facts.
 */
function sanitizeAnswerContext(text) {
  if (!text) return "";

  const lines = String(text).split("\n");
  const cleaned = [];
  let previousBlank = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ").trim();

    if (!line) {
      if (!previousBlank) cleaned.push("");
      previousBlank = true;
      continue;
    }
    previousBlank = false;

    const len = line.length;
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    const digits = (line.match(/[0-9]/g) || []).length;
    const symbols = (line.match(/[^A-Za-z0-9\s]/g) || []).length;
    const pipes = (line.match(/\|/g) || []).length;

    const letterRatio = letters / len;
    const digitRatio = digits / len;
    const symbolRatio = symbols / len;

    const mostlyStructuredNoise =
      len > 40 &&
      letterRatio < 0.15 &&
      (digitRatio > 0.45 || symbolRatio > 0.55);

    const tableDelimiterNoise = pipes >= 8 && letters < 10;

    if (mostlyStructuredNoise || tableDelimiterNoise) continue;

    cleaned.push(line);
  }

  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function tokenizeForOverlap(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
  );
}

function keywordOverlapScore(query, title, content) {
  const q = tokenizeForOverlap(query);
  if (!q.size) return 0;

  const d = tokenizeForOverlap(`${title || ""}\n${content || ""}`);
  let hits = 0;
  for (const token of q) {
    if (d.has(token)) hits++;
  }
  return hits / q.size;
}

app.post("/combine-and-answer", async (req, res) => {
  try {
    const {
      query,
      chunks,
      includeRelated = true,
      relatedWindow = 2,
      relatedBefore,
      relatedAfter,
      maxContextChunks = 10,
    } = req.body;

    if (!query || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: "Missing query or chunks array" });
    }

    // Group selected chunks by source document
    const docs = new Map();
    for (const chunk of chunks) {
      const baseTitle = String(chunk.title || "untitled").split(" | ")[0];
      if (!docs.has(baseTitle)) docs.set(baseTitle, new Set());
      docs.get(baseTitle).add(String(chunk.id));
    }

    const beforeWindow = Math.max(0, Number(relatedBefore ?? relatedWindow) || 0);
    const afterWindow = Math.max(0, Number(relatedAfter ?? relatedWindow) || 0);
    const maxChunks = Math.max(1, Number(maxContextChunks) || 10);

    // Collect selected and neighbour chunks per document.
    const candidates = [];

    for (const [baseTitle, selectedIds] of docs) {
      let rows;

      if (includeRelated) {
        const related = await db.query(
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
          [baseTitle]
        );
        rows = related.rows;
      }

      // Fall back to what the client sent if the document is not in the DB
      if (!rows || rows.length === 0) {
        rows = chunks
          .filter((c) => String(c.title || "").split(" | ")[0] === baseTitle)
          .map((c) => ({ id: c.id, title: c.title, content: c.content }));
      }

      const selectedPositions = rows
        .map((row, i) => (selectedIds.has(String(row.id)) ? i : -1))
        .filter((i) => i >= 0);

      rows.forEach((row, i) => {
        const isSelected = selectedIds.has(String(row.id));
        const distance = selectedPositions.length
          ? Math.min(...selectedPositions.map((p) => Math.abs(p - i)))
          : i;

        const isNeighbour = selectedPositions.some(
          (p) => i >= p - beforeWindow && i <= p + afterWindow
        );

        // Keep selected chunks always; keep only nearby neighbours if enabled.
        if (!isSelected && (!includeRelated || !isNeighbour)) return;

        const cleanedContent = sanitizeAnswerContext(row.content);
        if (!cleanedContent) return;

        const overlap = keywordOverlapScore(query, row.title, cleanedContent);

        candidates.push({
          id: row.id,
          docTitle: baseTitle,
          title: row.title,
          content: cleanedContent,
          order: i,
          priority: isSelected ? 0 : distance,
          isSelected,
          overlap,
          text: `## ${row.title}${isSelected ? " (matched)" : ""}\n\n${cleanedContent}`,
        });
      });
    }

    const selectedCandidates = candidates.filter((c) => c.isSelected);
    const neighbourCandidates = candidates.filter((c) => !c.isSelected);

    // If too many selected chunks are sent, keep only the most query-relevant ones.
    let selectedKept = selectedCandidates;
    if (selectedCandidates.length > maxChunks) {
      const rerankedSelected = await rerank(query, selectedCandidates, maxChunks);
      selectedKept = rerankedSelected || [...selectedCandidates]
        .sort((a, b) => b.overlap - a.overlap || a.order - b.order)
        .slice(0, maxChunks);
    }

    const roomForNeighbours = Math.max(0, maxChunks - selectedKept.length);
    let neighboursKept = [];

    if (roomForNeighbours > 0 && neighbourCandidates.length > 0) {
      // Strictly re-rank neighbours to keep only high-signal context.
      const rerankedNeighbours = await rerank(query, neighbourCandidates, roomForNeighbours);
      neighboursKept = rerankedNeighbours || [...neighbourCandidates]
        .sort(
          (a, b) =>
            b.overlap - a.overlap ||
            a.priority - b.priority ||
            a.docTitle.localeCompare(b.docTitle) ||
            a.order - b.order
        )
        .slice(0, roomForNeighbours);
    }

    let included = [...selectedKept, ...neighboursKept];

    // The template is only ever read — it is the prompt, not an output file
    const TEMPLATE_PATH = "./combineAndAnswer.md";
    let template;
    try {
      template = fs.readFileSync(TEMPLATE_PATH, "utf8");
    } catch (e) {
      return res.status(500).json({ error: `Template file not found at ${TEMPLATE_PATH}` });
    }

    const renderPrompt = (includedRows) => {
      const byDoc = new Map();
      for (const c of includedRows) {
        if (!byDoc.has(c.docTitle)) byDoc.set(c.docTitle, []);
        byDoc.get(c.docTitle).push(c);
      }
      const mdParts = [...byDoc.entries()].map(([docTitle, items]) => {
        const body = items
          .sort((a, b) => a.order - b.order)
          .map((c) => c.text)
          .join("\n\n");
        return `---\n# ${docTitle}\n---\n\n${body}`;
      });
      return template
        .replace(/{{QUERY}}/g, () => query)
        .replace(/{{CHUNKS}}/g, () => mdParts.join("\n\n"));
    };

    // Reserve room for the generated answer plus chat-template overhead
    const contextSize = await getAnswerContextSize();
    const promptBudget = contextSize - ANSWER_MAX_TOKENS - 512;

    if (promptBudget <= 0) {
      return res.status(500).json({ error: `Model context (${contextSize}) is too small to answer` });
    }

    let mdContent = renderPrompt(included);
    let promptTokens = await countAnswerTokens(mdContent);

    while (promptTokens > promptBudget && included.length > 1) {
      // Drop least useful context first: neighbours before selected chunks.
      let dropIndex = -1;
      let bestDropScore = Number.NEGATIVE_INFINITY;

      for (let i = 0; i < included.length; i++) {
        const c = included[i];
        const dropScore = c.isSelected
          ? -1000 + c.priority + c.overlap
          : 1000 + c.priority - c.overlap;

        if (dropScore > bestDropScore) {
          bestDropScore = dropScore;
          dropIndex = i;
        }
      }

      if (dropIndex < 0) break;
      included = included.filter((_, i) => i !== dropIndex);
      mdContent = renderPrompt(included);
      promptTokens = await countAnswerTokens(mdContent);
    }

    const droppedChunks = candidates.length - included.length;
    console.log(
      `Combine & answer: ${docs.size} document(s), ${included.length}/${candidates.length} chunk(s), ` +
      `${promptTokens}/${promptBudget} prompt tokens` +
      (droppedChunks ? ` (${droppedChunks} dropped to fit context)` : "")
    );

    let response;
    try {
      response = await fetch(`${ANSWER_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen",
          messages: [
            {
              role: "user",
              content: mdContent,
            },
          ],
          max_tokens: ANSWER_MAX_TOKENS,
          temperature: 0.3,
          // Qwen otherwise burns the whole budget on reasoning and returns empty content
          reasoning_format: "none",
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(300000),
      });
    } catch (err) {
      console.error("Model unreachable:", err.message);
      return res.status(502).json({
        error: `Model service unreachable at ${ANSWER_URL}: ${err.message}`,
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Model returned ${response.status}:`, errText);
      return res.status(502).json({
        error: "Model service unavailable",
        details: errText,
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (e) {
      console.error("Model returned non-JSON response:", e.message);
      return res.status(502).json({ error: "Model returned invalid JSON" });
    }

    const choice = data.choices?.[0];
    const raw =
      choice?.message?.content ||
      choice?.message?.reasoning_content ||
      data.message?.content ||
      data.text ||
      "";

    // Strip any reasoning block the model still emitted inline
    const answer = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || raw.trim();

    if (!answer) {
      console.error("Empty model response:", JSON.stringify(data).slice(0, 500));
      return res.status(502).json({
        error: `Model returned no answer (finish_reason: ${choice?.finish_reason || "unknown"})`,
      });
    }

    res.json({
      answer,
      documents: [...docs.keys()],
      contextChunks: included.length,
      totalChunks: candidates.length,
      promptTokens,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

main().catch(console.error);
