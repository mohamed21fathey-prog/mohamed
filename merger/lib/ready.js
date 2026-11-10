// ضمان تشغيل ensureSchema مرة واحدة لكل نسخة دالة دافئة (بدل كل طلب)
const { ensureSchema } = require("./db");
let readyPromise = null;
module.exports = function ready() {
  if (!readyPromise) readyPromise = ensureSchema().catch(e => { readyPromise = null; throw e; });
  return readyPromise;
};
