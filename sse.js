// sse.js
import express from "express";
import pkg from "pg";
const { Pool } = pkg;

export const sseRouter = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const clients = new Set();

sseRouter.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();

  res.write(`event: ping\ndata: "connected"\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// Keep one dedicated connection for LISTEN
(async () => {
  const client = await pool.connect();
  await client.query("LISTEN suggestions_changes");
  client.on("notification", (msg) => {
    // Broadcast to every connected browser
    for (const res of clients) {
      res.write(`event: dbchange\ndata: ${msg.payload}\n\n`);
    }
  });
})();
