/* ========================================================= */
const path = require("path");
const { handleMultyQ } = require("./multyQ"); // يُرجع Array من المقاطع
const { handleMissingQ } = require("./missingQ"); // fallback للأسئلة الفردية

function handleMissingAndMultyQ(question, basePath = "./data") {
  // 1) استدعاء منطق الأسئلة المتعددة
}

module.exports = { handleMissingAndMultyQ };
