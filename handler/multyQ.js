const fs = require("fs");
const path = require("path");

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

function handleMultyQ(question, previousContext = {}, basePath = "./data") {
  const intentsRaw = loadJSON(path.join(basePath, "Q_structure/intent.json"));
  const keywordsRaw = loadJSON(
    path.join(basePath, "Q_structure/keywords.json")
  );
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));

  const lowered = question.toLowerCase();
  const intentPositions = extractIntentPositions(lowered, intentsRaw);

  if (intentPositions.length < 2) {
    return null;
  }

  const answersBundle = [];

  for (let i = 0; i < intentPositions.length; i++) {
    const start = intentPositions[i].index;
    const end = intentPositions[i + 1]
      ? intentPositions[i + 1].index
      : question.length;
    const part = question.slice(start, end).trim();
    const intent = intentPositions[i].intent;
    const context = extractContextFromPart(part, keywordsRaw);
    const keyword = context?.keyword;
    const type = context?.type || null;
    const condition = context?.condition || [];
    const place = context?.place || null;

    if (intent && keyword) {
      const answers = loadAnswersForKeyword(keyword, remote, basePath);
      const best = findBestAnswer(answers, intent, type, condition, place);
      answersBundle.push({
        question: `ما ${intent} ${keyword}؟`,
        intent,
        keyword,
        type,
        condition,
        place,
        answer: best.answer,
        proof: best.proof,
      });
    } else if (intent) {
      answersBundle.push({
        question: `ما ${intent}؟`,
        intent,
        keyword: null,
        answer: "يرجى تحديد الموضوع المرتبط بهذه النية.",
        proof: [],
      });
    } else if (keyword) {
      answersBundle.push({
        question: `ما المطلوب بخصوص ${keyword}؟`,
        intent: null,
        keyword,
        answer: "يرجى توضيح نوع السؤال المرتبط بهذا الموضوع.",
        proof: [],
      });
    } else {
      answersBundle.push({
        question: part,
        intent: null,
        keyword: null,
        answer: "تعذر فهم هذا الجزء من السؤال.",
        proof: [],
      });
    }
  }

  return {
    ask: "split",
    message: "تم تقسيم سؤالك إلى الأجزاء التالية مع إجاباتها:",
    answers: answersBundle,
    context: previousContext,
    multy : true,
  };
}

module.exports = {
  handleMultyQ,
};
