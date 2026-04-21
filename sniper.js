// ============================
// SNIPER V10 (FINAL STABLE)
// ============================

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// ============================
// SECURITY
// ============================

app.use((req, res, next) => {
  if (req.path === "/") return next();

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ============================
// STORAGE
// ============================

const DATA_DIR = process.env.DATA_DIR || "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const TRADES_FILE = path.join(DATA_DIR, "trades.json");
const SIGNALS_FILE = path.join(DATA_DIR, "signals.json");

const load = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f));
  } catch {
    return [];
  }
};

const save = (f, d) =>
  fs.writeFileSync(f, JSON.stringify(d, null, 2));

// Ensure files exist
if (!fs.existsSync(TRADES_FILE)) save(TRADES_FILE, []);
if (!fs.existsSync(SIGNALS_FILE)) save(SIGNALS_FILE, []);

// ============================
// TELEGRAM
// ============================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat
