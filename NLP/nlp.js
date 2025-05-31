const fs = require("fs");
const Typo = require("typo-js");
const didYouMean = require("didyoumean2").default;

// 🟢 تحميل بيانات Hunspell من مجلد NLP
const affData = "./NLP/ar.aff";
const affDataContent = fs.readFileSync(affData, "utf-8");

const dicData = "./NLP/ar.dic";
const dicDataContent = fs.readFileSync(dicData, "utf-8");

// 🟢 تحميل القاموس الشخصي من vocab_arabic.json داخل NLP
const vocab = JSON.parse(fs.readFileSync("./NLP/vocab_arabic.json", "utf-8"));

// 🟢 إنشاء كائن Typo-js
const dictionary = new Typo("ar", affData, dicData, { platform: "any" });

function correctTypos(input) {
  const tokens = input.split(/\s+/);
  const corrected = tokens.map((word) => {
    // 1️⃣ أولاً نجرّب باستخدام Typo-js
    if (dictionary.check(word)) {
      return word; // الكلمة صحيحة
    }
    const suggestions = dictionary.suggest(word);
    if (suggestions.length > 0) {
      return suggestions[0]; // اقتراح من typo-js
    }

    // 2️⃣ إذا فشل Typo-js، ننتقل إلى didyoumean2
    const match = didYouMean(word, vocab, {
      threshold: 0.4,
      returnFirstMatch: true,
    });
    return match || word; // إما التصحيح أو نفس الكلمة
  });

  return corrected.join(" ");
}

module.exports = { correctTypos };
