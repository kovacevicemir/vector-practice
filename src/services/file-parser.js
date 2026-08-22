const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const {
  TIKA_URL,
  TIKA_OCR_LANG,
  TIKA_OCR_TIMEOUT_SECONDS,
  PLAIN_TEXT_EXTS,
  IMAGE_EXTS,
  HEADING_SELECTOR,
} = require("../config/constants");
const { sanitizeText } = require("../utils/text");
const { flattenHtml, sectionFrom } = require("../utils/html");
const { sectionsFromPlainText, isLowSignalText } = require("./chunker");

// --------------------------------------------------
// APACHE TIKA HELPERS
// --------------------------------------------------

/** Send the raw file to Tika and get structured XHTML back. */
async function tikaToHtml(filePath) {
  const response = await fetch(`${TIKA_URL}/tika`, {
    method: "PUT",
    headers: {
      Accept: "text/html",
      "Content-Type": "application/octet-stream",
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

// --------------------------------------------------
// PLAIN TEXT READER (bypass Tika)
// --------------------------------------------------

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

// --------------------------------------------------
// MAIN EXTRACTION
// --------------------------------------------------

/**
 * Extract structured sections from a file.
 * Uses Tika for binary formats, direct read for plain text.
 * Falls back to OCR when text extraction yields low-signal results.
 */
async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);

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

  // OCR fallback: if extracted text is low-signal, try OCR
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

module.exports = {
  extractTextFromFile,
  tikaToHtml,
  tikaToText,
  readPlainTextFile,
};
