#!/bin/bash
# ─────────────────────────────────────────────
# Bot Health Check + Auto-Restart
# ─────────────────────────────────────────────

BOT_DIR="/Users/stevenangel/Dropbox/Busniees assets 2026/drop-whatsapp-bot"
LOG_FILE="/tmp/drop-bot.log"
HEALTH_LOG="/tmp/drop-bot-health.log"
CRM_URL="https://crm-app-production-3d20.up.railway.app/api/leads"
ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY "$BOT_DIR/.env" | cut -d= -f2-)

NOW=$(date '+%Y-%m-%d %H:%M:%S')
ISSUES=()

# ── 1. בדוק שהתהליך רץ ──────────────────────
BOT_PID=$(pgrep -f "node.*index.js" 2>/dev/null | head -1)
if [ -z "$BOT_PID" ]; then
    ISSUES+=("❌ תהליך הבוט לא רץ")
else
    echo "[$NOW] ✅ תהליך פעיל (PID: $BOT_PID)" >> "$HEALTH_LOG"
fi

# ── 2. בדוק שהבוט מחובר לוואטסאפ ───────────
if [ -f "$LOG_FILE" ]; then
    # בדוק שב-10 דקות האחרונות היה "פעיל" בלוג
    RECENT=$(find "$LOG_FILE" -newermt "$(date -v-10M '+%Y-%m-%d %H:%M:%S')" 2>/dev/null)
    if grep -q "🚀 הבוט פעיל" "$LOG_FILE" 2>/dev/null; then
        echo "[$NOW] ✅ WhatsApp מחובר" >> "$HEALTH_LOG"
    else
        ISSUES+=("⚠️ לא נמצא אישור חיבור WhatsApp בלוג")
    fi
fi

# ── 3. בדוק חיבור ל-CRM ─────────────────────
CRM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$CRM_URL" 2>/dev/null)
if [ "$CRM_STATUS" = "200" ]; then
    echo "[$NOW] ✅ CRM מחובר (HTTP $CRM_STATUS)" >> "$HEALTH_LOG"
else
    ISSUES+=("❌ CRM לא מגיב (HTTP $CRM_STATUS)")
fi

# ── 4. בדוק חיבור ל-Anthropic ───────────────
ANTHROPIC_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    "https://api.anthropic.com/v1/models" 2>/dev/null)
if [ "$ANTHROPIC_STATUS" = "200" ]; then
    echo "[$NOW] ✅ Anthropic API מחובר" >> "$HEALTH_LOG"
else
    ISSUES+=("❌ Anthropic API לא מגיב (HTTP $ANTHROPIC_STATUS)")
fi

# ── ריסטרט אוטומטי אם הבוט נפל ─────────────
if [ -z "$BOT_PID" ]; then
    echo "[$NOW] 🔄 מפעיל בוט מחדש..." >> "$HEALTH_LOG"
    cd "$BOT_DIR"
    nohup node index.js >> "$LOG_FILE" 2>&1 &
    NEW_PID=$!
    sleep 5
    if pgrep -f "node.*index.js" > /dev/null 2>&1; then
        echo "[$NOW] ✅ הבוט הופעל מחדש (PID: $NEW_PID)" >> "$HEALTH_LOG"
    else
        echo "[$NOW] ❌ ריסטרט נכשל!" >> "$HEALTH_LOG"
    fi
fi

# ── סיכום ────────────────────────────────────
if [ ${#ISSUES[@]} -eq 0 ]; then
    echo "[$NOW] ✅ כל הבדיקות עברו" >> "$HEALTH_LOG"
else
    echo "[$NOW] ⚠️ בעיות: ${ISSUES[*]}" >> "$HEALTH_LOG"
fi

# שמור רק 500 שורות אחרונות בלוג
tail -500 "$HEALTH_LOG" > "$HEALTH_LOG.tmp" && mv "$HEALTH_LOG.tmp" "$HEALTH_LOG"
