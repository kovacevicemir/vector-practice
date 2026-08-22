const { Client } = require("pg");
const { DB_CONFIG } = require("./constants");

/**
 * Singleton PostgreSQL client wrapper.
 * Provides connect, disconnect, reconnect, and table initialization.
 */

let db = null;

function createClient(customConfig) {
  const config = customConfig || DB_CONFIG;
  const client = new Client(config);
  client.on("error", (err) => console.error("DB connection error:", err.message));
  return client;
}

async function connect(customConfig) {
  if (db) {
    try { await db.end(); } catch (_) {}
  }
  db = createClient(customConfig);
  await db.connect();
  return db;
}

async function disconnect() {
  if (db) {
    try { await db.end(); } catch (_) {}
    db = null;
  }
}

async function reconnect(customConfig) {
  await disconnect();
  return connect(customConfig);
}

function getClient() {
  if (!db) {
    throw new Error("Database not connected. Call connect() first.");
  }
  return db;
}

/**
 * Create or migrate the documents table.
 */
async function ensureTable() {
  const client = getClient();
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS documents (
      id BIGSERIAL PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL,
      metadata JSONB,
      embedding VECTOR(768)
    );

    ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata JSONB;
  `);
}

module.exports = {
  connect,
  disconnect,
  reconnect,
  getClient,
  ensureTable,
  // Direct access for cases that need the raw client (backup/restore)
  get rawClient() { return db; },
  set rawClient(c) { db = c; },
};
