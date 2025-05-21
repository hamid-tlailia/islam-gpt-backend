const fs = require("fs");
const didYouMean = require("didyoumean2").default;

// تحميل القاموس العربي الموسّع
const vocab = JSON.parse(fs.readFileSync("./NLP/vocab_arabic.json", "utf-8"));

function correctTypos(input) {
  const tokens = input.split(/\s+/);
  const corrected = tokens.map((word) => {
    const match = didYouMean(word, vocab, { threshold: 0.5 });
    return match || word;
  });
  return corrected.join(" ");
}

module.exports = { correctTypos };
