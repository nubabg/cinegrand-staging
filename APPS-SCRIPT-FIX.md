# Поправка за Locks в Apps Script

## 1. Добави този ред в doPost (веднага след releaseLock)

В началото на `doPost(e)`, след реда за `releaseLock`, добави:

```javascript
if (data.action === "acquireLockFirstFree") return handleAcquireLockFirstFree_(data);
```

Трябва да изглежда така:

```javascript
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (data.action === "acquireLock") return handleAcquireLock_(data);
    if (data.action === "releaseLock") return handleReleaseLock_(data);
    if (data.action === "acquireLockFirstFree") return handleAcquireLockFirstFree_(data);  // ← ДОБАВИ ТОЗИ РЕД

    var record = data.record;
    // ... останалият код
```

## 2. Провери дали имаш locks.gs

Трябва да имаш файл **locks.gs** с функциите:
- `handleAcquireLock_`
- `handleReleaseLock_`
- `handleAcquireLockFirstFree_`
- `getLockSheet_`
- `jsonResponse_`

Ако нямаш такъв файл, създай нов (File → New → Script file) и копирай целия код от `locks.gs` в репото.

## 3. Лист "Locks"

Скриптът използва лист с име **"Locks"** (не "Локс"). Ако няма такъв лист, той се създава автоматично при първо заключване. Листът "Локс" (с dropdown в L1) остава отделно за refresh.

## 4. Redeploy

След промените: **Deploy** → **Manage deployments** → **Edit** → **New version** → **Deploy**
