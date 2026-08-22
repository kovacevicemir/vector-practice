const { Router } = require("express");
const fs = require("fs");
const path = require("path");

const { DOCS_FOLDER, upload } = require("../config/constants");
const { extractTextFromFile } = require("../services/file-parser");
const { embedAndInsertChunks } = require("../services/db-service");

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
