/* =========================================================
   handler.js – إصدار 02-06-2025
   ========================================================= */

const fs = require("fs");
const path = require("path");
const { handleMissingQ } = require("./missingQ");
const { handleMultyQ } = require("./multyQ");

/* ───────── أدوات عامّة ───────── */
let _lastCtx = null; // { keyword,type,condition,place }

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hasWhole(txt, ph) {
  const pat = `(?<![\\p{L}])(?:ال)?${escape(
    ph.trim().toLowerCase()
  )}(?![\\p{L}])`;
  return new RegExp(pat, "iu").test(txt.toLowerCase());
}
function loadJSON(f) {
  return JSON.parse(fs.readFileSync(f, "utf-8"));
}

/* ───────── استخراج جميع النيّات ───────── */

/* util: حوِّل النمط إلى “كلمة كاملة” مع مرونة الفراغات */
function wholePatternFlex(pat) {
  const esc = pat.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // تهريب المحارف
  const flex = esc.replace(/\s+/g, "\\s*"); // فراغات مرنة
  return `(?<![\\p{L}])(?:ال)?${flex}(?![\\p{L}])`; // حدود كلمة
}

/* نسخة محسَّنة من استخراج جميع النيّات */
function extractAllIntents(text, intRaw) {
  const t = text.toLowerCase();
  const hits = [];

  /* اجمع كل المطابقات مع مواضعها وطولها */
  for (const [intent, o] of Object.entries(intRaw)) {
    for (const p of o.patterns) {
      const re = new RegExp(wholePatternFlex(p), "giu");
      let m;
      while ((m = re.exec(t)) !== null) {
        hits.push({ intent, index: m.index, length: m[0].length });
      }
    }
  }

  /* رتِّب: أوّلاً حسب الموضع، ثم الأطول فالأقصر (لإزاحة التداخل) */
  hits.sort((a, b) =>
    a.index === b.index ? b.length - a.length : a.index - b.index
  );

  /* أزِل التداخل وأبقِ على النيّات الفريدة */
  const result = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.index >= lastEnd) {
      if (!result.includes(h.intent)) result.push(h.intent);
      lastEnd = h.index + h.length;
    }
  }
  return result; // مثال: ["التحية"] مع "كيف حالك"
}

/* ───────── استخراج Keyword + سياق مع index ───────── */

/******************* أداة المساعدة ********************/
function wholePattern(pattern) {
  const esc = pattern.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flex = esc.replace(/\s+/g, "\\s*");
  return `(?<![\\p{L}])(?:ال)?${flex}(?![\\p{L}])`;
}

function hasWhole(text, pattern) {
  const re = new RegExp(wholePattern(pattern), "iu");
  return re.test(text);
}

/******************* النسخة الدقيقة من extractKwCtx ********************/
function extractKwCtx(text, kwRaw) {
  const low = text.toLowerCase();
  const res = [];

  for (const [kw, data] of Object.entries(kwRaw)) {
    const hit = [kw, ...(data.variants || [])].find((v) => hasWhole(low, v));
    if (!hit) continue;

    const firstIdx = low.search(new RegExp(wholePattern(hit), "iu"));

    let type = null;
    if (data.types) {
      for (const [ty, vals] of Object.entries(data.types)) {
        if ([ty, ...vals].some((v) => hasWhole(low, v))) {
          type = ty;
          break;
        }
      }
    }

    let place = null;
    if (data.places) {
      for (const [pl, vals] of Object.entries(data.places)) {
        if (vals.some((v) => hasWhole(low, v))) {
          place = pl;
          break;
        }
      }
    }

    const conds = [];
    if (data.conditions) {
      for (const [c, vals] of Object.entries(data.conditions)) {
        if (vals.some((v) => hasWhole(low, v))) conds.push(c);
      }
    }

    const label = data.label || null;
    const push = (cond) =>
      res.push({
        keyword: kw,
        type,
        condition: cond || null,
        place,
        idx: firstIdx,
        variant: hit,
        label,
      });

    if (conds.length) conds.forEach(push);
    else push(null);
  }

  return res;
}


/* ───────── فلترة الكلمات المتضمَّنة ───────── */

function filterSub(arr) {
  return arr.filter((m, i) => {
    return !arr.some(
      (o, j) =>
        i !== j &&
        o.variant === m.variant && // ← نفس الـ variant بالضبط
        // لو كان أحدهما keyword مطابق للـ variant فأبقِه وازل الآخر.
        (o.keyword === o.variant ? m.keyword !== m.variant : j < i)
    );
  });
}

/* ───────── تحميل الأجوبة واختيار الأنسب ───────── */

function loadAns(kw, remote, base) {
  const e = remote.find((r) => r.keyword.toLowerCase() === kw.toLowerCase());
  if (!e) return [];
  const fp = path.join(base, e.file);
  return fs.existsSync(fp) ? loadJSON(fp) : [];
}
function pickBest(arr, intent, type, cond, place) {
  let best = null,
    maxScore = -1;

  for (const e of arr) {
    let score = 0;

    if (intent && e.intent === intent) score += 3;
    if (type && e.type === type) score += 2;
    if (place && e.place === place) score += 1;

    if (cond) {
      const condArray = Array.isArray(cond) ? cond : [cond];
      const entryCond = Array.isArray(e.condition)
        ? e.condition
        : [e.condition];
      const matchedConds = condArray.filter((c) => entryCond.includes(c));
      score += matchedConds.length * 3; // زيادة النقاط للشروط المتطابقة
    } else {
      // إذا لم يتم تحديد شرط، نفضّل الإجابات بدون شرط
      if (
        !e.condition ||
        (Array.isArray(e.condition) && e.condition.length === 0)
      ) {
        score += 2;
      }
    }

    // الأفضلية للتطابق الكامل
    const isExactMatch =
      intent &&
      e.intent === intent &&
      (!type || e.type === type) &&
      (!place || e.place === place) &&
      (cond
        ? Array.isArray(cond)
          ? cond.every((c) =>
              Array.isArray(e.condition)
                ? e.condition.includes(c)
                : e.condition === c
            )
          : Array.isArray(e.condition)
          ? e.condition.includes(cond)
          : e.condition === cond
        : !e.condition ||
          (Array.isArray(e.condition) && e.condition.length === 0));
    if (isExactMatch) {
      score += 5; // مكافأة للتطابق الكامل
    }

    if (score > maxScore) {
      best = e;
      maxScore = score;
    }
  }

  /* util صغير لاختيار عنصر عشوائى */
  const rand = (a) => a[Math.floor(Math.random() * a.length)];

  return best
    ? {
        ans: Array.isArray(best.answers)
          ? rand(best.answers) // ⇦ اختيار عشوائى كل مرة
          : best.answer || "",
        proof: best.proof || [],
        label: best.label || null,
      }
    : { ans: "لم يتم العثور على إجابة دقيقة.", proof: [] };
}

/* ───────── تحليل شامل للسؤال ───────── */

function analyze(text, intRaw, kwRaw) {
  const intents = new Set(extractAllIntents(text, intRaw));
  const rawKwCtx = extractKwCtx(text, kwRaw);
  const lowText = text.toLowerCase();

  const kwCtx = filterSub(rawKwCtx).map((ctx) => {
    const kwData = kwRaw[ctx.keyword];

    // 🔥 تحليل الشروط (conditions)
    let matchedConditions = [];
    if (kwData && kwData.conditions) {
      for (const [cond, patterns] of Object.entries(kwData.conditions)) {
        if (patterns.some((p) => hasWhole(lowText, p))) {
          matchedConditions.push(cond); // أضف كل تطابق
        }
      }
    }

    // 🔥 تحليل الأنواع (types)
    let matchedTypes = [];
    if (kwData && kwData.types) {
      for (const [typ, patterns] of Object.entries(kwData.types)) {
        if ([typ, ...patterns].some((p) => hasWhole(lowText, p))) {
          matchedTypes.push(typ); // أضف كل تطابق
        }
      }
    }

    return {
      ...ctx,
      condition:
        matchedConditions.length > 0
          ? matchedConditions.length === 1
            ? matchedConditions[0]
            : matchedConditions
          : ctx.condition,
      type:
        matchedTypes.length > 0
          ? matchedTypes.length === 1
            ? matchedTypes[0]
            : matchedTypes
          : ctx.type,
    };
  });

  const pairs = new Set(
    kwCtx.map(
      (o) =>
        `${o.keyword}::${
          Array.isArray(o.condition)
            ? o.condition.join(",")
            : o.condition || "_"
        }`
    )
  );

  console.log("Intents:", intents, "Keywords Context:", kwCtx, "Pairs:", pairs);
  return { intents, kwCtx, pairs };
}

function extractIntentsAfterKeyword(text, intRaw, kwRaw) {
  const t = text.toLowerCase();
  const found = [];

  // ابحث عن أقرب كلمة مفتاحية (من kwRaw)
  let minKeywordIndex = -1;
  let foundKeyword = null;
  for (const [kw, data] of Object.entries(kwRaw)) {
    const variants = [kw, ...(data.variants || [])];
    for (const v of variants) {
      const idx = t.indexOf(v.toLowerCase());
      if (idx !== -1 && (minKeywordIndex === -1 || idx < minKeywordIndex)) {
        minKeywordIndex = idx;
        foundKeyword = v;
      }
    }
  }

  if (minKeywordIndex === -1) {
    console.log(`❌ لم يتم العثور على أي كلمة مفتاحية في النص.`);
    return found;
  }

  // ابحث عن جميع intents التي تأتي بعد هذه الكلمة
  for (const [intent, o] of Object.entries(intRaw)) {
    for (const p of o.patterns) {
      const regex = new RegExp(
        `(?<![\\p{L}])(?:ال)?${escape(p.trim().toLowerCase())}(?![\\p{L}])`,
        "iu"
      );
      const match = regex.exec(t);
      if (match && match.index > minKeywordIndex) {
        found.push({
          intent,
          index: match.index,
          keyword: foundKeyword,
          keywordIndex: minKeywordIndex,
        });
      }
    }
  }

  return found; // مصفوفة [{ intent, index, keyword, keywordIndex }]
}
// Format answer function
// 🔥 دالة مساعدة لتنسيق الإجابة النهائية
function formatAnswer(keyword, intent, type, condition, place, remote, base) {
  const { ans, proof, label } = pickBest(
    loadAns(keyword, remote, base),
    intent,
    type,
    condition,
    place
  );
  const isLabel = label !== null ? `${label} , ` : "";
  return {
    intent,
    keyword,
    type,
    condition,
    place,
    answer: isLabel + ans,
    ref: proof,
    score: 1,
  };
}

// Check question complexity
function isMulti(kwCtx) {
  if (!kwCtx || kwCtx.length === 0) return false;

  const ctx = kwCtx[0]; // نتعامل مع أول Keyword Context فقط
  const condition = ctx.condition;
  const type = ctx.type;

  // إذا كانت condition مصفوفة بدون type كامل (أو type فارغ)
  if (Array.isArray(condition) && condition.length > 1) {
    return true; // multi
  }

  // إذا كانت type مصفوفة بدون شرط pattern كامل (مثلاً تخصيص)
  if (Array.isArray(type) && type.length > 1) {
    // تحقق من وجود condition pattern كامل
    if (!ctx.condition || typeof ctx.condition !== "string") {
      return true; // multi
    }
  }

  return false; // simple
}

/* =========================================================
   findAnswer
   ========================================================= */

function findAnswer(question, prev = {}, base = "./data") {
  const intRaw = loadJSON(path.join(base, "Q_structure/intent.json"));
  const kwRaw = loadJSON(path.join(base, "Q_structure/keywords.json"));
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));

  const A = analyze(question, intRaw, kwRaw);
  function isKeywordFirstAndAllIntentsAfter(result) {
    if (!result || result.length === 0) return false;

    // احصل على أول keyword وموقعها
    const keywordIndex = result[0].keywordIndex;

    // تحقق أن جميع intents تأتي بعد keyword
    const allAfterKeyword = result.every(({ index }) => index > keywordIndex);

    // هل يوجد intent واحد على الأقل؟
    const hasAtLeastOneIntent = result.length > 0;

    return hasAtLeastOneIntent && allAfterKeyword;
  }

  // 👇 مثال الاستخدام
  const result = extractIntentsAfterKeyword(question, intRaw, kwRaw);
  if (isKeywordFirstAndAllIntentsAfter(result)) {
    // نفّذ المنطق الخاص بك (مثلاً: مشاركة الكلمة مع جميع intents وتمريرها لـ handleMultyQ)
    const sharedKeyword = result[0].keyword;
    const sharedIntents = result.map((r) => r.intent);
    const founds = {
      foundIntents: new Set(sharedIntents),
      foundKeywords: new Set([sharedKeyword]),
    };
    const r = handleMultyQ(question, founds, "", base);
    if (r) return r;
  } else {
    console.log("❌ الشرط غير متحقق.");
  }
  /* ------------------------------------------------------------------
   ❶ لا Keyword لكن يوجد Intent واحد على الأقل  ➜  اطلب كلمة مفتاحية
------------------------------------------------------------------ */
  if (A.pairs.length === 0 && A.intents.size > 0 && !_lastCtx) {
    console.log("you are here ===========================");
    const onlyIntent = [...A.intents][0]; // أو ضمّها بفاصلة إن كانت >1
    return handleMissingQ(question, "", onlyIntent, base);
  }
  if (A.pairs.length === 1 && A.intents.size > 0) {
    console.log("you are here ===========================");
  }
  /* ------------------------------------------------------------------
   ❷ لا Intent إطلاقاً لكن توجد Keywords  ➜  اطلب توضيح النية
------------------------------------------------------------------ */
  if (A.intents.size === 0 && A.kwCtx.length === 1 && prev.isMissing) {
    console.log("ggggg");
    const firstKeyword = A.kwCtx[0].keyword;
    return handleMissingQ(question, firstKeyword, null, base);
  }

  /* — 1. لا Keyword إطلاقًا → جرّب وراثة آخر Keyword محفوظ */
  if (A.kwCtx.length === 0) {
    if (_lastCtx) {
      // استخدم آخر سياق كمفتاحيّة لهذا السؤال
      A.kwCtx.push({ ..._lastCtx, idx: 0 });
    } else {
      // لا شيء لنرِثه → نحتاج توضيحًا
      const lastIntent = [...A.intents][0] || null;
      return handleMissingQ(question, "", lastIntent, base);
    }
  }

  /* — 2. لا Intent + >1 Keyword → definitions */
  if (A.intents.size === 0 && A.pairs.size > 1) {
    // إذا كان هناك أكثر من Keyword، نبحث عن تعريفات لكل منها
    const defs = A.kwCtx.map((o) => {
      const { ans, proof } = pickBest(
        loadAns(o.keyword, remote, base),
        "تعريف",
        o.type,
        null,
        null
      );
      return {
        keyword: o.keyword,
        intent: "تعريف",
        type: o.type || null,
        answer: ans,
        ref: proof,
      };
    });
    return { definitions: defs, score: 1 };
  }

  /* — 3. Intent واحد + >1 Keyword → handleMultyQ (answersBundle) */
  if (A.intents.size === 1 && A.pairs.size > 1) {
    const founds = {
      foundIntents: A.intents,
      foundKeywords: new Set(A.kwCtx.map((k) => k.keyword)),
    };

    const r = handleMultyQ(question, founds, "", base);
    if (r) return r;
  }
  // Hnadle multy intents for 1 keyword
  if (A.intents.size > 1 && _lastCtx?.keyword !== "") {
    const q = Array.from(A.intents)
      .map((intent) => `${intent} ${_lastCtx?.keyword}`)
      .join(" و "); // تفصلهم بواو (و) مثلا: "حكم الصيام و تعريف الصيام"
    const founds = A;
    const pairs = A.pairs;
    const r = handleMultyQ(q, founds, pairs, base);
    if (r) return r;
  }
  if (A.intents.size === 1 && A.pairs.size === 1) {
    if (isMulti(A.kwCtx)) {
      const intent = [...A.intents][0];
      const keyword = [...A.pairs][0].split("::")[0];
      const typeCondString = [...A.pairs][0].split("::")[1];
      const splitItems = typeCondString
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      const results = [];

      for (const item of splitItems) {
        const kwCtx = A.kwCtx.find((k) => k.keyword === keyword);
        let type = null,
          condition = null,
          place = null;

        if (kwCtx) {
          // تحقق من type
          if (Array.isArray(kwCtx.type) && kwCtx.type.includes(item)) {
            type = item;
          } else if (typeof kwCtx.type === "string" && kwCtx.type === item) {
            type = item;
          }

          // تحقق من condition
          if (
            Array.isArray(kwCtx.condition) &&
            kwCtx.condition.includes(item)
          ) {
            condition = item;
          } else if (
            typeof kwCtx.condition === "string" &&
            kwCtx.condition === item
          ) {
            condition = item;
          }

          // تحقق من place (إن وجد)
          if (Array.isArray(kwCtx.place) && kwCtx.place.includes(item)) {
            place = item;
          } else if (typeof kwCtx.place === "string" && kwCtx.place === item) {
            place = item;
          }

          // 🔥 🔥 بناء extras لكل item بشكل منفصل 🔥 🔥
          const extras = [type, condition, place].filter((x) => x).join(" , ");

          const ansArr = loadAns(keyword, remote, base);
          const best = pickBest(ansArr, intent, type, condition, place);

          results.push({
            question: `ما ${intent} ${keyword}${
              extras ? ` 【 ${extras} 】` : ""
            } ؟`,
            intent,
            keyword,
            type: type || null,
            condition: condition || null,
            place: place || null,
            answer: best.ans,
            proof: best.proof,
          });
        }
      }

      return {
        ask: "split",
        message: "تم تقسيم سؤالك بناءً على pairs:",
        answers: results,
      };
    } else {
      // الحالة simple
      const intent = [...A.intents][0];
      const bestCtx = A.kwCtx[0];
      const keyword = bestCtx.keyword;
      const type = bestCtx.type;
      const condition = bestCtx.condition;
      const place = bestCtx.place;
      _lastCtx = { keyword, type, condition, place };
      return formatAnswer(
        keyword,
        intent,
        type,
        condition,
        place,
        remote,
        base
      );
    }
  }
  if (A.intents.size === 0 && A.pairs.size === 1) {
    if (isMulti(A.kwCtx)) {
      const intent = [...A.intents][0] || "حكم";
      const keyword = [...A.pairs][0].split("::")[0];
      const typeCondString = [...A.pairs][0].split("::")[1];
      const splitItems = typeCondString
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      const results = [];

      for (const item of splitItems) {
        const kwCtx = A.kwCtx.find((k) => k.keyword === keyword);
        let type = null,
          condition = null,
          place = null;

        if (kwCtx) {
          // تحقق من type
          if (Array.isArray(kwCtx.type) && kwCtx.type.includes(item)) {
            type = item;
          } else if (typeof kwCtx.type === "string" && kwCtx.type === item) {
            type = item;
          }

          // تحقق من condition
          if (
            Array.isArray(kwCtx.condition) &&
            kwCtx.condition.includes(item)
          ) {
            condition = item;
          } else if (
            typeof kwCtx.condition === "string" &&
            kwCtx.condition === item
          ) {
            condition = item;
          }

          // تحقق من place (إن وجد)
          if (Array.isArray(kwCtx.place) && kwCtx.place.includes(item)) {
            place = item;
          } else if (typeof kwCtx.place === "string" && kwCtx.place === item) {
            place = item;
          }

          // 🔥 🔥 بناء extras لكل item بشكل منفصل 🔥 🔥
          const extras = [type, condition, place].filter((x) => x).join(" , ");

          const ansArr = loadAns(keyword, remote, base);
          const best = pickBest(ansArr, intent, type, condition, place);

          results.push({
            question: `ما ${intent} ${keyword}${
              extras ? ` 【 ${extras} 】` : ""
            } ؟`,
            intent,
            keyword,
            type: type || null,
            condition: condition || null,
            place: place || null,
            answer: best.ans,
            proof: best.proof,
          });
        }
      }

      return {
        ask: "split",
        message: "تم تقسيم سؤالك بناءً على pairs:",
        answers: results,
      };
    } else {
      // الحالة simple
      const intent = [...A.intents][0];
      const bestCtx = A.kwCtx[0];
      const keyword = bestCtx.keyword;
      const type = bestCtx.type;
      const condition = bestCtx.condition;
      const place = bestCtx.place;
      _lastCtx = { keyword, type, condition, place };
      return formatAnswer(
        keyword,
        intent,
        type,
        condition,
        place,
        remote,
        base
      );
    }
  }
  /* — 4. Intentات متعددة → handleMultyQ */
  if (A.intents.size > 1) {
    const founds = {
      foundIntents: A.intents,
      foundKeywords: new Set(A.kwCtx.map((k) => k.keyword)),
    };
    const r = handleMultyQ(question, founds, A.pairs, base);
    if (r) return r;
  }
  const splitedQ = question
    .split(/\s+/)
    .map((part) => (part.startsWith("ال") ? part : "ال" + part).trim())
    .filter((part) => part.length > 0);
  const mentionedQ = splitedQ
    .map((part) =>
      A.kwCtx.find(
        (match) => match.keyword.toLowerCase() === part.toLowerCase()
      )
    )
    .find((match) => match !== undefined);
  /* — 4-bis. Keyword واحد لكن ctx > 1 (شروط/أماكن متعددة) → handleMultyQ */
  function hasBothTypeAndCondition(ctx) {
    const hasType = !!ctx.type;
    const hasCond = Array.isArray(ctx.condition)
      ? ctx.condition.length > 0
      : !!ctx.condition;
    return hasType && hasCond;
  }

  if (A.kwCtx.length === 1 && hasBothTypeAndCondition(A.kwCtx[0])) {
    const founds = {
      foundIntents: A.intents.size ? A.intents : new Set(["تعريف"]), // نيّة احتياطية
      foundKeywords: new Set([A.kwCtx[0].keyword]),
    };
    const r = handleMultyQ(question, founds, base);
    if (r) return r; // لا تتابع إلى منطق السؤال البسيط
  }

  /* — 5. سؤال بسيط: خذ Keyword الأقرب لبداية النص */
  const intent = [...A.intents][0] || prev.intent || null;
  const bestCtx = mentionedQ || A.kwCtx[0];
  const keyword = bestCtx.keyword;
  const type = bestCtx.type || prev.type || null;
  const condition = bestCtx.condition || prev.condition || null;
  const place = bestCtx.place || prev.place || null;

  /* 6️⃣ خزّن السياق لأسئلة النية-فقط القادمة */
  _lastCtx = { keyword, type, condition, place };

  return formatAnswer(keyword, intent, type, condition, place, remote, base);
}

/* ───────── تصدير ───────── */
module.exports = { findAnswer };
