const fs = require("fs");

const path = require("path");
const { handleMissingQ } = require("./missingQ");

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/* util: حوِّل النمط إلى “كلمة كاملة” مع مرونة المسافات */
function wholePattern(pattern) {
  // 1) اهرب جميع المحارف الخاصة
  const esc = pattern.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 2) اجعل المسافات اختيارية (مثل escapeAndFlexPattern لديك)
  const flex = esc.replace(/\s+/g, "\\s*");
  // 3) أضف حدود الكلمة العربية مع السماح بـ (ال)
  return `(?<![\\p{L}])(?:ال)?${flex}(?![\\p{L}])`;
}

/* — النسخة المنقَّحة من extractIntentPositions — */
function extractIntentPositions(text, intentsRaw) {
  const lowered = text.toLowerCase();
  const positions = [];

  for (const [intent, data] of Object.entries(intentsRaw)) {
    for (const pattern of data.patterns) {
      const regex = new RegExp(wholePattern(pattern), "giu"); // ⬅︎
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

  /* إزالة التداخل كما فى كودك الأصلى */
  positions.sort((a, b) => a.index - b.index);
  const filtered = [];
  let lastEnd = -1;
  for (const p of positions) {
    if (p.index >= lastEnd) {
      filtered.push(p);
      lastEnd = p.index + p.length;
    }
  }
  console.log("intents filtred :", filtered);
  return filtered;
}

/* util: هل تحتوى الـ text على كلّ كلمات pattern (بأى ترتيب)؟ */
function hasAllWords(text, phrase) {
  return phrase
    .split(/\s+/) // ⇦ فصّل العبارة إلى كلمات
    .every((w) => text.includes(w.toLowerCase()));
}

/* util: أطول عنصر فريد */
function pickLongest(arr = []) {
  if (!arr.length) return null;
  const uniq = [...new Set(arr)];
  return uniq.reduce((a, b) => (b.length > a.length ? b : a));
}

/* النسخة المصحَّحة */
/* util ─ اختيار أطول عنصر فريد */
function pickLongest(arr = []) {
  if (!arr.length) return null;
  const uniq = [...new Set(arr)];
  return uniq.reduce((a, b) => (b.length > a.length ? b : a));
}

/* util ─ هل تظهر جميع كلمات pattern فى text؟ (ترتيب حرّ) */
function matchPattern(text, pattern) {
  const p = pattern.toLowerCase().trim();
  if (text.includes(p)) return true; // تطابق حرفىّ
  const words = p.split(/\s+/);
  return words.every((w) => text.includes(w));
}

/* ── النسخة الديناميّة من extractContextFromPart ───────── */
function extractContextFromPart(text, keywordsRaw) {
  const lowered = text.toLowerCase();
  let fallbackCtx = null;

  for (const [keyword, data] of Object.entries(keywordsRaw)) {
    /* 1️⃣ هل ذُكرت الكلمة المفتاحيّة صراحةً؟ */
    const kwTerms = [keyword, ...(data.variants || [])];
    const hasKeyword = kwTerms.some((t) => lowered.includes(t.toLowerCase()));

    /* 2️⃣ تجميع المطابقات */
    const tHits = [],
      cHits = [],
      pHits = [];

    // ⬤ types
    for (const [typ, pats] of Object.entries(data.types || {})) {
      const hit = [typ, ...pats].some((p) => matchPattern(lowered, p));
      if (hit) tHits.push(typ);
    }

    // ⬤ conditions
    for (const [cond, pats] of Object.entries(data.conditions || {})) {
      const hit = pats.some((p) => matchPattern(lowered, p));
      if (hit) cHits.push(cond);
    }

    // ⬤ places
    for (const [plc, pats] of Object.entries(data.places || {})) {
      const hit = pats.some((p) => matchPattern(lowered, p));
      if (hit) pHits.push(plc);
    }

    /* 3️⃣ إذا لم نجد أيّ ارتباط → انتقل للـ keyword التالية */
    if (!hasKeyword && !tHits.length && !cHits.length && !pHits.length)
      continue;

    /* 4️⃣ أزل التداخل (condition يتغلّب على type عند التكرار) */
    const uniqCond = cHits.filter((c) => !tHits.includes(c));
    const uniqType = tHits.filter((t) => !cHits.includes(t));

    /* 5️⃣ اختر الأطول */
    const chosenCond = pickLongest(uniqCond);
    const chosenType = chosenCond ? null : pickLongest(uniqType);

    const ctx = {
      keyword,
      type: chosenType,
      condition: chosenCond,
      place: pickLongest(pHits) || null,
    };

    /* 6️⃣ إذا وُجدت الكلمة المفتاحيّة صراحةً فارجع فورًا */
    if (hasKeyword) return ctx;

    /* 7️⃣ وإلاّ خزّنه كاحتمال احتياطىّ */
    if (!fallbackCtx) fallbackCtx = ctx;
  }
  return fallbackCtx; // قد تكون null
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
          ? best.answers[Math.floor(Math.random() * best.answers.length)]
          : best.answer || "",
        proof: best.proof || [],
        label: best.label || "",
      }
    : { answer: "لم يتم العثور على إجابة دقيقة.", proof: [] };
}

function handleMultyQ(question, founds, pairs, basePath = "./data") {
  const intentsRaw = loadJSON(path.join(basePath, "Q_structure/intent.json"));
  const keywordsRaw = loadJSON(
    path.join(basePath, "Q_structure/keywords.json")
  );
  const remote = loadJSON(path.join(__dirname, "remoteQuestion.json"));

  const lowered = question.toLowerCase();
  const intentPositions = extractIntentPositions(lowered, intentsRaw);

  if (intentPositions.length === 0) return null;

  const answersBundle = [];

  /* ── ❷ بناء مصفوفة parts كما في كودك الحالي ────────────────────────── */
  const parts = [];

  /* — A) أجزاء تسبق كل نيّة صريحة أو تقع بينها — */
  let cursor = 0;
  intentPositions.forEach((pos, idx) => {
    /* جزء قبل النيّة الحالية */
    if (pos.index > cursor) {
      const chunk = question.slice(cursor, pos.index).trim();
      splitByWa(chunk).forEach((txt) =>
        parts.push({ text: txt, intent: null })
      );
    }

    /* الجزء الذي يبدأ بالنيّة ذاتها ويليها كلمات */
    const end = intentPositions[idx + 1]
      ? intentPositions[idx + 1].index
      : question.length;
    const withIntent = question.slice(pos.index, end).trim();
    splitByWa(withIntent).forEach((txt) =>
      parts.push({ text: txt, intent: pos.intent })
    );

    cursor = end;
  });

  /* — B) ذيل الجملة بعد آخر نيّة إن وجد — */
  if (cursor < question.length) {
    splitByWa(question.slice(cursor).trim()).forEach((txt) =>
      parts.push({ text: txt, intent: null })
    );
  }

  /* 2) ضبط النيّة لأول جزء بلا نيّة */
  /* — 2) ضبط النيّة لأول جزء بلا نيّة — */
  const defaultIntent = [...(founds?.foundIntents || [])][0] || "حكم";
  if (parts.length && !parts[0].intent) {
    parts[0].intent = defaultIntent;
  }

  /* — 3) وراثة النيّة إلى الأمام — */
  let lastIntent = null;
  for (const p of parts) {
    if (p.intent) {
      lastIntent = p.intent; // نيّة صريحة
    } else if (lastIntent) {
      p.intent = lastIntent; // وراثة
    } else {
      p.intent = defaultIntent; // ← fallback موحَّد
      lastIntent = defaultIntent;
    }
  }
  let lastKeywordCtx = null; // السياق للكلمة المفتاحية الأخيرة
  for (const part of parts) {
    let ctx = extractContextFromPart(part.text, keywordsRaw);
    console.log("Parts : ", parts);
    console.log("found intents : ", founds?.foundIntents);
    if (!ctx && lastKeywordCtx) ctx = { ...lastKeywordCtx };

    if (!ctx) {
      // لم نجد كلمة مفتاحية → استخدم missingQ

      const foundIntentsStr = [...founds?.foundIntents]

        .map((v) => `${v}`)

        .join(", ");

      const isIntent = foundIntentsStr ? foundIntentsStr : null;

      const missing = handleMissingQ(part.text, "", isIntent, basePath);

      if (missing.intent && missing.keyword) {
        const ansArr = loadAnswersForKeyword(missing.keyword, remote, basePath);

        const best = findBestAnswer(
          ansArr,

          missing.intent,

          missing.type,

          missing.condition,

          missing.place
        );

        answersBundle.push({
          question: part.text,

          intent: missing.intent,

          keyword: missing.keyword,

          type: missing.type,

          condition: missing.condition,

          place: missing.place,

          answer: best.answer,

          proof: best.proof,
        });
      } else {
        return {
          ask: missing.ask,

          message: missing.message,

          context: missing.context,
        };
      }
    } else {
      /* كلمة مفتاحية موجودة */
      if (ctx) lastKeywordCtx = ctx; // حدِّثه عند العثور على Keyword
      // 🟢 استخرج القيم من السياق

      const { keyword, type, condition, place } = ctx;

      lastKeywordCtx = ctx;

      /// تُعيد نصًّا منزوع الفراغات أو "" إذا لم تكن القيمة String صافية

      const clean = (v) =>
        typeof v === "string"
          ? v.trim() // ✔︎ سلسلة ⇒ نحذف الفراغات
          : Array.isArray(v)
          ? v.map(String).join(" ").trim() // مصفوفة ⇒ نحوّل العناصر ونضمّها
          : ""; // أي شيء آخر ⇒ نعيد ""

      // 🟢 تنظيف القيم

      const cleanType = clean(type);

      const cleanCondition = clean(condition);

      const cleanPlace = clean(place);

      // 🟢 اختَر أول قيمة غير فارغة لإدراجها بين القوسين

      // Assume cleanType, cleanCondition, and cleanPlace are strings (can be empty or contain values)

      const items = [cleanType, cleanCondition, cleanPlace];

      // Filter out empty or whitespace-only values

      const filteredItems = items.filter((item) => item && item.trim() !== "");

      // Join them with " , " separator

      const extra = filteredItems.join(" , ");

      // 🟢 ابنِ جملة السؤال خالية من () الفارغة

      const question = `ما ${part.intent} ${keyword}${
        extra ? ` 【 ${extra} 】` : ""
      } ؟`;

      // 🟢 حمّل الإجابات واختر أفضلها

      const ansArr = loadAnswersForKeyword(keyword, remote, basePath);

      const best = findBestAnswer(
        ansArr,

        part.intent,

        cleanType,

        condition,

        cleanPlace
      );

      const isLable = lowered

        .split(/\s*و\s+/)

        .some((part) => part.includes("هل يجوز"));

      const label = isLable
        ? best.label && (best.label === "نعم" ? "نعم , " : "لا , ")
        : "";

      // 🟢 خزّن كل شيء في الحزمة

      answersBundle.push({
        question,

        intent: part.intent,

        keyword,

        type: cleanType || null, // نحفظ undefined إذا لم تكن هناك قيمة فعلية

        condition: condition || null,

        place: cleanPlace || null,

        answer: label + best.answer,

        proof: best.proof,
      });
    }
  }

  /* 5) أعد النتائج */
  /* ـــ إزالة التكرارات ــــــــــــــــــــــــــــــــــــــــــ */
  const unique = [];
  const seen = new Set();

  for (const a of answersBundle) {
    const key = [
      a.intent,
      a.keyword,
      a.type || "",
      Array.isArray(a.condition) ? a.condition.join("|") : a.condition || "",
      a.place || "",
    ].join("|");

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(a);
    }
  }
  /* … بعد بناء مصفوفة unique مباشرةً وقبل return … */

  // ــ تحقق هل الكلمة الوحيدة هي «المفتي»
  const onlyMufti =
    unique.length > 0 && // يوجد على الأقل إجابة
    unique.every((a) => a.keyword === "المفتي");

  // ــ مسار خاص للمفتي
  if (onlyMufti) {
    // دمج كل الإجابات (مع ترقيم بسيط)
    const combined = unique
      .map((a, i) => `️${a.answer}`) // أو استخدم • أو - بدل الترقيم
      .join(" , ");

    // يمكن دمج الأدلة إذا احتجت
    const combinedProof = unique.flatMap((a) => a.proof);

    return {
      ask: "simple",
      message: combined, // جواب موحَّد
      answers: [
        {
          intent: unique[0].intent, // أو null إذا تنوّعت
          keyword: "المفتي",
          answer: combined,
          proof: combinedProof,
        },
      ],
    };
  }

  /*  وإلاّ ابقِ على التصرّف الافتراضي */
  return {
    ask: "split",
    message: "تم تقسيم سؤالك إلى الأجزاء التالية مع إجاباتها:",
    answers: unique,
  };

  /* ========= دالة مساعدة لفصل النص على «و» مع الحفاظ على الكلمات ========= */
  function splitByWa(chunk) {
    return chunk
      .split(/(?:^|\s)و\s+/) // فصل عند الواو المعطوفة
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

module.exports = {
  handleMultyQ,
};
