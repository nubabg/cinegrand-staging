#!/bin/bash
# Обновява version.json и пуша — всички отворени сайтове ще се презаредят в рамките на ~45 сек
cd "$(dirname "$0")"
echo '{"t":'$(date +%s)'}' > version.json
git add version.json
git commit -m "chore: refresh signal"
git push
echo "✓ Refresh signal изпратен. Отворените табове ще се презаредят в рамките на ~45 сек."
