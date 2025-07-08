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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// -- LOGIN remains the same
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid password" });
  }
  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token });
});

// -- Save vedtatt status
app.post("/vedtatt", async (req, res) => {
  const { rowId, vedtatt } = req.body;
  try {
    await pool.query(
      `INSERT INTO vedtatt_status (row_id, vedtatt)
       VALUES ($1, $2)
       ON CONFLICT (row_id) DO UPDATE SET vedtatt = $2`,
      [rowId, vedtatt]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error saving vedtatt:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// -- Load all vedtatt states
app.get("/vedtatt", async (req, res) => {
  try {
    const result = await pool.query("SELECT row_id, vedtatt FROM vedtatt_status");
    const vedtattMap = {};
    result.rows.forEach(row => vedtattMap[row.row_id] = row.vedtatt);
    res.json(vedtattMap);
  } catch (err) {
    console.error("Error loading vedtatt states:", err);
    res.status(500).json({ error: "Database error" });
  }
});
