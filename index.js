import express from "express";
import jwt from "jsonwebtoken";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get("/debug", (req, res) => {
  res.send(`ADMIN_PASSWORD is: ${process.env.ADMIN_PASSWORD}`);
});

app.post("/login", (req, res) => {
  const { password } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid password" });
  }

  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
