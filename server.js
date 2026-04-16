// =============================================================================
// Framer Form Webhook Receiver — server.js
// A Node.js/Express server that receives Framer form submissions via webhook,
// stores them in SQLite, and serves a dashboard UI.
// Files are uploaded to Cloudflare R2 for persistent storage.
// =============================================================================

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const initSqlJs = require("sql.js");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");

// Multer setup — store files in memory (then upload to R2)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
});

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const DB_PATH = path.join(__dirname, "submissions.db");

// ---------------------------------------------------------------------------
// Cloudflare R2 Setup
// ---------------------------------------------------------------------------

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "framer-form-uploads";

// Only create S3 client if R2 credentials are configured
let s3 = null;
if (R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_ACCOUNT_ID) {
  s3 = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log("[r2] Cloudflare R2 configured for file uploads");
} else {
  console.log("[r2] R2 not configured — file uploads will be stored locally (not persistent on Render)");
}

// Upload a file buffer to R2, returns the public key/path
async function uploadToR2(submissionId, filename, buffer, mimeType) {
  const key = `${submissionId}/${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));
  return key;
}

// Delete all files for a submission from R2
async function deleteFromR2(submissionId) {
  try {
    // List all objects with this submission prefix
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      Prefix: `${submissionId}/`,
    }));

    if (listed.Contents && listed.Contents.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: R2_BUCKET_NAME,
        Delete: {
          Objects: listed.Contents.map(obj => ({ Key: obj.Key })),
        },
      }));
      console.log(`[r2] Deleted ${listed.Contents.length} file(s) for submission ${submissionId}`);
    }
  } catch (err) {
    console.error(`[r2] Error deleting files for ${submissionId}:`, err.message);
  }
}

// Local uploads fallback (when R2 is not configured)
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

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

// Serve local uploads (fallback when R2 is not configured)
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
function parseMultipart(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
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
app.post("/webhook", parseMultipart, authenticateWebhook, async (req, res) => {
  try {
    console.log(`[webhook] Content-Type: ${req.headers["content-type"]}`);
    console.log(`[webhook] Body:`, req.body);
    console.log(`[webhook] Files:`, req.files ? req.files.length : 0);

    const id = req._submissionId || uuidv4();
    const received_at = new Date().toISOString();

    const source_ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const fields = req.body && typeof req.body === "object" ? req.body : {};

    // Handle file uploads
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `${Date.now()}-${safeName}`;
        let fileUrl;

        if (s3) {
          // Upload to Cloudflare R2
          const key = await uploadToR2(id, filename, file.buffer, file.mimetype);
          fileUrl = `/api/files/${key}`;
        } else {
          // Fallback: save locally
          const subDir = path.join(UPLOADS_DIR, id);
          if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
          fs.writeFileSync(path.join(subDir, filename), file.buffer);
          fileUrl = `/uploads/${id}/${filename}`;
        }

        const fileEntry = {
          fieldName: file.fieldname,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: fileUrl,
        };

        const key = `__file_${file.fieldname || "file"}`;
        if (fields[key]) {
          if (!Array.isArray(fields[key])) fields[key] = [fields[key]];
          fields[key].push(fileEntry);
        } else {
          fields[key] = fileEntry;
        }
      }
      console.log(`[webhook] ${req.files.length} file(s) uploaded ${s3 ? "to R2" : "locally"}`);
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

// GET /api/files/:submissionId/:filename — Serve files from R2
app.get("/api/files/:submissionId/:filename", async (req, res) => {
  if (!s3) {
    return res.status(404).json({ error: "R2 not configured" });
  }
  try {
    const key = `${req.params.submissionId}/${req.params.filename}`;
    const response = await s3.send(new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    }));

    // Set content type and disposition for download
    res.set("Content-Type", response.ContentType || "application/octet-stream");
    res.set("Content-Disposition", `inline; filename="${req.params.filename}"`);

    // Stream the file to the response
    response.Body.pipe(res);
  } catch (err) {
    console.error("[api] Error fetching file from R2:", err.message);
    return res.status(404).json({ error: "File not found" });
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
app.delete("/api/submissions/:id", async (req, res) => {
  try {
    const check = db.prepare(`SELECT id FROM submissions WHERE id = ?`);
    check.bind([req.params.id]);
    const exists = check.step();
    check.free();

    if (!exists) {
      return res.status(404).json({ error: "Submission not found" });
    }

    db.run(`DELETE FROM submissions WHERE id = ?`, [req.params.id]);
    saveDb();

    // Delete uploaded files
    if (s3) {
      await deleteFromR2(req.params.id);
    } else {
      const uploadDir = path.join(UPLOADS_DIR, req.params.id);
      if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
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
    console.log(`  ✦ File storage:         ${s3 ? "Cloudflare R2" : "Local (not persistent)"}`);
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
