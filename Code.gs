/**
 * Cine Grand Hygiene Control — Google Apps Script Backend
 *
 * Handles three types of POST requests from index.html:
 *   1. { record: {...} }                                  → запис на проверка
 *   2. { action: "acquireLock", type, location, session_id } → заключване на локация
 *   3. { action: "releaseLock", session_id }               → освобождаване на заключване
 *
 * ИНСТРУКЦИИ ЗА ДЕПЛОЙ:
 *   1. Отворете Google Apps Script проекта (script.google.com)
 *   2. Заменете съдържанието на Code.gs с този файл
 *   3. Запазете и деплойнете като Web App:
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   4. Копирайте новото Web App URL и го поставете в SHEETS_WEB_APP_URL в index.html
 *
 * СТРУКТУРА НА ТАБЛИЦАТА:
 *   Лист "Inspections" — записи на проверки
 *   Лист "Locks"       — активни заключвания (type, location, session_id, expires_at)
 */

var SPREADSHEET_ID   = "17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA";
var RECORDS_SHEET    = "Inspections";
var LOCKS_SHEET      = "Locks";
var LOCK_TTL_MINUTES = 45;

/* ──────────────────────────────────────────────────────────
   Main entry point
   ────────────────────────────────────────────────────────── */
function doPost(e) {
  var output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    var body = (e.postData && e.postData.contents) ? e.postData.contents : "{}";
    var data = JSON.parse(body);
    var result;

    if (data.action === "acquireLock") {
      result = acquireLock_(data.type, data.location, data.session_id);
    } else if (data.action === "releaseLock") {
      result = releaseLock_(data.session_id);
    } else if (data.record) {
      result = writeRecord_(data.record);
    } else {
      result = { success: false, error: "Unknown action" };
    }

    output.setContent(JSON.stringify(result));
  } catch (err) {
    output.setContent(JSON.stringify({ success: false, error: err.message }));
  }

  return output;
}

/* ──────────────────────────────────────────────────────────
   Record writing
   ────────────────────────────────────────────────────────── */
function writeRecord_(record) {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(RECORDS_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(RECORDS_SHEET);
    sheet.appendRow(["ID", "Дата/Час", "Тип/Локация", "Проверяващ", "Статус", "Проблеми", "Бележки"]);
    sheet.setFrozenRows(1);
  }

  try {
    /* Изграждаме стойностите от raw record обекта */
    var issues     = (record.items || []).filter(function(i) { return i.status === "dirty"; });
    var issueLabel = issues.length ? issues.map(function(i) { return i.label; }).join(", ") : "";
    var status     = issues.length ? "МРЪСНА" : "ЧИСТА";
    var config     = record.type === "bathroom" ? "Санитарен Възел" : "Кинозала";
    var typeLabel  = config + " - " + (record.location || "");

    sheet.appendRow([
      String(record.id || ""),
      record.timestamp ? Utilities.formatDate(new Date(record.timestamp), Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm") : "",
      typeLabel,
      record.inspector || "",
      status,
      issueLabel,
      record.notes || "",
    ]);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* ──────────────────────────────────────────────────────────
   Lock helpers
   ────────────────────────────────────────────────────────── */

/** Връща (и при нужда създава) листа "Locks". */
function ensureLocksSheet_() {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(LOCKS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LOCKS_SHEET);
    sheet.appendRow(["type", "location", "session_id", "expires_at"]);
    sheet.setFrozenRows(1);
    /* Форматираме колона expires_at като число за лесно сравнение */
    sheet.getRange("D:D").setNumberFormat("0");
  }
  return sheet;
}

/** Изтрива редове с изтекло expires_at (Unix ms). */
function cleanExpiredLocks_(sheet) {
  var now  = Date.now();
  var data = sheet.getDataRange().getValues();
  /* Итерираме отзад напред, за да не изместваме индексите при изтриване */
  for (var i = data.length - 1; i >= 1; i--) {
    var exp = Number(data[i][3]);
    if (!exp || exp < now) {
      sheet.deleteRow(i + 1);
    }
  }
}

/* ──────────────────────────────────────────────────────────
   acquireLock
   ────────────────────────────────────────────────────────── */
/**
 * Заявява заключване на type+location за дадена сесия.
 *
 * Връща:
 *   { success: true }                        — заключването е заявено
 *   { success: false, error: "locked", ... } — локацията е вече заета
 *   { success: false, error: <msg> }         — грешка
 */
function acquireLock_(type, location, sessionId) {
  if (!type || !location || !sessionId) {
    return { success: false, error: "Missing parameters" };
  }

  /* Използваме Apps Script lock, за да предотвратим race conditions
     при едновременно сканиране от двама служители */
  var scriptLock = LockService.getScriptLock();
  try {
    scriptLock.waitLock(5000);
  } catch (e) {
    return { success: false, error: "Service busy, please try again" };
  }

  try {
    var sheet = ensureLocksSheet_();
    cleanExpiredLocks_(sheet);

    var data = sheet.getDataRange().getValues();
    var now  = Date.now();

    for (var i = 1; i < data.length; i++) {
      var rowType   = String(data[i][0]);
      var rowLoc    = String(data[i][1]);
      var rowSid    = String(data[i][2]);
      var rowExp    = Number(data[i][3]);

      if (rowType === type && rowLoc === location && rowExp > now) {
        if (rowSid !== sessionId) {
          /* Локацията е заета от друга сесия */
          return { success: false, error: "locked", location: location };
        }
        /* Същата сесия се reconnecтва (reload) — подновяваме expires_at */
        sheet.getRange(i + 1, 4).setValue(now + LOCK_TTL_MINUTES * 60 * 1000);
        return { success: true, renewed: true };
      }
    }

    /* Локацията е свободна — добавяме нов ред */
    sheet.appendRow([type, location, sessionId, now + LOCK_TTL_MINUTES * 60 * 1000]);
    return { success: true };

  } finally {
    scriptLock.releaseLock();
  }
}

/* ──────────────────────────────────────────────────────────
   releaseLock
   ────────────────────────────────────────────────────────── */
/**
 * Освобождава заключването за дадена session_id.
 * Безопасно е да се извика многократно (идемпотентно).
 */
function releaseLock_(sessionId) {
  if (!sessionId) {
    return { success: false, error: "Missing session_id" };
  }

  var sheet = ensureLocksSheet_();
  var data  = sheet.getDataRange().getValues();

  /* Итерираме отзад напред при изтриване */
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][2]) === sessionId) {
      sheet.deleteRow(i + 1);
    }
  }

  return { success: true };
}
