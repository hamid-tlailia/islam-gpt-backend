/* =========================================================================
   handleMissingQ.js – إصدار 27-05-2025  (Fix #7: exact-type preference)
   ====================================================================== */
const fs = require("fs");
const path = require("path");

let partialContext = {}; // يُخزّن السياق غير المكتمل بين الاستدعاءات

/* ───────── أدوات عامّة ───────── */
function loadJSON(f) {
  return JSON.parse(fs.readFileSync(f, "utf-8"));
}
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
function normalizeWithType(k, t) {
  const clean = k.replace(/^ال/, "").trim();
  const tt = t && !t.startsWith("ال") ? `ال${t}` : t;
  return t ? `${clean} ${tt}` : `ال${clean}`;
}
function includesWord(txt, w) {
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(^|[\\s،؛؟.!"'()\\[\\]{}])${esc}($|[\\s،؛؟.!"'()\\[\\]{}])`,
    "i"
  );
  return re.test(txt);
}
function questionHasKeyword(q, k, raw) {
  if (!k) return false;
  if (includesWord(q, k) || includesWord(q, k.replace(/^ال/, ""))) return true;
  const vars = raw[k]?.variants || [];
  return vars.some(
    (v) => includesWord(q, v) || includesWord(q, v.replace(/^ال/, ""))
  );
}
function detectKeywordInQuestion(q, raw) {
  for (const k of Object.keys(raw)) if (questionHasKeyword(q, k, raw)) return k;
  return null;
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
    };

    /* (1) ذكر الكلمة المفتاحية نصًّا */
    if (includesWord(part, kw) || includesWord(part, kw.replace(/^ال/, ""))) {
      found.matchedBy = "keyword";
    }

    /* (2) المتغيّرات */
    if (!found.matchedBy && data.variants?.some((v) => includesWord(part, v))) {
      found.matchedBy = "variant";
    }

    /* (3) الأنواع – تفضيل المطابقة بالاسم نفسه */
    if (data.types) {
      let bestType = null;
      let exactMatch = false;

      for (const [t, vals] of Object.entries(data.types)) {
        const nameMatch =
          includesWord(allText, t) ||
          includesWord(allText, t.replace(/^ال/, ""));
        const valMatch =
          !nameMatch && vals.some((v) => includesWord(allText, v));

        if (nameMatch) {
          bestType = t;
          exactMatch = true;
          break; // وجدنا النوع بالاسم نفسه ↠ لا حاجة للمزيد
        }
        if (valMatch && !bestType) {
          bestType = t; // احتفظ بأول تطابق بالـ vals إذا لم نجد اسماً
        }
      }

      if (bestType) {
        found.type = bestType;
        found.matchedBy = found.matchedBy || "type";
      }
    }

    /* (4) الشروط */
    if (data.conditions) {
      for (const [c, vals] of Object.entries(data.conditions)) {
        if (vals.some((v) => includesWord(part, v))) {
          found.condition ??= [];
          found.condition.push(c);
          found.matchedBy = found.matchedBy || "condition";
        }
      }
    }

    /* (5) الأماكن */
    if (data.places) {
      for (const [p, vals] of Object.entries(data.places)) {
        if (vals.some((v) => includesWord(part, v))) {
          found.place = p;
          found.matchedBy = found.matchedBy || "place";
        }
      }
    }

    if (found.matchedBy || found.type || found.condition || found.place)
      results.push(found);
  }
  return results;
}
const priority = (m) => ({ keyword: 4, variant: 3, type: 2 }[m.matchedBy] || 1);

/* ───────── استخراج النوايا ───────── */
function extractAllIntents(txt, intRaw) {
  txt = txt.toLowerCase();
  const arr = [];
  for (const [intent, obj] of Object.entries(intRaw)) {
    for (const p of obj.patterns) {
      const re = new RegExp(
        `(^|[\\s،؛؟.!"'()\\[\\]{}])${p.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}($|[\\s،؛؟.!"'()\\[\\]{}])`,
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
  const e = remote?.find((r) => r?.keyword?.toLowerCase() === k?.toLowerCase());
  if (!e) {
    return [
      { answers: [`عذرًا، لا تتوفر إجابة مفصّلة عن «${k}».`], proof: [] },
    ];
  }
  const file = path.join(base, e.file);
  if (!fs.existsSync(file)) {
    return [
      {
        answers: [`عذرًا، تعذّر العثور على ملف الإجابات لـ «${k}».`],
        proof: [],
      },
    ];
  }
  return loadJSON(file);
}
function bestAnswer(arr, intent, type, cond, place) {
  // ❶ إذا وُجد intent صريح، صفِّف القائمة بحيث تأتي المطابقات أوّلاً
  if (intent) {
    arr = arr.sort(
      (a, b) => (a.intent === intent ? -1 : 0) - (b.intent === intent ? -1 : 0)
    );
  }

  let best = null,
    bestScore = -1;
  for (const e of arr) {
    let s = 0;
    if (intent && e.intent === intent) s += 2; // أولوية أعلى
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

/* =======================================================================
   الدالّة الرئيسة
   ======================================================================= */
function handleMissingQ(
  question,
  matchedKeyword = "",
  mayIntent,
  base = "./data"
) {
  const kwRaw = loadJSON(path.join(base, "Q_structure/keywords.json"));
  const intRaw = loadJSON(path.join(base, "Q_structure/intent.json"));
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));

  /* تغيّر الموضوع؟ */
  const newKW = detectKeywordInQuestion(question, kwRaw);
  if (partialContext.keyword && newKW && newKW !== partialContext.keyword) {
    // أزل الكلمة المفتاحيّة القديمة فقط، واحتفظ بـ type / condition / place
    delete partialContext.keyword;
  }

  const parts = advancedSplit(question.toLowerCase());
  const intents = extractAllIntents(question, intRaw);
  if (intents.length === 1) partialContext.intent = intents[0];

  let ctx = { ...partialContext };
  let matches = [];
  for (const p of parts)
    matches = matches.concat(extractFromContext(p, question, kwRaw));

  if (matches.length) {
    matches.sort((a, b) => priority(b) - priority(a));
    const best = matches[0];
    if (priority(best) >= 2) {
      ctx.keyword = best.keyword.startsWith("ال")
        ? best.keyword
        : `ال${best.keyword}`;
    }
    ctx.type ??= best.type;
    ctx.condition ??= best.condition;
    ctx.place ??= best.place;
  }

  /* منطق القرار */
  const uniq = [...new Set(matches.map((m) => m.keyword))];
  const combos = matches.map((m) => m.keyword).filter(Boolean);
  const logicStr = normalizeWithType(ctx.keyword || "", ctx.type || "");
  const hasKW = !!ctx.keyword,
    hasInt = !!ctx.intent,
    manyInt = intents.length > 1;

  if (manyInt && !hasKW) {
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
  /* ← إزالة ‎!hasKW‎ لضمان طلب التوضيح عند تعدد الكلمات */
  if (uniq.length > 1 && matchedKeyword === "") {
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
  if (!hasKW && (uniq.length === 1 || matchedKeyword)) {
    ctx.keyword = matchedKeyword || uniq[0];
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
      keyword: ctx.keyword,
      available: { keyword: true, intent: false, context: true },
      context: ctx,
    };
  }
  if (!hasKW && !hasInt) {
    partialContext = ctx;
    return {
      ask: "clarify",
      message:
        "نأسف لعدم توفر الإجابة على هذا السؤال حالياً، يرجى المحاولة لاحقاً.",
      available: { keyword: false, intent: false, context: false },
      context: ctx,
    };
  }

  /* البحث عن إجابة */
  /* ========= إذا لم تُحدَّد النيّة وكان للـ keyword أكثر من نيّة ========= */
  const answersAll = loadAnsForKW(ctx.keyword, remote, base);
  if (!ctx.intent) {
    const intentsAvailable = [
      ...new Set(answersAll.map((a) => a.intent).filter(Boolean)),
    ];

    if (intentsAvailable.length > 1) {
      partialContext = ctx; // احتفظ بالسياق
      return {
        ask: "intent",
        message:
          `لدي أكثر من إجابة ممكنة بخصوص ${ctx.keyword} ` +
          `(${intentsAvailable.join("، ")}). حدِّد المطلوب.`,
        available: { keyword: true, intent: false, context: true },
        context: ctx,
      };
    }
  }

  const answers = loadAnsForKW(ctx.keyword, remote, base);
  const best = bestAnswer(
    answers,
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
