# DROP WhatsApp Bot

בוט WhatsApp AI לשיעורים הפרטיים של סטיבן אנג'ל (DROP).
עונה ללקוחות פוטנציאלים בעברית ומפנה לקביעת שיחה ב-Calendly.

---

## קבצים בפרויקט

| קובץ | תפקיד |
|------|--------|
| `index.js` | הבוט הראשי - מחבר ל-WhatsApp ומעבד הודעות |
| `ai.js` | חיבור ל-Claude API |
| `system_prompt.js` | כל המידע על DROP + הנחיות לבוט |
| `package.json` | תלויות הפרויקט |
| `.env` | מפתחות API (לא מועלה ל-Git) |
| `.wwebjs_auth/` | סשן WhatsApp שמור (לא מועלה ל-Git) |

---

## הגדרה ראשונה (מחשב חדש)

### 1. דרישות מוקדמות
```bash
node --version   # חייב להיות v18 ומעלה
npm --version
```
אם Node.js לא מותקן: https://nodejs.org

### 2. התקנת תלויות
```bash
cd whatsapp-bot
npm install
```

### 3. הגדרת API Key
```bash
cp .env.example .env
```
פתח את `.env` ושים את המפתח שלך מ-https://console.anthropic.com/

### 4. הפעלה
```bash
npm start
```
סרוק את קוד ה-QR שיופיע בטרמינל עם WhatsApp שלך.
הסשן יישמר ב-`.wwebjs_auth/` - בפעם הבאה לא תצטרך לסרוק שוב.

---

## העברה למחשב אחר

**אפשרות א - עם Dropbox (אוטומטי):**
כל תיקיית `whatsapp-bot` כבר ב-Dropbox.
במחשב החדש: `npm install` → `npm start` → סרוק QR מחדש.

**אפשרות ב - עם סשן קיים (ללא סריקה מחדש):**
העתק גם את תיקיית `.wwebjs_auth/` יחד עם שאר הקבצים.

> **שים לב:** לעולם אל תעלה `.wwebjs_auth/` ל-GitHub - זה הסשן שלך.

---

## עדכון תוכן הבוט

כל המידע נמצא ב-`system_prompt.js`.
שנה שם, מחיר, מיקום, ז'אנרים וכו' - ישירות בקובץ הזה.

---

## הפעלה ברקע (לשרת / מחשב שנשאר דלוק)

```bash
npm install -g pm2
pm2 start index.js --name drop-bot
pm2 save
pm2 startup   # הפעלה אוטומטית עם ריסטרט
```

---

## פתרון בעיות נפוצות

**הבוט לא מגיב:**
- ודא שה-`.env` קיים עם מפתח תקין
- ודא שהחיבור ל-WhatsApp תקין (`npm start`)

**QR לא מופיע:**
- מחק את תיקיית `.wwebjs_auth/` ו-`.wwebjs_cache/` והפעל מחדש

**שגיאת "Cannot find module":**
- הפעל `npm install` מחדש
