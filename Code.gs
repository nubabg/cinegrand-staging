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
        data = sheet.getDataRange().getDisplayValues();
      }
      // limited казва на клиента, че липсва история — само тогава той си
      // дърпа пълния лист, когато потребителят отвори „Данни".
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, data: data, limited: limited }))
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

    var record = data.record;
    var ss = SpreadsheetApp.openById("17cuchNPS7ajySczy-Wc7eUlDFgAClaE8gsZrqCXAKcA");
    var sheet = ss.getSheetByName("ИНФО") || ss.getSheetByName("Sheet1") || ss.getSheets()[0];
    var lastRow = sheet.getLastRow();
    var nextRow = lastRow < 1 ? 2 : lastRow + 1;
    var recordNumber = nextRow - 1;
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
    var dateStr = Utilities.formatDate(date, "Europe/Sofia", "dd.MM.yyyy HH:mm");
    var typeText = record.type === "hall"
      ? "Кинозала - " + record.location
      : "Тоалетна - " + record.location;
    // Записване на данните
    sheet.getRange(nextRow, 1).setValue(recordNumber);
    sheet.getRange(nextRow, 2).setValue(dateStr);
    sheet.getRange(nextRow, 3).setValue(typeText);
    sheet.getRange(nextRow, 4).setValue(record.inspector);
    sheet.getRange(nextRow, 5).setValue(status);
    sheet.getRange(nextRow, 6).setValue(issuesText);
    sheet.getRange(nextRow, 7).setValue(notes);
    // Колона 8: Линк(ове) към снимка/снимки (ако има)
    var photoUrls = [];
    if (record.photoUrls && record.photoUrls.length) {
      photoUrls = record.photoUrls;
    } else if (record.photoUrl) {
      photoUrls = [record.photoUrl];
    }
    if (photoUrls.length === 1) {
      sheet.getRange(nextRow, 8).setFormula('=HYPERLINK("' + photoUrls[0] + '";"📷 Виж снимка")');
    } else if (photoUrls.length > 1) {
      var label = "📷 " + photoUrls.length + " снимки";
      sheet.getRange(nextRow, 8).setFormula('=HYPERLINK("' + photoUrls[0] + '";"' + label + '")');
      sheet.getRange(nextRow, 8).setNote(photoUrls.join("\n"));
    } else {
      sheet.getRange(nextRow, 8).setValue("—");
    }
    // Автоматично форматиране на новия ред
    styleInfoRow(sheet, nextRow);
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, row: nextRow, recordNumber: recordNumber }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
// -----------------------------------------------------------
// 2. styleInfoRow - форматира един ред в ИНФО автоматично
// -----------------------------------------------------------
function styleInfoRow(sheet, row) {
  try {
    var range = sheet.getRange(row, 1, 1, 8);
    // Редуване на цветове: четни = тъмно синьо, нечетни = малко по-светло
    var bgColor = (row % 2 === 0) ? "#1a2744" : "#1e3054";
    range.setBackground(bgColor);
    range.setFontColor("#FFFFFF");
    range.setFontFamily("Arial");
    range.setFontSize(10);
    range.setVerticalAlignment("middle");
    // Граница
    range.setBorder(true, true, true, true, true, true, "#2d4a7a", SpreadsheetApp.BorderStyle.SOLID);
    // Специфични ширини по колона
    range.setHorizontalAlignment("center");
    sheet.getRange(row, 6, 1, 1).setHorizontalAlignment("left"); // ПРОБЛЕМИ - ляво
    sheet.getRange(row, 7, 1, 1).setHorizontalAlignment("left"); // БЕЛЕЖКИ - ляво
    sheet.getRange(row, 8, 1, 1).setHorizontalAlignment("center"); // СНИМКА - центрирано
    // Wrap text за ПРОБЛЕМИ и БЕЛЕЖКИ
    sheet.getRange(row, 6, 1, 1).setWrap(true);
    sheet.getRange(row, 7, 1, 1).setWrap(true);
    // СНИМКА линк - синьо оцветяване
    sheet.getRange(row, 8, 1, 1).setFontColor("#4da6ff").setFontWeight("bold");
    // Оцветяване на СТАТУС (колона 5)
    var statusCell = sheet.getRange(row, 5);
    var statusVal = statusCell.getValue();
    if (statusVal === "Чисто") {
      statusCell.setBackground("#1b5e20");
      statusCell.setFontColor("#a5d6a7");
      statusCell.setFontWeight("bold");
    } else if (statusVal === "Проблем") {
      statusCell.setBackground("#b71c1c");
      statusCell.setFontColor("#ffcdd2");
      statusCell.setFontWeight("bold");
    }
    // Задаване на минимална височина
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
    // Провери дали клетката вече е попълнена
    var existing = sheet.getRange(row, colIndex).getValue();
    if (existing && String(existing).trim() !== "") {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: "already_filled", existing: existing }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // Запиши името
    sheet.getRange(row, colIndex).setValue(name);
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
   колони. Викай под LockService, защото може да пише заглавия. */
function lfSheet_(ss) {
  var sheet = getSheetLoose_(ss, LF_SHEET);
  if (!sheet) {
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
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ctx = lfSheet_(lfOpen_());
    var items = lfReadAll_(ctx);
    // Редове, въведени ръчно в таблицата, получават ID, за да могат да се
    // променят и трият от системата.
    items.forEach(function (it) {
      if (!it.id) {
        it.id = lfNewId_();
        ctx.sheet.getRange(it._row, ctx.map.id).setNumberFormat("@").setValue(it.id);
      }
    });
    var admin = false;
    if (data.adminPass) {
      var chk = lfAdminCheck_(data.adminPass);
      if (!chk.ok) return jsonResponse_({ success: false, code: chk.code, error: chk.error });
      admin = true;
    }
    var list = items.map(function (it) {
      var o = {};
      LF_FIELDS.forEach(function (f) { o[f.key] = it[f.key]; });
      if (!admin) o.contact = lfMaskContact_(o.contact);
      return o;
    });
    return jsonResponse_({ success: true, admin: admin, items: list,
      statuses: LF_STATUSES, kinds: LF_KINDS, categories: LF_CATEGORIES });
  } finally {
    lock.releaseLock();
  }
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

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ctx = lfSheet_(lfOpen_());
    // Повторно изпращане на същия запис (напр. след изтекла връзка) не създава дубликат.
    var existing = lfReadAll_(ctx).filter(function (x) { return x.id === id; })[0];
    if (existing) return jsonResponse_({ success: true, id: id, duplicate: true });

    if (data.photoData) {
      try {
        var blob = Utilities.newBlob(Utilities.base64Decode(String(data.photoData)), "image/jpeg", id + ".jpg");
        var folder = lfPhotoFolder_();
        if (folder) {
          var file = folder.createFile(blob);
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          rec.photo = file.getUrl();
        }
      } catch (photoErr) {
        rec.photo = "";   // вещта се записва и без снимка
      }
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
    return cb(ctx, hit);
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
