# Sync staging → inspection

## Еднократна настройка (1 мин)

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens**
2. **Generate new token (classic)**
3. Име: `inspection-sync`
4. Scope: `repo` (пълен достъп)
5. **Generate** → копирай токена

6. Отиди в **cinegrand-staging** repo
7. **Settings** → **Secrets and variables** → **Actions**
8. **New repository secret**
9. Име: `INSPECTION_PAT`
10. Стойност: влепи токена → **Add secret**

## Как да sync-неш

1. cinegrand-staging → **Actions**
2. Вляво: **Sync to Inspection (main site)**
3. **Run workflow** → **Run workflow**
4. Готово – cinegrand-inspection е обновен

## Спиране / пускане на workflow-а

**Спиране:** Преименувай `sync-to-inspection.yml` → `sync-to-inspection.yml.disabled`
**Пускане отново:** Преименувай `sync-to-inspection.yml.disabled` → `sync-to-inspection.yml`

След всяка промяна: Commit + push
