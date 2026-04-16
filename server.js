// =============================================================================
// Framer Form Webhook Receiver — server.js
// A Node.js/Express server that receives Framer form submissions via webhook,
// stores them in SQLite, emails each submission via Gmail, and serves a dashboard.
// =============================================================================

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const nodemailer = require("nodemailer");
const initSqlJs = require("sql.js");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");

// Multer setup — store files in memory (for email attachments)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
});

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const DB_PATH = path.join(__dirname, "submissions.db");

// ---------------------------------------------------------------------------
// Gmail Setup
// ---------------------------------------------------------------------------

const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || GMAIL_USER; // Where to send notifications (defaults to same account)

let mailTransport = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  mailTransport = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });
  console.log(`[mail] Gmail configured — notifications will be sent to ${NOTIFY_EMAIL}`);
} else {
  console.log("[mail] Gmail not configured — email notifications disabled");
}

// Send submission email with all fields and file attachments
async function sendSubmissionEmail(id, fields, files, received_at) {
  if (!mailTransport) return;

  try {
    // Build a readable subject from the first recognizable fields
    const name = fields.name || fields.Name || fields.fullName || fields.full_name || "";
    const email = fields.email || fields.Email || "";
    const subjectParts = [name, email].filter(Boolean).join(" — ");
    const subject = subjectParts
      ? `New Submission: ${subjectParts}`
      : `New Form Submission — ${new Date(received_at).toLocaleString()}`;

    // Build HTML email body with all fields
    const fieldRows = Object.entries(fields)
      .filter(([key]) => !key.startsWith("__file_")) // Skip file metadata in body
      .map(([key, val]) => {
        const value = typeof val === "object" ? JSON.stringify(val) : String(val);
        return `
          <tr>
            <td style="padding:10px 16px;font-weight:600;color:#555;background:#f8f8f6;border-bottom:1px solid #e4e4e0;text-transform:uppercase;font-size:12px;letter-spacing:0.5px;vertical-align:top;width:160px;">${key}</td>
            <td style="padding:10px 16px;color:#1a1a1a;border-bottom:1px solid #e4e4e0;font-size:14px;">${value}</td>
          </tr>`;
      })
      .join("");

    // List attached files in the email
    const fileList = (files || []).map(f =>
      `<li style="margin:4px 0;font-size:13px;">📎 ${f.originalname} (${formatFileSize(f.size)})</li>`
    ).join("");

    const html = `
      <div style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1a1a1a;color:#fff;padding:16px 24px;border-radius:10px 10px 0 0;">
          <h2 style="margin:0;font-size:16px;font-weight:600;">Form Inbox</h2>
          <p style="margin:4px 0 0;font-size:12px;opacity:0.7;">Submission ${id}</p>
        </div>
        <div style="padding:0;border:1px solid #e4e4e0;border-top:none;border-radius:0 0 10px 10px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:10px 16px;font-weight:600;color:#555;background:#f8f8f6;border-bottom:1px solid #e4e4e0;text-transform:uppercase;font-size:12px;letter-spacing:0.5px;width:160px;">Received</td>
              <td style="padding:10px 16px;color:#1a1a1a;border-bottom:1px solid #e4e4e0;font-size:14px;">${new Date(received_at).toLocaleString()}</td>
            </tr>
            ${fieldRows}
          </table>
          ${fileList ? `<div style="padding:12px 16px;border-top:1px solid #e4e4e0;"><p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#555;text-transform:uppercase;">Attachments</p><ul style="margin:0;padding-left:20px;">${fileList}</ul></div>` : ""}
        </div>
        <p style="text-align:center;font-size:11px;color:#999;margin-top:16px;">Sent by Form Inbox Webhook Receiver</p>
      </div>
    `;

    // Prepare file attachments
    const attachments = (files || []).map(f => ({
      filename: f.originalname,
      content: f.buffer,
      contentType: f.mimetype,
    }));

    await mailTransport.sendMail({
      from: `Form Inbox <${GMAIL_USER}>`,
      to: NOTIFY_EMAIL,
      subject,
      html,
      attachments,
    });

    console.log(`[mail] Notification sent for submission ${id}`);
  } catch (err) {
    console.error(`[mail] Failed to send email for ${id}:`, err.message);
    // Don't throw — email failure should never break the submission
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ---------------------------------------------------------------------------
// Local uploads fallback
// ---------------------------------------------------------------------------

const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.text({ limit: "1mb", type: "text/*" }));
app.use(express.raw({ limit: "1mb", type: "application/octet-stream" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));

// ---------------------------------------------------------------------------
// Database Setup
// ---------------------------------------------------------------------------

let db;

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
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
// Webhook Authentication
// ---------------------------------------------------------------------------

function authenticateWebhook(req, res, next) {
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

function parseMultipart(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    req._submissionId = uuidv4();
    upload.any()(req, res, (err) => {
      if (err) console.error("[webhook] Multer error:", err.message);
      next();
    });
  } else {
    next();
  }
}

// POST /webhook — Receive and store a form submission + send email
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

    // Keep a reference to raw files for email attachments
    const rawFiles = req.files || [];

    // Handle file uploads to local storage
    if (rawFiles.length > 0) {
      for (const file of rawFiles) {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `${Date.now()}-${safeName}`;
        let fileUrl = null;

        try {
          const subDir = path.join(UPLOADS_DIR, id);
          if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
          fs.writeFileSync(path.join(subDir, filename), file.buffer);
          fileUrl = `/uploads/${id}/${filename}`;
        } catch (uploadErr) {
          console.error(`[webhook] File save failed for ${file.originalname}:`, uploadErr.message);
        }

        const fileEntry = {
          fieldName: file.fieldname,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: fileUrl || "(upload failed)",
        };

        const key = `__file_${file.fieldname || "file"}`;
        if (fields[key]) {
          if (!Array.isArray(fields[key])) fields[key] = [fields[key]];
          fields[key].push(fileEntry);
        } else {
          fields[key] = fileEntry;
        }
      }
      console.log(`[webhook] ${rawFiles.length} file(s) saved locally`);
    }

    // Save to database
    db.run(
      `INSERT INTO submissions (id, received_at, source_ip, fields) VALUES (?, ?, ?, ?)`,
      [id, received_at, source_ip, JSON.stringify(fields)]
    );
    saveDb();

    console.log(`[webhook] Submission ${id} stored (${Object.keys(fields).length} fields)`);

    // Send email notification (non-blocking — don't wait for it)
    sendSubmissionEmail(id, fields, rawFiles, received_at);

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
    const uploadDir = path.join(UPLOADS_DIR, req.params.id);
    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }

    console.log(`[api] Submission ${req.params.id} deleted`);
    return res.json({ success: true });
  } catch (err) {
    console.error("[api] Error deleting submission:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Catch-all: serve the dashboard
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
    console.log(`  ✦ Email notifications:  ${mailTransport ? "enabled" : "disabled"}`);
    if (WEBHOOK_SECRET) {
      console.log(`  ✦ Webhook auth:         enabled`);
    } else {
      console.log(`  ✦ Webhook auth:         disabled`);
    }
    console.log();
  });
}).catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
