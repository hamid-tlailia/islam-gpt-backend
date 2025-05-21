const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { findAnswer } = require("./handler/handler"); // أو المسار حسب موقع الملف
// import nlp handler
const { correctTypos } = require("./NLP/nlp");
// import keep alive cron
const keepAliveCron = require("./keepAliveCron");
// start the cron
keepAliveCron();
const app = express();
app.use(cors());
app.use(bodyParser.json());
// Question and Answer endpoint
app.post("/api/ask", (req, res) => {
  const { question, previousContext } = req.body;

  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Question is required." });
  }
  const correctedQ = correctTypos(question); // ✅ تصحيح السؤال
  console.log("Corrected Question:", correctedQ);
  try {
    const response = findAnswer(correctedQ, previousContext || {});
    res.json(response);
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
// Health check endpoint
app.get("/health-check", (req, res) => {
  res.status(200).send("OK");
});
// Starting app server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);

