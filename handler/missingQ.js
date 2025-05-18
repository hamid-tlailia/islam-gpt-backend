// missingQ.js
const fs = require("fs");
const path = require("path");

let partialContext = {};

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function advancedSplit(text) {
  const connectors = [
    "،",
    "؛",
    "\\.",
    "؟",
    "!", // علامات الترقيم
    "\\bثم\\b",
    "\\bأو\\b",
    "\\bلكن\\b",
    "\\bبعد\\b",
    "\\bقبل\\b",
    "\\bو\\b", // كلمات رابطة
  ];
  const regex = new RegExp(`\\s*(?:${connectors.join("|")})\\s*`, "gi");
  return text
    .split(regex)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
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

    if (data.variants?.some((v) => lowered.includes(v.toLowerCase()))) {
      found.matchedBy = "variant";
    }

    if (data.types) {
      for (const [type, vals] of Object.entries(data.types)) {
        if (vals.some((v) => lowered.includes(v.toLowerCase()))) {
          found.type = type;
          found.matchedBy = found.matchedBy || "type";
        }
      }
    }

    if (data.conditions) {
      for (const [cond, vals] of Object.entries(data.conditions)) {
        if (vals.some((v) => lowered.includes(v.toLowerCase()))) {
          if (!found.condition) found.condition = [];
          found.condition.push(cond);
          found.matchedBy = found.matchedBy || "condition";
        }
      }
    }

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

  return best;
}

function handleMissingQ(question, basePath = "./data") {
  const keywordsRaw = loadJSON(
    path.join(basePath, "Q_structure/keywords.json")
  );
  const intentsRaw = loadJSON(path.join(basePath, "Q_structure/intent.json"));
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));

  const cleanedParts = advancedSplit(question.toLowerCase());

  const foundIntent = extractIntent(question, intentsRaw);
  if (foundIntent) {
    partialContext.intent = foundIntent;
  }

  let extractedIntent = partialContext.intent || null;
  let extractedKeyword = partialContext.keyword || null;
  let fullContext = { ...partialContext };

  let contextMatches = [];
  for (const part of cleanedParts) {
    contextMatches = extractFromContext(part, keywordsRaw);
    if (contextMatches.length > 0) {
      const best = contextMatches[0];
      extractedKeyword = best.keyword;
      fullContext.keyword = best.keyword;
      fullContext.type = best.type || fullContext.type;
      fullContext.condition = best.condition || fullContext.condition;
      fullContext.place = best.place || fullContext.place;
      break;
    }
  }

  const uniqueKeywords = [...new Set(contextMatches.map((m) => m.keyword))];
  let typeKeywordCombo = "";
  if (fullContext.keyword) {
    const cleanKeyword = fullContext.keyword.replace(/^ال/, "").trim();
    let cleanType = fullContext.type
      ? fullContext.type.replace(/^ال/, "").trim()
      : "";
    if (cleanType && !cleanType.startsWith("ال")) {
      cleanType = "ال" + cleanType;
    }
    typeKeywordCombo = cleanType
      ? `${cleanKeyword} ${cleanType}`
      : cleanKeyword;
  }

  if (uniqueKeywords.length > 1) {
    partialContext = fullContext;
    return {
      ask: "keyword",
      message: `سؤالك عن "${question}" يحتمل أكثر من موضوع: ${uniqueKeywords.join(
        " أو "
      )}. من فضلك حدّد.`,
      available: {
        keyword: false,
        intent: !!extractedIntent,
        context: true,
      },
      context: fullContext,
    };
  }

  if (fullContext.keyword && !extractedIntent) {
    partialContext = fullContext;
    return {
      ask: "intent",
    message: `ما الذي تود معرفته بخصوص ${typeKeywordCombo}؟ (مثال: حكمه، تعريفه، أو كيفية أدائه). يرجى تحديد النية.`,
      keyword: fullContext.keyword,
      available: {
        keyword: true,
        intent: false,
        context: true,
      },
      context: fullContext,
    };
  }

  if (!fullContext.keyword && !extractedIntent) {
    partialContext = fullContext;
    return {
      ask: "clarify",
      message:
        "لم أتمكن من تحديد النية أو الموضوع بدقة. هل يمكنك إعادة صياغة سؤالك أو توضيحه؟",
      available: {
        keyword: false,
        intent: false,
        context: false,
      },
      context: fullContext,
    };
  }

  const answers = loadAnswersForKeyword(fullContext.keyword, remote, basePath);
  const result = findBestAnswer(
    answers,
    extractedIntent,
    fullContext.type,
    fullContext.condition,
    fullContext.place
  );

  partialContext = {}; // reset context once completed

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

module.exports = {
  handleMissingQ,
};
