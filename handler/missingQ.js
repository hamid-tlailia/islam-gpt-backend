/* =========================================================================
   handleMissingQ.js – إصدار مُحدَّث 27-05-2025
   (Fix #7 + sub-keyword filter + longest-match preference)
   ========================================================================= */

const fs = require("fs");
const path = require("path");

let partialContext = {}; // يحتفظ بالسياق بين الاستدعاءات

/* ───────── أدوات مساعدة عامة ───────── */

/** تهرّب محارف RegExp الخاصة */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * تحقّق من وجود عبارة كاملة داخل نص مع حدود حروف حقيقيّة
 * يدعم Unicode property escapes (يتطلّب Node ≥ v12).
 */
function hasWholePhrase(text, phrase) {
  const esc = escapeRegex(phrase.trim().toLowerCase());
  const pattern = `(?<![\\p{L}])${esc}(?![\\p{L}])`;
  return new RegExp(pattern, "iu").test(text.toLowerCase());
}

/** قراءة ملف JSON */
function loadJSON(f) {
  return JSON.parse(fs.readFileSync(f, "utf-8"));
}

/** تقسيم متقدِّم بناءً على روابط/فواصل عربية */
function advancedSplit(t) {
  const c = [
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
  return t
    .split(new RegExp(`\\s*(?:${c.join("|")})\\s*`, "gi"))
    .map((p) => p.trim())
    .filter((p) => p.length > 2);
}

/** تنسيق keyword+type للعرض */
function normalizeWithType(k, t) {
  const clean = k.replace(/^ال/, "").trim();
  const tt = t && !t.startsWith("ال") ? `ال${t}` : t;
  return t ? `${clean} ${tt}` : `ال${clean}`;
}

/* ───────── أدوات كشف الكلمات ───────── */

function questionHasKeyword(q, k, raw) {
  if (!k) return false;
  if (hasWholePhrase(q, k) || hasWholePhrase(q, k.replace(/^ال/, "")))
    return true;
  const vars = raw[k]?.variants || [];
  return vars.some(
    (v) => hasWholePhrase(q, v) || hasWholePhrase(q, v.replace(/^ال/, ""))
  );
}

function detectKeywordInQuestion(q, raw) {
  const hits = [];
  for (const k of Object.keys(raw)) {
    if (questionHasKeyword(q, k, raw)) {
      const variantHit = [k, ...(raw[k].variants || [])].find((v) =>
        hasWholePhrase(q, v)
      );
      hits.push({
        keyword: k,
        variantMatched: variantHit,
        len: variantHit.length,
      });
    }
  }
  /* احتفظ بالأطول فقط */
  if (!hits.length) return null;
  hits.sort((a, b) => b.len - a.len);
  return hits[0].keyword;
}

/* ───────── فلترة الكلمات المتضمَّنة ───────── */

function filterSubKeywords(arr) {
  return arr.filter(
    (m) =>
      !arr.some(
        (o) =>
          o !== m &&
          o.variantMatched.includes(m.variantMatched) &&
          o.variantMatched.length > m.variantMatched.length
      )
  );
}

/* ───────── استخراج السياق من جزء ───────── */

function extractFromContext(part, allText, kwRaw) {
  const results = [];

  for (const [kw, data] of Object.entries(kwRaw)) {
    const found = {
      keyword: kw,
      matchedBy: null,
      type: null,
      condition: null,
      place: null,
      variantMatched: null,
      variantLen: 0,
    };

    /* (1) keyword أو variant */
    const variantHit = [kw, ...(data.variants || [])].find((v) =>
      hasWholePhrase(part, v)
    );
    if (!variantHit) continue;

    found.matchedBy = "keyword";
    found.variantMatched = variantHit;
    found.variantLen = variantHit.length;

    /* (2) الأنواع */
    if (data.types) {
      let bestType = null,
        exact = false;
      for (const [t, vals] of Object.entries(data.types)) {
        const nameMatch =
          hasWholePhrase(allText, t) ||
          hasWholePhrase(allText, t.replace(/^ال/, ""));
        const valMatch =
          !nameMatch && vals.some((v) => hasWholePhrase(allText, v));
        if (nameMatch) {
          bestType = t;
          exact = true;
          break;
        }
        if (valMatch && !bestType) bestType = t;
      }
      if (bestType) {
        found.type = bestType;
        found.matchedBy ||= "type";
      }
    }

    /* (3) الشروط */
    if (data.conditions) {
      for (const [c, vals] of Object.entries(data.conditions)) {
        if (vals.some((v) => hasWholePhrase(part, v))) {
          found.condition ??= [];
          found.condition.push(c);
          found.matchedBy ||= "condition";
        }
      }
    }

    /* (4) الأماكن */
    if (data.places) {
      for (const [p, vals] of Object.entries(data.places)) {
        if (vals.some((v) => hasWholePhrase(part, v))) {
          found.place = p;
          found.matchedBy ||= "place";
        }
      }
    }

    results.push(found);
  }
  return results;
}

/* أولوية مطابقات السياق */
function priority(m) {
  const base = { keyword: 4, variant: 3, type: 2 }[m.matchedBy] || 1;
  return base * 1000 + m.variantLen; // أطول عبارة تحظى بترجيح إضافي
}

/* ───────── استخراج النوايا ───────── */

function extractAllIntents(txt, intRaw) {
  txt = txt.toLowerCase();
  const arr = [];
  for (const [intent, obj] of Object.entries(intRaw)) {
    for (const p of obj.patterns) {
      const re = new RegExp(
        `(^|[\\s،؛؟.!"'()\\[\\]{}])${escapeRegex(p)}($|[\\s،؛؟.!"'()\\[\\]{}])`,
        "i"
      );
      if (re.test(txt)) {
        arr.push(intent);
        break;
      }
    }
  }
  return arr;
}

/* ───────── تحميل الإجابات (مع Fallback) ───────── */

function loadAnsForKW(k, remote, base) {
  const e = remote.find((r) => r.keyword?.toLowerCase() === k?.toLowerCase());
  if (!e) {
    return [
      {
        answers: [`عذرًا، لا تتوفر إجابة مفصّلة عن ${k ? k : "الموضوع"}.`],
        proof: [],
      },
    ];
  }
  const file = path.join(base, e.file);
  if (!fs.existsSync(file)) {
    return [
      {
        answers: [`عذرًا، تعذّر العثور على ملف الإجابات  .`],
        proof: [],
      },
    ];
  }
  return loadJSON(file);
}

function bestAnswer(arr, intent, type, cond, place) {
  if (intent) {
    arr = arr.sort((a, b) => (b.intent === intent) - (a.intent === intent));
  }
  let best = null,
    bestScore = -1;
  for (const e of arr) {
    let s = 0;
    if (intent && e.intent === intent) s += 2;
    if (type && e.type === type) s++;
    if (cond) {
      const u = Array.isArray(cond) ? cond : [cond];
      const en = Array.isArray(e.condition) ? e.condition : [e.condition];
      s += u.filter((c) => en.includes(c)).length;
    }
    if (place) {
      const ok = Array.isArray(e.place)
        ? e.place.includes(place)
        : e.place === place;
      if (ok) s++;
    }
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  return best;
}

/* ======================================================================
   الدالّة الرئيسة
   ====================================================================== */

function handleMissingQ(
  question,
  matchedKeyword = "",
  mayIntent,
  base = "./data"
) {
  const kwRaw = loadJSON(path.join(base, "Q_structure/keywords.json"));
  const intRaw = loadJSON(path.join(base, "Q_structure/intent.json"));
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));
  console.log(
    `معالجة سؤال مفقود: ${question} (matchedKeyword: ${matchedKeyword})`
  );
  /* 1️⃣  تحديث السياق إذا تغيّر الموضوع */
  const newKW = detectKeywordInQuestion(question, kwRaw);
  if (partialContext.keyword && newKW && newKW !== partialContext.keyword) {
    delete partialContext.keyword;
  }

  /* 2️⃣  تقسيم السؤال واستخراج النيّات */
  const parts = advancedSplit(question.toLowerCase());
  const intents = extractAllIntents(question, intRaw);
  if (intents.length === 1) partialContext.intent = intents[0];

  /* 3️⃣  استخراج كلمات مفتاحية وسياقات من كل جزء */
  let matches = [];
  for (const p of parts) {
    matches = matches.concat(extractFromContext(p, question, kwRaw));
  }
  matches = filterSubKeywords(matches);

  /* 4️⃣  دمج السياق */
  let ctx = { ...partialContext };
  if (matches.length) {
    matches.sort((a, b) => priority(b) - priority(a));
    const best = matches[0];
    if (priority(best) >= 2000) {
      // keyword أو variant مؤكَّد
      ctx.keyword = best.keyword.startsWith("ال")
        ? best.keyword
        : `ال${best.keyword}`;
    }
    ctx.type ??= best.type;
    ctx.condition ??= best.condition;
    ctx.place ??= best.place;
  }

  /* 5️⃣  منطق القرار لطلب التوضيح أو الإجابة */
  const uniqKws = [...new Set(matches.map((m) => m.keyword))];
  const combos = matches.map((m) => m.keyword);
  const logicStr = normalizeWithType(ctx.keyword || "", ctx.type || "");
  const hasKW = !!ctx.keyword;
  const hasInt = !!ctx.intent;
  const manyInt = intents.length > 1;

  if (manyInt && !hasKW) {
    console.log(`مطلوب توضيح: ${intents.join(", ")}`);
    return {
      ask: "intent",
      message: `ما الذي تشير إليه بخصوص (${intents.join("، ")})؟`,
      available: { keyword: false, intent: true, context: true },
      context: ctx,
    };
  }

  if (
    !hasKW &&
    intents.length === 1 &&
    question.trim().split(/\s+/).length <= 1
  ) {
    const i = intents[0];
    return {
      ask: "keyword",
      message: `أي موضوع يخص «${i}» تقصده؟ مثل: ${i} الصلاة، ${i} الصيام…`,
      available: { keyword: false, intent: true, context: false },
      context: ctx,
    };
  }

  if (uniqKws.length > 1 && !matchedKeyword) {
    partialContext = ctx;
    return {
      ask: "keyword",
      message: `سؤالك عن «${question}» يحتمل: ${combos.join(
        " أم "
      )}. حدّد المطلوب.`,
      available: { keyword: false, intent: hasInt, context: true },
      context: ctx,
    };
  }

  if (!hasKW && (uniqKws.length === 1 || matchedKeyword)) {
    ctx.keyword = matchedKeyword || uniqKws[0];
    const km = matches.find((m) => m.keyword === ctx.keyword) || {};
    ctx.type ??= km.type;
    ctx.condition ??= km.condition;
    ctx.place ??= km.place;
  }

  if (hasKW && !hasInt) {
    partialContext = ctx;
    return {
      ask: "intent",
      message: `ما الذي تود معرفته بخصوص ${logicStr}؟ (حكم، تعريف، فضل، كيفية…)`,
      available: { keyword: true, intent: false, context: true },
      context: ctx,
    };
  }

  if (!hasKW && !hasInt) {
    partialContext = ctx;
    return {
      ask: "clarify",
      message: "نأسف، يرجى إعادة صياغة السؤال مع مزيد من التفاصيل.",
      available: { keyword: false, intent: false, context: false },
      context: ctx,
    };
  }

  /* 6️⃣  جلب وإرجاع أفضل إجابة */
  const answersAll = loadAnsForKW(ctx.keyword, remote, base);
  if (!ctx.intent) {
    const intentsAvailable = [
      ...new Set(answersAll.map((a) => a.intent).filter(Boolean)),
    ];
    if (intentsAvailable.length > 1) {
      partialContext = ctx;
      return {
        ask: "intent",
        message: `لدي أكثر من إجابة ممكنة بخصوص ${
          ctx.keyword
        } (${intentsAvailable.join("، ")}). حدِّد المطلوب.`,
        available: { keyword: true, intent: false, context: true },
        context: ctx,
      };
    }
  }

  const best = bestAnswer(
    answersAll,
    ctx.intent || "",
    ctx.type,
    ctx.condition,
    ctx.place
  );
  partialContext = {};

  if (best) {
    return {
      intent: ctx.intent,
      keyword: ctx.keyword,
      type: ctx.type || null,
      condition: ctx.condition || null,
      place: ctx.place || null,
      answer: Array.isArray(best.answers)
        ? best.answers[Math.floor(Math.random() * best.answers.length)]
        : best.answer,
      ref: best.proof || [],
      score: 1,
    };
  }

  return {
    intent: ctx.intent,
    keyword: ctx.keyword,
    type: ctx.type || null,
    condition: ctx.condition || null,
    place: ctx.place || null,
    answer:
      "نأسف لعدم توفر الإجابة على هذا السؤال حالياً، يرجى المحاولة لاحقاً.",
    score: 0.6,
  };
}

module.exports = { handleMissingQ };
