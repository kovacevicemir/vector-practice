const express = require("express");

const corsMiddleware = require("./src/middleware/cors");
const { connect, ensureTable } = require("./src/config/database");

const insertRouter = require("./src/routes/insert");
const searchRouter = require("./src/routes/search");
const docsRouter = require("./src/routes/docs");
const combineAnswerRouter = require("./src/routes/combine-answer");
const backupRouter = require("./src/routes/backup");

const app = express();
app.use(express.json());
app.use(corsMiddleware);

// Mount routes
app.use(insertRouter);       // POST /insert
app.use(searchRouter);        // GET /search, GET /search/chunks
app.use(docsRouter);          // GET /docs-files, POST /import-folder, POST /upload-file
app.use(combineAnswerRouter); // POST /combine-and-answer
app.use(backupRouter);        // GET /backup, POST /restore

// --------------------------------------------------
// START
// --------------------------------------------------

async function main() {
  await connect();
  await ensureTable();
  app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
  });
}

main().catch(console.error);
