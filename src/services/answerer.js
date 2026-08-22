const { ANSWER_URL, ANSWER_MAX_TOKENS } = require("../config/constants");

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
 * Render the prompt by combining query, chunks, and template.
 */
function renderPrompt(query, includedRows, template) {
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
}

module.exports = {
  getAnswerContextSize,
  countAnswerTokens,
  renderPrompt,
};
