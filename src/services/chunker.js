const {
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
} = require("../config/constants");
const { sanitizeText, estimateTokens, findSentenceBreak } = require("../utils/text");
const { extractHeadings } = require("../utils/html");

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
 * Check if extracted text has too little signal to be useful.
 */
function isLowSignalText(text) {
  const cleaned = sanitizeText(text || "");
  if (!cleaned) return true;

  const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  const symbolRatio = ((cleaned.match(/[^A-Za-z0-9\s]/g) || []).length) / Math.max(1, cleaned.length);

  return letters < 30 || words < 8 || symbolRatio > 0.45;
}

/**
 * Convert plain text into section objects.
 */
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

module.exports = {
  chunkText,
  mergeSections,
  isLowSignalText,
  sectionsFromPlainText,
};
