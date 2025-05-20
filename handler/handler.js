const fs = require("fs");
const path = require("path");
const { handleMissingQ } = require("./missingQ");
const { handleMultyQ } = require("./multyQ");

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

    const all = [
      keyword,
      ...(data.variants || []),
      ...Object.values(data.types || {}).flat(),
      ...Object.values(data.conditions || {}).flat(),
      ...Object.values(data.places || {}).flat(),
    ];

    if (all.some((v) => lowered.includes(v.toLowerCase()))) {
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
      score += 0.5;
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
        continue;
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

function isMultyQuestion(text, intentsRaw, keywordsRaw) {
  const parts = advancedSplit(text);
  const foundIntents = new Set();
  const foundKeywords = new Set();

  for (const part of parts) {
    const intent = extractIntent(part, intentsRaw);
    const kwMatches = extractKeywordAndContext(part, keywordsRaw);
    if (intent) foundIntents.add(intent);
    for (const m of kwMatches) {
      m.matchedBy === "variant" && foundKeywords.add(m.keyword);
    }
  }

  return {
    state: foundIntents.size > 1 || foundKeywords.size > 1,
    founds: { foundIntents, foundKeywords },
  };
}

function findAnswer(question, previousContext = {}, basePath = "./data") {
  const intentsRaw = loadJSON(path.join(basePath, "Q_structure/intent.json"));
  const keywordsRaw = loadJSON(
    path.join(basePath, "Q_structure/keywords.json")
  );
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));

  const lowered = question.toLowerCase();

  // ✅ فحص إذا كان السؤال متعدد
  const isMulty = isMultyQuestion(question, intentsRaw, keywordsRaw);
  if (isMulty.state && isMulty.founds.foundIntents.size > 0) {
    // handle multi question
    const multiResult = handleMultyQ(question, isMulty.founds, basePath);
    if (multiResult) return multiResult;
  }

  // 🔍 تحليل فردي
  const newIntent = extractIntent(lowered, intentsRaw);
  const keywordMatches = extractKeywordAndContext(lowered, keywordsRaw);
  const uniqueKeywords = [...new Set(keywordMatches.map((m) => m.keyword))];

  const intent = newIntent || previousContext.intent || null;
  const matched = keywordMatches[0] || {};
  const keyword = matched.keyword || previousContext.keyword || null;
  const type = matched.type || previousContext.type || null;
  const condition = matched.condition || previousContext.condition || null;
  const place = matched.place || previousContext.place || null;
  // handle missing complex question
  if (isMulty.state) {
    // Check if the question is only one word (ignoring spaces)
    const isSingleWord = question.trim().split(/\s+/).length === 1;

    if (
      isMulty.founds.foundIntents.size === 0 &&
      isMulty.founds.foundKeywords.size > 1 &&
      question.length > 1 &&
      !isSingleWord
    ) {
      const definitionIntent = "تعريف"; // or use the intent name for "definition" in your intents file
      const uniqueKeywords = [...isMulty.founds.foundKeywords];
      console.log("uniqueKeywords", uniqueKeywords);
      const definitions = uniqueKeywords.map((kw) => {
      const answers = loadAnswersForKeyword(kw, remote, basePath);
      const def = findBestAnswer(answers, definitionIntent, null, null, null);
      return {
        keyword: kw,
        intent: definitionIntent,
        answer: def
        ? Array.isArray(def.answers)
          ? def.answers[Math.floor(Math.random() * def.answers.length)]
          : def.answer
        : "لم أجد تعريفًا لهذا المصطلح.",
        ref: def && def.proof ? def.proof : [],
        score: def ? 1 : 0.6,
      };
      });
      return { definitions };
    }
  }
  // handle simple missing question
  if (!keyword || !intent) {
    return handleMissingQ(question);
  }

  const answers = loadAnswersForKeyword(keyword, remote, basePath);
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
