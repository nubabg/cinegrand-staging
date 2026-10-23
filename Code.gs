// ========================================================
// CG CLAN INFO - Google Apps Script
// Основен скрипт: получава данни от сайта + автоматизация
// ========================================================

// ── Shared secret — трябва да съвпада с SHEETS_SECRET_TOKEN в index.html ──
var SECRET_TOKEN = "cg-2025-secret-token";

// ── Lock constants ──
var LOCK_SHEET_NAME = "Locks";
var LOCK_TIMEOUT_MIN = 10;
var LOCK_SPREADSHEET_ID = "1UDZQAZU2WAs8G6Yh_II-PZp_0oTj6kGj__b8qecgMAU";

// ── Лист „Почистване съблекални" ──
var CHANGING_ROOMS_SHEET = "Почистване съблекални";

/**
 * Търси лист по име, толерантно към разлики в регистър и излишни интервали
 * (напр. „Почистване  съблекални " след ръчно преименуване в таблицата).
 */
function getSheetLoose_(ss, name) {
  var exact = ss.getSheetByName(name);
  if (exact) return exact;
  var norm = function (s) { return String(s).replace(/\s+/g, " ").trim().toLowerCase(); };
  var want = norm(name);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (norm(sheets[i].getName()) === want) return sheets[i];
  }
  return null;
}

// -----------------------------------------------------------
// 1. doGet(e) - четене на данни от таблицата (частен достъп)
// -----------------------------------------------------------
function doGet(e) {
  try {
    var params = e.parameter || {};
    var token  = params._token || "";
    if (token !== SECRET_TOKEN) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: "Unauthorized" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var action = params.action || "getInfo";
    var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");

    if (action === "getInfo") {
      var sheet = ss.getSheetByName("ИНФО") || ss.getSheetByName("Sheet1") || ss.getSheets()[0];
      // limit=N връща само заглавния ред плюс последните N записа.
      // Началният екран има нужда единствено от скорошното, а листът расте
      // без край — без ограничение всяко зареждане на сайта четеше и
      // сериализираше цялата история.
      var limit = parseInt(params.limit || "0", 10);
      var lastRow = sheet.getLastRow();
      var lastCol = sheet.getLastColumn();
      var data, limited = false;
      if (limit > 0 && lastCol > 0 && lastRow > limit + 1) {
        var header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues();
        var body   = sheet.getRange(lastRow - limit + 1, 1, limit, lastCol).getDisplayValues();
        data = header.concat(body);
        limited = true;
      } else {
        data = infoAll_(sheet);
      }
      // limited казва на клиента, че липсва история — само тогава той си
      // дърпа пълния лист, когато потребителят отвори „Данни".
      // total — колко непразни записа има в листа; клиентът сверява, че е
      // получил всичките (само при пълен лист — при limit няма смисъл).
      var total = null;
      if (!limited) {
        total = 0;
        for (var r = 1; r < data.length; r++) {
          if (data[r].some(function (v) { return v !== ""; })) total++;
        }
      }
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, data: data, limited: limited, total: total }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "ping") {
      // Лек warmup — само събужда скрипта, без да чете листове.
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, pong: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "getChangingRooms") {
      var sheet = getSheetLoose_(ss, CHANGING_ROOMS_SHEET);
      if (!sheet) {
        return ContentService
          .createTextOutput(JSON.stringify({ success: false, error: "Sheet not found" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var data = sheet.getDataRange().getDisplayValues();
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, data: data }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: "Unknown action" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
// -----------------------------------------------------------
// Основна база на ИНФО в кеша
// -----------------------------------------------------------
// Целият лист се чете бавно (над 30 с), а старите проверки не се менят.
// Затова копие на листа стои в кеша на Apps Script до 6 часа, а при всяка
// заявка от таблицата се дочитат само новите редове плюс последните
// INFO_SNAP_RECHECK (ако някой е поправил скорошен ред на ръка). Целият лист
// се чете само когато копието липсва — най-много веднъж на 6 часа.
var INFO_SNAP_TTL = 21600;
var INFO_SNAP_RECHECK = 30;
var INFO_SNAP_PART = 40000;   // знаци на парче (кешът побира до 100 KB на ключ)

function infoSnapRead_(cache) {
  var meta = cache.get("info_snap_meta");
  if (!meta) return null;
  try { meta = JSON.parse(meta); } catch (_) { return null; }
  var keys = [];
  for (var i = 0; i < meta.parts; i++) keys.push("info_snap_" + meta.id + "_" + i);
  var got = keys.length ? cache.getAll(keys) : {}, rows = [];
  for (var k = 0; k < keys.length; k++) {
    if (!got[keys[k]]) return null;   // част е изтрита от кеша → чете се наново
    rows = rows.concat(JSON.parse(got[keys[k]]));
  }
  if (rows.length !== meta.last - 1) return null;
  return { last: meta.last, cols: meta.cols, rows: rows };
}

function infoSnapWrite_(cache, rows, last, cols) {
  try {
    var id = String(Date.now()), parts = {}, n = 0, chunk = [], size = 0;
    rows.forEach(function (r) {
      var len = JSON.stringify(r).length + 1;
      if (chunk.length && size + len > INFO_SNAP_PART) { parts["info_snap_" + id + "_" + n++] = JSON.stringify(chunk); chunk = []; size = 0; }
      chunk.push(r); size += len;
    });
    if (chunk.length) parts["info_snap_" + id + "_" + n++] = JSON.stringify(chunk);
    cache.putAll(parts, INFO_SNAP_TTL);
    // Описанието се записва последно: докато го няма, старото копие важи.
    cache.put("info_snap_meta", JSON.stringify({ id: id, parts: n, last: last, cols: cols }), INFO_SNAP_TTL);
  } catch (e) { Logger.log("infoSnapWrite_: " + e); }
}

/* Целият лист ИНФО (заглавие + редове) като getDataRange().getDisplayValues(). */
function infoAll_(sheet) {
  var cache = CacheService.getScriptCache();
  var last = sheet.getLastRow(), cols = sheet.getLastColumn();
  if (last < 1 || cols < 1) return [];
  var header = sheet.getRange(1, 1, 1, cols).getDisplayValues();
  if (last < 2) return header;
  var snap = infoSnapRead_(cache);
  // Изтрити редове или нови колони → копието не става, чете се наново.
  if (snap && snap.cols === cols && last >= snap.last) {
    var from = Math.max(2, snap.last - INFO_SNAP_RECHECK + 1);
    var tail = sheet.getRange(from, 1, last - from + 1, cols).getDisplayValues();
    var rows = snap.rows.slice(0, from - 2).concat(tail);
    // Копието се подновява, когато са се натрупали много нови редове.
    if (last - snap.last >= 100) infoSnapWrite_(cache, rows, last, cols);
    return header.concat(rows);
  }
  var body = sheet.getRange(2, 1, last - 1, cols).getDisplayValues();
  infoSnapWrite_(cache, body, last, cols);
  return header.concat(body);
}

// -----------------------------------------------------------
// 2. doPost(e) - получава данни от сайта и записва в ИНФО
// -----------------------------------------------------------
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // ── Проверка на токена ──────────────────────────────────
    if (data._token !== SECRET_TOKEN) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: "Unauthorized" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // ───────────────────────────────────────────────────────

    if (data.action === "acquireLock") return handleAcquireLock_(data);
    if (data.action === "releaseLock") return handleReleaseLock_(data);
    if (data.action === "checkLock") return handleCheckLock_(data);
    if (data.action === "acquireLockFirstFree") return handleAcquireLockFirstFree_(data);
    if (data.action === "updateChangingRoom") return handleUpdateChangingRoom_(data);
    if (data.action === "uploadPhoto") return handleUploadPhoto_(data);
    if (data.action === "getPhotosBySession") return handleGetPhotosBySession_(data);
    // Lost and Found — регистърът на вещите (виж края на файла).
    if (data.action === "lfList") return handleLfList_(data);
    if (data.action === "lfAdd") return handleLfAdd_(data);
    if (data.action === "lfSetStatus") return handleLfSetStatus_(data);
    if (data.action === "lfDelete") return handleLfDelete_(data);
    if (data.action === "lfAdminCheck") return handleLfAdminCheck_(data);
    // Задачи (виж края на файла).
    if (data.action === "tasksStaff") return handleTasksStaff_(data);
    if (data.action === "tasksMine") return handleTasksMine_(data);
    if (data.action === "tasksComplete") return handleTasksComplete_(data);
    if (data.action === "tasksLogin") return handleTasksLogin_(data);
    if (data.action === "tasksAdminList") return handleTasksAdminList_(data);
    if (data.action === "tasksCreate") return handleTasksCreate_(data);
    if (data.action === "tasksRate") return handleTasksRate_(data);
    if (data.action === "tasksCancel") return handleTasksCancel_(data);
    if (data.action === "tasksBoard") return handleTasksBoard_(data);
    if (data.action === "tasksSetStatus") return handleTasksSetStatus_(data);
    if (data.action === "tasksNote") return handleTasksNote_(data);
    if (data.action === "tasksStaffSeed") return handleTasksStaffSeed_(data);
    if (data.action === "tasksStaffSave") return handleTasksStaffSave_(data);
    if (data.action === "tasksStaffAdd") return handleTasksStaffAdd_(data);
    if (data.action === "tasksPhotos") return handleTasksPhotos_(data);
    if (data.action === "tasksOverview") return handleTasksOverview_(data);
    if (data.action === "tasksLog") return handleTasksLog_(data);
    if (data.action === "tasksDossier") return handleTasksDossier_(data);
    if (data.action === "tasksDossierSave") return handleTasksDossierSave_(data);
    if (data.action === "tasksProfile") return handleTasksProfile_(data);
    if (data.action === "tasksProfileSave") return handleTasksProfileSave_(data);
    if (data.action === "tasksStaffPhoto") return handleTasksStaffPhoto_(data);
    if (data.action === "tasksStaffRemove") return handleTasksStaffRemove_(data);

    return handleRecord_(data);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
// -----------------------------------------------------------
// Запис на проверка в ИНФО
// -----------------------------------------------------------
// Скрит лист с уникалните номера на вече записаните проверки. Приложението
// праща всяка проверка с номер (uid) и я праща пак, ако не е получило
// потвърждение — тук повторението се разпознава и не прави втори ред.
var SYNC_SHEET_NAME = "_CG_SYNC";
var SYNC_SCAN_ROWS = 5000;

function syncSheet_(ss) {
  var sh = ss.getSheetByName(SYNC_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SYNC_SHEET_NAME);
    sh.getRange(1, 1, 1, 4).setValues([["uid", "ред в ИНФО", "№", "записано"]]);
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
  }
  return sh;
}

function syncFind_(sh, uid) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var n = Math.min(last - 1, SYNC_SCAN_ROWS);
  var vals = sh.getRange(last - n + 1, 1, n, 3).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]) === uid) return { row: vals[i][1], recordNumber: vals[i][2] };
  }
  return null;
}

// Текст, който започва с „=", таблицата би приела за формула.
function sheetText_(v) {
  var s = String(v == null ? "" : v);
  return /^[=]/.test(s) ? "'" + s : s;
}

function handleRecord_(data) {
  var record = data.record;
  if (!record || typeof record !== "object") {
    return jsonResponse_({ success: false, error: "Липсва запис за проверка." });
  }
  var uid = /^[A-Za-z0-9-]{6,60}$/.test(String(record.uid || "")) ? String(record.uid) : "";
  var cache = CacheService.getScriptCache();
  if (uid) {
    var hit = cache.get("rec_" + uid);
    if (hit) {
      var h = JSON.parse(hit);
      return jsonResponse_({ success: true, duplicate: true, idem: true, uid: uid, row: h.row, recordNumber: h.recordNumber });
    }
  }

  var issues = [];
  var allClean = true;
  if (record.items && record.items.length > 0) {
    for (var i = 0; i < record.items.length; i++) {
      if (record.items[i].status === "dirty") {
        allClean = false;
        issues.push(record.items[i].label);
      }
    }
  }
  var status = allClean ? "Чисто" : "Проблем";
  var issuesText = issues.length > 0 ? issues.join(", ") : "—";
  var notes = record.notes || "—";
  var date = new Date(record.timestamp);
  if (isNaN(date.getTime())) date = new Date();
  var dateStr = Utilities.formatDate(date, "Europe/Sofia", "dd.MM.yyyy HH:mm");
  var typeText = record.type === "hall"
    ? "Кинозала - " + record.location
    : "Тоалетна - " + record.location;
  // Колона 8: линк(ове) към снимка/снимки (ако има)
  var photoUrls = [];
  if (record.photoUrls && record.photoUrls.length) {
    photoUrls = record.photoUrls;
  } else if (record.photoUrl) {
    photoUrls = [record.photoUrl];
  }
  var q = function (s) { return String(s).replace(/"/g, '""'); };
  var photoCell = "—";
  if (photoUrls.length === 1) {
    photoCell = '=HYPERLINK("' + q(photoUrls[0]) + '";"📷 Виж снимка")';
  } else if (photoUrls.length > 1) {
    photoCell = '=HYPERLINK("' + q(photoUrls[0]) + '";"📷 ' + photoUrls.length + ' снимки")';
  }

  // Без заключване две едновременни проверки четат един и същ последен ред
  // и втората презаписва първата.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
    var sheet = ss.getSheetByName("ИНФО") || ss.getSheetByName("Sheet1") || ss.getSheets()[0];
    var sync = uid ? syncSheet_(ss) : null;
    if (uid) {
      var found = syncFind_(sync, uid);
      if (found) {
        cache.put("rec_" + uid, JSON.stringify(found), 21600);
        return jsonResponse_({ success: true, duplicate: true, idem: true, uid: uid, row: found.row, recordNumber: found.recordNumber });
      }
    }
    var lastRow = sheet.getLastRow();
    var nextRow = lastRow < 1 ? 2 : lastRow + 1;
    var recordNumber = nextRow - 1;
    sheet.getRange(nextRow, 1, 1, 8).setValues([[
      recordNumber, dateStr, sheetText_(typeText), sheetText_(record.inspector),
      status, sheetText_(issuesText), sheetText_(notes), photoCell
    ]]);
    if (photoUrls.length > 1) sheet.getRange(nextRow, 8).setNote(photoUrls.join("\n"));
    styleInfoRow(sheet, nextRow, status);
    if (uid) {
      sync.appendRow([uid, nextRow, recordNumber,
        Utilities.formatDate(new Date(), "Europe/Sofia", "dd.MM.yyyy HH:mm:ss")]);
    }
    // Редът трябва да е в таблицата, преди следващата заявка да види
    // getLastRow() — иначе заключването не пази от нищо.
    SpreadsheetApp.flush();
    if (uid) cache.put("rec_" + uid, JSON.stringify({ row: nextRow, recordNumber: recordNumber }), 21600);
    return jsonResponse_({ success: true, idem: true, uid: uid, row: nextRow, recordNumber: recordNumber });
  } finally {
    lock.releaseLock();
  }
}

// -----------------------------------------------------------
// 2. styleInfoRow - форматира един ред в ИНФО автоматично
// -----------------------------------------------------------
function styleInfoRow(sheet, row, status) {
  // Всичко с по една заявка за целия ред: досега бяха ~20 отделни извиквания
  // плюс едно четене по средата, което ги принуждаваше да се изпратят веднага.
  try {
    if (status === undefined) status = sheet.getRange(row, 5).getValue();
    var range = sheet.getRange(row, 1, 1, 8);
    // Редуване на цветове: четни = тъмно синьо, нечетни = малко по-светло
    var bgColor = (row % 2 === 0) ? "#1a2744" : "#1e3054";
    var bg = [], fc = [], fw = [], ha = [];
    for (var c = 0; c < 8; c++) { bg.push(bgColor); fc.push("#FFFFFF"); fw.push("normal"); ha.push("center"); }
    ha[5] = "left"; ha[6] = "left";              // ПРОБЛЕМИ и БЕЛЕЖКИ - ляво
    fc[7] = "#4da6ff"; fw[7] = "bold";            // СНИМКА линк - синьо
    if (status === "Чисто") { bg[4] = "#1b5e20"; fc[4] = "#a5d6a7"; fw[4] = "bold"; }
    else if (status === "Проблем") { bg[4] = "#b71c1c"; fc[4] = "#ffcdd2"; fw[4] = "bold"; }
    range.setBackgrounds([bg]).setFontColors([fc]).setFontWeights([fw]).setHorizontalAlignments([ha])
      .setFontFamily("Arial").setFontSize(10).setVerticalAlignment("middle")
      .setBorder(true, true, true, true, true, true, "#2d4a7a", SpreadsheetApp.BorderStyle.SOLID);
    sheet.getRange(row, 6, 1, 2).setWrap(true);   // Wrap text за ПРОБЛЕМИ и БЕЛЕЖКИ
    sheet.setRowHeight(row, 40);
  } catch(err) {
    Logger.log("styleInfoRow error: " + err.toString());
  }
}

// -----------------------------------------------------------
// setupInfoHeaders - добавя хедър "СНИМКА" в колона 8
// -----------------------------------------------------------
function setupInfoHeaders() {
  var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
  var sheet = ss.getSheetByName("ИНФО") || ss.getSheetByName("Sheet1") || ss.getSheets()[0];
  // Проверка дали има хедър в колона 8
  var existingHeader = sheet.getRange(1, 8).getValue();
  if (!existingHeader || existingHeader === "") {
    sheet.getRange(1, 8).setValue("СНИМКА");
    // Форматиране на хедъра (съвпада с останалите)
    var headerCell = sheet.getRange(1, 8);
    headerCell.setBackground("#1A1A1A");
    headerCell.setFontColor("#C9A84C");
    headerCell.setFontFamily("Arial");
    headerCell.setFontSize(11);
    headerCell.setFontWeight("bold");
    headerCell.setVerticalAlignment("middle");
    headerCell.setHorizontalAlignment("center");
    headerCell.setBorder(true, true, true, true, true, true, "#C9A84C", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  }
  // Задаване на ширина на колона 8
  sheet.setColumnWidth(8, 140);
  Logger.log("✅ Хедър СНИМКА добавен в колона 8.");
}
// -----------------------------------------------------------
// 3. onEditHandler - тригер при ръчно редактиране в ИНФО
// -----------------------------------------------------------
function onEditHandler(e) {
  try {
    var sheet = e.source.getActiveSheet();
    var sheetName = sheet.getName();
    // Работи само в ИНФО листа
    if (sheetName !== "ИНФО" && sheetName !== "Sheet1") return;
    var row = e.range.getRow();
    if (row < 2) return; // Не форматира хедъра
    // Форматира само ако е попълнен ред (поне колона 1 или 2 не е празна)
    var firstCell = sheet.getRange(row, 1).getValue();
    var secondCell = sheet.getRange(row, 2).getValue();
    if (!firstCell && !secondCell) return;
    styleInfoRow(sheet, row);
  } catch(err) {
    Logger.log("onEditHandler error: " + err.toString());
  }
}
// -----------------------------------------------------------
// 4. setupStatisticsSheet - еднократна настройка (run once!)
// -----------------------------------------------------------
function setupStatisticsSheet() {
  var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
  // Намери или създай СТАТИСТИКА sheet
  var statSheet = ss.getSheetByName("СТАТИСТИКА");
  if (!statSheet) {
    statSheet = ss.insertSheet("СТАТИСТИКА");
  } else {
    statSheet.clearContents();
    statSheet.clearFormats();
  }
  var infoSheet = ss.getSheetByName("ИНФО") || ss.getSheetByName("Sheet1") || ss.getSheets()[0];
  var infoName = infoSheet.getName();
  // --- БЛОК 1: ПРОВЕРЯВАЩИ ---
  var h1 = statSheet.getRange("A1");
  h1.setValue("ПРОВЕРЯВАЩИ — Брой проверки по служител");
  h1.setBackground("#1a2744");
  h1.setFontColor("#ffffff");
  h1.setFontWeight("bold");
  h1.setFontSize(11);
  statSheet.getRange("A1:C1").merge().setBackground("#1a2744");
  statSheet.getRange("A2").setValue("Служител");
  statSheet.getRange("B2").setValue("Брой проверки");
  statSheet.getRange("A2:B2").setBackground("#2d4a7a").setFontColor("#ffffff").setFontWeight("bold");
  // COUNTIF формула за всеки уникален проверяващ — QUERY
  statSheet.getRange("A3").setFormula(
    '=IFERROR(QUERY(' + infoName + '!D2:D,"SELECT D, COUNT(D) WHERE D <> \"\" GROUP BY D ORDER BY COUNT(D) DESC LABEL D \"Служител\", COUNT(D) \"Брой проверки\"",0),{"Няма данни",""})'
  );
  // --- БЛОК 2: ПРОБЛЕМИ ---
  var h2 = statSheet.getRange("A20");
  h2.setValue("ТОП ПРОБЛЕМИ — Най-чести отбелязани проблеми");
  h2.setBackground("#1a2744");
  h2.setFontColor("#ffffff");
  h2.setFontWeight("bold");
  h2.setFontSize(11);
  statSheet.getRange("A20:C20").merge().setBackground("#1a2744");
  statSheet.getRange("A21").setValue("Проблем");
  statSheet.getRange("B21").setValue("Брой пъти");
  statSheet.getRange("A21:B21").setBackground("#2d4a7a").setFontColor("#ffffff").setFontWeight("bold");
  statSheet.getRange("A22").setFormula(
    '=IFERROR(QUERY(' + infoName + '!F2:F,"SELECT F, COUNT(F) WHERE F <> \"\" AND F <> \"—\" GROUP BY F ORDER BY COUNT(F) DESC LABEL F \"Проблем\", COUNT(F) \"Брой пъти\"",0),{"Няма данни",""})'
  );
  // --- БЛОК 3: ЧЕСТОТА ПО ДАТА ---
  var h3 = statSheet.getRange("A40");
  h3.setValue("ЧЕСТОТА — Брой проверки по дата");
  h3.setBackground("#1a2744");
  h3.setFontColor("#ffffff");
  h3.setFontWeight("bold");
  h3.setFontSize(11);
  statSheet.getRange("A40:C40").merge().setBackground("#1a2744");
  statSheet.getRange("A41").setValue("Дата");
  statSheet.getRange("B41").setValue("Брой проверки");
  statSheet.getRange("A41:B41").setBackground("#2d4a7a").setFontColor("#ffffff").setFontWeight("bold");
  statSheet.getRange("A42").setFormula(
    '=IFERROR(QUERY(ARRAYFORMULA(IF(' + infoName + '!B2:B="","",LEFT(' + infoName + '!B2:B,10))),"SELECT Col1, COUNT(Col1) WHERE Col1 <> \"\" GROUP BY Col1 ORDER BY Col1 DESC LABEL Col1 \"Дата\", COUNT(Col1) \"Брой проверки\"",0),{"Няма данни",""})'
  );
  // --- БЛОК 4: ОБОБЩЕНИЕ ---
  var h4 = statSheet.getRange("D1");
  h4.setValue("ОБОБЩЕНИЕ");
  h4.setBackground("#1a2744");
  h4.setFontColor("#ffffff");
  h4.setFontWeight("bold");
  h4.setFontSize(11);
  statSheet.getRange("D1:E1").merge().setBackground("#1a2744");
  statSheet.getRange("D2").setValue("Общо проверки:");
  statSheet.getRange("E2").setFormula('=COUNTA(' + infoName + '!A2:A)');
  statSheet.getRange("D3").setValue("Чисто:");
  statSheet.getRange("E3").setFormula('=COUNTIF(' + infoName + '!E2:E,"Чисто")');
  statSheet.getRange("D4").setValue("С проблем:");
  statSheet.getRange("E4").setFormula('=COUNTIF(' + infoName + '!E2:E,"Проблем")');
  statSheet.getRange("D5").setValue("% Чисто:");
  statSheet.getRange("E5").setFormula('=IFERROR(E3/E2*100,0)&"%"');
  statSheet.getRange("D2:E5").setBackground("#1e3054").setFontColor("#ffffff");
  statSheet.getRange("D2:D5").setFontWeight("bold");
  // Форматиране на СТАТИСТИКА sheet
  statSheet.setColumnWidth(1, 220);
  statSheet.setColumnWidth(2, 140);
  statSheet.setColumnWidth(3, 80);
  statSheet.setColumnWidth(4, 160);
  statSheet.setColumnWidth(5, 100);
  // --- ДИАГРАМА 1: Проверяващи (Bar) ---
  try {
    var charts = statSheet.getCharts();
    for (var c = 0; c < charts.length; c++) {
      statSheet.removeChart(charts[c]);
    }
  } catch(e) {}
  var chartRange1 = statSheet.getRange("A2:B17");
  var chart1 = statSheet.newChart()
    .setChartType(Charts.ChartType.BAR)
    .addRange(chartRange1)
    .setPosition(1, 6, 0, 0)
    .setOption("title", "Проверки по служител")
    .setOption("width", 450)
    .setOption("height", 300)
    .setOption("legend", {position: "none"})
    .setOption("colors", ["#4a90d9"])
    .build();
  statSheet.insertChart(chart1);
  // --- ДИАГРАМА 2: Проблеми (Pie) ---
  var chartRange2 = statSheet.getRange("A21:B35");
  var chart2 = statSheet.newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(chartRange2)
    .setPosition(12, 6, 0, 0)
    .setOption("title", "Топ проблеми")
    .setOption("width", 450)
    .setOption("height", 300)
    .setOption("pieHole", 0.4)
    .build();
  statSheet.insertChart(chart2);
  // --- ДИАГРАМА 3: Честота (Column) ---
  var chartRange3 = statSheet.getRange("A41:B55");
  var chart3 = statSheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(chartRange3)
    .setPosition(23, 6, 0, 0)
    .setOption("title", "Честота на проверките по дата")
    .setOption("width", 450)
    .setOption("height", 300)
    .setOption("colors", ["#2e7d32"])
    .build();
  statSheet.insertChart(chart3);
  Logger.log("СТАТИСТИКА sheet setup completed successfully!");
  Logger.log("✅ СТАТИСТИКА sheet е настроен успешно! Формулите ще се обновяват автоматично.");
}
// -----------------------------------------------------------
// 5. installTriggers - инсталира тригерите (run once!)
// -----------------------------------------------------------
function installTriggers() {
  var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
  // Изтриване на стари onEdit тригери за да не се дублират
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "onEditHandler") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Инсталиране на нов onEdit тригер
  ScriptApp.newTrigger("onEditHandler")
    .forSpreadsheet(ss)
    .onEdit()
    .create();
  Logger.log("Trigger onEditHandler installed successfully!");
  Logger.log("✅ Тригерът е инсталиран! Вече всеки нов ред ще се форматира автоматично.");
}
// -----------------------------------------------------------
// 6. formatInfoSheetFull - форматира всички съществуващи редове
// -----------------------------------------------------------
function formatInfoSheetFull() {
  var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
  var sheet = ss.getSheetByName("ИНФО") || ss.getSheetByName("Sheet1") || ss.getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("No data rows to format.");
    return;
  }
  for (var r = 2; r <= lastRow; r++) {
    var firstCell = sheet.getRange(r, 1).getValue();
    var secondCell = sheet.getRange(r, 2).getValue();
    if (firstCell || secondCell) {
      styleInfoRow(sheet, r);
    }
  }
  // Ширини на колоните
  sheet.setColumnWidth(1, 80);   // НОМЕР
  sheet.setColumnWidth(2, 140);  // ДАТА/ЧАС
  sheet.setColumnWidth(3, 150);  // ТИП
  sheet.setColumnWidth(4, 120);  // ПРОВЕРЯВАЩ
  sheet.setColumnWidth(5, 90);   // СТАТУС
  sheet.setColumnWidth(6, 220);  // ПРОБЛЕМИ
  sheet.setColumnWidth(7, 180);  // БЕЛЕЖКИ
  sheet.setColumnWidth(8, 140);  // СНИМКА
  Logger.log("formatInfoSheetFull completed for " + (lastRow - 1) + " rows.");
  Logger.log("✅ Всички редове са форматирани!");
}
// --------------------------------------------------------
// 7. applyProfessionalDesign - Корпоративен дизайн на таблицата
// --------------------------------------------------------
function applyProfessionalDesign() {
  var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
  var sheet = ss.getSheetByName("ИНФО") || ss.getSheetByName("Sheet1") || ss.getSheets()[0];
  var lastRow = sheet.getLastRow();
  var totalRows = Math.max(lastRow, 50);
  var COLOR_HEADER_BG   = "#1A1A1A";
  var COLOR_HEADER_TEXT = "#C9A84C";
  var COLOR_ROW_ODD     = "#0D0D0D";
  var COLOR_ROW_EVEN    = "#1C1C1C";
  var COLOR_TEXT        = "#E8E8E8";
  var COLOR_BORDER      = "#C9A84C";
  var COLOR_BORDER_INNER= "#333333";
  var COLOR_STATUS_OK   = "#1A3A1A";
  var COLOR_STATUS_ERR  = "#3A1A1A";
  var COLOR_STATUS_OK_TEXT  = "#4CAF50";
  var COLOR_STATUS_ERR_TEXT = "#F44336";
  var headerRange = sheet.getRange(1, 1, 1, 8);
  headerRange.setBackground(COLOR_HEADER_BG);
  headerRange.setFontColor(COLOR_HEADER_TEXT);
  headerRange.setFontFamily("Arial");
  headerRange.setFontSize(11);
  headerRange.setFontWeight("bold");
  headerRange.setVerticalAlignment("middle");
  headerRange.setHorizontalAlignment("center");
  headerRange.setBorder(true, true, true, true, true, true, COLOR_BORDER, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.setRowHeight(1, 40);
  // Добавяне на "СНИМКА" хедър ако липсва
  if (!sheet.getRange(1, 8).getValue()) {
    sheet.getRange(1, 8).setValue("СНИМКА");
  }
  for (var r = 2; r <= totalRows; r++) {
    var rowRange = sheet.getRange(r, 1, 1, 8);
    var bgColor = (r % 2 === 0) ? COLOR_ROW_EVEN : COLOR_ROW_ODD;
    rowRange.setBackground(bgColor);
    rowRange.setFontColor(COLOR_TEXT);
    rowRange.setFontFamily("Arial");
    rowRange.setFontSize(10);
    rowRange.setVerticalAlignment("middle");
    rowRange.setFontWeight("normal");
    rowRange.setBorder(true, true, true, true, true, true, COLOR_BORDER_INNER, SpreadsheetApp.BorderStyle.SOLID);
    if (r % 5 === 0) {
      rowRange.setBorder(null, null, true, null, null, null, COLOR_BORDER, SpreadsheetApp.BorderStyle.SOLID);
    }
    sheet.getRange(r, 1, 1, 1).setHorizontalAlignment("center");
    sheet.getRange(r, 2, 1, 1).setHorizontalAlignment("center");
    sheet.getRange(r, 3, 1, 1).setHorizontalAlignment("left");
    sheet.getRange(r, 4, 1, 1).setHorizontalAlignment("center");
    sheet.getRange(r, 5, 1, 1).setHorizontalAlignment("center");
    sheet.getRange(r, 6, 1, 1).setHorizontalAlignment("left");
    sheet.getRange(r, 7, 1, 1).setHorizontalAlignment("left");
    sheet.getRange(r, 8, 1, 1).setHorizontalAlignment("center");
    var statusCell = sheet.getRange(r, 5);
    var statusVal = statusCell.getValue();
    if (statusVal === "Чисто") {
      statusCell.setBackground(COLOR_STATUS_OK);
      statusCell.setFontColor(COLOR_STATUS_OK_TEXT);
      statusCell.setFontWeight("bold");
    } else if (statusVal === "Проблем") {
      statusCell.setBackground(COLOR_STATUS_ERR);
      statusCell.setFontColor(COLOR_STATUS_ERR_TEXT);
      statusCell.setFontWeight("bold");
    }
    sheet.getRange(r, 6, 1, 1).setWrap(true);
    sheet.getRange(r, 7, 1, 1).setWrap(true);
    sheet.setRowHeight(r, 32);
  }
  var fullRange = sheet.getRange(1, 1, totalRows, 8);
  fullRange.setBorder(true, true, true, true, null, null, COLOR_BORDER, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 145);
  sheet.setColumnWidth(3, 160);
  sheet.setColumnWidth(4, 130);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 230);
  sheet.setColumnWidth(7, 190);
  sheet.setColumnWidth(8, 140);
  Logger.log("✅ Корпоративният дизайн е приложен успешно!");
  SpreadsheetApp.getActiveSpreadsheet().toast("✅ Корпоративен дизайн приложен!", "Ciné Grand Style", 5);
}
// --------------------------------------------------------
// 8. applyDesignFull1000 - Cine Grand стил за 1000 реда
// --------------------------------------------------------
function applyDesignFull1000() {
  var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
  var sheet = ss.getSheetByName("ИНФО") || ss.getSheetByName("Sheet1") || ss.getSheets()[0];
  var totalRows = sheet.getMaxRows();
  var HDR_BG = "#1A1A1A";
  var HDR_FG = "#C9A84C";
  var ODD_BG = "#0D0D0D";
  var EVN_BG = "#1C1C1C";
  var ROW_FG = "#E8E8E8";
  var GOLD   = "#C9A84C";
  var INNER  = "#2A2A2A";
  var hdr = sheet.getRange(1, 1, 1, 8);
  hdr.setBackground(HDR_BG);
  hdr.setFontColor(HDR_FG);
  hdr.setFontFamily("Arial");
  hdr.setFontSize(11);
  hdr.setFontWeight("bold");
  hdr.setVerticalAlignment("middle");
  hdr.setHorizontalAlignment("center");
  hdr.setBorder(true, true, true, true, true, true, GOLD, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.setRowHeight(1, 40);
  // Добавяне на "СНИМКА" хедър ако липсва
  if (!sheet.getRange(1, 8).getValue()) {
    sheet.getRange(1, 8).setValue("СНИМКА");
  }
  var allData = sheet.getRange(2, 1, totalRows - 1, 8);
  allData.setBackground(ODD_BG);
  allData.setFontColor(ROW_FG);
  allData.setFontFamily("Arial");
  allData.setFontSize(10);
  allData.setVerticalAlignment("middle");
  allData.setFontWeight("normal");
  allData.setBorder(true, true, true, true, true, true, INNER, SpreadsheetApp.BorderStyle.SOLID);
  for (var r = 3; r <= totalRows; r += 2) {
    sheet.getRange(r, 1, 1, 8).setBackground(EVN_BG);
  }
  sheet.getRange(2, 1, totalRows - 1, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 2, totalRows - 1, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 3, totalRows - 1, 1).setHorizontalAlignment("left");
  sheet.getRange(2, 4, totalRows - 1, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 5, totalRows - 1, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 6, totalRows - 1, 1).setHorizontalAlignment("left");
  sheet.getRange(2, 7, totalRows - 1, 1).setHorizontalAlignment("left");
  sheet.getRange(2, 8, totalRows - 1, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 6, totalRows - 1, 1).setWrap(true);
  sheet.getRange(2, 7, totalRows - 1, 1).setWrap(true);
  sheet.setRowHeightsForced(2, totalRows - 1, 30);
  sheet.getRange(1, 1, totalRows, 8).setBorder(true, true, true, true, null, null, GOLD, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 145);
  sheet.setColumnWidth(3, 160);
  sheet.setColumnWidth(4, 130);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 230);
  sheet.setColumnWidth(7, 190);
  sheet.setColumnWidth(8, 140);
  var lastData = sheet.getLastRow();
  if (lastData >= 2) {
    var sv = sheet.getRange(2, 5, lastData - 1, 1).getValues();
    for (var i = 0; i < sv.length; i++) {
      var v = sv[i][0];
      if (v === "Чисто") {
        sheet.getRange(i + 2, 5).setBackground("#1A3A1A").setFontColor("#4CAF50").setFontWeight("bold");
      } else if (v === "Проблем") {
        sheet.getRange(i + 2, 5).setBackground("#3A1A1A").setFontColor("#F44336").setFontWeight("bold");
      }
    }
  }
  Logger.log("Готово! Форматирани " + totalRows + " реда.");
  SpreadsheetApp.getActiveSpreadsheet().toast("Дизайн приложен на " + totalRows + " реда!", "Cine Grand", 5);
}
// -------------------------------------------------------
// Почистване съблекални — записва ime в колона B или C
// -------------------------------------------------------
function handleUpdateChangingRoom_(data) {
  try {
    var ss    = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
    var sheet = getSheetLoose_(ss, CHANGING_ROOMS_SHEET);
    if (!sheet) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: "Sheet not found" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var row     = parseInt(data.row);   // 1-based row number (от frontend-а)
    var col     = data.col;             // "B" or "C"
    var name    = data.name || "";
    var dateStr = data.dateStr || "";
    // Определи колоната (B=2, C=3)
    var colIndex = (col === "B") ? 2 : 3;
    // Проверката и записът са под заключване — иначе двама едновременно
    // виждат празна клетка и вторият презаписва първия.
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var existing = sheet.getRange(row, colIndex).getValue();
      if (existing && String(existing).trim() !== "") {
        // Повторен опит на същия човек (отговорът на първия се е загубил)
        // е успех, не „вече попълнено".
        if (String(existing).trim() === String(name).trim()) {
          return jsonResponse_({ success: true, row: row, col: col, name: name, duplicate: true });
        }
        return ContentService
          .createTextOutput(JSON.stringify({ success: false, error: "already_filled", existing: existing }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      // Запиши името
      sheet.getRange(row, colIndex).setValue(name);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, row: row, col: col, name: name }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// -------------------------------------------------------
// Качване на снимка в Google Drive и логване в PHOTOS
// -------------------------------------------------------
function handleUploadPhoto_(data) {
  try {
    var photoData = data.photoData;
    var fileName = data.fileName || "photo.jpg";
    var comment = data.comment || "";
    var location = data.location || "";
    var inspector = data.inspector || "";
    var timestamp = data.timestamp || new Date().toISOString();
    var pcSessionId = data.pcSessionId || "";

    if (!photoData || photoData.length === 0) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: "No photo data" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Преобразуване на base64 в blob
    var blob = Utilities.newBlob(Utilities.base64Decode(photoData), "image/jpeg", fileName);

    // Получаване или създаване на папка за снимки
    var folder = getOrCreatePhotosFolder_();
    if (!folder) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: "Failed to create/get photos folder" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Качване на файл в папката
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // Логване на снимката в PHOTOS лист
    var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
    logPhotoToSheet_(ss, file, comment, location, inspector, timestamp, pcSessionId);

    return ContentService
      .createTextOutput(JSON.stringify({
        success: true,
        photoUrl: file.getUrl(),
        fileName: file.getName()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// -------------------------------------------------------
// Получаване на папка за снимки по хардкоднато ID
// -------------------------------------------------------
var PHOTOS_FOLDER_ID = "1upFim6e3ToquhqJl9KO2u_6m9QoZ-Iek";

function getOrCreatePhotosFolder_() {
  try {
    return DriveApp.getFolderById(PHOTOS_FOLDER_ID);
  } catch (error) {
    Logger.log("Error in getOrCreatePhotosFolder_: " + error);
    return null;
  }
}

// -------------------------------------------------------
// Логване на снимка в PHOTOS лист
// -------------------------------------------------------
function logPhotoToSheet_(ss, file, comment, location, inspector, timestamp, pcSessionId) {
  try {
    // Получаване или създаване на PHOTOS лист
    var sheet = ss.getSheetByName("PHOTOS");
    if (!sheet) {
      sheet = ss.insertSheet("PHOTOS");
      // Добавяне на хедъри (включително PC сесия)
      sheet.getRange("A1").setValue("Линк към снимка");
      sheet.getRange("B1").setValue("Дата и час");
      sheet.getRange("C1").setValue("Коментар");
      sheet.getRange("D1").setValue("Локация");
      sheet.getRange("E1").setValue("Инспектор");
      sheet.getRange("F1").setValue("PC сесия");

      // Форматиране на хедър ред
      var headerRange = sheet.getRange("A1:F1");
      headerRange.setBackground("#1a2744");
      headerRange.setFontColor("#FFFFFF");
      headerRange.setFontWeight("bold");
      headerRange.setHorizontalAlignment("center");

      // Настройка на ширини на колони
      sheet.setColumnWidth(1, 400);
      sheet.setColumnWidth(2, 180);
      sheet.setColumnWidth(3, 300);
      sheet.setColumnWidth(4, 150);
      sheet.setColumnWidth(5, 150);
      sheet.setColumnWidth(6, 220);
    } else {
      // Ако листът съществува без F хедър — добави го
      var fHeader = sheet.getRange("F1").getValue();
      if (!fHeader) {
        sheet.getRange("F1").setValue("PC сесия");
        sheet.getRange("F1").setBackground("#1a2744").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
        sheet.setColumnWidth(6, 220);
      }
    }

    // Получаване на последния ред и добавяне на нов запис
    var lastRow = sheet.getLastRow();
    var nextRow = lastRow + 1;

    // Форматиране на дата/час
    var date = new Date(timestamp);
    var dateStr = Utilities.formatDate(date, "Europe/Sofia", "yyyy-MM-dd HH:mm:ss");

    // Записване на данните
    sheet.getRange(nextRow, 1).setValue(file.getUrl());
    sheet.getRange(nextRow, 2).setValue(dateStr);
    sheet.getRange(nextRow, 3).setValue(comment);
    sheet.getRange(nextRow, 4).setValue(location);
    sheet.getRange(nextRow, 5).setValue(inspector);
    sheet.getRange(nextRow, 6).setValue(pcSessionId || "");

    // Форматиране на новия ред
    var dataRange = sheet.getRange(nextRow, 1, 1, 6);
    dataRange.setBackground("#1e3054");
    dataRange.setFontColor("#FFFFFF");
    dataRange.setFontSize(10);
    dataRange.setVerticalAlignment("top");
    dataRange.setWrap(true);

    // Линкът в колона A трябва да е синьо и подчертано
    sheet.getRange(nextRow, 1).setFontColor("#4da6ff");

    Logger.log("Photo logged to PHOTOS sheet: " + file.getName() + " (sid=" + (pcSessionId || "") + ")");
  } catch (error) {
    Logger.log("Error in logPhotoToSheet_: " + error);
  }
}

// -------------------------------------------------------
// Връща всички снимки за дадена PC сесия (за live polling от PC)
// -------------------------------------------------------
function handleGetPhotosBySession_(data) {
  try {
    var pcSessionId = data.pcSessionId || "";
    if (!pcSessionId) return jsonResponse_({ success: false, error: "No pcSessionId" });
    var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
    var sheet = ss.getSheetByName("PHOTOS");
    if (!sheet) return jsonResponse_({ success: true, photos: [] });
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return jsonResponse_({ success: true, photos: [] });
    var values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    var photos = [];
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][5]) === String(pcSessionId)) {
        photos.push({
          url: values[i][0],
          timestamp: values[i][1],
          comment: values[i][2],
          location: values[i][3],
          inspector: values[i][4]
        });
      }
    }
    return jsonResponse_({ success: true, photos: photos });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.toString() });
  }
}

// -------------------------------------------------------
// LOCK FUNCTIONS — управление на заключванията
// -------------------------------------------------------
function getLockSheet_() {
  var ss = SpreadsheetApp.openById(LOCK_SPREADSHEET_ID);
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
  // ОПТИМИЗИРАНО: вместо deleteRow() в цикъл (бавно, N операции, причинява
  // Google timeout/грешки при натоварване) — четем всичко веднъж, филтрираме
  // изтеклите и презаписваме листа с ЕДНА операция.
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return;
  var now = new Date();
  var header = data[0];
  var cols = header.length;
  var keep = [];
  for (var i = 1; i < data.length; i++) {
    var expiresAt = new Date(data[i][4]);
    if (!(now > expiresAt)) keep.push(data[i]); // задръж само НЕизтеклите
  }
  // Ако няма изтекли — не пипай листа (спестява запис)
  if (keep.length === data.length - 1) return;
  // Изчисти старите data редове и презапиши задържаните с една операция
  var oldRows = data.length - 1;
  sheet.getRange(2, 1, oldRows, cols).clearContent();
  if (keep.length > 0) {
    sheet.getRange(2, 1, keep.length, cols).setValues(keep);
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

function handleAcquireLockFirstFree_(data) {
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
    var lockedLocations = {};
    for (var i = 1; i < allData.length; i++) {
      lockedLocations[allData[i][0] + "|" + allData[i][1]] = true;
    }

    var locations = data.locations || [];
    var type = data.type || "";
    var sessionId = data.sessionId || "";
    for (var j = 0; j < locations.length; j++) {
      var loc = locations[j];
      if (!lockedLocations[type + "|" + loc]) {
        var now = new Date();
        var expires = new Date(now.getTime() + LOCK_TIMEOUT_MIN * 60 * 1000);
        sheet.appendRow([type, loc, sessionId, now.toISOString(), expires.toISOString()]);
        lock.releaseLock();
        return jsonResponse_({ success: true, location: loc });
      }
    }

    lock.releaseLock();
    return jsonResponse_({ success: false, allLocked: true, error: "Всички локации са заети." });
  } catch (e) {
    lock.releaseLock();
    return jsonResponse_({ success: false, error: e.message });
  }
}

function handleCheckLock_(data) {
  try {
    var sheet = getLockSheet_();
    cleanExpiredLocks_(sheet);
    var allData = sheet.getDataRange().getValues();
    for (var i = 1; i < allData.length; i++) {
      if (allData[i][2] === data.sessionId) {
        return jsonResponse_({ success: true, valid: true });
      }
    }
    return jsonResponse_({ success: true, valid: false });
  } catch (e) {
    return jsonResponse_({ success: false, error: e.message });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===========================================================
// LOST AND FOUND — регистър на изгубени и намерени вещи
// ===========================================================
// Колоните се намират по заглавие, а не по позиция: листът е оформен ръчно
// и може да се пренарежда. Липсващите служебни колони (Категория, ID,
// Обновено) се добавят сами в края на заглавния ред.
//
// Администраторската парола НЕ стои в кода. Задава се в Apps Script:
// Project Settings → Script properties → LF_ADMIN_PASS. Без нея смяната на
// статус и изтриването са изключени.
var LF_SHEET = "LOST AND FOUND";
var LF_STATUSES = ["Търси се", "Намерена", "Върната"];
var LF_KINDS = ["Изгубена", "Намерена"];
var LF_CATEGORIES = ["Телефон", "Портфейл / документи", "Ключове", "Дрехи", "Чанта / раница",
  "Очила", "Слушалки / електроника", "Бижута / часовник", "Детски вещи", "Чадър", "Друго"];
var LF_MAX_FAILS = 5;            // грешни админ пароли преди заключване
var LF_LOCKOUT_SEC = 600;        // заключване за 10 минути

/* Ред на служебните полета; „header" е заглавието, с което се създава
   колоната, ако я няма. „match" разпознава съществуващо заглавие. */
var LF_FIELDS = [
  { key: "employee",  header: "Име служител",                      match: function (h) { return h.indexOf("служител") !== -1; } },
  { key: "date",      header: "Дата",                              match: function (h) { return h === "дата"; } },
  { key: "time",      header: "Час",                               match: function (h) { return h === "час"; } },
  { key: "kind",      header: "Изгубена или намерена",             match: function (h) { return h.indexOf("изгубена") === 0; } },
  { key: "item",      header: "Вещ, белези, цвят и марка",         match: function (h) { return h.indexOf("вещ") === 0; } },
  { key: "location",  header: "Локация подробно",                  match: function (h) { return h.indexOf("локация") === 0; } },
  { key: "screening", header: "Прожекция: заглавие, зала и час",   match: function (h) { return h.indexOf("заглавие") !== -1; } },
  { key: "contact",   header: "Контакти клиент",                   match: function (h) { return h.indexOf("контакт") === 0; } },
  { key: "status",    header: "Статус Търси се/Намерена/Върната",  match: function (h) { return h.indexOf("статус") === 0; } },
  { key: "photo",     header: "Снимка на загубена вещ",            match: function (h) { return h.indexOf("снимка") === 0; } },
  { key: "category",  header: "Категория",                         match: function (h) { return h.indexOf("категория") === 0; } },
  { key: "id",        header: "ID",                                match: function (h) { return h === "id"; } },
  { key: "updated",   header: "Обновено",                          match: function (h) { return h.indexOf("обновено") === 0; } }
];

function lfNorm_(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); }

/* Листът и картата „поле → номер на колона" (1-базиран). Добавя липсващите
   колони. Викай под LockService, защото може да пише заглавия — освен с
   readOnly: тогава нищо не пише и връща null, ако има какво да се допише. */
function lfSheet_(ss, readOnly) {
  var sheet = getSheetLoose_(ss, LF_SHEET);
  if (!sheet) {
    if (readOnly) return null;
    sheet = ss.insertSheet(LF_SHEET);
    sheet.getRange(1, 1, 1, LF_FIELDS.length).setValues([LF_FIELDS.map(function (f) { return f.header; })]);
    sheet.setFrozenRows(1);
  }
  var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0].map(lfNorm_);
  var map = {};
  var used = {};
  LF_FIELDS.forEach(function (f) {
    for (var c = 0; c < headers.length; c++) {
      if (!used[c] && headers[c] && f.match(headers[c])) { map[f.key] = c + 1; used[c] = true; return; }
    }
  });
  if (readOnly && LF_FIELDS.some(function (f) { return !map[f.key]; })) return null;
  LF_FIELDS.forEach(function (f) {
    if (!map[f.key]) {
      var col = sheet.getLastColumn() + 1;
      sheet.getRange(1, col).setValue(f.header);
      map[f.key] = col;
    }
  });
  return { sheet: sheet, map: map };
}

function lfNewId_() {
  return "LF-" + Utilities.formatDate(new Date(), "Europe/Sofia", "yyMMddHHmm") + "-" +
    Utilities.getUuid().replace(/-/g, "").slice(0, 5).toUpperCase();
}

/* Контакт без администратор: имейлът остава с първата буква и домейна,
   а в телефоните се виждат само последните три цифри. */
function lfMaskContact_(s) {
  s = String(s || "");
  if (!s) return "";
  s = s.replace(/([^\s@]{1})[^\s@]*@([^\s@]+)/g, "$1•••@$2");
  var digits = (s.match(/\d/g) || []).length;
  var seen = 0;
  return s.replace(/\d/g, function (d) { seen++; return seen > digits - 3 ? d : "•"; });
}

/* Админ проверка — паролата е само в Script properties. При
   LF_MAX_FAILS грешни опита проверката се заключва за LF_LOCKOUT_SEC. */
function lfAdminCheck_(pass) {
  var want = PropertiesService.getScriptProperties().getProperty("LF_ADMIN_PASS");
  if (!want) return { ok: false, code: "NO_ADMIN_PASS", error: "Администраторската парола не е зададена в Apps Script (Script properties → LF_ADMIN_PASS)." };
  var cache = CacheService.getScriptCache();
  var fails = parseInt(cache.get("lf_admin_fails") || "0", 10);
  if (fails >= LF_MAX_FAILS) return { ok: false, code: "LOCKED", error: "Твърде много грешни опита. Опитай отново след 10 минути." };
  var given = String(pass || "");
  var diff = given.length === want.length ? 0 : 1;
  for (var i = 0; i < Math.max(given.length, want.length); i++) {
    diff |= (given.charCodeAt(i) || 0) ^ (want.charCodeAt(i) || 0);
  }
  if (diff !== 0) {
    cache.put("lf_admin_fails", String(fails + 1), LF_LOCKOUT_SEC);
    return { ok: false, code: "BAD_PASS", error: "Грешна администраторска парола." };
  }
  cache.remove("lf_admin_fails");
  return { ok: true };
}

function lfOpen_() { return SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA"); }

function lfReadAll_(ctx) {
  var sheet = ctx.sheet, map = ctx.map;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = sheet.getLastColumn();
  var vals = sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
  var out = [];
  for (var r = 0; r < vals.length; r++) {
    var row = vals[r];
    var it = { _row: r + 2 };
    LF_FIELDS.forEach(function (f) { it[f.key] = String(row[map[f.key] - 1] || "").trim(); });
    if (!it.employee && !it.item && !it.date && !it.kind && !it.location) continue;
    out.push(it);
  }
  return out;
}

function handleLfList_(data) {
  var admin = false;
  if (data.adminPass) {
    var chk = lfAdminCheck_(data.adminPass);
    if (!chk.ok) return jsonResponse_({ success: false, code: chk.code, error: chk.error });
    admin = true;
  }
  // Обикновено само се чете — без заключване, за да не чака списъкът чужд
  // запис (напр. качване на снимка). Заключва се само ако има какво да се
  // допише: липсваща колона или ред, въведен ръчно без ID.
  var ss = lfOpen_();
  var ctx = lfSheet_(ss, true);
  var items = ctx ? lfReadAll_(ctx) : null;
  if (!items || items.some(function (it) { return !it.id; })) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      ctx = lfSheet_(ss);
      items = lfReadAll_(ctx);
      // Редове, въведени ръчно в таблицата, получават ID, за да могат да се
      // променят и трият от системата.
      items.forEach(function (it) {
        if (!it.id) {
          it.id = lfNewId_();
          ctx.sheet.getRange(it._row, ctx.map.id).setNumberFormat("@").setValue(it.id);
        }
      });
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  }
  var list = items.map(function (it) {
    var o = {};
    LF_FIELDS.forEach(function (f) { o[f.key] = it[f.key]; });
    if (!admin) o.contact = lfMaskContact_(o.contact);
    return o;
  });
  return jsonResponse_({ success: true, admin: admin, items: list,
    statuses: LF_STATUSES, kinds: LF_KINDS, categories: LF_CATEGORIES });
}

function handleLfAdd_(data) {
  var it = data.item || {};
  var clean = function (v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max || 500); };
  var rec = {
    employee:  clean(it.employee, 80),
    date:      clean(it.date, 10),
    time:      clean(it.time, 5),
    kind:      clean(it.kind, 20),
    category:  clean(it.category, 40),
    item:      clean(it.item, 1000),
    location:  clean(it.location, 300),
    screening: clean(it.screening, 300),
    contact:   clean(it.contact, 200)
  };
  if (!rec.employee || !rec.item || !rec.location) {
    return jsonResponse_({ success: false, code: "MISSING", error: "Попълни служител, описание на вещта и локация." });
  }
  if (LF_KINDS.indexOf(rec.kind) === -1) return jsonResponse_({ success: false, code: "BAD_KIND", error: "Невалиден тип: " + rec.kind });
  if (LF_CATEGORIES.indexOf(rec.category) === -1) rec.category = "Друго";
  var now = new Date();
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(rec.date)) rec.date = Utilities.formatDate(now, "Europe/Sofia", "dd.MM.yyyy");
  if (!/^\d{2}:\d{2}$/.test(rec.time)) rec.time = Utilities.formatDate(now, "Europe/Sofia", "HH:mm");
  // Изгубената вещ започва като търсена, намерената — като намерена.
  rec.status = rec.kind === "Изгубена" ? "Търси се" : "Намерена";
  var id = /^LF-[A-Za-z0-9-]{4,40}$/.test(String(data.id || "")) ? String(data.id) : lfNewId_();

  // Повторно изпращане на същия запис (напр. след изтекла връзка) не създава
  // дубликат. Първа проверка без заключване — за да не се качва снимката
  // напразно; окончателната е под заключването по-долу.
  var ss = lfOpen_();
  var pre = lfSheet_(ss, true);
  if (pre && lfReadAll_(pre).some(function (x) { return x.id === id; })) {
    return jsonResponse_({ success: true, id: id, duplicate: true });
  }
  // Качването в Drive отнема секунди — прави се извън заключването, за да не
  // чакат през това време другите записи и четения.
  var file = null;
  if (data.photoData) {
    try {
      var blob = Utilities.newBlob(Utilities.base64Decode(String(data.photoData)), "image/jpeg", id + ".jpg");
      var folder = lfPhotoFolder_();
      if (folder) {
        file = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        rec.photo = file.getUrl();
      }
    } catch (photoErr) {
      rec.photo = "";   // вещта се записва и без снимка
    }
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ctx = lfSheet_(ss);
    var existing = lfReadAll_(ctx).filter(function (x) { return x.id === id; })[0];
    if (existing) {
      // Паралелен опит със същия запис е бил по-бърз — снимката е излишна.
      if (file) { try { file.setTrashed(true); } catch (e) {} }
      return jsonResponse_({ success: true, id: id, duplicate: true });
    }
    rec.id = id;
    rec.updated = Utilities.formatDate(now, "Europe/Sofia", "dd.MM.yyyy HH:mm") + " · регистрирана от " + rec.employee;

    var sheet = ctx.sheet;
    var width = sheet.getLastColumn();
    var row = [];
    for (var c = 0; c < width; c++) row.push("");
    LF_FIELDS.forEach(function (f) { if (rec[f.key] != null) row[ctx.map[f.key] - 1] = rec[f.key]; });
    var target = sheet.getLastRow() + 1;
    var range = sheet.getRange(target, 1, 1, width);
    range.setNumberFormat("@");          // телефони с водеща нула, дати и часове остават текст
    range.setValues([row]);
    SpreadsheetApp.flush();
    return jsonResponse_({ success: true, id: id, status: rec.status, photo: rec.photo || "" });
  } finally {
    lock.releaseLock();
  }
}

function lfPhotoFolder_() {
  var root = getOrCreatePhotosFolder_();
  if (!root) return null;
  var it = root.getFoldersByName("Lost and Found");
  return it.hasNext() ? it.next() : root.createFolder("Lost and Found");
}

/* Общо за промяна и изтриване: проверява паролата и намира реда по ID. */
function lfAdminFind_(data, cb) {
  var chk = lfAdminCheck_(data.adminPass);
  if (!chk.ok) return jsonResponse_({ success: false, code: chk.code, error: chk.error });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ctx = lfSheet_(lfOpen_());
    var hit = lfReadAll_(ctx).filter(function (x) { return x.id && x.id === String(data.id || ""); })[0];
    if (!hit) return jsonResponse_({ success: false, code: "NOT_FOUND", error: "Записът не е намерен — може да е изтрит или преместен." });
    var out = cb(ctx, hit);
    SpreadsheetApp.flush();
    return out;
  } finally {
    lock.releaseLock();
  }
}

function handleLfSetStatus_(data) {
  var status = String(data.status || "");
  if (LF_STATUSES.indexOf(status) === -1) return jsonResponse_({ success: false, code: "BAD_STATUS", error: "Невалиден статус: " + status });
  return lfAdminFind_(data, function (ctx, hit) {
    var stamp = Utilities.formatDate(new Date(), "Europe/Sofia", "dd.MM.yyyy HH:mm") + " · статус „" + status + "\" от администратор";
    ctx.sheet.getRange(hit._row, ctx.map.status).setValue(status);
    ctx.sheet.getRange(hit._row, ctx.map.updated).setNumberFormat("@").setValue(stamp);
    return jsonResponse_({ success: true, id: hit.id, status: status, updated: stamp });
  });
}

function handleLfDelete_(data) {
  return lfAdminFind_(data, function (ctx, hit) {
    ctx.sheet.deleteRow(hit._row);
    return jsonResponse_({ success: true, id: hit.id, deleted: true });
  });
}

function handleLfAdminCheck_(data) {
  var chk = lfAdminCheck_(data.adminPass);
  return jsonResponse_(chk.ok ? { success: true, admin: true } : { success: false, code: chk.code, error: chk.error });
}

// ===========================================================
// ЗАДАЧИ — възлагане от администратор, изпълнение от служител,
// оценка 1–10 с коментар. Листове „Tasks" и „Служители" в същата
// таблица. Администраторите са в Script properties:
//   TASKS_ADMIN_<потребител> = <парола>   (напр. TASKS_ADMIN_denis)
// В GitHub няма пароли — страницата е публична.
// ===========================================================
var TK_SHEET = "Tasks";
var TK_STAFF_SHEET = "Служители";
var TK_HEADERS = ["ID", "Създадена", "Създал", "Заглавие", "Описание", "Категория", "Приоритет",
  "Възложена на", "Срок", "Статус", "Изпълнена на", "Изпълнил", "Часове", "Бележка от служителя",
  "Оценка", "Коментар", "Оценена на", "Оценил", "Обновено", "Бележки"];
var TK_STAFF_HEADERS = ["Име", "Ранг", "Позиция", "ПИН", "Активен", "Снимка"];
var TK_STATUSES = ["Възложена", "Изпълнена", "Оценена", "Отменена"];
var TK_PRIORITIES = ["Нисък", "Нормален", "Висок", "Спешен"];
var TK_TOKEN_HOURS = 12;
var TK_MAX_FAILS = 5;
var TK_LOCKOUT_SEC = 600;

/* Таблицата се отваря веднъж на заявка (openById е бавно — досега едно
   действие я отваряше 3–4 пъти: данни, лог, служители…). */
var TK_SS_ = null;
function tkOpen_() { return TK_SS_ || (TK_SS_ = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA")); }
function tkNow_() { return Utilities.formatDate(new Date(), "Europe/Sofia", "dd.MM.yyyy HH:mm"); }
function tkClean_(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max || 500); }
function tkText_(v) { var s = String(v == null ? "" : v); return /^=/.test(s) ? "'" + s : s; }

/* Лист с точно тези заглавия (създава го; добавя липсващи колони накрая). */
function tkSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  var have = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
  var map = {};
  have.forEach(function (h, i) { if (h && !map[h]) map[h] = i; });
  headers.forEach(function (h) {
    if (map[h] == null) {
      var col = sh.getLastColumn() + 1;
      sh.getRange(1, col).setValue(h);
      map[h] = col - 1;
    }
  });
  return { sheet: sh, map: map };
}
function tkRows_(ctx, headers) {
  var sh = ctx.sheet, last = sh.getLastRow();
  if (last < 2) return [];
  var width = sh.getLastColumn();
  var vals = sh.getRange(2, 1, last - 1, width).getDisplayValues();
  var out = [];
  for (var r = 0; r < vals.length; r++) {
    var o = { _row: r + 2 };
    headers.forEach(function (h) { o[h] = String(vals[r][ctx.map[h]] == null ? "" : vals[r][ctx.map[h]]).trim(); });
    out.push(o);
  }
  return out;
}
function tkWriteRow_(ctx, row, obj) {
  var width = ctx.sheet.getLastColumn();
  var cur = row <= ctx.sheet.getLastRow() ? ctx.sheet.getRange(row, 1, 1, width).getValues()[0] : [];
  while (cur.length < width) cur.push("");
  Object.keys(obj).forEach(function (h) { if (ctx.map[h] != null) cur[ctx.map[h]] = tkText_(obj[h]); });
  var rg = ctx.sheet.getRange(row, 1, 1, width);
  rg.setNumberFormat("@");
  rg.setValues([cur]);
}

/* ── Сигурност ── */
function tkSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty("TASKS_SECRET");
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty("TASKS_SECRET", s); }
  return s;
}
function tkB64_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ""); }
function tkSign_(payload) { return tkB64_(Utilities.computeHmacSha256Signature(payload, tkSecret_())); }
function tkHashPin_(pin) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, tkSecret_() + "|pin|" + String(pin));
  return "h:" + tkB64_(d);
}
function tkSafeEq_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  for (var i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function tkFailKey_(k) { return "tk_fail_" + String(k).toLowerCase().slice(0, 60); }
function tkLocked_(k) { return Number(CacheService.getScriptCache().get(tkFailKey_(k)) || 0) >= TK_MAX_FAILS; }
function tkFail_(k) {
  var c = CacheService.getScriptCache(), key = tkFailKey_(k);
  c.put(key, String(Number(c.get(key) || 0) + 1), TK_LOCKOUT_SEC);
}
function tkAdmins_() {
  var all = PropertiesService.getScriptProperties().getProperties(), out = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf("TASKS_ADMIN_") === 0 && all[k]) out[k.slice(12).toLowerCase()] = { name: k.slice(12), pass: all[k] };
  });
  return out;
}
function tkCheckToken_(token) {
  var parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  var payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString(); } catch (e) { return null; }
  if (!tkSafeEq_(tkSign_(payload), parts[1])) return null;
  var p = payload.split("|");
  if (p.length !== 2 || Number(p[1]) < Date.now()) return null;
  var admin = tkAdmins_()[p[0].toLowerCase()];
  return admin ? admin.name : null;   // махнат администратор губи достъп веднага
}
function tkDeny_() { return jsonResponse_({ success: false, code: "AUTH", error: "Входът е изтекъл — влезте отново." }); }

/* ── Главен администратор ──
   Един профил (по подразбиране „denis"; може да се смени със Script
   property TASKS_OWNER) е недосегаем: само той вижда „Логове" и само той
   може да променя, премахва или сменя снимката/ПИН-а на своя запис в
   „Служители" (по подразбиране „Денис"; TASKS_OWNER_STAFF). Другите
   администратори нямат правомощия над него — проверката е тук, на сървъра. */
function tkOwner_() { return String(PropertiesService.getScriptProperties().getProperty("TASKS_OWNER") || "denis").trim().toLowerCase(); }
function tkOwnerStaff_() { return String(PropertiesService.getScriptProperties().getProperty("TASKS_OWNER_STAFF") || "Денис").trim(); }
function tkIsOwner_(admin) { return String(admin || "").toLowerCase() === tkOwner_(); }
function tkProtected_(admin, staffName) {
  return !tkIsOwner_(admin) && String(staffName || "").trim().toLowerCase() === tkOwnerStaff_().toLowerCase();
}
function tkForbidden_(admin, what) {
  // Опитът се вижда в „Логове" на главния администратор.
  if (admin) tkLog_(admin, "Отказан достъп", tkOwnerStaff_(), what || "");
  return jsonResponse_({ success: false, code: "FORBIDDEN", error: "Този профил е защитен — само главният администратор може да го променя." });
}

/* ── Данни ── */
function tkPublicTask_(t, withRating) {
  var o = { id: t["ID"], created: t["Създадена"], title: t["Заглавие"], description: t["Описание"],
    category: t["Категория"], priority: t["Приоритет"], assignee: t["Възложена на"], due: t["Срок"],
    status: t["Статус"], doneAt: t["Изпълнена на"], doneBy: t["Изпълнил"], hours: t["Часове"], note: t["Бележка от служителя"],
    createdBy: t["Създал"], overdue: tkOverdue_(t), late: tkLate_(t) };
  if (withRating) { o.score = t["Оценка"]; o.comment = t["Коментар"]; o.ratedAt = t["Оценена на"]; o.ratedBy = t["Оценил"]; o.updated = t["Обновено"]; o.notes = tkNotes_(t["Бележки"]); }
  return o;
}
/* Дни от „dd.MM.yyyy" (за сравнение на дати без часова зона). */
function tkDay_(s) {
  var m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(String(s || ""));
  return m ? Math.round(Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86400000) : null;
}
function tkToday_() { return tkDay_(Utilities.formatDate(new Date(), "Europe/Sofia", "dd.MM.yyyy")); }
/* Просрочена: още „Възложена", а срокът е минал (по българско време).
   Задачата НЕ изчезва след срока — остава, докато не се изпълни или отмени. */
function tkOverdue_(t) {
  if (t["Статус"] !== "Възложена") return 0;
  var due = tkDay_(t["Срок"]);
  return due == null ? 0 : Math.max(0, tkToday_() - due);
}
/* Изпълнена след срока — с колко дни. */
function tkLate_(t) {
  if (t["Статус"] !== "Изпълнена" && t["Статус"] !== "Оценена") return 0;
  var due = tkDay_(t["Срок"]), done = tkDay_(t["Изпълнена на"]);
  return due == null || done == null ? 0 : Math.max(0, done - due);
}
/* „Бележки" — дневник: всеки ред е „dd.MM.yyyy HH:mm · кой: текст". */
function tkNotes_(raw) {
  return String(raw || "").split("\n").filter(function (l) { return l.trim(); }).map(function (l) {
    var m = /^(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}) · ([^:]{1,60}): ([\s\S]*)$/.exec(l);
    return m ? { at: m[1], by: m[2], text: m[3] } : { at: "", by: "", text: l };
  });
}
function tkAddNote_(t, who, text) {
  var lines = String(t["Бележки"] || "").split("\n").filter(function (l) { return l.trim(); });
  lines.push(tkNow_() + " · " + who + ": " + text);
  var out = lines.join("\n");
  while (out.length > 40000 && lines.length > 1) { lines.shift(); out = lines.join("\n"); }   // клетката побира до 50 000 знака
  return out;
}
function tkStaff_(ss) { return tkRows_(tkSheet_(ss, TK_STAFF_SHEET, TK_STAFF_HEADERS), TK_STAFF_HEADERS); }
function tkStaffPublic_(rows) {
  return rows.filter(function (s) { return s["Име"] && s["Активен"] !== "не"; })
    .map(function (s) { return { name: s["Име"], rank: s["Ранг"], position: s["Позиция"], hasPin: !!s["ПИН"] }; });
}
function tkPinOk_(staffRow, pin) {
  if (!staffRow || !staffRow["ПИН"]) return true;
  return tkSafeEq_(staffRow["ПИН"], tkHashPin_(pin || ""));
}

/* ── Действия на служител ── */
function handleTasksStaff_(data) {
  return jsonResponse_({ success: true, staff: tkStaffPublic_(tkStaff_(tkOpen_())) });
}
function handleTasksMine_(data) {
  var name = tkClean_(data.name, 80);
  if (!name) return jsonResponse_({ success: false, code: "MISSING", error: "Изберете име." });
  var ss = tkOpen_();
  var me = tkStaff_(ss).filter(function (s) { return s["Име"] === name; })[0];
  var withHistory = false;
  if (data.pin != null && data.pin !== "") {
    if (tkLocked_("pin_" + name)) return jsonResponse_({ success: false, code: "LOCKED", error: "Твърде много грешни ПИН-ове. Опитайте след 10 минути." });
    if (!me || !me["ПИН"]) return jsonResponse_({ success: false, code: "NO_PIN", error: "Нямате ПИН — помолете администратора да ви зададе." });
    if (!tkPinOk_(me, data.pin)) { tkFail_("pin_" + name); return jsonResponse_({ success: false, code: "BAD_PIN", error: "Грешен ПИН." }); }
    withHistory = true;
  }
  var tasks = tkRows_(tkSheet_(ss, TK_SHEET, TK_HEADERS), TK_HEADERS).filter(function (t) { return t["ID"] && t["Възложена на"] === name; });
  var open = tasks.filter(function (t) { return t["Статус"] === "Възложена"; }).map(function (t) { return tkPublicTask_(t, false); });
  // Приключените — без оценка и коментар (те са само с ПИН, в history).
  var done = tasks.filter(function (t) { return t["Статус"] !== "Възложена"; }).slice(-30).map(function (t) { return tkPublicTask_(t, false); });
  var res = { success: true, name: name, hasPin: !!(me && me["ПИН"]), rank: me ? me["Ранг"] : "", position: me ? me["Позиция"] : "", open: open, done: done, photoVer: tkPhotoVer_() };
  // С ПИН — всички задачи (и отворените — заради коментарите на администратора).
  if (withHistory) res.history = tasks.map(function (t) { return tkPublicTask_(t, true); });
  return jsonResponse_(res);
}
function handleTasksComplete_(data) {
  var name = tkClean_(data.name, 80), id = tkClean_(data.id, 60);
  var hours = Number(String(data.hours || "").replace(",", "."));
  if (!name || !id) return jsonResponse_({ success: false, code: "MISSING", error: "Липсва име или задача." });
  if (!(hours > 0 && hours <= 200)) return jsonResponse_({ success: false, code: "BAD_HOURS", error: "Въведете колко часа (напр. 1,5)." });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = tkOpen_();
    var me = tkStaff_(ss).filter(function (s) { return s["Име"] === name; })[0];
    if (me && me["ПИН"]) {
      if (tkLocked_("pin_" + name)) return jsonResponse_({ success: false, code: "LOCKED", error: "Твърде много грешни ПИН-ове. Опитайте след 10 минути." });
      if (!tkPinOk_(me, data.pin)) { tkFail_("pin_" + name); return jsonResponse_({ success: false, code: "BAD_PIN", error: "Грешен ПИН." }); }
    }
    var ctx = tkSheet_(ss, TK_SHEET, TK_HEADERS);
    var t = tkRows_(ctx, TK_HEADERS).filter(function (x) { return x["ID"] === id; })[0];
    if (!t) return jsonResponse_({ success: false, code: "NOT_FOUND", error: "Задачата не е намерена." });
    if (t["Възложена на"] !== name) return jsonResponse_({ success: false, code: "NOT_YOURS", error: "Тази задача е възложена на " + t["Възложена на"] + "." });
    if (t["Статус"] === "Изпълнена" && t["Изпълнил"] === name) return jsonResponse_({ success: true, duplicate: true, id: id });
    if (t["Статус"] !== "Възложена") return jsonResponse_({ success: false, code: "BAD_STATE", error: "Задачата вече е „" + t["Статус"] + "“." });
    var now = tkNow_();
    tkWriteRow_(ctx, t._row, { "Статус": "Изпълнена", "Изпълнена на": now, "Изпълнил": name,
      "Часове": String(Math.round(hours * 100) / 100), "Бележка от служителя": tkClean_(data.note, 1000),
      "Обновено": now + " · изпълнена от " + name });
    SpreadsheetApp.flush();
    return jsonResponse_({ success: true, id: id, status: "Изпълнена" });
  } finally { lock.releaseLock(); }
}

/* ── Администратор ── */
function handleTasksLogin_(data) {
  var user = tkClean_(data.user, 60).toLowerCase(), pass = String(data.pass || "");
  var admins = tkAdmins_();
  if (!Object.keys(admins).length) return jsonResponse_({ success: false, code: "NO_ADMINS", error: "Няма администратори — добавете TASKS_ADMIN_<име> в Script properties." });
  if (tkLocked_("adm_" + user)) return jsonResponse_({ success: false, code: "LOCKED", error: "Твърде много грешни опити. Опитайте след 10 минути." });
  var a = admins[user];
  if (!a || !tkSafeEq_(a.pass, pass)) { tkFail_("adm_" + user); tkLog_("—", "Неуспешен вход", user || "—", ""); return jsonResponse_({ success: false, code: "BAD_LOGIN", error: "Грешно име или парола." }); }
  tkLog_(a.name, "Вход", "", "");
  var payload = a.name + "|" + (Date.now() + TK_TOKEN_HOURS * 3600 * 1000);
  return jsonResponse_({ success: true, user: a.name, owner: tkIsOwner_(a.name), ownerStaff: tkOwnerStaff_(), token: tkB64_(Utilities.newBlob(payload).getBytes()) + "." + tkSign_(payload), hours: TK_TOKEN_HOURS });
}
function handleTasksAdminList_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  tkArchiveOld_();
  var ss = tkOpen_();
  var tasks = tkRows_(tkSheet_(ss, TK_SHEET, TK_HEADERS), TK_HEADERS).filter(function (t) { return t["ID"]; })
    .map(function (t) { return tkPublicTask_(t, true); });
  var staffRows = tkStaff_(ss);
  var removed = staffRows.filter(function (s) { return s["Име"] && s["Активен"] === "не"; }).map(function (s) { return { name: s["Име"], rank: s["Ранг"], position: s["Позиция"], hasPin: !!s["ПИН"] }; });
  return jsonResponse_({ success: true, admin: admin, owner: tkIsOwner_(admin), ownerStaff: tkOwnerStaff_(), tasks: tasks, staff: tkStaffPublic_(staffRows), removed: removed,
    statuses: TK_STATUSES, priorities: TK_PRIORITIES, photoVer: tkPhotoVer_() });
}
function handleTasksCreate_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var it = data.task || {};
  var rec = { title: tkClean_(it.title, 200), description: tkClean_(it.description, 3000), category: tkClean_(it.category, 60),
    priority: TK_PRIORITIES.indexOf(it.priority) >= 0 ? it.priority : "Нормален", assignee: tkClean_(it.assignee, 80), due: tkClean_(it.due, 10) };
  if (!rec.title || !rec.assignee) return jsonResponse_({ success: false, code: "MISSING", error: "Попълнете заглавие и на кого е задачата." });
  if (rec.due && !/^\d{2}\.\d{2}\.\d{4}$/.test(rec.due)) rec.due = "";
  var id = /^TK-[A-Za-z0-9-]{4,40}$/.test(String(data.id || "")) ? String(data.id) : "TK-" + Utilities.formatDate(new Date(), "Europe/Sofia", "yyMMddHHmm") + "-" + Utilities.getUuid().slice(0, 5).toUpperCase();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = tkOpen_();
    var staff = tkStaffPublic_(tkStaff_(ss)).map(function (s) { return s.name; });
    if (staff.indexOf(rec.assignee) < 0) return jsonResponse_({ success: false, code: "BAD_ASSIGNEE", error: "„" + rec.assignee + "“ не е в списъка със служители." });
    var ctx = tkSheet_(ss, TK_SHEET, TK_HEADERS);
    if (tkRows_(ctx, TK_HEADERS).some(function (t) { return t["ID"] === id; })) return jsonResponse_({ success: true, duplicate: true, id: id });
    var now = tkNow_();
    var row = { "ID": id, "Създадена": now, "Създал": admin, "Заглавие": rec.title,
      "Описание": rec.description, "Категория": rec.category, "Приоритет": rec.priority, "Възложена на": rec.assignee,
      "Срок": rec.due, "Статус": "Възложена", "Обновено": now + " · възложена от " + admin };
    tkWriteRow_(ctx, ctx.sheet.getLastRow() + 1, row);
    tkLog_(admin, "Нова задача", rec.title, "на " + rec.assignee + (rec.due ? ", срок " + rec.due : "") + ", " + rec.priority);
    SpreadsheetApp.flush();
    return jsonResponse_({ success: true, id: id, task: tkAfter_({}, row) });
  } finally { lock.releaseLock(); }
}
/* Задачата след промяната — връща се на admin.html, за да не презарежда
   целия списък след всяко действие. */
function tkAfter_(t, changes) {
  var o = {};
  Object.keys(t).forEach(function (k) { o[k] = t[k]; });
  Object.keys(changes).forEach(function (k) { o[k] = String(changes[k] == null ? "" : changes[k]); });
  return tkPublicTask_(o, true);
}
function tkAdminTask_(data, fn) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ctx = tkSheet_(tkOpen_(), TK_SHEET, TK_HEADERS);
    var t = tkRows_(ctx, TK_HEADERS).filter(function (x) { return x["ID"] && x["ID"] === String(data.id || ""); })[0];
    if (!t) return jsonResponse_({ success: false, code: "NOT_FOUND", error: "Задачата не е намерена." });
    var out = fn(ctx, t, admin);
    SpreadsheetApp.flush();
    return out;
  } finally { lock.releaseLock(); }
}
function handleTasksRate_(data) {
  var score = Number(data.score);
  if (!(score >= 1 && score <= 10 && Math.round(score) === score)) return jsonResponse_({ success: false, code: "BAD_SCORE", error: "Оценката е от 1 до 10." });
  return tkAdminTask_(data, function (ctx, t, admin) {
    if (t["Статус"] !== "Изпълнена" && t["Статус"] !== "Оценена") return jsonResponse_({ success: false, code: "BAD_STATE", error: "Може да се оцени само изпълнена задача." });
    var now = tkNow_();
    var ch = { "Статус": "Оценена", "Оценка": String(score), "Коментар": tkClean_(data.comment, 2000),
      "Оценена на": now, "Оценил": admin, "Обновено": now + " · оценена " + score + "/10 от " + admin };
    tkWriteRow_(ctx, t._row, ch);
    tkLog_(admin, "Оценка", t["Заглавие"], score + "/10 за " + t["Възложена на"]);
    return jsonResponse_({ success: true, id: t["ID"], status: "Оценена", task: tkAfter_(t, ch) });
  });
}
function handleTasksCancel_(data) {
  return tkAdminTask_(data, function (ctx, t, admin) {
    if (t["Статус"] !== "Възложена") return jsonResponse_({ success: false, code: "BAD_STATE", error: "Може да се отмени само задача, която още не е изпълнена." });
    var now = tkNow_();
    var ch = { "Статус": "Отменена", "Обновено": now + " · отменена от " + admin };
    tkWriteRow_(ctx, t._row, ch);
    tkLog_(admin, "Отмяна на задача", t["Заглавие"], t["Възложена на"]);
    return jsonResponse_({ success: true, id: t["ID"], status: "Отменена", task: tkAfter_(t, ch) });
  });
}
/* Табло за всички (без вход): кой каква задача има, до кога и кой я е
   възложил. Без описание, бележки, часове и оценки — те са лични. */
var TK_BOARD_DONE_DAYS = 14;
function handleTasksBoard_(data) {
  tkArchiveOld_();
  var ss = tkOpen_();
  var staff = {};
  tkStaffPublic_(tkStaff_(ss)).forEach(function (s) { staff[s.name] = s; });
  var today = tkToday_();
  var tasks = tkRows_(tkSheet_(ss, TK_SHEET, TK_HEADERS), TK_HEADERS).filter(function (t) {
    if (!t["ID"] || t["Статус"] === "Отменена") return false;
    if (t["Статус"] === "Възложена" || t["Статус"] === "Изпълнена") return true;
    var d = tkDay_(t["Изпълнена на"]) || tkDay_(t["Оценена на"]);
    return d != null && today - d <= TK_BOARD_DONE_DAYS;
  }).map(function (t) {
    var s = staff[t["Възложена на"]] || {};
    return { id: t["ID"], title: t["Заглавие"], category: t["Категория"], priority: t["Приоритет"],
      assignee: t["Възложена на"], rank: s.rank || "", position: s.position || "", createdBy: t["Създал"],
      created: t["Създадена"], due: t["Срок"], status: t["Статус"], doneAt: t["Изпълнена на"],
      overdue: tkOverdue_(t), late: tkLate_(t) };
  });
  return jsonResponse_({ success: true, today: Utilities.formatDate(new Date(), "Europe/Sofia", "dd.MM.yyyy"), doneDays: TK_BOARD_DONE_DAYS, tasks: tasks, photoVer: tkPhotoVer_() });
}
/* Администраторът сменя статуса ръчно: обратно във „Възложена",
   „Изпълнена" или „Отменена" (оценката е отделно — tasksRate). По желание
   и нов срок. Всяка промяна се записва в „Бележки", нищо не се губи. */
function handleTasksSetStatus_(data) {
  var to = String(data.status || "");
  if (["Възложена", "Изпълнена", "Отменена"].indexOf(to) < 0) return jsonResponse_({ success: false, code: "BAD_STATUS", error: "Непознат статус." });
  var due = data.due == null ? null : tkClean_(data.due, 10);
  if (due && !/^\d{2}\.\d{2}\.\d{4}$/.test(due)) return jsonResponse_({ success: false, code: "BAD_DUE", error: "Срокът е във формат дд.мм.гггг." });
  var hours = data.hours == null || data.hours === "" ? null : Number(String(data.hours).replace(",", "."));
  if (hours !== null && !(hours > 0 && hours <= 200)) return jsonResponse_({ success: false, code: "BAD_HOURS", error: "Часовете са от 0 до 200." });
  return tkAdminTask_(data, function (ctx, t, admin) {
    var from = t["Статус"], changes = {}, log = [];
    if (due !== null && due !== t["Срок"]) { changes["Срок"] = due; log.push("срок " + (t["Срок"] || "—") + " → " + (due || "—")); }
    if (to !== from) {
      log.push("статус „" + from + "“ → „" + to + "“" + (from === "Оценена" ? " (беше " + t["Оценка"] + "/10" + (t["Коментар"] ? ": " + t["Коментар"] : "") + ")" : ""));
      var clear = function (keys) { keys.forEach(function (k) { changes[k] = ""; }); };
      if (to === "Възложена") {
        clear(["Оценка", "Коментар", "Оценена на", "Оценил", "Изпълнена на", "Изпълнил", "Часове"]);
      } else if (to === "Изпълнена") {
        clear(["Оценка", "Коментар", "Оценена на", "Оценил"]);
        if (from === "Възложена" || from === "Отменена" || !t["Изпълнена на"]) {
          changes["Изпълнена на"] = tkNow_(); changes["Изпълнил"] = t["Възложена на"];
          if (hours !== null) changes["Часове"] = String(Math.round(hours * 100) / 100);
        }
      }
      changes["Статус"] = to;
    }
    var reason = tkClean_(data.note, 500);
    if (!log.length) return jsonResponse_({ success: true, id: t["ID"], status: from, unchanged: true });
    changes["Бележки"] = tkAddNote_(t, admin, log.join(", ") + (reason ? " — " + reason : ""));
    changes["Обновено"] = tkNow_() + " · " + log.join(", ") + " · " + admin;
    tkWriteRow_(ctx, t._row, changes);
    tkLog_(admin, "Смяна на задача", t["Заглавие"], log.join(", ") + (reason ? " — " + reason : ""));
    return jsonResponse_({ success: true, id: t["ID"], status: to, task: tkAfter_(t, changes) });
  });
}
/* Коментар от администратора по всяко време (без оценка). */
function handleTasksNote_(data) {
  var text = tkClean_(data.text, 1000);
  if (!text) return jsonResponse_({ success: false, code: "MISSING", error: "Напишете коментар." });
  return tkAdminTask_(data, function (ctx, t, admin) {
    var notes = tkAddNote_(t, admin, text);
    var ch = { "Бележки": notes, "Обновено": tkNow_() + " · коментар от " + admin };
    tkWriteRow_(ctx, t._row, ch);
    tkLog_(admin, "Коментар", t["Заглавие"], text);
    return jsonResponse_({ success: true, id: t["ID"], notes: tkNotes_(notes), task: tkAfter_(t, ch) });
  });
}
/* Нов служител от администратора (или връщане на премахнат). Името е на
   кирилица — същото правило като в списъка за проверки. */
function handleTasksStaffAdd_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var name = tkClean_(data.name, 60).replace(/\s+/g, " ");
  if (!/^[Ѐ-ӿ][Ѐ-ӿ ]{1,59}$/.test(name)) return jsonResponse_({ success: false, code: "BAD_NAME", error: "Името е на кирилица (напр. „Иван Петров“)." });
  if (tkProtected_(admin, name)) return tkForbidden_(admin, "опит за добавяне/връщане");
  var pin = data.pin == null ? "" : String(data.pin);
  if (pin && !/^\d{4,8}$/.test(pin)) return jsonResponse_({ success: false, code: "BAD_PIN", error: "ПИН-ът е от 4 до 8 цифри." });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ctx = tkSheet_(tkOpen_(), TK_STAFF_SHEET, TK_STAFF_HEADERS);
    var s = tkRows_(ctx, TK_STAFF_HEADERS).filter(function (x) { return x["Име"].toLowerCase() === name.toLowerCase(); })[0];
    if (s && s["Активен"] !== "не") return jsonResponse_({ success: false, code: "EXISTS", error: "„" + s["Име"] + "“ вече е в списъка." });
    var obj = { "Име": s ? s["Име"] : name, "Активен": "да" };
    if (data.rank != null) obj["Ранг"] = tkClean_(data.rank, 60);
    if (data.position != null) obj["Позиция"] = tkClean_(data.position, 80);
    if (pin) obj["ПИН"] = tkHashPin_(pin);
    tkWriteRow_(ctx, s ? s._row : ctx.sheet.getLastRow() + 1, obj);
    tkLog_(admin, s ? "Върнат служител" : "Нов служител", obj["Име"], [obj["Ранг"], obj["Позиция"]].filter(Boolean).join(", "));
    if (s && s["Снимка"]) tkPhotoBump_();   // снимката му пак се показва
    SpreadsheetApp.flush();
    return jsonResponse_({ success: true, name: obj["Име"], restored: !!s });
  } finally { lock.releaseLock(); }
}
/* Премахване: редът остава (Активен = „не"), за да не се губи историята
   на задачите и проверките му. Изчезва от списъците в приложението. */
function handleTasksStaffRemove_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var name = tkClean_(data.name, 80);
  if (tkProtected_(admin, name)) return tkForbidden_(admin, "опит за премахване");
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = tkOpen_();
    var ctx = tkSheet_(ss, TK_STAFF_SHEET, TK_STAFF_HEADERS);
    var s = tkRows_(ctx, TK_STAFF_HEADERS).filter(function (x) { return x["Име"] === name; })[0];
    if (!s) return jsonResponse_({ success: false, code: "NOT_FOUND", error: "Няма такъв служител." });
    var open = tkRows_(tkSheet_(ss, TK_SHEET, TK_HEADERS), TK_HEADERS).filter(function (t) { return t["Възложена на"] === name && t["Статус"] === "Възложена"; }).length;
    if (open && !data.force) return jsonResponse_({ success: false, code: "HAS_OPEN", open: open, error: name + " има " + open + " отворени задачи." });
    tkWriteRow_(ctx, s._row, { "Активен": "не" });
    tkLog_(admin, "Премахнат служител", name, open ? open + " отворени задачи" : "");
    if (s["Снимка"]) tkPhotoBump_();
    SpreadsheetApp.flush();
    return jsonResponse_({ success: true, name: name, open: open });
  } finally { lock.releaseLock(); }
}
/* ── Снимки: администраторът качва своя снимка и снимки на служителите ──
   Снимката е малка (до 160×160, JPEG), смалена още в браузъра, и се пази
   като текст (data URL) в клетка — без Google Drive и без публични линкове.
   „TK_PHOTO_VER" се сменя при всяка промяна: приложението тегли снимките
   само когато версията е нова, иначе ги взима от паметта на устройството. */
var TK_ADMIN_SHEET = "Админи";
var TK_ADMIN_HEADERS = ["Потребител", "Име", "Снимка", "Обновено"];
var TK_PHOTO_MAX = 45000;   // клетката побира до 50 000 знака
function tkPhotoOk_(s) {
  return s === "" || (s.length <= TK_PHOTO_MAX && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/]+=*$/.test(s));
}
function tkPhotoVer_() { return PropertiesService.getScriptProperties().getProperty("TK_PHOTO_VER") || "0"; }
function tkPhotoBump_() { var v = String(Date.now()); PropertiesService.getScriptProperties().setProperty("TK_PHOTO_VER", v); return v; }
function tkAdminRows_(ss) { return tkRows_(tkSheet_(ss, TK_ADMIN_SHEET, TK_ADMIN_HEADERS), TK_ADMIN_HEADERS); }
/* Публично: снимки на активните служители + име и снимка на администраторите. */
function handleTasksPhotos_(data) {
  // Снимките се сменят рядко: пазят се в кеша, докато не се смени версията.
  var cache = CacheService.getScriptCache(), key = "tk_photos_" + tkPhotoVer_(), hit = cache.get(key);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  var ss = tkOpen_(), staff = {}, admins = {};
  tkStaff_(ss).forEach(function (s) { if (s["Име"] && s["Активен"] !== "не" && s["Снимка"]) staff[s["Име"]] = s["Снимка"]; });
  var known = tkAdmins_();
  tkAdminRows_(ss).forEach(function (a) {
    var u = String(a["Потребител"] || "").toLowerCase();
    if (u && known[u]) admins[u] = { name: a["Име"] || known[u].name, photo: a["Снимка"] || "" };
  });
  var json = JSON.stringify({ success: true, ver: tkPhotoVer_(), staff: staff, admins: admins });
  try { if (json.length < 95000) cache.put(key, json, 3600); } catch (_) {}
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
function handleTasksProfile_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var me = tkAdminRows_(tkOpen_()).filter(function (a) { return String(a["Потребител"]).toLowerCase() === admin.toLowerCase(); })[0];
  return jsonResponse_({ success: true, user: admin, name: me ? me["Име"] : "", photo: me ? me["Снимка"] : "" });
}
function handleTasksProfileSave_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var name = data.name == null ? null : tkClean_(data.name, 60);
  var photo = data.photo == null ? null : String(data.photo);
  if (photo !== null && !tkPhotoOk_(photo)) return jsonResponse_({ success: false, code: "BAD_PHOTO", error: "Снимката е твърде голяма или не е изображение." });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ctx = tkSheet_(tkOpen_(), TK_ADMIN_SHEET, TK_ADMIN_HEADERS);
    var me = tkRows_(ctx, TK_ADMIN_HEADERS).filter(function (a) { return String(a["Потребител"]).toLowerCase() === admin.toLowerCase(); })[0];
    var obj = { "Потребител": admin, "Обновено": tkNow_() };
    if (name !== null) obj["Име"] = name;
    if (photo !== null) obj["Снимка"] = photo;
    tkWriteRow_(ctx, me ? me._row : ctx.sheet.getLastRow() + 1, obj);
    var ver = tkPhotoBump_();
    tkLog_(admin, "Профил", admin, [name !== null ? "име: " + (name || "—") : "", photo !== null ? (photo ? "нова снимка" : "махната снимка") : ""].filter(Boolean).join(", "));
    SpreadsheetApp.flush();
    return jsonResponse_({ success: true, user: admin, ver: ver });
  } finally { lock.releaseLock(); }
}
function handleTasksStaffPhoto_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var name = tkClean_(data.name, 80), photo = String(data.photo == null ? "" : data.photo);
  if (tkProtected_(admin, name)) return tkForbidden_(admin, "опит за смяна на снимка");
  if (!tkPhotoOk_(photo)) return jsonResponse_({ success: false, code: "BAD_PHOTO", error: "Снимката е твърде голяма или не е изображение." });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ctx = tkSheet_(tkOpen_(), TK_STAFF_SHEET, TK_STAFF_HEADERS);
    var s = tkRows_(ctx, TK_STAFF_HEADERS).filter(function (x) { return x["Име"] === name; })[0];
    if (!s) return jsonResponse_({ success: false, code: "NOT_FOUND", error: "Няма такъв служител." });
    tkWriteRow_(ctx, s._row, { "Снимка": photo });
    tkLog_(admin, "Снимка на служител", name, photo ? "нова снимка" : "махната снимка");
    var ver = tkPhotoBump_();
    SpreadsheetApp.flush();
    return jsonResponse_({ success: true, name: name, ver: ver });
  } finally { lock.releaseLock(); }
}
/* Добавя имена от списъка за проверките (Names.md), които още ги няма. */
function handleTasksStaffSeed_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var names = (Array.isArray(data.names) ? data.names : []).map(function (n) { return tkClean_(n, 80); }).filter(String).slice(0, 300);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ctx = tkSheet_(tkOpen_(), TK_STAFF_SHEET, TK_STAFF_HEADERS);
    var have = {}; tkRows_(ctx, TK_STAFF_HEADERS).forEach(function (s) { have[s["Име"]] = 1; });
    var added = 0;
    var skipped = 0;
    names.forEach(function (n) {
      if (have[n]) return;
      if (tkProtected_(admin, n)) { skipped++; return; }
      tkWriteRow_(ctx, ctx.sheet.getLastRow() + 1, { "Име": n, "Активен": "да" });
      have[n] = 1; added++;
    });
    if (added) tkLog_(admin, "Служители от списъка", added + " добавени", "");
    if (skipped) tkLog_(admin, "Отказан достъп", tkOwnerStaff_(), "опит за добавяне от списъка");
    SpreadsheetApp.flush();
    return jsonResponse_({ success: true, added: added });
  } finally { lock.releaseLock(); }
}
function handleTasksStaffSave_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var name = tkClean_(data.name, 80);
  if (!name) return jsonResponse_({ success: false, code: "MISSING", error: "Липсва име." });
  if (tkProtected_(admin, name)) return tkForbidden_(admin, "опит за промяна (ранг/позиция/ПИН)");
  var pin = data.pin == null ? null : String(data.pin);
  if (pin !== null && pin !== "" && !/^\d{4,8}$/.test(pin)) return jsonResponse_({ success: false, code: "BAD_PIN", error: "ПИН-ът е от 4 до 8 цифри." });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ctx = tkSheet_(tkOpen_(), TK_STAFF_SHEET, TK_STAFF_HEADERS);
    var s = tkRows_(ctx, TK_STAFF_HEADERS).filter(function (x) { return x["Име"] === name; })[0];
    var row = s ? s._row : ctx.sheet.getLastRow() + 1;
    var obj = { "Име": name, "Ранг": tkClean_(data.rank, 60), "Позиция": tkClean_(data.position, 80) };
    if (!s) obj["Активен"] = "да";
    if (pin !== null) obj["ПИН"] = pin === "" ? "" : tkHashPin_(pin);   // "" = махни ПИН-а
    tkWriteRow_(ctx, row, obj);
    tkLog_(admin, "Промяна на служител", name, [obj["Ранг"] && "ранг: " + obj["Ранг"], obj["Позиция"] && "позиция: " + obj["Позиция"], pin !== null ? (pin ? "нов ПИН" : "махнат ПИН") : ""].filter(Boolean).join(", "));
    SpreadsheetApp.flush();
    return jsonResponse_({ success: true, name: name });
  } finally { lock.releaseLock(); }
}

/* ══════════════════════════════════════════════════════════════
   ОБЗОР за администратора — обобщение от всички листове: проверки (ИНФО),
   графикът за съблекалните, Lost & Found и задачите. Само чете — нищо не
   записва. Резултатът се пази в кеша (виж handleTasksOverview_), за да не
   се четат листовете при всяко отваряне.
   ══════════════════════════════════════════════════════════════ */
var TK_OVERVIEW_DAYS = 30;
var TK_OVERVIEW_CHUNK = 1500;   // редове на едно четене от ИНФО (отдолу нагоре)
function tkDayStr_(n) {
  var d = new Date(n * 86400000), p = function (x) { return (x < 10 ? "0" : "") + x; };
  return p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1) + "." + d.getUTCFullYear();
}
function tkTop_(obj, n) {
  return Object.keys(obj).map(function (k) { return [k, obj[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n);
}
function tkInspectionStats_(ss, today) {
  var W = TK_OVERVIEW_DAYS;
  var sh = ss.getSheetByName("ИНФО") || ss.getSheetByName("Sheet1") || ss.getSheets()[0];
  var out = { total: 0, n: 0, p: 0, prevN: 0, prevP: 0, daily: [], locations: [], issues: [], inspectors: [], zeroDays: 0 };
  var last = sh.getLastRow();
  if (last < 2) return out;
  // Целият лист се чете над 30 с (виж „Данни" в index.html), а обзорът
  // има нужда само от последните 2 × W дни. Редовете се добавят отдолу,
  // затова четем отдолу нагоре на парчета, докато стигнем по-стар ред.
  var vals = [], end = last;
  while (end >= 2) {
    var start = Math.max(2, end - TK_OVERVIEW_CHUNK + 1);
    var part = sh.getRange(start, 1, end - start + 1, 6).getDisplayValues();
    vals = part.concat(vals);
    end = start - 1;
    var oldest = null;
    for (var q = 0; q < part.length && oldest == null; q++) oldest = tkDay_(part[q][1]);
    if (oldest != null && today - oldest >= 2 * W) break;
  }
  out.total = last - 1;
  // Последната проверка за всяко място се помни отделно — място, което не е
  // проверявано повече от 2 × W дни, иначе би изчезнало от списъка.
  var props = PropertiesService.getScriptProperties(), seen = {};
  try { seen = JSON.parse(props.getProperty("tk_loc_last") || "{}") || {}; } catch (_) { seen = {}; }
  var days = {}, locs = {}, iss = {}, issPrev = {}, insp = {};
  Object.keys(seen).forEach(function (k) { locs[k] = { name: k, n: 0, p: 0, last: seen[k], top: {} }; });
  for (var r = 0; r < vals.length; r++) {
    var row = vals[r], d = tkDay_(row[1]);
    if (d == null) continue;
    var type = String(row[2] || "").trim() || "—", bad = String(row[4]).trim() === "Проблем";
    var list = String(row[5] || "").split(/\s*,\s*/).filter(function (x) { return x && x !== "—"; });
    var loc = locs[type] || (locs[type] = { name: type, n: 0, p: 0, last: null, top: {} });
    if (loc.last == null || d > loc.last) loc.last = d;
    var age = today - d;
    if (age >= 0 && age < W) {
      out.n++; if (bad) out.p++;
      var day = days[d] || (days[d] = { n: 0, p: 0 }); day.n++; if (bad) day.p++;
      loc.n++; if (bad) loc.p++;
      list.forEach(function (x) { iss[x] = (iss[x] || 0) + 1; loc.top[x] = (loc.top[x] || 0) + 1; });
      var who = String(row[3] || "").trim();
      if (who) { var w = insp[who] || (insp[who] = { name: who, n: 0, p: 0 }); w.n++; if (bad) w.p++; }
    } else if (age >= W && age < 2 * W) {
      out.prevN++; if (bad) out.prevP++;
      list.forEach(function (x) { issPrev[x] = (issPrev[x] || 0) + 1; });
    }
  }
  var seenNew = {};
  Object.keys(locs).forEach(function (k) { if (locs[k].last != null) seenNew[k] = locs[k].last; });
  try { props.setProperty("tk_loc_last", JSON.stringify(seenNew)); } catch (_) {}
  for (var i = W - 1; i >= 0; i--) {
    var k = today - i, v = days[k] || { n: 0, p: 0 };
    out.daily.push({ date: tkDayStr_(k), n: v.n, p: v.p });
    if (i < 14 && !v.n) out.zeroDays++;
  }
  out.locations = Object.keys(locs).map(function (k) {
    var l = locs[k];
    return { name: l.name, n: l.n, p: l.p, last: l.last == null ? "" : tkDayStr_(l.last), since: l.last == null ? null : today - l.last, top: tkTop_(l.top, 3) };
  }).sort(function (a, b) { return (b.n ? b.p / b.n : 0) - (a.n ? a.p / a.n : 0) || b.n - a.n; });
  out.issues = tkTop_(iss, 10).map(function (x) { return { name: x[0], n: x[1], prev: issPrev[x[0]] || 0 }; });
  out.inspectors = Object.keys(insp).map(function (k) { return insp[k]; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 15);
  return out;
}
/* Графикът в „Почистване съблекални": A = дата, B = мъжка, C = женска
   (попълва се името на почистилия). Празна клетка след датата = пропуснато. */
function tkChangingRoomStats_(ss, today) {
  var out = { found: false, upcoming: [], missed: [], done: 0, due: 0 };
  var sh = getSheetLoose_(ss, CHANGING_ROOMS_SHEET);
  if (!sh || sh.getLastRow() < 1) return out;
  out.found = true;
  var vals = sh.getRange(1, 1, sh.getLastRow(), 3).getDisplayValues();
  vals.forEach(function (row) {
    var d = tkDay_(row[0]);
    if (d == null) return;
    var male = String(row[1] || "").trim(), female = String(row[2] || "").trim();
    if (d >= today) {
      if (out.upcoming.length < 8) out.upcoming.push({ date: tkDayStr_(d), days: d - today, male: male, female: female });
    } else if (today - d <= TK_OVERVIEW_DAYS) {
      out.due++;
      if (male && female) out.done++;
      else out.missed.push({ date: tkDayStr_(d), male: male, female: female });
    }
  });
  out.missed.reverse();
  return out;
}
function tkLostFoundStats_(ss, today) {
  var out = { found: false, total: 0, open: 0, returned: 0, old: 0, cats: [] };
  var ctx = lfSheet_(ss, true);
  if (!ctx) return out;
  out.found = true;
  var cats = {};
  lfReadAll_(ctx).forEach(function (it) {
    out.total++;
    if (it.status === "Върната") { out.returned++; return; }
    out.open++;
    var d = tkDay_(it.date);
    if (d != null && today - d > 30) out.old++;
    if (it.category) cats[it.category] = (cats[it.category] || 0) + 1;
  });
  out.cats = tkTop_(cats, 5);
  return out;
}
function tkTaskStats_(ss, today) {
  var out = { open: 0, overdue: 0, waiting: 0, done: 0, onTime: 0, avg: null, rated: 0, late: [] };
  var sum = 0, lateBy = {};
  tkRows_(tkSheet_(ss, TK_SHEET, TK_HEADERS), TK_HEADERS).forEach(function (t) {
    if (!t["ID"]) return;
    if (t["Статус"] === "Възложена") {
      out.open++;
      if (tkOverdue_(t)) { out.overdue++; lateBy[t["Възложена на"]] = (lateBy[t["Възложена на"]] || 0) + 1; }
    }
    if (t["Статус"] === "Изпълнена") out.waiting++;
    var dd = tkDay_(t["Изпълнена на"]);
    if ((t["Статус"] === "Изпълнена" || t["Статус"] === "Оценена") && dd != null && today - dd < TK_OVERVIEW_DAYS) {
      out.done++;
      if (!tkLate_(t)) out.onTime++;
      if (t["Оценка"]) { out.rated++; sum += Number(t["Оценка"]) || 0; }
    }
  });
  if (out.rated) out.avg = Math.round(sum / out.rated * 10) / 10;
  out.late = tkTop_(lateBy, 5);
  return out;
}
/* Обзорът се пази в кеша до 6 часа. Обикновената заявка винаги връща
   кеша веднага (под секунда), ако го има; admin.html сам иска свеж обзор
   отзад, когато кешът е по-стар от 10 минути. „Обнови" (fresh) го прескача. */
var TK_OVERVIEW_TTL = 21600;
function tkOverviewBuild_() {
  var ss = tkOpen_(), today = tkToday_(), res = { success: true, today: tkDayStr_(today), days: TK_OVERVIEW_DAYS, at: tkNow_(), ts: Date.now() };
  // Всеки лист поотделно: грешка в един не спира останалите.
  [["inspections", tkInspectionStats_], ["rooms", tkChangingRoomStats_], ["lostFound", tkLostFoundStats_], ["tasks", tkTaskStats_]].forEach(function (p) {
    try { res[p[0]] = p[1](ss, today); } catch (e) { res[p[0]] = { error: String(e) }; }
  });
  var json = JSON.stringify(res);
  try { if (json.length < 90000) CacheService.getScriptCache().put("tk_overview", json, TK_OVERVIEW_TTL); } catch (_) {}
  return json;
}
function handleTasksOverview_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var hit = data.fresh ? null : CacheService.getScriptCache().get("tk_overview");
  return ContentService.createTextOutput(hit || tkOverviewBuild_()).setMimeType(ContentService.MimeType.JSON);
}
/* По желание: тригер по време (Apps Script → Тригери → warmOverview, на
   всеки 10 минути) държи обзора и основната база на ИНФО винаги готови
   в кеша, така че никой не чака пълното четене. */
function warmOverview() {
  tkOverviewBuild_();
  var ss = tkOpen_();
  infoAll_(ss.getSheetByName("ИНФО") || ss.getSheetByName("Sheet1") || ss.getSheets()[0]);
}

/* ══════════════════════════════════════════════════════════════
   ЛОГ НА АДМИНИСТРАТОРИТЕ — кой какво е направил и кога. Всяко действие
   от admin.html добавя ред в листа „Админ лог". ПИН-ове и пароли никога
   не се записват. Грешка в лога не спира самото действие.
   ══════════════════════════════════════════════════════════════ */
var TK_LOG_SHEET = "Админ лог";
var TK_LOG_HEADERS = ["Дата", "Администратор", "Действие", "Обект", "Подробности"];
function tkLog_(admin, action, target, details) {
  try {
    var vals = [tkNow_(), admin, action, tkClean_(target, 200), tkClean_(details, 500)].map(tkText_);
    // Бързо: листът вече съществува с тези колони — само добавяме ред.
    var sh = tkOpen_().getSheetByName(TK_LOG_SHEET);
    if (sh) { sh.appendRow(vals); return; }
    var ctx = tkSheet_(tkOpen_(), TK_LOG_SHEET, TK_LOG_HEADERS), row = [];
    for (var i = 0; i < ctx.sheet.getLastColumn(); i++) row.push("");
    TK_LOG_HEADERS.forEach(function (h, j) { row[ctx.map[h]] = vals[j]; });
    ctx.sheet.appendRow(row);
  } catch (e) { Logger.log("tkLog_: " + e); }
}
function handleTasksLog_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  if (!tkIsOwner_(admin)) {
    tkLog_(admin, "Отказан достъп", "Логове", "опит за преглед на логовете");
    return jsonResponse_({ success: false, code: "FORBIDDEN", error: "Логовете се виждат само от главния администратор." });
  }
  var ctx = tkSheet_(tkOpen_(), TK_LOG_SHEET, TK_LOG_HEADERS), sh = ctx.sheet, last = sh.getLastRow();
  var limit = Math.min(1000, Math.max(50, Number(data.limit) || 500)), out = [];
  if (last >= 2) {
    var from = Math.max(2, last - limit + 1);
    var vals = sh.getRange(from, 1, last - from + 1, sh.getLastColumn()).getDisplayValues();
    for (var r = vals.length - 1; r >= 0; r--) {
      var v = vals[r];
      out.push({ at: v[ctx.map["Дата"]], admin: v[ctx.map["Администратор"]], action: v[ctx.map["Действие"]], target: v[ctx.map["Обект"]], details: v[ctx.map["Подробности"]] });
    }
  }
  return jsonResponse_({ success: true, entries: out, total: Math.max(0, last - 1) });
}

/* ══════════════════════════════════════════════════════════════
   АВТОМАТИЧНО АРХИВИРАНЕ — задачи, създадени преди повече от 3 месеца
   (90 дни), се махат от системата: преместват се в листа „Tasks архив"
   (нищо не се губи — оценки, часове и коментари остават там). Проверява
   се най-много веднъж на 6 часа, при отваряне на таблото или admin.html.
   ══════════════════════════════════════════════════════════════ */
var TK_ARCHIVE_SHEET = "Tasks архив";
var TK_ARCHIVE_DAYS = 90;
function tkArchiveOld_() {
  var cache = CacheService.getScriptCache();
  if (cache.get("tk_archived")) return 0;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 0;
  try {
    var ss = tkOpen_(), ctx = tkSheet_(ss, TK_SHEET, TK_HEADERS), today = tkToday_();
    var old = tkRows_(ctx, TK_HEADERS).filter(function (t) {
      var d = tkDay_(t["Създадена"]);
      return t["ID"] && d != null && today - d >= TK_ARCHIVE_DAYS;
    });
    if (old.length) {
      var heads = TK_HEADERS.concat(["Архивирана на"]);
      var actx = tkSheet_(ss, TK_ARCHIVE_SHEET, heads), now = tkNow_();
      old.forEach(function (t) {
        var obj = {};
        TK_HEADERS.forEach(function (h) { obj[h] = t[h]; });
        obj["Архивирана на"] = now;
        tkWriteRow_(actx, actx.sheet.getLastRow() + 1, obj);
      });
      // Отдолу нагоре, за да не се разместват номерата на редовете.
      old.sort(function (a, b) { return b._row - a._row; }).forEach(function (t) { ctx.sheet.deleteRow(t._row); });
      tkLog_("система", "Автоматично архивиране", old.length + " задачи", "създадени преди повече от " + TK_ARCHIVE_DAYS + " дни → „" + TK_ARCHIVE_SHEET + "“");
      SpreadsheetApp.flush();
    }
    cache.put("tk_archived", "1", 21600);
    return old.length;
  } finally { lock.releaseLock(); }
}

/* ══════════════════════════════════════════════════════════════
   ДОСИЕ НА СЛУЖИТЕЛЯ — информация, която администраторът попълва за
   всеки служител (телефон, имейл, спешен контакт, постъпване…). Само за
   администратори: никога не излиза към приложението на служителите.
   Досието на главния администратор (защитения запис) се вижда и променя
   само от него. В „Логове" се записва, че е променено — без самите данни.
   ══════════════════════════════════════════════════════════════ */
var TK_DOSSIER_SHEET = "Досиета";
var TK_DOSSIER_FIELDS = [
  { key: "phone", h: "Телефон", max: 30, re: /^[+0-9 ()\/-]{5,30}$/, err: "Телефонът е само с цифри, интервали и +()-." },
  { key: "email", h: "Имейл", max: 120, re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, err: "Невалиден имейл." },
  { key: "address", h: "Адрес", max: 200 },
  { key: "birthday", h: "Рожден ден", max: 10, re: /^\d{2}\.\d{2}\.\d{4}$/, err: "Датата е във формат дд.мм.гггг." },
  { key: "started", h: "Постъпил на", max: 10, re: /^\d{2}\.\d{2}\.\d{4}$/, err: "Датата е във формат дд.мм.гггг." },
  { key: "contract", h: "Договор", max: 60 },
  { key: "emergencyName", h: "Спешен контакт", max: 80 },
  { key: "emergencyPhone", h: "Телефон за спешен контакт", max: 30, re: /^[+0-9 ()\/-]{5,30}$/, err: "Телефонът за спешен контакт е само с цифри, интервали и +()-." },
  { key: "uniform", h: "Размер униформа", max: 20 },
  { key: "languages", h: "Езици", max: 120 },
  { key: "skills", h: "Умения и обучения", max: 500 },
  { key: "notes", h: "Бележки", max: 3000 }
];
var TK_DOSSIER_HEADERS = ["Име"].concat(TK_DOSSIER_FIELDS.map(function (f) { return f.h; }), ["Обновено", "Обновил"]);
function tkDossierOut_(row) {
  var o = {};
  TK_DOSSIER_FIELDS.forEach(function (f) { o[f.key] = row ? row[f.h] : ""; });
  o.updated = row ? row["Обновено"] : ""; o.updatedBy = row ? row["Обновил"] : "";
  return o;
}
function handleTasksDossier_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var name = tkClean_(data.name, 80);
  if (tkProtected_(admin, name)) return tkForbidden_(admin, "опит за преглед на досие");
  var ctx = tkSheet_(tkOpen_(), TK_DOSSIER_SHEET, TK_DOSSIER_HEADERS);
  var row = tkRows_(ctx, TK_DOSSIER_HEADERS).filter(function (x) { return x["Име"] === name; })[0];
  return jsonResponse_({ success: true, name: name, dossier: tkDossierOut_(row) });
}
function handleTasksDossierSave_(data) {
  var admin = tkCheckToken_(data.token);
  if (!admin) return tkDeny_();
  var name = tkClean_(data.name, 80), d = data.dossier || {};
  if (!name) return jsonResponse_({ success: false, code: "MISSING", error: "Липсва име." });
  if (tkProtected_(admin, name)) return tkForbidden_(admin, "опит за промяна на досие");
  var obj = {}, bad = null;
  TK_DOSSIER_FIELDS.forEach(function (f) {
    var v = f.key === "notes" || f.key === "skills" ? String(d[f.key] == null ? "" : d[f.key]).replace(/\r/g, "").trim().slice(0, f.max) : tkClean_(d[f.key], f.max);
    if (v && f.re && !f.re.test(v) && !bad) bad = { code: "BAD_" + f.key.toUpperCase(), error: f.err };
    obj[f.h] = v;
  });
  if (bad) return jsonResponse_({ success: false, code: bad.code, error: bad.error });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = tkOpen_();
    if (!tkStaff_(ss).some(function (x) { return x["Име"] === name; })) return jsonResponse_({ success: false, code: "NOT_FOUND", error: "Няма такъв служител." });
    var ctx = tkSheet_(ss, TK_DOSSIER_SHEET, TK_DOSSIER_HEADERS);
    var row = tkRows_(ctx, TK_DOSSIER_HEADERS).filter(function (x) { return x["Име"] === name; })[0];
    var changed = TK_DOSSIER_FIELDS.filter(function (f) { return String(row ? row[f.h] : "") !== obj[f.h]; }).map(function (f) { return f.h.toLowerCase(); });
    obj["Име"] = name; obj["Обновено"] = tkNow_(); obj["Обновил"] = admin;
    tkWriteRow_(ctx, row ? row._row : ctx.sheet.getLastRow() + 1, obj);
    if (changed.length) tkLog_(admin, "Досие", name, "променено: " + changed.join(", "));
    SpreadsheetApp.flush();
    var out = {}; TK_DOSSIER_HEADERS.forEach(function (h) { out[h] = String(obj[h] == null ? "" : obj[h]); });
    return jsonResponse_({ success: true, name: name, dossier: tkDossierOut_(out) });
  } finally { lock.releaseLock(); }
}
