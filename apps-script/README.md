# Location Inspection Locks – Google Apps Script

Този код добавя lock механизъм за проверки на локации. Когато някой сканира QR и започне проверка на Зала 1, локацията се „заключва“. Други не могат да започнат проверка на същата зала, докато първият не приключи или не изтече времето (45 мин).

## Инсталация

1. Отвори Google Apps Script проекта, свързан с твоята Spreadsheet (този, който обслужва `SHEETS_WEB_APP_URL`).
2. Добави съдържанието на `Locks.gs` като нов файл в проекта (или копирай функциите в съществуващ файл).
3. Модифицирай `doPost` да обработва `acquireLock` и `releaseLock`:

```javascript
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || "{}");
    var action = data.action;

    if (action === "acquireLock") {
      return ContentService.createTextOutput(JSON.stringify(handleAcquireLock(data)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (action === "releaseLock") {
      return ContentService.createTextOutput(JSON.stringify(handleReleaseLock(data)))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Съществуваща логика за запис на record...
    // ...
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

4. Ако имаш `doGet` за CORS или други нужди, увери се че `doPost` е наличен.
5. Деплойни новата версия на Web App (Deploy → Manage deployments → Edit → Version: New version).

## Лист „Locks“

При първо извикване на `acquireLock` ще се създаде автоматично лист „Locks“ в същия spreadsheet с колони:

| type | location | session_id | expires_at |
|------|----------|------------|------------|
| hall | Зала 1   | uuid-xxx   | 2025-03-17T15:45:00 |

## Endpoints

### acquireLock
- **POST** с JSON body: `{ "action": "acquireLock", "type": "hall", "location": "Зала 1", "sessionId": "uuid" }`
- Успех: `{ "ok": true }`
- Грешка (заето): `{ "ok": false, "error": "locked", "message": "Локацията вече се проверява..." }`

### releaseLock
- **POST** с JSON body: `{ "action": "releaseLock", "sessionId": "uuid" }`
- Успех: `{ "ok": true }`

## Timeout

Lock-ът изтича след **45 минути**. Изтеклите записи се изчистват при всяко извикване на `acquireLock` или `releaseLock`.
