const { ESTIMATE_TOKENS_PER_CHAR } = require("../config/constants");

// --------------------------------------------------
// TIKTOKEN — accurate BPE token estimation
// Cached encoder avoids alloc/free per call.
// --------------------------------------------------
let _tiktokenEncoder = null;
function getTiktokenEncoder() {
  if (!_tiktokenEncoder) {
    try {
      const { encoding_for_model } = require("tiktoken");
      _tiktokenEncoder = encoding_for_model("gpt-4o"); // cl100k_base
    } catch {}
  }
  return _tiktokenEncoder;
}

// --------------------------------------------------
// SENTENCE-SPLITTER — proper sentence boundary detection
// Handles abbreviations (Dr., Mr.), decimals (3.14), URLs.
// --------------------------------------------------
let _sentenceSplitter = null;
function getSentenceSplitter() {
  if (!_sentenceSplitter) {
    try {
      _sentenceSplitter = require("sentence-splitter").split;
    } catch {}
  }
  return _sentenceSplitter;
}

/**
 * Remove null bytes, normalize line endings, collapse excessive whitespace.
 */
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
 * Estimate token count using tiktoken BPE tokenizer.
 * Falls back to ~4 chars/token heuristic when tiktoken is unavailable.
 */
function estimateTokens(text) {
  const enc = getTiktokenEncoder();
  if (enc) {
    try {
      return enc.encode(text || "").length;
    } catch {}
  }
  // Fallback: conservative ~4 chars per token for English text
  return Math.ceil((text || "").length / ESTIMATE_TOKENS_PER_CHAR);
}

/**
 * Find the nearest sentence break after a position.
 * Uses sentence-splitter for accurate boundary detection
 * (handles abbreviations, decimals, URLs, ellipsis).
 * Falls back to regex-based detection when unavailable.
 */
function findSentenceBreak(text, start) {
  const windowStart = Math.max(0, start - 200);
  const windowEnd = Math.min(text.length, start + 500);
  const searchWindow = text.substring(windowStart, windowEnd);

  const split = getSentenceSplitter();
  if (split) {
    try {
      const nodes = split(searchWindow);
      // Collect sentence end positions relative to the original text
      const sentenceEnds = nodes
        .filter((n) => n.type === "Sentence")
        .map((n) => windowStart + n.range[1]);

      if (sentenceEnds.length > 0) {
        // Return the last sentence end within the window
        return sentenceEnds[sentenceEnds.length - 1];
      }
    } catch {}
  }

  // Fallback: find last [!?.:] + whitespace in window
  const matches = searchWindow.match(/[.!?]+[\s\n]+/g);
  if (matches && matches.length > 0) {
    const last = matches[matches.length - 1];
    return windowStart + searchWindow.lastIndexOf(last) + last.length;
  }
  return text.lastIndexOf(" ", start + 500);
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

module.exports = {
  sanitizeText,
  estimateTokens,
  findSentenceBreak,
  sanitizeSearchQuery,
  sanitizeAnswerContext,
  tokenizeForOverlap,
  keywordOverlapScore,
};
