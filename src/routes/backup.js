const { Router } = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Client } = require("pg");

const { DB_CONFIG, upload } = require("../config/constants");
const { disconnect, connect } = require("../config/database");

const router = Router();

// --------------------------------------------------
// DATABASE BACKUP (pg_dump → download)
// --------------------------------------------------

router.get("/backup", async (req, res) => {
  try {
    const filename = "database_backup.sql";

    res.setHeader("Content-Type", "application/sql");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    const child = spawn("podman", [
      "exec",
      "-i",
      "postgres",
      "pg_dump",
      "-U",
      DB_CONFIG.user,
      "-d",
      DB_CONFIG.database,
    ]);

    child.stdout.pipe(res);

    let stderr = "";

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      console.error("Backup failed:", err.message);

      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.destroy(err);
      }
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error("pg_dump failed:", stderr);

        if (!res.headersSent) {
          res.status(500).json({
            error: stderr || `pg_dump exited with code ${code}`,
          });
        } else {
          res.destroy(
            new Error(stderr || `pg_dump exited with code ${code}`)
          );
        }
      }
    });

  } catch (error) {
    console.error("Backup failed:", error.message);

    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.destroy(error);
    }
  }
});

// --------------------------------------------------
// HELPER: execute SQL inside PostgreSQL container
// --------------------------------------------------

function runPsql(database, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("podman", [
      "exec",
      "-i",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ]);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            stderr || `psql exited with code ${code}`
          )
        );
      }
    });
  });
}

// --------------------------------------------------
// DATABASE RESTORE (import database_backup)
// --------------------------------------------------

router.post("/restore", upload.single("backup"), async (req, res) => {
  let backupFile = null;
  let restoreClient = null;

  try {
    // --------------------------------------------------
    // 1. Get backup file
    // --------------------------------------------------

    if (req.file) {
      backupFile = req.file.path;
    } else {
      backupFile = path.join(__dirname, "..", "..", "database_backup.sql");

      if (!fs.existsSync(backupFile)) {
        return res.status(400).json({
          error: "No backup file found",
        });
      }
    }

    // --------------------------------------------------
    // 2. Completely close current application DB connection
    // --------------------------------------------------

    try {
      await disconnect();
    } catch (err) {
      console.warn("DB disconnect warning:", err.message);
    }

    // --------------------------------------------------
    // 3. Create fresh restore database
    // --------------------------------------------------

    console.log("Creating fresh restore database...");

    await runPsql(
      "postgres",
      "DROP DATABASE IF EXISTS vectordb_restore WITH (FORCE)"
    );

    await runPsql(
      "postgres",
      "CREATE DATABASE vectordb_restore"
    );

    // --------------------------------------------------
    // 4. Restore SQL dump
    // --------------------------------------------------

    console.log("Restoring backup...");

    await new Promise((resolve, reject) => {
      const child = spawn("podman", [
        "exec",
        "-i",
        "postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "vectordb_restore",
        "-v",
        "ON_ERROR_STOP=1",
      ], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      let finished = false;

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        if (!finished) {
          finished = true;
          reject(err);
        }
      });

      const fileStream = fs.createReadStream(backupFile);

      fileStream.on("error", (err) => {
        if (!finished) {
          finished = true;
          reject(err);
        }
      });

      // IMPORTANT:
      // Ignore EPIPE because psql may close stdin after an error.
      child.stdin.on("error", (err) => {
        if (err.code !== "EPIPE" && !finished) {
          finished = true;
          reject(err);
        }
      });

      fileStream.pipe(child.stdin);

      child.on("close", (code) => {
        if (finished) return;

        finished = true;

        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `PostgreSQL restore failed:\n${stderr}`
            )
          );
        }
      });
    });

    console.log("Backup restored successfully.");

    // --------------------------------------------------
    // 5. Verify restored database
    // --------------------------------------------------

    restoreClient = new Client({
      host: DB_CONFIG.host,
      port: DB_CONFIG.port,
      database: "vectordb_restore",
      user: DB_CONFIG.user,
      password: DB_CONFIG.password,
    });

    restoreClient.on("error", (err) => {
      console.error("Restore verification connection error:", err.message);
    });

    await restoreClient.connect();

    const result = await restoreClient.query(
      "SELECT COUNT(*)::bigint AS count FROM documents"
    );

    const documentCount = Number(result.rows[0].count);

    await restoreClient.end();
    restoreClient = null;

    console.log(`Restore verification successful: ${documentCount} documents`);

    // --------------------------------------------------
    // 6. Drop existing vectordb
    // --------------------------------------------------

    console.log("Removing old vectordb...");

    await runPsql(
      "postgres",
      "DROP DATABASE IF EXISTS vectordb WITH (FORCE)"
    );

    // --------------------------------------------------
    // 7. Rename restored DB
    // --------------------------------------------------

    console.log("Renaming restored database...");

    await runPsql(
      "postgres",
      "ALTER DATABASE vectordb_restore RENAME TO vectordb"
    );

    // --------------------------------------------------
    // 8. Create a BRAND NEW pg Client.
    // --------------------------------------------------

    console.log("Creating new application database connection...");

    await connect();

    console.log("New database connection established.");

    // --------------------------------------------------
    // 9. Clean uploaded backup
    // --------------------------------------------------

    if (req.file) {
      try {
        fs.unlinkSync(backupFile);
      } catch (_) {}
    }

    // --------------------------------------------------
    // 10. Success
    // --------------------------------------------------

    console.log(`Database restore complete: ${documentCount} documents`);

    return res.json({
      message: "Database restored successfully",
      documents: documentCount,
    });

  } catch (error) {
    console.error("Restore failed:", error.message);

    if (restoreClient) {
      try {
        await restoreClient.end();
      } catch (_) {}
    }

    if (req.file && backupFile) {
      try {
        fs.unlinkSync(backupFile);
      } catch (_) {}
    }

    // Try to reconnect application DB if restore failed
    try {
      await connect();
      console.log("Application DB reconnected.");
    } catch (reconnectError) {
      console.error("Could not reconnect application DB:", reconnectError.message);
    }

    return res.status(500).json({
      error: error.message,
    });
  }
});

module.exports = router;
