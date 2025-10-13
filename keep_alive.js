import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("Bot is alive!");
});

export const keepAlive = () => {
  app.listen(3000, () => {
    console.log("✅ Keep-alive server running on port 3000");
  });
};
