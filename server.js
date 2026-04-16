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

// Uploads directory — where files from Framer forms are stored
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer setup — store files to disk with unique names
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Create a subdirectory per submission (set in parseMultipart before multer runs)
    const subDir = path.join(UPLOADS_DIR, req._submissionId || "unknown");
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true });
    }
    cb(null, subDir);
  },
  filename: (req, file, cb) => {
    // Keep original filename but prefix with timestamp to avoid collisions
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
});

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const DB_PATH = path.join(__dirname, "submissions.db");

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Enable CORS for all origins (Framer sites can POST from any domain)
app.use(cors());

// Parse JSON and URL-encoded bodies (Framer may send various formats)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.text({ limit: "1mb", type: "text/*" }));
app.use(express.raw({ limit: "1mb", type: "application/octet-stream" }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, "public")));

// Serve uploaded files at /uploads/<submissionId>/<filename>
app.use("/uploads", express.static(UPLOADS_DIR));

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

// Middleware: try parsing multipart/form-data, but don't fail on other types
// Uses upload.any() because Framer forms may include file fields
function parseMultipart(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    // Generate submission ID early so multer can use it for the folder name
    req._submissionId = uuidv4();
    upload.any()(req, res, (err) => {
      if (err) {
        console.error("[webhook] Multer error:", err.message);
      }
      next();
    });
  } else {
    next();
  }
}

// POST /webhook — Receive and store a form submission
// Handles JSON, URL-encoded, AND multipart/form-data (Framer uses this one)
app.post("/webhook", parseMultipart, authenticateWebhook, (req, res) => {
  try {
    // Log what we received for debugging
    console.log(`[webhook] Content-Type: ${req.headers["content-type"]}`);
    console.log(`[webhook] Body:`, req.body);
    console.log(`[webhook] Files:`, req.files ? req.files.length : 0);

    // Use the pre-generated ID (from multipart) or create a new one
    const id = req._submissionId || uuidv4();
    const received_at = new Date().toISOString();

    // Grab the client IP (works behind proxies like Railway)
    const source_ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    // All body fields are stored dynamically as JSON — no hardcoded field names
    const fields = req.body && typeof req.body === "object" ? req.body : {};

    // If files were uploaded, add them to the fields object
    if (req.files && req.files.length > 0) {
      const fileEntries = req.files.map((f) => ({
        fieldName: f.fieldname,
        originalName: f.originalname,
        mimeType: f.mimetype,
        size: f.size,
        url: `/uploads/${id}/${f.filename}`,
      }));

      // Add each file under its field name
      for (const file of fileEntries) {
        const key = file.fieldName || "file";
        // If there's already a file entry for this field, make it an array
        if (fields[`__file_${key}`]) {
          if (!Array.isArray(fields[`__file_${key}`])) {
            fields[`__file_${key}`] = [fields[`__file_${key}`]];
          }
          fields[`__file_${key}`].push(file);
        } else {
          fields[`__file_${key}`] = file;
        }
      }

      console.log(`[webhook] ${fileEntries.length} file(s) saved to uploads/${id}/`);
    }

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

    // Also delete uploaded files for this submission
    const uploadDir = path.join(UPLOADS_DIR, req.params.id);
    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
      console.log(`[api] Deleted upload folder: ${uploadDir}`);
    }

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
