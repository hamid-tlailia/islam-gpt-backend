const fs = require("fs");
const path = require("path");

let partialContext = {};

/* =========== أدوات مساعدة =========== */
function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function advancedSplit(text) {
  const connectors = [
    "،",
    "؛",
    "\\.",
    "؟",
    "!",
    "\\bثم\\b",
    "\\bأو\\b",
    "\\bلكن\\b",
    "\\bبعد\\b",
    "\\bقبل\\b",
    "\\bو\\b",
  ];
  const regex = new RegExp(`\\s*(?:${connectors.join("|")})\\s*`, "gi");
  return text
    .split(regex)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
}

function normalizeWithType(keyword, type) {
  const clean = keyword.replace(/^ال/, "").trim();
  return type ? `${type} ${clean}` : `ال${clean}`;
}

function extractFromContext(text, keywordsRaw) {
  const lowered = text.toLowerCase();
  const contextMatches = [];

  for (const [keyword, data] of Object.entries(keywordsRaw)) {
    const found = {
      keyword,
      matchedBy: null,
      type: null,
      condition: null,
      place: null,
    };

    /* ===== variant match ===== */
    if (data.variants?.some((v) => lowered.includes(v.toLowerCase()))) {
      found.matchedBy = "variant";
    }

    /* ===== type match ===== */
    if (data.types) {
      for (const [type, vals] of Object.entries(data.types)) {
        if (vals.some((v) => lowered.includes(v.toLowerCase()))) {
          found.type = type;
          found.matchedBy = found.matchedBy || "type";
        }
      }
    }

    /* ===== condition match ===== */
    if (data.conditions) {
      for (const [cond, vals] of Object.entries(data.conditions)) {
        if (vals.some((v) => lowered.includes(v.toLowerCase()))) {
          found.condition ??= [];
          found.condition.push(cond);
          found.matchedBy = found.matchedBy || "condition";
        }
      }
    }

    /* ===== place match ===== */
    if (data.places) {
      for (const [place, vals] of Object.entries(data.places)) {
        if (vals.some((v) => lowered.includes(v.toLowerCase()))) {
          found.place = place;
          found.matchedBy = found.matchedBy || "place";
        }
      }
    }

    if (found.matchedBy || found.type || found.condition || found.place) {
      contextMatches.push(found);
    }
  }

  return contextMatches;
}

function extractIntent(text, intentsRaw) {
  text = text.toLowerCase();
  const intents = Object.entries(intentsRaw).map(([intent, obj]) => ({
    intent,
    patterns: obj.patterns,
  }));
  const matched = intents.find(({ patterns }) =>
    patterns.some((p) => text.includes(p.toLowerCase()))
  );
  return matched ? matched.intent : null;
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
    if (condition) {
      const userConds = Array.isArray(condition) ? condition : [condition];
      const entryConds = Array.isArray(entry.condition)
        ? entry.condition
        : [entry.condition];
      score += userConds.filter((c) => entryConds.includes(c)).length;
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

  return best;
}

/* =========== الدالّة الرئيسة =========== */
function handleMissingQ(question, basePath = "./data") {
  const keywordsRaw = loadJSON(
    path.join(basePath, "Q_structure/keywords.json")
  );
  const intentsRaw = loadJSON(path.join(basePath, "Q_structure/intent.json"));
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));

  const cleanedParts = advancedSplit(question.toLowerCase());

  /* --- النيّة --- */
  const foundIntent = extractIntent(question, intentsRaw);
  if (foundIntent) partialContext.intent = foundIntent;

  let extractedIntent = partialContext.intent || null;
  let fullContext = { ...partialContext };

  /* --- تحليل السياق --- */
  let contextMatches = [];
  for (const part of cleanedParts) {
    const matches = extractFromContext(part, keywordsRaw);
    contextMatches = contextMatches.concat(matches);

    if (matches.length === 0) continue;

    const best = matches[0];

    /* ==== متغيّرات الكلمة المفتاحيّة ==== */
    const keywordVariants = keywordsRaw[best.keyword]?.variants || [];

    /* ❶ تحقق من ذِكر الكلمة المفتاحية صراحة */
    const rawKeyword = best.keyword.replace(/^ال/, "").trim();
    const mentionedInQuestion =
      question.includes(best.keyword) || question.includes(rawKeyword);

    /* ❷ تحقق من متغيّرات حقيقية (تستثني الـ type نفسه) */
    const variantMatch = keywordVariants.some((v) => {
      const nV = v.replace(/^ال/, "").trim().toLowerCase();
      const nType = (best.type || "").replace(/^ال/, "").trim().toLowerCase();
      return nV !== nType && question.includes(v);
    });

    if (mentionedInQuestion || variantMatch) {
      fullContext.keyword = best.keyword.startsWith("ال")
        ? best.keyword
        : `ال${best.keyword}`;
    }

    /* أضف type / condition / place */
    fullContext.type ??= best.type;
    fullContext.condition ??= best.condition;
    fullContext.place ??= best.place;
  }

  /* --- تجهيز البدائل --- */
  const uniqueKeywords = [...new Set(contextMatches.map((m) => m.keyword))];
  const typeKeywordCombos = contextMatches
    .map((m) => normalizeWithType(m.keyword, m.type))
    .filter(Boolean);

  /* ❶ لا Keyword مُصرَّح + ≥1 مرشح ⇒ اسأل عن Keyword */
  if (!fullContext.keyword && uniqueKeywords.length >= 1) {
    partialContext = fullContext;
    return {
      ask: "keyword",
      message: `سؤالك عن "${question}" يحتمل موضوعًا واحدًا أو أكثر: ${typeKeywordCombos.join(
        " أو "
      )}. من فضلك حدّد أيّها تقصد.`,
      available: { keyword: false, intent: !!extractedIntent, context: true },
      context: fullContext,
    };
  }

  /* ❷ Keyword موجودة لكن لا Intent ⇒ اسأل عن النيّة */
  if (fullContext.keyword && !extractedIntent) {
    partialContext = fullContext;
    return {
      ask: "intent",
      message: `ما الذي تود معرفته بخصوص ${question.trim()}؟ (مثال: حكمه، تعريفه، أو كيفية أدائه). يرجى تحديد النية.`,
      keyword: fullContext.keyword,
      available: { keyword: true, intent: false, context: true },
      context: fullContext,
    };
  }

  /* ❸ لا Keyword ولا Intent ⇒ طلب توضيح عام */
  if (!fullContext.keyword && !extractedIntent) {
    partialContext = fullContext;
    return {
      ask: "clarify",
      message:
        "لم أتمكن من تحديد النية أو الموضوع بدقة. هل يمكنك إعادة صياغة سؤالك أو توضيحه؟",
      available: { keyword: false, intent: false, context: false },
      context: fullContext,
    };
  }

  /* --- البحث عن إجابة --- */
  const answers = loadAnswersForKeyword(fullContext.keyword, remote, basePath);
  const result = findBestAnswer(
    answers,
    extractedIntent,
    fullContext.type,
    fullContext.condition,
    fullContext.place
  );

  partialContext = {}; // إعادة الضبط

  if (result) {
    return {
      intent: extractedIntent,
      keyword: fullContext.keyword,
      type: fullContext.type || null,
      condition: fullContext.condition || null,
      place: fullContext.place || null,
      answer: Array.isArray(result.answers)
        ? result.answers[Math.floor(Math.random() * result.answers.length)]
        : result.answer,
      ref: result.proof || [],
      score: 1,
    };
  }

  return {
    intent: extractedIntent,
    keyword: fullContext.keyword,
    type: fullContext.type || null,
    condition: fullContext.condition || null,
    place: fullContext.place || null,
    answer: "لم أجد إجابة دقيقة لهذا السؤال.",
    score: 0.6,
  };
}

module.exports = { handleMissingQ };
