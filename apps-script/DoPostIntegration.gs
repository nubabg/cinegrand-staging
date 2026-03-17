/**
 * Интеграция на Lock endpoints в съществуващия doPost
 *
 * Добави този блок В НАЧАЛОТО на твоята doPost функция, ПРЕДИ
 * обработката на record submission:
 *
 * ---
 *
 * function doPost(e) {
 *   try {
 *     var data = {};
 *     try {
 *       data = JSON.parse(e.postData.contents || "{}");
 *     } catch (parseErr) {
 *       return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Invalid JSON" }))
 *         .setMimeType(ContentService.MimeType.JSON);
 *     }
 *
 *     var action = data.action;
 *     if (action === "acquireLock") {
 *       var result = handleAcquireLock(data);
 *       return ContentService.createTextOutput(JSON.stringify(result))
 *         .setMimeType(ContentService.MimeType.JSON);
 *     }
 *     if (action === "releaseLock") {
 *       var result = handleReleaseLock(data);
 *       return ContentService.createTextOutput(JSON.stringify(result))
 *         .setMimeType(ContentService.MimeType.JSON);
 *     }
 *
 *     // ... съществуваща логика за record ...
 *
 *   } catch (err) {
 *     return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
 *       .setMimeType(ContentService.MimeType.JSON);
 *   }
 * }
 *
 * ---
 */
