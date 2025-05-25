/**
 * يولِّد NLP/vocab_arabic.json اعتمادًا على كل النصوص الموجودة في:
 *   – keywords.json  (keywords / variants / types / conditions / places)
 *   – intents.json   (intents + مرادفاتها إن وُجدت)
 *
 * شغِّله بعد كل تعديل:  node build_vocab.js
 */

const fs = require("fs");
const path = require("path");

/* ──────── مسارات الملفات ──────── */
// ⚙️ مسار ملف الكلمات المفتاحية
const KEYWORDS_FILE = "./data/Q_structure/keywords.json";
// Intents file path
const INTENTS_FILE = "./data/Q_structure/intents.json";
// ⚙️ مسار ملف الـ vocab المطلوب تجديده
const VOCAB_FILE = "./NLP/vocab_arabic.json";

/* ──────── دوال مساعدة ──────── */
/** إزالة التشكيل والعلامات غير الحرفية */
const normalize = (str) =>
  str
    .replace(/[\u0610-\u061A\u064B-\u065F\u06D6-\u06ED]/g, "") // التشكيل
    .replace(/[^\u0621-\u063A\u0641-\u064A\s]/g, "") // غير حروف عربية
    .trim();

/** شطر نص (أو مصفوفة نصوص) إلى كلمات منفردة */
const tokenize = (val) => {
  if (!val) return [];
  const txt = Array.isArray(val) ? val.join(" ") : String(val);
  return txt.split(/\s+/).map(normalize).filter(Boolean);
};

/* ──────── تجميع التوكنز من keywords.json ──────── */
const addFromKeywords = (file, tokens) => {
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));

  for (const kw in data) {
    const obj = data[kw];

    tokens.add(normalize(kw));
    tokenize(obj.variants).forEach((t) => tokens.add(t));

    if (obj.types) {
      const list = Array.isArray(obj.types)
        ? obj.types
        : Object.values(obj.types).flat();
      tokenize(list).forEach((t) => tokens.add(t));
    }

    if (obj.conditions) {
      const list = Array.isArray(obj.conditions)
        ? obj.conditions
        : Object.values(obj.conditions).flat();
      tokenize(list).forEach((t) => tokens.add(t));
    }

    if (obj.places) {
      const list = Array.isArray(obj.places)
        ? obj.places.map((p) => Object.values(p)).flat()
        : Object.keys(obj.places);
      tokenize(list).forEach((t) => tokens.add(t));
    }
  }
};

/* ──────── تجميع التوكنز من intents.json ────────
   هيكل افتراضي شائع:
   {
      "حكم": { "variants": ["حكم", "أحكام"] },
      "كيفية": { "variants": ["كيفية", "كيف"] }
   }
   عدّل الدالة إذا كان التنسيق مختلفًا.
*/
const addFromIntents = (file, tokens) => {
  if (!fs.existsSync(file)) return;

  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  for (const intent in data) {
    const obj = data[intent];

    tokens.add(normalize(intent));
    if (obj.variants) tokenize(obj.variants).forEach((t) => tokens.add(t));
  }
};

/* ──────── البناء والحفظ ──────── */
const tokens = new Set();

addFromKeywords(KEYWORDS_FILE, tokens);
addFromIntents(INTENTS_FILE, tokens);

const vocabArr = Array.from(tokens).filter(Boolean).sort();
fs.writeFileSync(VOCAB_FILE, JSON.stringify(vocabArr, null, 2), "utf-8");

console.log(
  `✅ vocab_arabic.json تم تحديثه – إجمالي الكلمات: ${vocabArr.length}`
);
