// index.js
import express from "express";
import jwt from "jsonwebtoken";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ---------------- PG pool (prefer internal URL) ----------------
const connStr = process.env.INTERNAL_DATABASE_URL || process.env.DATABASE_URL || "";
const useSSL = (() => {
  // Internal URLs on Render should NOT use SSL; external URLs should.
  // Heuristic: if it looks internal, no SSL; otherwise SSL.
  return !/internal|localhost|127\.0\.0\.1/i.test(connStr);
})();

const pool = new Pool({
  connectionString: connStr,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
});

// Log pool errors so they don’t crash the process
pool.on("error", (err) => {
  console.error("PG pool error:", err);
});

// Small helper: retry a query once after a short backoff (handles cold starts/cut sockets)
async function queryWithRetry(sql, params = [], attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
    }
  }
  throw lastErr;
}

// ---------------- Auth middleware ----------------
function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Missing token" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload?.admin) throw new Error("not admin");
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

// ---------------- Login ----------------
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid password" });
  }
  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token });
});

// ---------------- TEMP: one-time DROP + CREATE table ----------------
// Call once, then remove this block and redeploy.
app.post("/admin/recreate-vedtatt", async (req, res) => {
  const pass = req.headers["x-admin-password"];
  if (pass !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    console.log("🧨 Dropping vedtatt_status...");
    await queryWithRetry(`DROP TABLE IF EXISTS vedtatt_status;`);

    console.log("🧱 Creating vedtatt_status fresh...");
    await queryWithRetry(`
      CREATE TABLE vedtatt_status (
        suggestion_id TEXT PRIMARY KEY,
        vedtatt BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log("✅ vedtatt_status recreated.");
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ recreate-vedtatt error:", e);
    res.status(500).json({ error: "Database error", detail: String(e?.message || e) });
  }
});

// ---------------- Save vedtatt ----------------
app.post("/vedtatt", /* auth, */ async (req, res) => {
  const { suggestionId, vedtatt, rowId } = req.body;
  const key = suggestionId ?? rowId; // back-compat
  if (!key || typeof vedtatt !== "boolean") {
    return res.status(400).json({ error: "Missing suggestionId/vedtatt" });
  }
  try {
    await queryWithRetry(
      `INSERT INTO vedtatt_status (suggestion_id, vedtatt)
       VALUES ($1, $2)
       ON CONFLICT (suggestion_id) DO UPDATE
       SET vedtatt = EXCLUDED.vedtatt, updated_at = NOW()`,
      [key, vedtatt]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error saving vedtatt:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------- Load states ----------------
app.get("/vedtatt", async (_req, res) => {
  try {
    const result = await queryWithRetry(
      "SELECT suggestion_id, vedtatt FROM vedtatt_status"
    );
    const map = Object.fromEntries(result.rows.map((r) => [r.suggestion_id, r.vedtatt]));
    res.json(map);
  } catch (err) {
    console.error("Error loading vedtatt states:", err);
    // graceful fallback so UI doesn’t error
    res.status(200).json({});
  }
});

// ---------------- Optional: ensure table on boot (non-destructive) ----------------
async function ensureTableOnBoot() {
  try {
    await queryWithRetry(`
      CREATE TABLE IF NOT EXISTS vedtatt_status (
        suggestion_id TEXT PRIMARY KEY,
        vedtatt BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("✅ vedtatt_status ensured on boot");
  } catch (e) {
    console.error("❌ ensureTableOnBoot error:", e);
  }
}
ensureTableOnBoot();

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
