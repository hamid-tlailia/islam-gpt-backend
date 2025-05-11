const fs = require("fs");
const path = require("path");

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
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

function extractKeywordAndContext(text, keywordsRaw) {
  const lowered = text.toLowerCase();
  const possibleMatches = [];

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
          if (!found.matchedBy) found.matchedBy = "type";
          break;
        }
      }
    }

    if (data.conditions) {
      const matchedConditions = [];
      for (const [cond, vals] of Object.entries(data.conditions)) {
        if (vals.some((v) => lowered.includes(v.toLowerCase()))) {
          matchedConditions.push(cond);
          if (!found.matchedBy) found.matchedBy = "condition";
        }
      }
      if (matchedConditions.length > 0) {
        found.condition = matchedConditions;
      }
    }

    if (data.places) {
      for (const [place, vals] of Object.entries(data.places)) {
        if (vals.some((v) => lowered.includes(v.toLowerCase()))) {
          found.place = place;
          if (!found.matchedBy) found.matchedBy = "place";
          break;
        }
      }
    }

    if (found.matchedBy || found.type || found.condition || found.place) {
      possibleMatches.push(found);
    }
  }

  return possibleMatches;
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

    if (type && entry.type === type) {
      score++;
    } else if (!type && !entry.type) {
      score += 0.5; // تفضيل الإجابات العامة إذا لم يحدد المستخدم النوع
    }

    let condMatched = false;
    if (condition) {
      const userConds = Array.isArray(condition) ? condition : [condition];
      const entryConds = Array.isArray(entry.condition)
        ? entry.condition
        : [entry.condition];

      const matchedConds = userConds.filter((c) => entryConds.includes(c));
      condMatched = matchedConds.length > 0;

      if (userConds.length === 1 && entryConds.length > 1 && condMatched) {
        continue; // تجاهل هذه الإجابة
      }

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

function findAnswer(question, previousContext = {}, basePath = "./data") {
  const intentsRaw = loadJSON(path.join(basePath, "Q_structure/intent.json"));
  const keywordsRaw = loadJSON(
    path.join(basePath, "Q_structure/keywords.json")
  );
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));

  const lowered = question.toLowerCase();
  const newIntent = extractIntent(lowered, intentsRaw);
  const keywordMatches = extractKeywordAndContext(lowered, keywordsRaw);
  const uniqueKeywords = [...new Set(keywordMatches.map((m) => m.keyword))];

  const intent = newIntent || previousContext.intent || null;
  const matched = keywordMatches[0] || {};
  const keyword = matched.keyword || previousContext.keyword || null;
  const type = matched.type || previousContext.type || null;
  const condition = matched.condition || previousContext.condition || null;
  const place = matched.place || previousContext.place || null;

  if (!keyword && !intent) {
    return {
      ask: "clarify",
      message: "لم أستطع فهم سؤالك بدقة، هل يمكنك توضيحه؟",
      available: {
        keyword: false,
        intent: false,
        context: false,
      },
      context: {},
    };
  }

  if (uniqueKeywords.length > 1 && !intent) {
    return {
      ask: "keyword",
      message:
        "سؤالك يحتمل أكثر من موضوع: " +
        uniqueKeywords.join(" أو ") +
        ". من فضلك حدّد.",
      available: {
        keyword: false,
        intent: false,
        context: true,
      },
      context: {},
    };
  }

  const answers = keyword
    ? loadAnswersForKeyword(keyword, remote, basePath)
    : [];
  const kwMeta = keyword ? keywordsRaw[keyword] : null;
  const needsIntent = kwMeta?.needClarification !== false;

  if (!intent && needsIntent) {
    return {
      ask: "intent",
      message:
        "سؤالك يتعلق بـ " +
        keyword +
        ". من فضلك وضّح نيتك (حكم؟ تعريف ؟ كيفية؟).",
      keyword,
      available: {
        keyword: true,
        intent: false,
        context: matched.matchedBy !== "variant",
      },
      context: { keyword, type, condition, place },
    };
  }

  const result = findBestAnswer(answers, intent, type, condition, place);

  if (result) {
    return {
      intent,
      keyword,
      type,
      condition,
      place,
      answer: Array.isArray(result.answers)
        ? result.answers[Math.floor(Math.random() * result.answers.length)]
        : result.answer,
      ref: result.proof || [],
      score: 1,
    };
  }

  return {
    intent,
    keyword,
    type,
    condition,
    place,
    answer: "لم أجد إجابة دقيقة لهذا السؤال.",
    score: 0.6,
  };
}

module.exports = {
  findAnswer,
};
