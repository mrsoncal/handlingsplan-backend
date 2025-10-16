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

// ---- Robust PG pool
const isProd = process.env.NODE_ENV === "production";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
});

function auth(req, res, next) {
  // Optional: require admin for writes
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

app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid password" });
  }
  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token });
});

// ---- Save vedtatt (now uses suggestion_id). Back-compat: accept rowId too.
app.post("/vedtatt", /* auth, */ async (req, res) => {
  const { suggestionId, vedtatt, rowId } = req.body;
  const key = suggestionId ?? rowId; // support old clients briefly
  if (!key || typeof vedtatt !== "boolean") {
    return res.status(400).json({ error: "Missing suggestionId/vedtatt" });
  }
  try {
    await pool.query(
      `INSERT INTO vedtatt_status (suggestion_id, vedtatt)
       VALUES ($1, $2)
       ON CONFLICT (suggestion_id) DO UPDATE SET vedtatt = EXCLUDED.vedtatt, updated_at = NOW()`,
      [key, vedtatt]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error saving vedtatt:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ---- Load states; never 500 the client on transient DB errors
app.get("/vedtatt", async (req, res) => {
  try {
    const result = await pool.query("SELECT suggestion_id, vedtatt FROM vedtatt_status");
    const map = Object.fromEntries(result.rows.map(r => [r.suggestion_id, r.vedtatt]));
    res.json(map);
  } catch (err) {
    console.error("Error loading vedtatt states:", err);
    // graceful fallback so the UI still loads
    res.status(200).json({});
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

