/**
 * Location Inspection Locks
 * Блокиране на дублирани проверки – lock на локация
 *
 * Добави този файл към съществуващия Google Apps Script проект и интегрирай
 * в doPost (виж инструкциите по-долу).
 *
 * Endpoints:
 * - acquireLock: type, location, sessionId → OK или грешка ако локацията е заета
 * - releaseLock: sessionId → премахва lock-а
 *
 * Timeout: 45 минути – изтеклите locks се игнорират автоматично.
 */

var LOCK_TIMEOUT_MINUTES = 45;
var LOCKS_SHEET_NAME = "Locks";

/**
 * Връща листа "Locks", създава го ако не съществува.
 */
function getLocksSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOCKS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOCKS_SHEET_NAME);
    sheet.appendRow(["type", "location", "session_id", "expires_at"]);
    sheet.getRange("A1:D1").setFontWeight("bold");
  }
  return sheet;
}

/**
 * Изчиства изтеклите locks от листа.
 */
function cleanupExpiredLocks(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return;
  var now = new Date().getTime();
  var rowsToDelete = [];
  for (var i = 1; i < data.length; i++) {
    var expiresAt = data[i][3];
    if (expiresAt && new Date(expiresAt).getTime() < now) {
      rowsToDelete.push(i + 1); // 1-based row index
    }
  }
  for (var j = rowsToDelete.length - 1; j >= 0; j--) {
    sheet.deleteRow(rowsToDelete[j]);
  }
}

/**
 * Проверява дали локацията (type + location) е свободна.
 * Игнорира изтеклите locks.
 */
function isLocationFree(sheet, type, location) {
  var data = sheet.getDataRange().getValues();
  var now = new Date().getTime();
  for (var i = 1; i < data.length; i++) {
    var rowType = data[i][0];
    var rowLoc = data[i][1];
    var expiresAt = data[i][3];
    if (String(rowType) === String(type) && String(rowLoc) === String(location)) {
      if (expiresAt && new Date(expiresAt).getTime() >= now) {
        return false; // активен lock
      }
    }
  }
  return true;
}

/**
 * Добавя lock за type + location + sessionId.
 */
function addLock(sheet, type, location, sessionId) {
  var expiresAt = new Date(Date.now() + LOCK_TIMEOUT_MINUTES * 60 * 1000);
  sheet.appendRow([type, location, sessionId, expiresAt]);
}

/**
 * Премахва lock по sessionId.
 */
function removeLockBySessionId(sheet, sessionId) {
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][2]) === String(sessionId)) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

/**
 * acquireLock – при стартиране на проверка.
 * Параметри: type, location, sessionId
 * Връща: { ok: true } или { ok: false, error: "..." }
 */
function handleAcquireLock(params) {
  var type = params.type || "";
  var location = params.location || "";
  var sessionId = params.sessionId || "";
  if (!type || !location || !sessionId) {
    return { ok: false, error: "Липсват type, location или sessionId" };
  }
  var sheet = getLocksSheet();
  cleanupExpiredLocks(sheet);
  if (!isLocationFree(sheet, type, location)) {
    return { ok: false, error: "locked", message: "Локацията вече се проверява. Опитайте след ~" + LOCK_TIMEOUT_MINUTES + " мин." };
  }
  addLock(sheet, type, location, sessionId);
  return { ok: true };
}

/**
 * releaseLock – при изпращане на проверка или изход.
 * Параметри: sessionId
 * Връща: { ok: true } или { ok: false, error: "..." }
 */
function handleReleaseLock(params) {
  var sessionId = params.sessionId || "";
  if (!sessionId) {
    return { ok: false, error: "Липсва sessionId" };
  }
  var sheet = getLocksSheet();
  cleanupExpiredLocks(sheet);
  removeLockBySessionId(sheet, sessionId);
  return { ok: true };
}
