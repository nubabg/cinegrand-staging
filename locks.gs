/**
 * ═══════════════════════════════════════════════════════════════
 *  Location Inspection Locks — Google Apps Script
 *  Добави този код към съществуващия Apps Script проект.
 *  Листът "Locks" се създава автоматично при първо използване.
 * ═══════════════════════════════════════════════════════════════
 */

var LOCK_SHEET_NAME = "Locks";
var LOCK_TIMEOUT_MIN = 45;

function getLockSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOCK_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOCK_SHEET_NAME);
    sheet.appendRow(["type", "location", "session_id", "locked_at", "expires_at"]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 100);
    sheet.setColumnWidth(2, 180);
    sheet.setColumnWidth(3, 280);
    sheet.setColumnWidth(4, 200);
    sheet.setColumnWidth(5, 200);
  }
  return sheet;
}

function cleanExpiredLocks_(sheet) {
  var data = sheet.getDataRange().getValues();
  var now = new Date();
  for (var i = data.length - 1; i >= 1; i--) {
    var expiresAt = new Date(data[i][4]);
    if (now > expiresAt) {
      sheet.deleteRow(i + 1);
    }
  }
}

function handleAcquireLock_(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return jsonResponse_({ success: false, error: "Сървърът е зает. Опитайте отново." });
  }

  try {
    var sheet = getLockSheet_();
    cleanExpiredLocks_(sheet);

    var allData = sheet.getDataRange().getValues();
    for (var i = 1; i < allData.length; i++) {
      if (allData[i][0] === data.type && allData[i][1] === data.location) {
        var expiresAt = new Date(allData[i][4]);
        var minutesLeft = Math.max(1, Math.ceil((expiresAt - new Date()) / 60000));
        lock.releaseLock();
        return jsonResponse_({
          success: false,
          locked: true,
          minutesLeft: minutesLeft,
          error: data.location + " вече се проверява. Опитайте след ~" + minutesLeft + " мин."
        });
      }
    }

    var now = new Date();
    var expires = new Date(now.getTime() + LOCK_TIMEOUT_MIN * 60 * 1000);
    sheet.appendRow([
      data.type,
      data.location,
      data.sessionId,
      now.toISOString(),
      expires.toISOString()
    ]);

    lock.releaseLock();
    return jsonResponse_({ success: true });

  } catch (e) {
    lock.releaseLock();
    return jsonResponse_({ success: false, error: e.message });
  }
}

function handleReleaseLock_(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return jsonResponse_({ success: false, error: "Сървърът е зает." });
  }

  try {
    var sheet = getLockSheet_();
    var allData = sheet.getDataRange().getValues();
    for (var i = allData.length - 1; i >= 1; i--) {
      if (allData[i][2] === data.sessionId) {
        sheet.deleteRow(i + 1);
      }
    }
    lock.releaseLock();
    return jsonResponse_({ success: true });
  } catch (e) {
    lock.releaseLock();
    return jsonResponse_({ success: false, error: e.message });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * ═══════════════════════════════════════════════════════════════
 *  ВАЖНО: Добави тези редове В НАЧАЛОТО на съществуващата
 *  функция doPost(e), ПРЕДИ останалата логика за запис:
 *
 *    function doPost(e) {
 *      var data = JSON.parse(e.postData.contents);
 *
 *      // --- Lock endpoints ---
 *      if (data.action === "acquireLock") return handleAcquireLock_(data);
 *      if (data.action === "releaseLock") return handleReleaseLock_(data);
 *
 *      // ... съществуващият код за запис на проверки ...
 *    }
 * ═══════════════════════════════════════════════════════════════
 */
