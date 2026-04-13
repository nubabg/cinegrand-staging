// ========================================================
// CG CLAN INFO - Google Apps Script
// Основен скрипт: получава данни от сайта + автоматизация
// ========================================================

// ── Shared secret — трябва да съвпада с SHEETS_SECRET_TOKEN в index.html ──
var SECRET_TOKEN = "cg-2025-secret-token";

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
      var data  = sheet.getDataRange().getDisplayValues();
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, data: data }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "getChangingRooms") {
      var sheet = ss.getSheetByName("Почистване съблекални");
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
    // Колона 8: Линк към снимка (ако има)
    if (record.photoUrl) {
      sheet.getRange(nextRow, 8).setFormula('=HYPERLINK("' + record.photoUrl + '";"📷 Виж снимка")');
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
    var sheet = ss.getSheetByName("Почистване съблекални");
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
    logPhotoToSheet_(ss, file, comment, location, inspector, timestamp);

    return ContentService
      .createTextOutput(JSON.stringify({
        success: true,
        photoUrl: file.getDownloadUrl(),
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
// Получаване или създаване на папка за снимки
// -------------------------------------------------------
function getOrCreatePhotosFolder_() {
  try {
    var scriptProperties = PropertiesService.getScriptProperties();
    var folderId = scriptProperties.getProperty("INSPECTION_PHOTOS_FOLDER_ID");

    // Ако вече имаме папка, върни я
    if (folderId) {
      try {
        return DriveApp.getFolderById(folderId);
      } catch (e) {
        // Папката е изтрита, създадем нова
        scriptProperties.deleteProperty("INSPECTION_PHOTOS_FOLDER_ID");
      }
    }

    // Създаване на нова папка
    var folderName = "Cinegrand_InspectionPhotos";
    var folders = DriveApp.getFoldersByName(folderName);

    var folder;
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.getRootFolder().createFolder(folderName);
    }

    // Съхранение на ID на папката
    scriptProperties.setProperty("INSPECTION_PHOTOS_FOLDER_ID", folder.getId());

    return folder;
  } catch (error) {
    Logger.log("Error in getOrCreatePhotosFolder_: " + error);
    return null;
  }
}

// -------------------------------------------------------
// Логване на снимка в PHOTOS лист
// -------------------------------------------------------
function logPhotoToSheet_(ss, file, comment, location, inspector, timestamp) {
  try {
    // Получаване или създаване на PHOTOS лист
    var sheet = ss.getSheetByName("PHOTOS");
    if (!sheet) {
      sheet = ss.insertSheet("PHOTOS");
      // Добавяне на хедъри
      sheet.getRange("A1").setValue("Линк към снимка");
      sheet.getRange("B1").setValue("Дата и час");
      sheet.getRange("C1").setValue("Коментар");
      sheet.getRange("D1").setValue("Локация");
      sheet.getRange("E1").setValue("Инспектор");

      // Форматиране на хедър ред
      var headerRange = sheet.getRange("A1:E1");
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
    }

    // Получаване на последния ред и добавяне на нов запис
    var lastRow = sheet.getLastRow();
    var nextRow = lastRow + 1;

    // Форматиране на дата/час
    var date = new Date(timestamp);
    var dateStr = Utilities.formatDate(date, "Europe/Sofia", "yyyy-MM-dd HH:mm:ss");

    // Записване на данните
    sheet.getRange(nextRow, 1).setValue(file.getDownloadUrl());
    sheet.getRange(nextRow, 2).setValue(dateStr);
    sheet.getRange(nextRow, 3).setValue(comment);
    sheet.getRange(nextRow, 4).setValue(location);
    sheet.getRange(nextRow, 5).setValue(inspector);

    // Форматиране на новия ред
    var dataRange = sheet.getRange(nextRow, 1, 1, 5);
    dataRange.setBackground("#1e3054");
    dataRange.setFontColor("#FFFFFF");
    dataRange.setFontSize(10);
    dataRange.setVerticalAlignment("top");
    dataRange.setWrap(true);

    // Линкът в колона A трябва да е синьо и подчертано
    sheet.getRange(nextRow, 1).setFontColor("#4da6ff");

    Logger.log("Photo logged to PHOTOS sheet: " + file.getName());
  } catch (error) {
    Logger.log("Error in logPhotoToSheet_: " + error);
  }
}
