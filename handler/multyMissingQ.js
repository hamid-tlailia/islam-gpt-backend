/* =========================
   handleMissingAndMultyQ.js
   ========================= */
const path = require("path");

/* استيراد الوحدات الحالية */
const { handleMultyQ } = require("./multyQ");
const { handleMissingQ } = require("./missingQ");

/**
 * دمج منطق multi-question مع منطق Missing-Q.
 *
 * @param   {string}  question            السؤال الأصلي من المستخدم
 * @param   {string}  basePath            مسار مجلد البيانات (افتراضي "./data")
 * @returns {object}  هيكل نتيجة واحد إمّا:
 *                    - answers: [] عند اكتمال كل المقاطع
 *                    - ask: "multyMissing", message, pending, answers
 */
function handleMissingAndMultyQ(question, basePath = "./data") {
  /* 1) استدعاء multy-handler */
  const multiResult = handleMultyQ(question, basePath);

  /* إذا لم يرجع مصفوفة نفترض أنه كائن مفقود ⇒ أرسله كما هو */
  if (!Array.isArray(multiResult)) {
    return multiResult;
  }

  /* 2) فرز النتائج */
  const pending = []; // المقاطع التي ما تزال تحتاج keyword / intent / clarify
  const answered = []; // المقاطع التي حصلنا فيها على إجابة نهائية

  multiResult.forEach((part) => {
    if (part.ask) {
      pending.push(part);
    } else {
      answered.push(part);
    }
  });

  /* 3) إن وُجدت مقاطع ناقصة، أعد رسالة توضيح واحدة */
  if (pending.length > 0) {
    /* بناء رسالة تلخّص المطلوب لكل جزء */
    const msgLines = pending.map((p, idx) => {
      const need =
        p.ask === "keyword"
          ? "الكلمة المفتاحية"
          : p.ask === "intent"
          ? "النيّة"
          : "توضيح";
      const original = p.original || p.question || "هذا الجزء";
      return `(${idx + 1}) «${original.trim()}» يحتاج ${need}.`;
    });

    return {
      ask: "multyMissing",
      message:
        "أسئلتك تحتوي على أجزاء غير مكتملة:\n" +
        msgLines.join("\n") +
        "\nيرجى تزويدي بالمعلومات الناقصة لكل جزء حتى أستطيع الإجابة عليها جميعًا.",
      pending, // مصفوفة المقاطع الناقصة (يستفيد منها الـ frontend)
      answer: answered, // إجابات الأجزاء المكتملة بالفعل
    };
  }

  /* 4) كل شيء مكتمل ⇒ إرجاع جميع الإجابات */
  return { answers: answered };
}

module.exports = { handleMissingAndMultyQ };
