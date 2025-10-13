const express = require("express");

const app = express();
app.get("/", (req, res) => res.send("Bot is alive!"));

const keepAlive = () => {
  app.listen(process.env.PORT || 3000, () => {
    console.log("✅ Keep-alive server running");
  });
};

module.exports = keepAlive;
