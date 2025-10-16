// index.js
import express from "express";
import cors from "cors";
import pkg from "pg";
import { sseRouter } from "./sse.js";
const { Pool } = pkg;

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL env var");
  process.exit(1);
}

const app = express();
app.use(express.json());

// Allow your GitHub Pages (or set ALLOWED_ORIGIN env). Fallback: allow all for now.
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ---------- PG Pool ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render PG usually needs SSL
});

// Small helper with retry to avoid transient disconnects
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

// ---------- Health check ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// =====================================================================
//                          SSE + LISTEN bridge
// =====================================================================
import { Router } from "express";

const sseRouter = Router();
const sseClients = new Set();

/**
 * Browsers connect here and stay connected.
 * We broadcast DB NOTIFY payloads to all connected clients.
 */
sseRouter.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // avoid proxy buffering
  });
  res.flushHeaders();

  // initial ping (optional)
  res.write(`event: ping\ndata: "connected"\n\n`);

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.use("/sse", sseRouter);

// Dedicated LISTEN client (do not return it to the pool)
(async () => {
  try {
    const listenClient = await pool.connect();
    await listenClient.query("LISTEN suggestions_changes");

    listenClient.on("notification", (msg) => {
      // Fan out the raw payload to all connected SSE clients
      for (const res of sseClients) {
        res.write(`event: dbchange\ndata: ${msg.payload}\n\n`);
      }
    });

    listenClient.on("error", (err) => {
      console.error("LISTEN client error:", err);
    });

    console.log("✅ LISTEN on channel: suggestions_changes");
  } catch (err) {
    console.error("❌ Failed to start LISTEN:", err);
  }
})();

// =====================================================================
//                    Minimal vedtatt endpoints (adjust as needed)
// =====================================================================

/**
 * Return all vedtatt rows (adjust ordering/columns to your needs)
 */
app.get("/vedtatt", async (_req, res) => {
  try {
    const r = await queryWithRetry(
      `SELECT suggestion_id, vedtatt, updated_at
       FROM public.vedtatt_status
       ORDER BY updated_at DESC NULLS LAST`
    );
    res.json(r.rows);
  } catch (err) {
    console.error("GET /vedtatt error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * Fetch a single row by suggestion_id (text) — used by the client after SSE ping
 */
app.get("/vedtatt/:suggestionId", async (req, res) => {
  const id = req.params.suggestionId;
  try {
    const r = await queryWithRetry(
      `SELECT suggestion_id, vedtatt, updated_at
       FROM public.vedtatt_status
       WHERE suggestion_id = $1`,
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error("GET /vedtatt/:suggestionId error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * Upsert / toggle vedtatt (example). If your app posts differently, adjust this handler.
 * Body: { suggestion_id: string, vedtatt: boolean }
 */
app.post("/vedtatt", async (req, res) => {
  const { suggestion_id, vedtatt } = req.body || {};
  if (!suggestion_id || typeof vedtatt !== "boolean") {
    return res.status(400).json({ error: "Missing suggestion_id or vedtatt" });
  }
  try {
    const r = await queryWithRetry(
      `INSERT INTO public.vedtatt_status (suggestion_id, vedtatt, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (suggestion_id)
       DO UPDATE SET vedtatt = EXCLUDED.vedtatt, updated_at = NOW()
       RETURNING suggestion_id, vedtatt, updated_at`,
      [suggestion_id, vedtatt]
    );
    res.json(r.rows[0]);
    // The DB trigger will emit NOTIFY automatically after this INSERT/UPDATE
  } catch (err) {
    console.error("POST /vedtatt error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// =====================================================================
//                     (Optional) Login route placeholder
// =====================================================================
// If you already have /login in your previous file, keep it.
// Here’s a tiny placeholder to avoid breaking callers:
app.post("/login", async (_req, res) => {
  // Implement your real login here or keep your old code.
  res.json({ ok: true });
});

// =====================================================================
//                       Graceful shutdown
// =====================================================================
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down…`);
  app.close?.();
  // Close SSE clients
  for (const res of sseClients) {
    try { res.end(); } catch {}
  }
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

app.use("/sse", sseRouter);

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`SSE endpoint: /sse/events`);
});
