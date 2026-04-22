const express = require("express");
const axios = require("axios");

const app = express();

const PORT = process.env.PORT || 8080;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

async function sendTelegram(message) {

  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("Missing telegram vars");
    return;
  }

  try {

    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: message
      }
    );

    console.log("Telegram sent");

  } catch (err) {

    console.log(err.message);

  }

}

app.get("/", (req, res) => {
  res.send("SNIPER RUNNING");
});

app.listen(PORT, async () => {

  console.log(`Running on ${PORT}`);

  await sendTelegram("🚨 Crypto breakout test");

  await sendTelegram("📈 Stock breakout test");

  await sendTelegram("🔄 Portfolio swap test");

});
