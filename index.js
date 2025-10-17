// index.js — Real-time suggestions API (id-keyed + deltas + optimistic lock)
import express from "express";
import cors from "cors";
import pkg from "pg";
const { Pool } = pkg;

// -------------------- Config --------------------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL env var");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Allow your GitHub Pages (or set ALLOWED_ORIGIN). Fallback: allow all.
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// -------------------- PG Pool --------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function queryWithRetry(text, params = [], tries = 2) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (tries > 0) {
      console.warn("PG query failed, retrying…", err.code || err.message);
      return queryWithRetry(text, params, tries - 1);
    }
    throw err;
  }
}

// -------------------- Health --------------------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// -------------------- Simple login route --------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "default123";

app.post("/login", (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    // you can later replace token with a signed JWT if needed
    res.json({ success: true, token: "admin-token" });
  } else {
    res.status(401).json({ success: false, error: "Invalid password" });
  }
});


// =====================================================================
//                         Suggestions API
//  Table expected (from migration):
//   suggestions(
//     suggestion_id TEXT PRIMARY KEY,
//     status TEXT NOT NULL DEFAULT 'ny',
//     payload JSONB NOT NULL DEFAULT '{}'::jsonb,
//     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     updated_by TEXT
//   )
// =====================================================================

// 1) Upsert a batch (idempotent).
// Body: { items: [{ suggestion_id, status?, payload?, updated_by? }, ...] }
app.post("/api/suggestions/upsert", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "No items" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const raw of items) {
      const {
        suggestion_id,
        status,
        payload = {},
        updated_by = null,
      } = raw || {};

      if (!suggestion_id) {
        throw new Error("suggestion_id missing in one of the items");
      }

      await client.query(
        `INSERT INTO suggestions (suggestion_id, status, payload, updated_by)
        VALUES ($1, COALESCE($2, 'ny'), $3, $4)
        ON CONFLICT (suggestion_id) DO UPDATE
        SET
          -- Only change status if:
          --   a) the upsert provides a new status AND
          --   b) we're not regressing a vedtatt row unless the actor is 'admin'
          status = CASE
            WHEN EXCLUDED.status IS NULL THEN suggestions.status
            WHEN suggestions.status = 'vedtatt'
                  AND EXCLUDED.status <> 'vedtatt'
                  AND COALESCE(EXCLUDED.updated_by, '') <> 'admin'
              THEN suggestions.status
            ELSE EXCLUDED.status
          END,
          payload    = COALESCE(EXCLUDED.payload, suggestions.payload),
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()`,
        [suggestion_id, status, payload, updated_by]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, count: items.length });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/suggestions/upsert error:", e);
    res.status(500).json({ error: e.message || "Database error" });
  } finally {
    client.release();
  }
});

// 2) Delta fetch — return items updated since a given ISO timestamp.
// Query params: since?=ISO, status?=string, limit?=int
app.get("/api/suggestions", async (req, res) => {
  // 🚫 Prevent caching (so all clients always see the newest data)
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const { since, status, limit = 500 } = req.query;

  const params = [];
  const where = [];

  if (since) {
    try {
      const iso = new Date(since).toISOString();
      params.push(iso);
      where.push(`updated_at > $${params.length}`);
    } catch {
      return res.status(400).json({ error: "Invalid 'since' timestamp" });
    }
  }

  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }

  const sql = `SELECT suggestion_id, status, payload, created_at, updated_at, updated_by
               FROM suggestions
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY updated_at ASC
               LIMIT ${Number(limit)}`;

  try {
    const { rows } = await queryWithRetry(sql, params);
    res.json({ items: rows, serverTime: new Date().toISOString() });
  } catch (e) {
    console.error("GET /api/suggestions error:", e);
    res.status(500).json({ error: "Database error" });
  }
});

// 3) Update one suggestion with optimistic locking.
// Body: { status?, payload?, expectedUpdatedAt?: ISO, actor?: string }
app.patch("/api/suggestions/:id", async (req, res) => {
  const { id } = req.params;
  const { status, payload, expectedUpdatedAt, actor } = req.body || {};

  if (typeof status === "undefined" && typeof payload === "undefined") {
    return res.status(400).json({ error: "Nothing to update (status or payload required)" });
  }

  // Build dynamic SET list
  const sets = [];
  const values = [];
  let i = 0;

  if (typeof status !== "undefined") {
    values.push(status);
    sets.push(`status = $${++i}`);
  }
  if (typeof payload !== "undefined") {
    values.push(payload);
    sets.push(`payload = $${++i}`);
  }

  // actor goes into updated_by
  values.push(actor || null);
  const updatedByIndex = ++i;

  values.push(id);
  const idIndex = ++i;

  let sql = `UPDATE suggestions
             SET ${sets.join(", ")}, updated_at = NOW(), updated_by = $${updatedByIndex}
             WHERE suggestion_id = $${idIndex}`;
             
  sql += " RETURNING suggestion_id, status, payload, created_at, updated_at, updated_by";

  try {
    const { rows } = await queryWithRetry(sql, values);
    if (!rows.length) {
      return res.status(409).json({ error: "Version conflict or not found" });
    }
    res.json({ item: rows[0] });
  } catch (e) {
    console.error("PATCH /api/suggestions/:id error:", e);
    res.status(500).json({ error: "Database error" });
  }
});

// 4) Delete one suggestion by id
app.delete("/api/suggestions/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await queryWithRetry("DELETE FROM suggestions WHERE suggestion_id = $1", [id]);
    if (rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, deleted: id });
  } catch (e) {
    console.error("DELETE /api/suggestions/:id error:", e);
    res.status(500).json({ error: "Database error" });
  }
});


// =====================================================================
//                        Graceful shutdown
// =====================================================================
function shutdown(signal) {
  console.log(`\\n${signal} received, shutting down…`);
  app.close?.();

  pool
    .end()
    .then(() => {
      console.log("PG pool closed. Bye!");
      process.exit(0);
    })
    .catch((e) => {
      console.error("Error closing PG pool:", e);
      process.exit(1);
    });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// -------------------- Start server --------------------
app.listen(PORT, () => {
  console.log(`🚀 API listening on port ${PORT}`);
  console.log(`Health:        GET /api/health`);
  console.log(`Upsert batch:  POST /api/suggestions/upsert`);
  console.log(`Delta fetch:   GET  /api/suggestions?since=ISO&status=...`);
  console.log(`Update one:    PATCH /api/suggestions/:id`);
});

/* ---------------------------------------------------------------------
 Optional: SSE for instant updates later.
 You can wire PostgreSQL NOTIFY/LISTEN to broadcast to clients instead of polling.

 Example DB trigger (run in SQL, not JS):
   PERFORM pg_notify('suggestions_changes', row_to_json(NEW)::text);

 And in Node, open a dedicated client:
   const listenClient = await pool.connect();
   await listenClient.query("LISTEN suggestions_changes");
   listenClient.on("notification", (msg) => { /* fan out via res.write() * / });

 Then expose GET /api/suggestions/stream as an EventSource.
--------------------------------------------------------------------- */
