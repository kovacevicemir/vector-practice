const { Router } = require("express");
const fs = require("fs");
const path = require("path");

const { DOCS_FOLDER, upload } = require("../config/constants");
const { extractTextFromFile } = require("../services/file-parser");
const { embedAndInsertChunks } = require("../services/db-service");
const { runWithConcurrency } = require("../utils/concurrency");

// --------------------------------------------------
// IMPORT PROGRESS TRACKER
// --------------------------------------------------

let importProgress = null;

function resetProgress(files) {
  importProgress = {
    files,
    currentFile: null,
    currentFileIndex: 0,
    totalFiles: files.length,
    fileProgress: null,  // { current, total, percent }
    done: false,
    error: null,
  };
}

const router = Router();

// --------------------------------------------------
// LIST DOCS FILES
// --------------------------------------------------

router.get("/docs-files", (req, res) => {
  try {
    const folder = DOCS_FOLDER();
    const files = fs.readdirSync(folder).filter(f => !f.startsWith("."));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------
// IMPORT PROGRESS (polled by frontend)
// --------------------------------------------------

router.get("/import-progress", (req, res) => {
  res.json(importProgress || { done: true, files: [], totalFiles: 0 });
});

// --------------------------------------------------
// IMPORT FOLDER
// --------------------------------------------------

router.post("/import-folder", async (req, res) => {
  try {
    const folder = (req.body && req.body.folder) || "./docs";

    // Tika sniffs content types itself, so no extension whitelist is needed
    const files = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => entry.name);

    resetProgress(files);

    const results = [];

    const fileTasks = files.map((file, fileIdx) => async () => {
      const filePath = path.join(folder, file);

      try {
        if (importProgress) {
          importProgress.currentFile = file;
          importProgress.currentFileIndex = fileIdx;
        }

        const baseName = file.replace(/\.[^.]+$/, ""); // remove extension
        const rawSections = await extractTextFromFile(filePath);

        // Wrap embedAndInsertChunks to track per-file progress
        const result = await embedAndInsertChunks(baseName, rawSections, {
          onProgress: (current, total) => {
            if (importProgress) {
              importProgress.fileProgress = {
                current,
                total,
                percent: total > 0 ? ((current / total) * 100).toFixed(1) : 0,
              };
            }
          },
        });

        if (importProgress) {
          importProgress.fileProgress = {
            current: result.totalChunks,
            total: result.totalChunks,
            percent: 100,
          };
        }

        if (result.totalChunks > 0) {
          console.log(`  ${file}: ${result.totalChunks} chunks (${result.inserted} inserted, ${result.skipped} skipped)`);
        }
        results.push({ inserted: result.inserted, skipped: result.skipped });
      } catch (err) {
        console.error(`Failed to import ${file}:`, err.message);
        results.push({ inserted: 0, skipped: 0, failed: true, file, error: err.message });
      }
    });

    // Process up to 3 files concurrently to avoid overwhelming the embedding server
    await runWithConcurrency(fileTasks, 3);

    let imported = 0;
    let skipped = 0;
    let failed = [];
    for (const r of results) {
      imported += r.inserted || 0;
      skipped += r.skipped || 0;
      if (r.failed) failed.push({ file: r.file, error: r.error });
    }

    if (importProgress) {
      importProgress.done = true;
      importProgress.fileProgress = null;
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

router.post("/upload-file", upload.single("file"), async (req, res) => {
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

module.exports = router;
