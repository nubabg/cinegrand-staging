# Production Readiness Audit Report
**Cine Grand Hygiene Control Platform**  
**Date:** 2025-03-17

---

## 1. Audit Summary

### Scope
- **index.html** – Single-page app (state, rendering, charts, forms, Sheets sync, locks, QR, geolocation)
- **Code.gs** – Google Apps Script (doPost, record handling, validation)
- **locks.gs** – Lock management (reference; handlers must be in Apps Script project)

### Areas Checked
- Frontend behavior (UI states, rendering, modals)
- Data flow (fetch, parse, normalize, charts)
- Forms and validation (inspection, submit, duplicate prevention)
- Integration (Sheets, locks, gviz, CSV fallback)
- State management (records, sync, cooldowns)
- Error handling and edge cases

---

## 2. Findings and Fixes

### Critical (Fixed)

| Issue | Root Cause | Fix |
|-------|------------|-----|
| **dirtyItems crash** | `record.items` undefined on corrupted/old data | `(record && record.items \|\| []).filter(...)` |
| **colVal crash** | `Object.keys(row)` on null/undefined row | Guard: `if (!row \|\| typeof row !== 'object') return ''` |
| **Charts table crash** | `inspEntries[0][1]` when empty | `(inspEntries[0] && inspEntries[0][1]) \|\| 1` |
| **parseCSV crash** | `lines[0].split` on empty input | Check `lines.length > 0` before use |
| **submitInspection stuck** | `_submitBusy` not reset on exception | Wrapped in `try/finally` |
| **Code.gs invalid record** | No validation for `data.record` | Early return with error if missing/invalid |

### Medium (Fixed)

| Issue | Root Cause | Fix |
|-------|------------|-----|
| **acquireLockFirstFree not routed** | Code.gs only handled acquireLock/releaseLock | Added `acquireLockFirstFree` routing |
| **gviz null row** | Row without `row.c` could throw | Filter: `if (!row \|\| !row.c) return null` |
| **recordsForRange invalid timestamp** | Corrupted `r.timestamp` could break filter | try/catch + `isNaN(d.getTime())` guard |
| **issue chart division by zero** | `maxIss` 0 when all counts 0 | `Math.max(1, ...)` for maxIss |
| **Code.gs missing fields** | `record.inspector`, `record.timestamp` undefined | Fallbacks: `\|\| "—"`, `record.timestamp ? new Date(...) : new Date()` |

### Minor (Addressed)

- **Malformed chart rows** – Skip non-object rows in `rows.forEach`
- **parseCSV empty lines** – Filter before processing

---

## 3. Features Preserved

- Home, inspection, history, charts navigation
- QR modal (open/close without full re-render)
- Delete modal with password
- Charts cooldown (15s), button-only update
- Lock acquire/release, beacon on exit
- Geolocation access control
- Sheets sync (POST, retry)
- PDF export
- Form validation (inspector, items, location)

---

## 4. Production Readiness

### Stable
- Core flows (inspection, submit, sync) are protected
- Charts handle empty/invalid data
- Submit cannot get stuck on error
- Code.gs validates input and handles missing fields

### Requirements
1. **Apps Script** – `locks.gs` must be in the project (handleAcquireLock_, handleReleaseLock_, handleAcquireLockFirstFree_)
2. **LOCK_SPREADSHEET_ID** – Set in locks.gs to the Locks spreadsheet ID
3. **SHEETS_WEB_APP_URL** – Correct Web App URL in index.html

### Remaining Notes
- **DELETE_PASSWORD** – Stored in client; acceptable for local-only delete
- **api.ipify.org** – Used for IP whitelist; failure is non-blocking
- **Charts** – Data from public gviz/CSV; no auth

---

## 5. Conclusion

**Status: Production-ready**

The site is stable for normal use. Critical and medium issues have been fixed. Core behavior is unchanged. Remaining items are configuration (Sheets URL, Locks ID) and deployment (Apps Script with locks.gs).
