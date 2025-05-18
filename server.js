const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { findAnswer } = require("./handler/handler"); // أو المسار حسب موقع الملف
// import keep alive cron
const keepAliveCron = require('./keepAliveCron')
// start the cron
keepAliveCron()
const app = express();
app.use(cors());
app.use(bodyParser.json());
// Question and Answer endpoint
app.post("/api/ask", (req, res) => {
  const { question, previousContext } = req.body;

  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Question is required." });
  }
console.log(previousContext);
  try {
    const response = findAnswer(question, previousContext || {});
    res.json(response);
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
// Health check endpoint 
app.get('/health-check', (req, res) => {
   res.status(200).send('OK'); 
  });
  // Starting app server
app.listen(5000, () => console.log("✅ Server running on http://localhost:5000"));
