const fs = require("fs");

const path = require("path");
const { handleMissingQ } = require("./missingQ");

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function escapeAndFlexPattern(p) {
  return p
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s*");
}

function extractIntentPositions(text, intentsRaw) {
  const lowered = text.toLowerCase();
  const positions = [];

  for (const [intent, data] of Object.entries(intentsRaw)) {
    for (const pattern of data.patterns) {
      const regex = new RegExp(escapeAndFlexPattern(pattern), "gi");
      let match;
      while ((match = regex.exec(lowered)) !== null) {
        positions.push({
          index: match.index,
          length: match[0].length,
          intent,
          pattern,
        });
      }
    }
  }

  positions.sort((a, b) => a.index - b.index);
  const filtered = [];
  let lastEnd = -1;
  for (const p of positions) {
    if (p.index >= lastEnd) {
      filtered.push(p);
      lastEnd = p.index + p.length;
    }
  }
  return filtered;
}

function extractContextFromPart(text, keywordsRaw) {
  const lowered = text.toLowerCase();
  for (const [keyword, data] of Object.entries(keywordsRaw)) {
    const all = [
      keyword,
      ...(data.variants || []),
      ...Object.values(data.types || {}).flat(),
      ...Object.values(data.conditions || {}).flat(),
      ...Object.values(data.places || {}).flat(),
    ];

    if (all.some((v) => lowered.includes(v.toLowerCase()))) {
      const context = { keyword, type: null, condition: [], place: null };

      for (const [type, vals] of Object.entries(data.types || {})) {
        if (vals.some((v) => lowered.includes(v.toLowerCase()))) {
          context.type = type;
          break;
        }
      }
      for (const [cond, vals] of Object.entries(data.conditions || {})) {
        if (vals.some((v) => lowered.includes(v.toLowerCase()))) {
          context.condition.push(cond);
        }
      }
      for (const [place, vals] of Object.entries(data.places || {})) {
        if (vals.some((v) => lowered.includes(v.toLowerCase()))) {
          context.place = place;
          break;
        }
      }
      return context;
    }
  }
  return null;
}

function loadAnswersForKeyword(keyword, remote, basePath) {
  const entry = remote.find(
    (r) => r.keyword.toLowerCase() === keyword.toLowerCase()
  );
  if (!entry) return [];
  const filePath = path.join(basePath, entry.file);
  if (!fs.existsSync(filePath)) return [];
  return loadJSON(filePath);
}

function findBestAnswer(answers, intent, type, condition, place) {
  let best = null;
  let bestScore = -1;

  for (const entry of answers) {
    let score = 0;
    if (intent && entry.intent === intent) score++;
    if (type && entry.type === type) score++;
    if (condition && entry.condition) {
      const userConds = Array.isArray(condition) ? condition : [condition];
      const entryConds = Array.isArray(entry.condition)
        ? entry.condition
        : [entry.condition];
      const matchedConds = userConds.filter((c) => entryConds.includes(c));
      score += matchedConds.length;
    }
    if (place) {
      const placeMatch = Array.isArray(entry.place)
        ? entry.place.includes(place)
        : entry.place === place;
      if (placeMatch) score++;
    }
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return best
    ? {
        answer: Array.isArray(best.answers)
          ? best.answers[0]
          : best.answer || "",
        proof: best.proof || [],
      }
    : { answer: "لم يتم العثور على إجابة دقيقة.", proof: [] };
}

function handleMultyQ(question, founds, basePath = "./data") {
  const intentsRaw = loadJSON(path.join(basePath, "Q_structure/intent.json"));
  const keywordsRaw = loadJSON(
    path.join(basePath, "Q_structure/keywords.json")
  );
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));

  const lowered = question.toLowerCase();
  const intentPositions = extractIntentPositions(lowered, intentsRaw);

  if (intentPositions.length === 0) return null;

  const answersBundle = [];

  // توزيع intent حسب الموقع
  /* ── ❶ أضِف الدالة أعلى الملف (أو في أي مكان قبل استخدامها) ───────── */
  function adjustIntentForFirstKeyword(parts) {
    // إذا كان أول مقطع لا يملك intent → اجعله "تعريف"
    if (parts.length > 0 && !parts[0].intent) {
      parts[0].intent = "تعريف";
    }
    return parts;
  }

  /* ── ❷ بناء مصفوفة parts كما في كودك الحالي ────────────────────────── */
  const parts = [];

  /* — A) أجزاء تسبق كل نيّة صريحة أو تقع بينها — */
  let cursor = 0;
  intentPositions.forEach((pos, idx) => {
    /* جزء قبل النيّة الحالية */
    if (pos.index > cursor) {
      const chunk = question.slice(cursor, pos.index).trim();
      splitByWa(chunk).forEach((txt) =>
        parts.push({ text: txt, intent: null })
      );
    }

    /* الجزء الذي يبدأ بالنيّة ذاتها ويليها كلمات */
    const end = intentPositions[idx + 1]
      ? intentPositions[idx + 1].index
      : question.length;
    const withIntent = question.slice(pos.index, end).trim();
    splitByWa(withIntent).forEach((txt) =>
      parts.push({ text: txt, intent: pos.intent })
    );

    cursor = end;
  });

  /* — B) ذيل الجملة بعد آخر نيّة إن وجد — */
  if (cursor < question.length) {
    splitByWa(question.slice(cursor).trim()).forEach((txt) =>
      parts.push({ text: txt, intent: null })
    );
  }

  /* 2) ضبط النيّة لأول كلمة مفتاحية بلا نيّة = «تعريف» */
  if (parts.length && !parts[0].intent) {
    parts[0].intent = "تعريف";
  }

  /* 3) وراثة النيّة إلى الأمام */
  let lastIntent = null;
  for (const p of parts) {
    if (p.intent) lastIntent = p.intent;
    else if (lastIntent) p.intent = lastIntent; // وراثة
    else p.intent = "تعريف"; // احتياط
  }

  for (const part of parts) {
    const ctx = extractContextFromPart(part.text, keywordsRaw);

    if (!ctx) {
      // لم نجد كلمة مفتاحية → استخدم missingQ
      const missing = handleMissingQ(part.text, basePath);
      if (missing.intent && missing.keyword) {
        const ansArr = loadAnswersForKeyword(missing.keyword, remote, basePath);
        const best = findBestAnswer(
          ansArr,
          missing.intent,
          missing.type,
          missing.condition,
          missing.place
        );
        answersBundle.push({
          question: part.text,
          intent: missing.intent,
          keyword: missing.keyword,
          type: missing.type,
          condition: missing.condition,
          place: missing.place,
          answer: best.answer,
          proof: best.proof,
        });
      } else {
        return {
          ask: missing.ask,
          message: missing.message,
          context: missing.context,
        };
      }
    } else {
      /* كلمة مفتاحية موجودة */
      const { keyword, type, condition, place } = ctx;
      const ansArr = loadAnswersForKeyword(keyword, remote, basePath);
      const best = findBestAnswer(ansArr, part.intent, type, condition, place);

      answersBundle.push({
        question: `ما ${part.intent} ${keyword}${type ? ` (${type})` : ""} ؟`,
        intent: part.intent,
        keyword,
        type,
        condition,
        place,
        answer: best.answer,
        proof: best.proof,
      });
    }
  }

  /* 5) أعد النتائج */
  return {
    ask: "split",
    message: "تم تقسيم سؤالك إلى الأجزاء التالية مع إجاباتها:",
    answers: answersBundle,
  };

  /* ========= دالة مساعدة لفصل النص على «و» مع الحفاظ على الكلمات ========= */
  function splitByWa(chunk) {
    return chunk
      .split(/(?:^|\s)و\s+/) // فصل عند الواو المعطوفة
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

module.exports = {
  handleMultyQ,
};
