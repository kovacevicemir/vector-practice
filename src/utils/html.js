const { sanitizeText } = require("./text");
const { HEADING_SELECTOR } = require("../config/constants");

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

/**
 * Build a section object from a cheerio element.
 */
function sectionFrom($, el, pageNumber) {
  const $el = $(el);
  const heading = $el.find(HEADING_SELECTOR).first().text().trim();
  return {
    text: sanitizeText($el.text()),
    pageNumber,
    sectionTitle: heading || null,
  };
}

module.exports = {
  flattenHtml,
  extractHeadings,
  sectionFrom,
};
