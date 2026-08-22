const { EMBEDDING_URL } = require("../config/constants");

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

module.exports = {
  embed,
  embedBatch,
  embedDocument,
  embedQuery,
  embedDocumentSafe,
  embedRawSafe,
};
