// ========================================================
// CG CLAN INFO - Google Apps Script
// Основен скрипт: получава данни от сайта + автоматизация
// ========================================================

// ID на таблицата Локс (с dropdown в L1 за refresh)
var LOCK_SPREADSHEET_ID = "1UDZQAZU2WAs8G6Yh_II-PZp_0oTj6kGj__b8qecgMAU";

// -----------------------------------------------------------
// doGet(e) - за refresh polling от сайта
// Поддържа ?callback=fn за JSONP (обходи CORS)
// -----------------------------------------------------------
function doGet(e) {
  var result = handleGetRefreshSignal_();
  var callback = e && e.parameter && e.parameter.callback;
  if (callback && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(callback)) {
    var json = result.getContent();
    var js = callback + "(" + json + ")";
    return ContentService.createTextOutput(js).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return result;
}

function handleGetRefreshSignal_() {
  try {
    var ss = SpreadsheetApp.openById(LOCK_SPREADSHEET_ID);
    var sheet = ss.getSheetByName("Локс") || ss.getSheetByName("Locks") || ss.getSheets()[0];
    if (!sheet) return jsonResponse_({ action: "do_nothing" });
    var val = (sheet.getRange("L1").getValue() || "").toString().toUpperCase();
    if (val.indexOf("REFRESH") >= 0) {
      sheet.getRange("L1").setValue("DO NOTHING IN WEBSITES!");
      SpreadsheetApp.flush();
      return jsonResponse_({ action: "refresh" });
    }
    return jsonResponse_({ action: "do_nothing" });
  } catch (e) {
    return jsonResponse_({ action: "do_nothing", error: e.message });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ВАЖНО: Deploy → Manage deployments → Edit → New version → Deploy

// -----------------------------------------------------------
// 1. doPost(e) - получава данни от сайта и записва в ИНФО
// -----------------------------------------------------------
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (data.action === "acquireLock") return handleAcquireLock_(data);
    if (data.action === "releaseLock") return handleReleaseLock_(data);

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
    var range = sheet.getRange(row, 1, 1, 7);

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

    // Wrap text за ПРОБЛЕМИ и БЕЛЕЖКИ
    sheet.getRange(row, 6, 1, 1).setWrap(true);
    sheet.getRange(row, 7, 1, 1).setWrap(true);

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

  var headerRange = sheet.getRange(1, 1, 1, 7);
  headerRange.setBackground(COLOR_HEADER_BG);
  headerRange.setFontColor(COLOR_HEADER_TEXT);
  headerRange.setFontFamily("Arial");
  headerRange.setFontSize(11);
  headerRange.setFontWeight("bold");
  headerRange.setVerticalAlignment("middle");
  headerRange.setHorizontalAlignment("center");
  headerRange.setBorder(true, true, true, true, true, true, COLOR_BORDER, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.setRowHeight(1, 40);

  for (var r = 2; r <= totalRows; r++) {
    var rowRange = sheet.getRange(r, 1, 1, 7);
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

  var fullRange = sheet.getRange(1, 1, totalRows, 7);
  fullRange.setBorder(true, true, true, true, null, null, COLOR_BORDER, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 145);
  sheet.setColumnWidth(3, 160);
  sheet.setColumnWidth(4, 130);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 230);
  sheet.setColumnWidth(7, 190);

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

  var hdr = sheet.getRange(1, 1, 1, 7);
  hdr.setBackground(HDR_BG);
  hdr.setFontColor(HDR_FG);
  hdr.setFontFamily("Arial");
  hdr.setFontSize(11);
  hdr.setFontWeight("bold");
  hdr.setVerticalAlignment("middle");
  hdr.setHorizontalAlignment("center");
  hdr.setBorder(true, true, true, true, true, true, GOLD, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.setRowHeight(1, 40);

  var allData = sheet.getRange(2, 1, totalRows - 1, 7);
  allData.setBackground(ODD_BG);
  allData.setFontColor(ROW_FG);
  allData.setFontFamily("Arial");
  allData.setFontSize(10);
  allData.setVerticalAlignment("middle");
  allData.setFontWeight("normal");
  allData.setBorder(true, true, true, true, true, true, INNER, SpreadsheetApp.BorderStyle.SOLID);

  for (var r = 3; r <= totalRows; r += 2) {
    sheet.getRange(r, 1, 1, 7).setBackground(EVN_BG);
  }

  sheet.getRange(2, 1, totalRows - 1, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 2, totalRows - 1, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 3, totalRows - 1, 1).setHorizontalAlignment("left");
  sheet.getRange(2, 4, totalRows - 1, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 5, totalRows - 1, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 6, totalRows - 1, 1).setHorizontalAlignment("left");
  sheet.getRange(2, 7, totalRows - 1, 1).setHorizontalAlignment("left");

  sheet.getRange(2, 6, totalRows - 1, 1).setWrap(true);
  sheet.getRange(2, 7, totalRows - 1, 1).setWrap(true);

  sheet.setRowHeightsForced(2, totalRows - 1, 30);

  sheet.getRange(1, 1, totalRows, 7).setBorder(true, true, true, true, null, null, GOLD, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 145);
  sheet.setColumnWidth(3, 160);
  sheet.setColumnWidth(4, 130);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 230);
  sheet.setColumnWidth(7, 190);

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
