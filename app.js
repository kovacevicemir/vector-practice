const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const cheerio = require("cheerio");

// Configure multer for file uploads — write directly to docs folder.
const DOCS_FOLDER = () => process.env.DOCS_FOLDER || path.join(__dirname, "docs");
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = DOCS_FOLDER();
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
}); // no size limit

const app = express();
app.use(express.json());

// Allow all CORS origins
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --------------------------------------------------
// CHUNKING CONFIGURATION
// --------------------------------------------------

// Hard ceiling enforced by the embedding server's physical batch size (llama-server -ub).
// Chunks are verified against the real tokenizer and split if they exceed this.
// Match the llama-server -ub physical batch size exactly.
// The token-count fallback is deliberately pessimistic (1.5 chars/token)
// because math notation, symbols, and HTML entities tokenize much denser than English text.
const EMBED_MAX_TOKENS = Number(process.env.EMBED_MAX_TOKENS) || 512;
const EMBED_SAFETY_MARGIN = 16; // reserve headroom for prefix "title: … | text: " variability

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

// Plain-text formats that can be read directly without Apache Tika
const PLAIN_TEXT_EXTS = new Set([".txt", ".md", ".json", ".csv", ".xml", ".html", ".htm"]);

/**
 * Read a plain text file directly, bypassing Apache Tika entirely.
 * Much faster and avoids sending large files over HTTP to the Tika container.
 */
function readPlainTextFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();

  // For HTML/HTM files, parse with cheerio to extract clean text
  if (ext === ".html" || ext === ".htm") {
    const $ = cheerio.load(content);
    flattenHtml($);
    return sanitizeText($("body").text());
  }

  return sanitizeText(content);
}

/**
 * Run async tasks with a concurrency limit.
 * Ensures we don't overwhelm the embedding server or DB connection pool.
 */
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  const executing = new Set();

  for (const [index, task] of tasks.entries()) {
    const promise = task().then((result) => {
      executing.delete(promise);
      return result;
    });
    executing.add(promise);
    results[index] = promise;

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"].includes(ext);

  // Plain text formats: read directly, bypass Tika entirely
  if (PLAIN_TEXT_EXTS.has(ext)) {
    const text = readPlainTextFile(filePath);
    console.log(`Direct read: ${path.basename(filePath)} (${(text.length / 1024 / 1024).toFixed(1)} MB)`);
    return sectionsFromPlainText(text || "");
  }

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

async function embedAndInsertChunks(docName, rawSections, { concurrency = 6, batchSize = 8, logInterval = 50 } = {}) {
  const rawChunks = buildDocumentChunks(docName, rawSections);

  // Reserve headroom for the "title: … | text: " prefix added at embed time.
  // Section titles are truncated to MAX_TITLE_CHARS (150), so the worst-case title
  // overhead is roughly: docName (~10) + 150 chars + " | chunkNNNN" (~15) ≈ 175 chars.
  // At a conservative 1.5 chars/token, that's ~117 tokens for the full title.
  const MAX_TITLE_TOKENS = 140; // generous upper bound including all markers
  const textBudget = EMBED_MAX_TOKENS - (await countTokens(`title: ${docName} | text: `)) - MAX_TITLE_TOKENS - 24;

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
  const MAX_TITLE_CHARS = 150;
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

      // Insert all chunks in this batch concurrently
      const insertTasks = batch.map((item, i) => async () => {
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
      });

      await runWithConcurrency(insertTasks, concurrency);
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
let db = new Client({
  host: "127.0.0.1",
  port: 5434,
  database: "vectordb",
  user: "postgres",
  password: "postgres",
});
db.on("error", (err) => console.error("DB connection error:", err.message));


// --------------------------------------------------
// TEXT → VECTOR
// --------------------------------------------------

/**
 * Embed a single text string via the embedding server.
 */
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

/**
 * Embed multiple texts in a single batch request.
 * The OpenAI-compatible /v1/embeddings endpoint accepts arrays of strings.
 * Falls back to individual requests if the server doesn't support batching.
 */
async function embedBatch(texts) {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await embed(texts[0])];

  try {
    const response = await fetch(`${EMBEDDING_URL}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();

    // The response may be out of order or have index field
    if (Array.isArray(data.data)) {
      const sorted = [...data.data].sort((a, b) => a.index - b.index);
      return sorted.map((item) => item.embedding);
    }

    throw new Error("Unexpected response format");
  } catch (err) {
    // Batch embedding not supported — fall back to individual requests.
    // The texts are already prefixed with "title: … | text: ", so use embedRawSafe
    // which handles "too large" errors by splitting the raw text.
    console.warn(`Batch embedding failed, falling back to individual requests (${err.message.slice(0, 80)})`);
    return Promise.all(texts.map((t) => embedRawSafe(t)));
  }
}

// EmbeddingGemma is prefix-trained: documents and queries must use different
// prompt prefixes or retrieval quality collapses.
function embedDocument(title, text) {
  return embed(`title: ${title || "none"} | text: ${text}`);
}

function embedQuery(query) {
  return embed(`task: search result | query: ${query}`);
}

/**
 * Safe version of embedDocument that handles "too large" errors.
 * If the embedding server rejects the input as too large, the text
 * is split in half at a word boundary and each half is embedded separately.
 * Returns a single combined embedding (average of the two halves).
 */
async function embedDocumentSafe(title, text) {
  const prefixed = `title: ${title || "none"} | text: ${text}`;

  try {
    return await embed(prefixed);
  } catch (err) {
    const msg = String(err.message || "");
    // Check if the error is about input being too large
    if (msg.includes("too large") || msg.includes("too many tokens") || msg.includes("maximum context length")) {
      console.warn(`  Splitting oversized chunk: ${title} (${err.message.slice(0, 80)})`);

      // Split text in half at word boundary
      const mid = Math.floor(text.length / 2);
      let cut = text.lastIndexOf(" ", mid);
      if (cut <= 0) cut = text.indexOf(" ", mid);
      if (cut <= 0 || cut >= text.length - 1) cut = mid;

      const left = text.slice(0, cut).trim();
      const right = text.slice(cut).trim();

      if (!left || !right) {
        // Can't split further, just rethrow
        throw err;
      }

      // Embed both halves and average the vectors
      const [leftEmbed, rightEmbed] = await Promise.all([
        embedDocumentSafe(title, left),
        embedDocumentSafe(title, right),
      ]);

      // Average the embeddings
      return leftEmbed.map((v, i) => (v + rightEmbed[i]) / 2);
    }

    // Not a size error, rethrow
    throw err;
  }
}

/**
 * Raw safe embed — same as embedDocumentSafe but for already-prefixed text.
 * Used by embedBatch fallback where "title: … | text: " is already baked in.
 */
async function embedRawSafe(prefixedText) {
  try {
    return await embed(prefixedText);
  } catch (err) {
    const msg = String(err.message || "");
    if (msg.includes("too large") || msg.includes("too many tokens") || msg.includes("maximum context length")) {
      console.warn(`  Splitting oversized prefixed text (${err.message.slice(0, 60)})`);
      const mid = Math.floor(prefixedText.length / 2);
      let cut = prefixedText.lastIndexOf(" ", mid);
      if (cut <= 0) cut = prefixedText.indexOf(" ", mid);
      if (cut <= 0 || cut >= prefixedText.length - 1) cut = mid;
      const left = prefixedText.slice(0, cut).trim();
      const right = prefixedText.slice(cut).trim();
      if (!left || !right) throw err;
      const [leftEmbed, rightEmbed] = await Promise.all([
        embedRawSafe(left),
        embedRawSafe(right),
      ]);
      return leftEmbed.map((v, i) => (v + rightEmbed[i]) / 2);
    }
    throw err;
  }
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

    // Step 1: Sanitize the query for embedding (strip question words, stop words, punctuation)
    // The full original query is still used for the response and combine-and-answer
    const searchQuery = sanitizeSearchQuery(question);
    const embedding = await embedQuery(searchQuery);

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
    const folder = DOCS_FOLDER();
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
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const file = req.file;
    // Multer already wrote the file directly to ./docs/ with the original filename
    console.log(`Uploaded file: ${file.originalname} -> ${file.path}`);

    // Embed only this newly added file
    const baseName = file.originalname.replace(/\.[^.]+$/, "");
    const rawSections = await extractTextFromFile(file.path);

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
    // Conservative: special characters tokenize at ~1 char/token
    return Math.ceil(text.length / 1.5);
  }
}

/**
 * Strip question words, common stop words, and punctuation from a search query
 * so the embedding model matches factual content rather than question syntax.
 * The full original query is preserved for combine-and-answer.
 */
function sanitizeSearchQuery(query) {
  if (!query) return "";
  // Remove punctuation (keep hyphens inside words, keep apostrophes)
  let cleaned = query.replace(/[?.,!;:()"'“”‘’]+/g, " ");
  // Lowercase for stop-word matching
  const words = cleaned.toLowerCase().split(/\s+/).filter(Boolean);
  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "need", "dare", "ought",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
    "us", "them", "my", "your", "his", "its", "our", "their",
    "this", "that", "these", "those",
    "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
    "and", "but", "or", "nor", "not", "so", "yet", "if", "because",
    "as", "until", "while", "of", "at", "by", "for", "with", "about",
    "against", "between", "into", "through", "during", "before", "after",
    "above", "below", "to", "from", "up", "down", "in", "out", "on", "off",
    "over", "under", "again", "further", "then", "once", "here", "there",
    "all", "each", "every", "both", "few", "more", "most", "other", "some",
    "such", "no", "nor", "only", "own", "same", "too", "very", "just",
    "please", "tell", "find", "show", "give", "list", "let", "know",
  ]);
  const kept = words.filter(w => w.length > 1 && !stopWords.has(w));
  return kept.length > 0 ? kept.join(" ") : query;
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
      const finishReason = choice?.finish_reason || "unknown";
      console.error(`Model returned no answer (finish_reason: ${finishReason}):`, JSON.stringify(data).slice(0, 500));

            if (finishReason === "content_filter") {
        // DeepSeek has a built-in content filter. Retry with strategies:
        // 1) system prompt to steer response + near-zero temperature
        // 2) minimal prompt with context stripped
        const retryStrategies = [
          // Strategy 1: system prompt + very low temperature
          async () => {
            const res = await fetch(`${ANSWER_URL}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "qwen",
                messages: [
                  { role: "system", content: "You are a helpful assistant. Provide a concise factual answer based on the given context. Respond directly." },
                  { role: "user", content: mdContent },
                ],
                max_tokens: ANSWER_MAX_TOKENS,
                temperature: 0.01,
                repeat_penalty: 1.0,
                reasoning_format: "none",
                chat_template_kwargs: { enable_thinking: false },
              }),
              signal: AbortSignal.timeout(300000),
            });
            return res;
          },
          // Strategy 2: strip context, keep only the query
          async () => {
            const minimalPrompt = `Answer this question: ${query}

(Relevant context was provided but omitted due to content policy. Answer concisely based on what you know.)`;
            const res = await fetch(`${ANSWER_URL}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "qwen",
                messages: [
                  { role: "system", content: "You are a helpful assistant. Answer concisely." },
                  { role: "user", content: minimalPrompt },
                ],
                max_tokens: ANSWER_MAX_TOKENS,
                temperature: 0.01,
                reasoning_format: "none",
                chat_template_kwargs: { enable_thinking: false },
              }),
              signal: AbortSignal.timeout(300000),
            });
            return res;
          },
        ];

        for (const strategy of retryStrategies) {
          try {
            const retryRes = await strategy();
            if (retryRes.ok) {
              const retryData = await retryRes.json();
              const retryChoice = retryData.choices?.[0];
              const retryRaw =
                retryChoice?.message?.content ||
                retryChoice?.message?.reasoning_content ||
                retryData.message?.content ||
                retryData.text ||
                "";
              const retryAnswer = retryRaw.replace(/ thinking[\s\S]*?<\/think>/g, "").trim() || retryRaw.trim();
              if (retryAnswer) {
                return res.json({
                  answer: retryAnswer,
                  documents: [...docs.keys()],
                  contextChunks: included.length,
                  totalChunks: candidates.length,
                  promptTokens,
                });
              }
            }
          } catch (retryErr) {
            console.error("Content filter retry strategy failed:", retryErr.message);
          }
        }

        return res.status(502).json({
          error: "Model blocked the response (content_filter). The context may contain flagged content. Try a different query or reduce context.",
          finish_reason: "content_filter",
        });
      }

      return res.status(502).json({
        error: `Model returned no answer (finish_reason: ${finishReason})`,
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

// --------------------------------------------------
// DATABASE BACKUP (pg_dump → download)
// --------------------------------------------------

app.get("/backup", async (req, res) => {
  const { spawn } = require("child_process");

  try {
    const filename = "database_backup.sql";

    res.setHeader("Content-Type", "application/sql");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    const child = spawn("podman", [
      "exec",
      "-i",
      "postgres",
      "pg_dump",
      "-U",
      db.user,
      "-d",
      db.database,
    ]);

    child.stdout.pipe(res);

    let stderr = "";

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      console.error("Backup failed:", err.message);

      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.destroy(err);
      }
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error("pg_dump failed:", stderr);

        if (!res.headersSent) {
          res.status(500).json({
            error: stderr || `pg_dump exited with code ${code}`,
          });
        } else {
          res.destroy(
            new Error(stderr || `pg_dump exited with code ${code}`)
          );
        }
      }
    });

  } catch (error) {
    console.error("Backup failed:", error.message);

    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.destroy(error);
    }
  }
});

// --------------------------------------------------
// DATABASE RESTORE (import database_backup)
// --------------------------------------------------

app.post("/restore", upload.single("backup"), async (req, res) => {
  const { spawn } = require("child_process");

  let backupFile = null;
  let restoreClient = null;

  try {
    // --------------------------------------------------
    // 1. Get backup file
    // --------------------------------------------------

    if (req.file) {
      backupFile = req.file.path;
    } else {
      backupFile = path.join(__dirname, "database_backup.sql");

      if (!fs.existsSync(backupFile)) {
        return res.status(400).json({
          error: "No backup file found",
        });
      }
    }

    // --------------------------------------------------
    // 2. Completely close current application DB connection
    // --------------------------------------------------

    try {
      await db.end();
    } catch (err) {
      console.warn("DB disconnect warning:", err.message);
    }

    // --------------------------------------------------
    // Helper: execute SQL inside PostgreSQL container
    // --------------------------------------------------

    const runPsql = (database, sql) => {
      return new Promise((resolve, reject) => {
        const child = spawn("podman", [
          "exec",
          "-i",
          "postgres",
          "psql",
          "-U",
          "postgres",
          "-d",
          database,
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          sql,
        ]);

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        child.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        child.on("error", reject);

        child.on("close", (code) => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(
              new Error(
                stderr || `psql exited with code ${code}`
              )
            );
          }
        });
      });
    };

    // --------------------------------------------------
    // 3. Create fresh restore database
    // --------------------------------------------------

    console.log("Creating fresh restore database...");

    await runPsql(
      "postgres",
      "DROP DATABASE IF EXISTS vectordb_restore WITH (FORCE)"
    );

    await runPsql(
      "postgres",
      "CREATE DATABASE vectordb_restore"
    );

    // --------------------------------------------------
    // 4. Restore SQL dump
    // --------------------------------------------------

    console.log("Restoring backup...");

    await new Promise((resolve, reject) => {
      const child = spawn("podman", [
        "exec",
        "-i",
        "postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "vectordb_restore",
        "-v",
        "ON_ERROR_STOP=1",
      ], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      let finished = false;

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        if (!finished) {
          finished = true;
          reject(err);
        }
      });

      const fileStream = fs.createReadStream(backupFile);

      fileStream.on("error", (err) => {
        if (!finished) {
          finished = true;
          reject(err);
        }
      });

      // IMPORTANT:
      // Ignore EPIPE because psql may close stdin after an error.
      child.stdin.on("error", (err) => {
        if (err.code !== "EPIPE" && !finished) {
          finished = true;
          reject(err);
        }
      });

      fileStream.pipe(child.stdin);

      child.on("close", (code) => {
        if (finished) return;

        finished = true;

        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `PostgreSQL restore failed:\n${stderr}`
            )
          );
        }
      });
    });

    console.log("Backup restored successfully.");

    // --------------------------------------------------
    // 5. Verify restored database
    // --------------------------------------------------

    restoreClient = new Client({
      host: "127.0.0.1",
      port: 5434,
      database: "vectordb_restore",
      user: "postgres",
      password: "postgres",
    });

    restoreClient.on("error", (err) => {
      console.error(
        "Restore verification connection error:",
        err.message
      );
    });

    await restoreClient.connect();

    const result = await restoreClient.query(
      "SELECT COUNT(*)::bigint AS count FROM documents"
    );

    const documentCount = Number(result.rows[0].count);

    await restoreClient.end();
    restoreClient = null;

    console.log(
      `Restore verification successful: ${documentCount} documents`
    );

    // --------------------------------------------------
    // 6. Drop existing vectordb
    // --------------------------------------------------

    console.log("Removing old vectordb...");

    await runPsql(
      "postgres",
      "DROP DATABASE IF EXISTS vectordb WITH (FORCE)"
    );

    // --------------------------------------------------
    // 7. Rename restored DB
    // --------------------------------------------------

    console.log("Renaming restored database...");

    await runPsql(
      "postgres",
      "ALTER DATABASE vectordb_restore RENAME TO vectordb"
    );

    // --------------------------------------------------
    // 8. IMPORTANT:
    // Create a BRAND NEW pg Client.
    // Do not reuse the old Client object.
    // --------------------------------------------------

    console.log("Creating new application database connection...");

    db = new Client({
      host: "127.0.0.1",
      port: 5434,
      database: "vectordb",
      user: "postgres",
      password: "postgres",
    });

    db.on("error", (err) => {
      console.error(
        "Application database connection error:",
        err.message
      );
    });

    await db.connect();

    console.log("New database connection established.");

    // --------------------------------------------------
    // 9. Clean uploaded backup
    // --------------------------------------------------

    if (req.file) {
      try {
        fs.unlinkSync(backupFile);
      } catch (_) {}
    }

    // --------------------------------------------------
    // 10. Success
    // --------------------------------------------------

    console.log(
      `Database restore complete: ${documentCount} documents`
    );

    return res.json({
      message: "Database restored successfully",
      documents: documentCount,
    });

  } catch (error) {
    console.error("Restore failed:", error.message);

    if (restoreClient) {
      try {
        await restoreClient.end();
      } catch (_) {}
    }

    if (req.file && backupFile) {
      try {
        fs.unlinkSync(backupFile);
      } catch (_) {}
    }

    // Try to reconnect application DB if restore failed
    try {
      db = new Client({
        host: "127.0.0.1",
        port: 5434,
        database: "vectordb",
        user: "postgres",
        password: "postgres",
      });

      db.on("error", (err) => {
        console.error(
          "Database connection error:",
          err.message
        );
      });

      await db.connect();
      console.log("Application DB reconnected.");
    } catch (reconnectError) {
      console.error(
        "Could not reconnect application DB:",
        reconnectError.message
      );
    }

    return res.status(500).json({
      error: error.message,
    });
  }
});


main().catch(console.error);
