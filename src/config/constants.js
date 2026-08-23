const path = require("path");
const multer = require("multer");
const fs = require("fs");

// --------------------------------------------------
// DOCS FOLDER
// --------------------------------------------------

const DOCS_FOLDER = () => process.env.DOCS_FOLDER || path.join(__dirname, "..", "..", "docs");

// --------------------------------------------------
// MULTER CONFIG
// --------------------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = DOCS_FOLDER();
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
});

// --------------------------------------------------
// CHUNKING CONFIGURATION
// --------------------------------------------------

// Hard ceiling enforced by the embedding server's physical batch size (llama-server -ub).
// Chunks are verified against the real tokenizer and split if they exceed this.
// Match the llama-server -ub physical batch size exactly.
// The token-count fallback is deliberately pessimistic (1.5 chars/token)
// because math notation, symbols, and HTML entities tokenize much denser than English text.
const EMBED_MAX_TOKENS = Number(process.env.EMBED_MAX_TOKENS) || 2048;
const EMBED_SAFETY_MARGIN = 16; // reserve headroom for prefix "title: … | text: " variability

const CHUNK_MAX_TOKENS = Number(process.env.CHUNK_MAX_TOKENS) || 1700;
const CHUNK_OVERLAP_TOKENS = Math.round(CHUNK_MAX_TOKENS * 0.15);
const ESTIMATE_TOKENS_PER_CHAR = 4; // rough: 1 token ≈ 4 chars for English text
const CHUNK_MAX_CHARS = CHUNK_MAX_TOKENS * ESTIMATE_TOKENS_PER_CHAR;
const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * ESTIMATE_TOKENS_PER_CHAR;

// --------------------------------------------------
// APACHE TIKA
// --------------------------------------------------

const TIKA_URL = process.env.TIKA_URL || "http://127.0.0.1:9998";
const TIKA_OCR_LANG = process.env.TIKA_OCR_LANG || "eng";
const TIKA_OCR_TIMEOUT_SECONDS = Number(process.env.TIKA_OCR_TIMEOUT_SECONDS) || 180;

// --------------------------------------------------
// LLAMA.CPP SERVERS
// --------------------------------------------------

const EMBEDDING_URL = "http://127.0.0.1:8081";
const RERANKER_URL = "http://127.0.0.1:8082";
const RERANKER_BATCH_SIZE = Number(process.env.RERANKER_BATCH_SIZE) || 480; // physical batch (-ub) minus safety margin
const ANSWER_URL = "http://127.0.0.1:8083";
const ANSWER_MAX_TOKENS = 2048;

// --------------------------------------------------
// PLAIN TEXT FORMATS (bypass Tika)
// --------------------------------------------------

const PLAIN_TEXT_EXTS = new Set([".txt", ".md", ".json", ".csv", ".xml", ".html", ".htm"]);

// --------------------------------------------------
// IMAGE FORMATS
// --------------------------------------------------

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"]);

// --------------------------------------------------
// TITLE CONSTRAINTS
// --------------------------------------------------

const MAX_TITLE_CHARS = 150;
const MAX_TITLE_TOKENS = 140; // generous upper bound including all markers

// --------------------------------------------------
// HEADING / RERANK PATHS
// --------------------------------------------------

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const RERANK_PATHS = ["/v1/rerank", "/rerank", "/reranking"];

// --------------------------------------------------
// DB DEFAULTS
// --------------------------------------------------

const DB_CONFIG = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 5434,
  database: process.env.DB_NAME || "vectordb",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
};

module.exports = {
  DOCS_FOLDER,
  upload,
  EMBED_MAX_TOKENS,
  EMBED_SAFETY_MARGIN,
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  ESTIMATE_TOKENS_PER_CHAR,
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  TIKA_URL,
  TIKA_OCR_LANG,
  TIKA_OCR_TIMEOUT_SECONDS,
  EMBEDDING_URL,
  RERANKER_URL,
  RERANKER_BATCH_SIZE,
  ANSWER_URL,
  ANSWER_MAX_TOKENS,
  PLAIN_TEXT_EXTS,
  IMAGE_EXTS,
  MAX_TITLE_CHARS,
  MAX_TITLE_TOKENS,
  HEADING_SELECTOR,
  RERANK_PATHS,
  DB_CONFIG,
};
