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
  const parts = [];
  for (let i = 0; i < intentPositions.length; i++) {
    const start = intentPositions[i].index;
    const end = intentPositions[i + 1]
      ? intentPositions[i + 1].index
      : question.length;

    const textChunk = question.slice(start, end).trim();
    // تقسيم حسب "و"
    const subParts = textChunk
      .split(/(?:^|\s)و\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    // 🟡 إذا لم نجد "و" وقمنا باستخراج نية واحدة فقط، حاول التقطيع حسب المسافات
    if (subParts.length === 1 && intentPositions.length === 1) {
      const words = textChunk.split(/\s+/).filter(Boolean);
      const potentialParts = [];
      for (const word of words) {
        const context = extractContextFromPart(word, keywordsRaw);
        if (context?.keyword) {
          potentialParts.push({
            text: word,
            intent: intentPositions[i].intent,
          });
        }
      }
      if (potentialParts.length > 1) {
        parts.push(...potentialParts);
        continue; // تجاهل الجزء الأصلي
      }
    }

    for (const sub of subParts) {
      // استخراج السياق للتأكد من وجود كلمة مفتاحية
      const context = extractContextFromPart(sub, keywordsRaw);

      if (context?.keyword) {
        parts.push({
          text: sub,
          intent: intentPositions[i].intent,
        });
      }
    }
  }

  // تعميم النية عند الحاجة
  let lastIntent = null;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].intent) {
      lastIntent = parts[i].intent;
    } else if (lastIntent) {
      parts[i].intent = lastIntent;
    }
  }

  for (const part of parts) {
    const context = extractContextFromPart(part.text, keywordsRaw);
    const intent = part.intent;
    const keyword = context?.keyword;
    const type = context?.type || null;
    const condition = context?.condition || [];
    const place = context?.place || null;
    let hasAvailable = "";
    if (type) hasAvailable += `(${type})`;
    if (place) hasAvailable += (hasAvailable ? "،" : "") + ` (${place})`;
    if (condition && Array.isArray(condition) && condition.length > 0) {
      hasAvailable += (hasAvailable ? "،" : "") + `  (${condition.join(", ")})`;
    }
    if (intent && keyword) {
      const answers = loadAnswersForKeyword(keyword, remote, basePath);
      const best = findBestAnswer(answers, intent, type, condition, place);
      answersBundle.push({
        question: `ما ${intent} ${keyword} ${hasAvailable} ؟`,
        intent,
        keyword,
        type,
        condition,
        place,
        answer: best.answer,
        proof: best.proof,
      });
    } else {
      // سؤال ناقص → مرّره إلى missingQ
      const missing = handleMissingQ(part.text, basePath);

      if (missing.intent && missing.keyword) {
        const answers = loadAnswersForKeyword(
          missing.keyword,
          remote,
          basePath
        );
        const best = findBestAnswer(
          answers,
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
        // لم تكتمل الإجابة
        return {
          ask: missing.ask,
          message: missing.message,
          context: missing.context,
          available: missing.available,
          hold: answersBundle,
        };
      }
    }
  }

  return {
    ask: "split",
    message: "تم تقسيم سؤالك إلى الأجزاء التالية مع إجاباتها:",
    answers: answersBundle,
    context: founds,
  };
}

module.exports = {
  handleMultyQ,
};
