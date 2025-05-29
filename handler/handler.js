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

function extractAllIntents(text, intRaw) {
  const t = text.toLowerCase(),
    arr = [];
  for (const [intent, o] of Object.entries(intRaw))
    for (const p of o.patterns)
      if (hasWhole(t, p)) {
        arr.push(intent);
        break;
      }
  return arr; // مصفوفة نوايا (قد تكون فارغة)
}

/* ───────── استخراج Keyword + سياق مع index ───────── */

function extractKwCtx(text, kwRaw) {
  const low = text.toLowerCase(),
    res = [];
  for (const [kw, data] of Object.entries(kwRaw)) {
    const hit = [kw, ...(data.variants || [])].find((v) => hasWhole(low, v));
    if (!hit) continue;

    const firstIdx = low.indexOf(hit.toLowerCase());

    let type = null;
    if (data.types)
      for (const [ty, vals] of Object.entries(data.types))
        if ([ty, ...vals].some((v) => hasWhole(low, v))) {
          type = ty;
          break;
        }

    let place = null;
    if (data.places)
      for (const [pl, vals] of Object.entries(data.places))
        if (vals.some((v) => hasWhole(low, v))) {
          place = pl;
          break;
        }

    const conds = [];
    if (data.conditions)
      for (const [c, vals] of Object.entries(data.conditions))
        if (vals.some((v) => hasWhole(low, v))) conds.push(c);

    const push = (cond) =>
      res.push({
        keyword: kw,
        type,
        condition: cond || null,
        place,
        idx: firstIdx,
        variant: hit,
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
    score = -1;
  for (const e of arr) {
    let s = 0;
    if (intent && e.intent === intent) s++;
    if (type && e.type === type) s++;
    if (place && e.place === place) s++;
    if (cond) {
      const u = [cond],
        en = Array.isArray(e.condition) ? e.condition : [e.condition];
      s += u.filter((c) => en.includes(c)).length;
    }
    if (s > score) {
      best = e;
      score = s;
    }
  }
  return best
    ? {
        ans: Array.isArray(best.answers) ? best.answers[0] : best.answer || "",
        proof: best.proof || [],
      }
    : { ans: "لم يتم العثور على إجابة دقيقة.", proof: [] };
}

/* ───────── تحليل شامل للسؤال ───────── */

function analyze(text, intRaw, kwRaw) {
  const intents = new Set(extractAllIntents(text, intRaw));
  const kwCtx = filterSub(extractKwCtx(text, kwRaw));
  const pairs = new Set(
    kwCtx.map((o) => `${o.keyword}::${o.condition || "_"}`)
  );
  console.log("Intents:", intents, "Keywords Context:", kwCtx, "Pairs:", pairs);
  return { intents, kwCtx, pairs };
}

/* =========================================================
   findAnswer
   ========================================================= */

function findAnswer(question, prev = {}, base = "./data") {
  const intRaw = loadJSON(path.join(base, "Q_structure/intent.json"));
  const kwRaw = loadJSON(path.join(base, "Q_structure/keywords.json"));
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));

  const A = analyze(question, intRaw, kwRaw);

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
    console.log("تعريفات متعددة:", A.pairs);
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
    const r = handleMultyQ(question, founds, base);
    if (r) return r;
  }

  /* — 4. Intentات متعددة → handleMultyQ */
  if (A.intents.size > 1) {
    const founds = {
      foundIntents: A.intents,
      foundKeywords: new Set(A.kwCtx.map((k) => k.keyword)),
    };
    const r = handleMultyQ(question, founds, base);
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

  const { ans, proof } = pickBest(
    loadAns(keyword, remote, base),
    intent,
    type,
    condition,
    place
  );

  return {
    intent,
    keyword,
    type,
    condition,
    place,
    answer: ans,
    ref: proof,
    score: 1,
  };
}

/* ───────── تصدير ───────── */
module.exports = { findAnswer };
