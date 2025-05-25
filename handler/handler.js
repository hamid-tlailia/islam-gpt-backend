const fs = require("fs");
const path = require("path");
const { handleMissingQ } = require("./missingQ");
const { handleMultyQ } = require("./multyQ");

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function extractIntent(text, intentsRaw) {
  text = text.toLowerCase();

  for (const [intent, obj] of Object.entries(intentsRaw)) {
    for (let p of obj.patterns) {
      p = p.toLowerCase().trim(); // أزل الفراغات الزائدة
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(
        `(^|[\\s،؛؟.!"'()\\[\\]{}])${esc}($|[\\s،؛؟.!"'()\\[\\]{}])`,
        "i"
      );

      if (re.test(text)) return intent; // أوّل تطابق يكفي
    }
  }
  return null; // لا نيّة
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
        if (vals?.some((v) => lowered.includes(v.toLowerCase()))) {
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
  const splitedQ = question
    .split(/\s+/)
    .map((part) => (part.startsWith("ال") ? part : "ال" + part).trim())
    .filter((part) => part.length > 0);
  const mentionedQ = splitedQ
    .map((part) =>
      keywordMatches.find(
        (match) => match.keyword.toLowerCase() === part.toLowerCase()
      )
    )
    .find((match) => match !== undefined);
  const intent = newIntent || previousContext.intent || null;
  const matched = mentionedQ || keywordMatches[0] || {};
  const keyword = matched.keyword || previousContext.keyword || null;
  const type = matched.type || previousContext.type || null;
  const condition = matched.condition || previousContext.condition || null;
  const place = matched.place || previousContext.place || null;

  /* ========== handle missing complex question ========== */
  if (isMulty.state) {
    const isSingleWord = question.trim().split(/\s+/).length === 1;
    const notMissingComplex = !previousContext.isMissing;
    // لا نوايا صريحة، أكثر من كلمة مفتاحية، والجملة ليست كلمة واحدة
    if (
      isMulty.founds.foundIntents.size === 0 &&
      isMulty.founds.foundKeywords.size > 1 &&
      !isSingleWord &&
      notMissingComplex
    ) {
      const definitionIntent = "تعريف"; // نيّة التعريف
      const uniqueKeywords = [...isMulty.founds.foundKeywords];

      const definitions = uniqueKeywords.map((kw) => {
        /* ❶ احصل على كل المطابقات لهذا الـ keyword لمعرفة النوع */
        const kwMatchesForKw = keywordMatches.filter((m) => m.keyword === kw);

        /* ❷ استخرج أوّل type مذكور مع هذا الـ keyword (إن وُجد) */
        const typeForKw =
          kwMatchesForKw.map((m) => m.type).filter(Boolean)[0] || null;

        /* ❸ ابحث عن أفضل إجابة محدِّدًا الـ intent و الـ type */
        const answers = loadAnswersForKeyword(kw, remote, basePath);
        const def = findBestAnswer(
          answers,
          definitionIntent,
          typeForKw, // ← النوع المُكتشَف
          null,
          null
        );

        return {
          keyword: kw,
          intent: definitionIntent,
          type: typeForKw, // أعد النوع في الاستجابة
          answer: def
            ? Array.isArray(def.answers)
              ? def.answers[Math.floor(Math.random() * def.answers.length)]
              : def.answer
            : `لم أجد تعريفًا لـ «${kw}».`,
          ref: def?.proof || [],
          score: def ? 1 : 0.6,
        };
      });

      return { definitions };
    }
    if (
      isMulty.founds.foundIntents.size === 0 &&
      isMulty.founds.foundKeywords.size > 1 &&
      !isSingleWord &&
      !notMissingComplex
    ) {
      structuredQ = "";
      structuredQ = Array.from(isMulty.founds.foundKeywords)
        .map((kw) => `${previousContext.lastIntent} ${kw}`)
        .join(" و ");
      const multiResult = handleMultyQ(structuredQ, isMulty.founds, basePath);
      if (multiResult) return multiResult;
    }
  }

  // handle simple missing question
  const parts = question
    .split(/\s+/)
    .map((part) => (part.startsWith("ال") ? part : "ال" + part).trim())
    .filter((part) => part.length > 0);
  const matchedKeyword = parts.find((part) =>
    keywordMatches.some(
      (match) => match.keyword.toLowerCase() === part.toLowerCase()
    )
  );

  if (!keyword || !intent) {
    return handleMissingQ(question, matchedKeyword || "");
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
    answer:
      "نأسف لعدم توفر الإجابة على هذا السؤال حالياً، يرجى المحاولة لاحقاً.",
    score: 0.6,
  };
}

module.exports = {
  findAnswer,
};
