const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { findAnswer } = require("./handler/handler"); // أو المسار حسب موقع الملف

const app = express();
app.use(cors());
app.use(bodyParser.json());

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

app.listen(5000, () => console.log("✅ Server running on http://localhost:5000"));
