const { Router } = require("express");
const fs = require("fs");
const path = require("path");

const { ANSWER_URL, ANSWER_MAX_TOKENS } = require("../config/constants");
const { getClient } = require("../config/database");
const { sanitizeAnswerContext, keywordOverlapScore } = require("../utils/text");
const { rerank } = require("../services/reranker");
const { getAnswerContextSize, countAnswerTokens, renderPrompt } = require("../services/answerer");

const router = Router();

// --------------------------------------------------
// COMBINE & ANSWER
// --------------------------------------------------

router.post("/combine-and-answer", async (req, res) => {
  try {
    const {
      query,
      chunks,
      additionalContext,
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
        const db = getClient();
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
    const TEMPLATE_PATH = path.resolve(__dirname, "..", "..", "combineAndAnswer.md");
    let template;
    try {
      template = fs.readFileSync(TEMPLATE_PATH, "utf8");
    } catch (e) {
      return res.status(500).json({ error: `Template file not found at ${TEMPLATE_PATH}` });
    }

    // Reserve room for the generated answer plus chat-template overhead
    const contextSize = await getAnswerContextSize();
    const promptBudget = contextSize - ANSWER_MAX_TOKENS - 512;

    if (promptBudget <= 0) {
      return res.status(500).json({ error: `Model context (${contextSize}) is too small to answer` });
    }

    let mdContent = renderPrompt(query, included, template, additionalContext);
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
      mdContent = renderPrompt(query, included, template, additionalContext);
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
              const retryAnswer = retryRaw.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || retryRaw.trim();
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
      additionalContextUsed: !!(additionalContext && additionalContext.trim()),
      promptTokens,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
