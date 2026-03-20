# הפעלת הבוט על מחשב חדש

## דרישות מוקדמות
- Node.js v18 או גבוה יותר
- גישה ל-Dropbox (תיקיית `Busniees assets 2026`)

## שלב 1 — התקנת תלויות
```bash
cd "/Users/YOUR_USERNAME/Dropbox/Busniees assets 2026/drop-whatsapp-bot"
npm install
```

## שלב 2 — בדיקת קובץ .env
הקובץ `.env` צריך להכיל:
```
ANTHROPIC_API_KEY=sk-ant-api03-...    # המפתח הנוכחי
CRM_API_URL=https://YOUR-RAILWAY-URL.up.railway.app
CRM_API_KEY=drop2026secret
```
המפתח נמצא ב: `Dropbox/api keys/anthropic.md`

## שלב 3 — הפעלה
```bash
node index.js
```

## סריקת QR (פעם ראשונה על מחשב חדש)
- בפעם הראשונה יוצג QR בטרמינל
- סרוק עם WhatsApp (הגדרות → מכשירים מקושרים → קשר מכשיר)
- לאחר הסריקה הסשן נשמר ב-`.wwebjs_auth/` ולא תצטרך לסרוק שוב

## הערה חשובה
WhatsApp מאפשר **רק מכשיר אחד** מחובר בו זמנית (Web).
אם הבוט רץ על שני מחשבים במקביל — אחד יתנתק.

## קבצי הפרויקט
```
drop-whatsapp-bot/
├── index.js          ← נקודת הכניסה הראשית
├── ai.js             ← חיבור ל-Claude API
├── system_prompt.js  ← אישיות מיני סטיבן + סקריפט שיחה
├── crm_client.js     ← שמירת לידים ל-CRM
├── .env              ← מפתחות (לא לשתף!)
└── package.json      ← תלויות npm
```
