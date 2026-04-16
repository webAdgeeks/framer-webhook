// =============================================================================
// Framer Form Webhook Receiver — server.js
// A Node.js/Express server that receives Framer form submissions via webhook,
// stores them in SQLite, and serves a dashboard UI.
// =============================================================================

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const initSqlJs = require("sql.js");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");

// Multer setup — parses multipart/form-data (how Framer sends form submissions)
const upload = multer();

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const DB_PATH = path.join(__dirname, "submissions.db");

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Enable CORS for all origins (Framer sites can POST from any domain)
app.use(cors());

// Parse JSON and URL-encoded bodies (Framer sends both formats)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Database Setup (sql.js — pure JS SQLite, no native compilation needed)
// ---------------------------------------------------------------------------

let db; // Will be initialized before server starts

// Save the database to disk (called after every write operation)
function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

async function initDb() {
  const SQL = await initSqlJs();

  // Load existing database from disk if it exists
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create the submissions table if it doesn't exist
  db.run(`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      source_ip TEXT,
      fields TEXT NOT NULL
    )
  `);
  saveDb();
}

// ---------------------------------------------------------------------------
// Webhook Authentication Middleware
// ---------------------------------------------------------------------------

function authenticateWebhook(req, res, next) {
  // If no secret is configured, skip authentication (easy local testing)
  if (!WEBHOOK_SECRET) return next();

  const token = req.headers["x-webhook-token"];
  if (!token || token !== WEBHOOK_SECRET) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized — invalid or missing X-Webhook-Token header",
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /webhook — Receive and store a form submission
// upload.none() parses multipart/form-data (text fields only, no file uploads)
// This is needed because Framer sends forms as multipart/form-data
app.post("/webhook", upload.none(), authenticateWebhook, (req, res) => {
  try {
    const id = uuidv4();
    const received_at = new Date().toISOString();

    // Grab the client IP (works behind proxies like Railway)
    const source_ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    // All body fields are stored dynamically as JSON — no hardcoded field names
    const fields = req.body && typeof req.body === "object" ? req.body : {};

    db.run(
      `INSERT INTO submissions (id, received_at, source_ip, fields) VALUES (?, ?, ?, ?)`,
      [id, received_at, source_ip, JSON.stringify(fields)]
    );
    saveDb();

    console.log(`[webhook] Submission ${id} stored (${Object.keys(fields).length} fields)`);

    return res.status(200).json({ success: true, id });
  } catch (err) {
    console.error("[webhook] Error storing submission:", err.message);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// GET /api/submissions — Return all submissions, newest first
app.get("/api/submissions", (req, res) => {
  try {
    const stmt = db.prepare(`SELECT * FROM submissions ORDER BY received_at DESC`);
    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      row.fields = JSON.parse(row.fields);
      rows.push(row);
    }
    stmt.free();
    return res.json({ submissions: rows, total: rows.length });
  } catch (err) {
    console.error("[api] Error fetching submissions:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/submissions/:id — Return a single submission
app.get("/api/submissions/:id", (req, res) => {
  try {
    const stmt = db.prepare(`SELECT * FROM submissions WHERE id = ?`);
    stmt.bind([req.params.id]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      row.fields = JSON.parse(row.fields);
      stmt.free();
      return res.json(row);
    }
    stmt.free();
    return res.status(404).json({ error: "Submission not found" });
  } catch (err) {
    console.error("[api] Error fetching submission:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/submissions/:id — Delete a submission
app.delete("/api/submissions/:id", (req, res) => {
  try {
    // Check if submission exists first
    const check = db.prepare(`SELECT id FROM submissions WHERE id = ?`);
    check.bind([req.params.id]);
    const exists = check.step();
    check.free();

    if (!exists) {
      return res.status(404).json({ error: "Submission not found" });
    }

    db.run(`DELETE FROM submissions WHERE id = ?`, [req.params.id]);
    saveDb();

    console.log(`[api] Submission ${req.params.id} deleted`);
    return res.json({ success: true });
  } catch (err) {
    console.error("[api] Error deleting submission:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Catch-all: serve the dashboard for any non-API route
// ---------------------------------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  ✦ Form Inbox running at http://localhost:${PORT}`);
    console.log(`  ✦ Webhook endpoint:     http://localhost:${PORT}/webhook`);
    if (WEBHOOK_SECRET) {
      console.log(`  ✦ Webhook auth:         enabled (X-Webhook-Token required)`);
    } else {
      console.log(`  ✦ Webhook auth:         disabled (set WEBHOOK_SECRET to enable)`);
    }
    console.log();
  });
}).catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
