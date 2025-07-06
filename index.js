import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pkg;
const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // e.g. from Render
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

// Create table if it doesn't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
)
`).then(() => console.log("✅ Users table ready")).catch(console.error);

// Register
app.post("/register", async (req, res) => {
  const { email, password } = req.body;
  const password_hash = bcrypt.hashSync(password, 10);

  try {
    await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2)",
      [email, password_hash]
    );
    res.status(201).json({ message: "User registered" });
  } catch (err) {
    res.status(400).json({ error: "Email already in use" });
  }
});

// Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "2h" });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/", (req, res) => res.send("API is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
