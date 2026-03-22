require('dotenv').config({ override: true });
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { getAIResponse } = require('./ai');
const { upsertLead, updateLead, getPendingFollowups, extractEmail } = require('./crm_client');

// ── Green API config ──────────────────────────────────────────────────────────
const GREEN_URL      = process.env.GREEN_API_URL || 'https://7107.api.greenapi.com';
const GREEN_INSTANCE = process.env.GREEN_INSTANCE_ID || '7107544996';
const GREEN_TOKEN    = process.env.GREEN_API_TOKEN || 'b213685ee00f4ea29922be6917fff18812ae2b6298e64754ab';

async function sendGreenMessage(chatId, text) {
    const url  = `${GREEN_URL}/waInstance${GREEN_INSTANCE}/sendMessage/${GREEN_TOKEN}`;
    const body = JSON.stringify({ chatId, message: text });
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

// ── HTTP server (webhook + health) ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/webhook') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            res.writeHead(200); res.end('ok');
            try {
                const data = JSON.parse(body);
                await handleWebhook(data);
            } catch (err) {
                console.error('❌ Webhook parse error:', err.message);
            }
        });
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h2>✅ DROP Bot is running (Green API)</h2></body></html>');
    }
});
server.listen(PORT, () => console.log(`🌐 Webhook server on port ${PORT}`));

// ── State ─────────────────────────────────────────────────────────────────────
const conversations = new Map();
const leadCache     = new Map();   // phone → { genres: Set, gender: null }
const processedIds  = new Set();   // prevent duplicate replies
const MAX_HISTORY   = 20;

// ── Blocked numbers ───────────────────────────────────────────────────────────
const BLOCKED_FILE = path.join(__dirname, 'blocked.json');
function loadBlocked() {
    try { return new Set(JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'))); }
    catch { return new Set((process.env.BLOCKED_NUMBERS || '').split(',').filter(Boolean)); }
}
function saveBlocked(set) {
    fs.writeFileSync(BLOCKED_FILE, JSON.stringify([...set]), 'utf8');
}
const BLOCKED = loadBlocked();

// ── Unsubscribe ───────────────────────────────────────────────────────────────
const UNSUB_KEYWORDS = ['הסר', 'הסר אותי', 'הסר אותי מהרשימות', 'stop', 'unsubscribe'];
function isUnsubRequest(text) {
    const t = text.trim().toLowerCase();
    return UNSUB_KEYWORDS.some(k => t === k || t.startsWith(k + ' '));
}

// ── Nudge ─────────────────────────────────────────────────────────────────────
const lastBotReply = new Map();
const nudgeSent    = new Set();
const NUDGE_DELAY  = 10 * 60 * 1000;
const NUDGE_MSG    = `היי! 😊 עדיין כאן אם יש לך שאלות על השיעורים עם סטיבן 🎧`;

async function checkNudges() {
    const now = Date.now();
    for (const [chatId, sentAt] of lastBotReply.entries()) {
        if (nudgeSent.has(chatId)) continue;
        if (now - sentAt < NUDGE_DELAY) continue;
        try {
            await sendGreenMessage(chatId, NUDGE_MSG);
            nudgeSent.add(chatId);
            lastBotReply.delete(chatId);
            console.log(`💬 Nudge → ${chatId}`);
        } catch (err) {
            console.error(`❌ Nudge failed (${chatId}):`, err.message);
        }
    }
}
setInterval(checkNudges, 60 * 1000);

// ── Follow-up ─────────────────────────────────────────────────────────────────
const FOLLOWUP_MSG = (name) =>
`היי${name ? ' ' + name : ''}! מיני סטיבן כאן 👋

רק בדקתי אם עדיין מתעניינ/ת בשיעורים עם סטיבן?

אם יש שאלות — אני כאן 😊
ואם תרצ/י לקבוע שיחה קצרה:
https://calendly.com/dj-steven-angel/15-min-zoom?back=1`;

async function sendPendingFollowups() {
    const leads = await getPendingFollowups();
    if (!leads.length) return;
    console.log(`\n📬 שולח ${leads.length} פולו-אפים...`);
    for (const lead of leads) {
        try {
            const chatId = lead.phone + '@c.us';
            await sendGreenMessage(chatId, FOLLOWUP_MSG(lead.name || lead.whatsapp_name));
            await updateLead(lead.phone, {
                followup_count:   (lead.followup_count || 0) + 1,
                last_followup_at: new Date().toISOString(),
                status:           'contacted',
            });
            console.log(`📤 פולו-אפ → ${lead.phone}`);
        } catch (err) {
            console.error(`❌ פולו-אפ נכשל (${lead.phone}):`, err.message);
        }
    }
}
if (process.env.CRM_API_URL && !process.env.CRM_API_URL.includes('YOUR-APP')) {
    setInterval(sendPendingFollowups, 60 * 60 * 1000);
    sendPendingFollowups();
}

// ── Name / genre / gender helpers ─────────────────────────────────────────────
const NOT_A_NAME = new Set([
    'מתביישת','מתבייש','מתעניין','מתעניינת','מתכוון','מתכוונת','מחפש','מחפשת',
    'רוצה','רוצים','צריך','צריכה','יודע','יודעת','גר','גרה','בא','באה',
    'מדבר','מדברת','נמצא','נמצאת','פה','כאן','עוקב','עוקבת','שומע','שומעת',
    'מוכן','מוכנה','סטודנט','תלמיד','תלמידה','חדש','חדשה','כבר','עוד','רק',
    'לא','כן','אוהב','אוהבת','ניסיתי','ניסית','רואה','שואל','שואלת',
]);

function extractName(text) {
    const patterns = [
        /(?:שמי|שם שלי|קוראים לי|נקרא|נקראת)\s+([א-תa-zA-Z]{2,12})/i,
        /^אני\s+([א-תa-zA-Z]{2,10})(?:\s|$|[.,!?])/i,
        /^([א-תa-zA-Z]{2,12})\s+(?:כאן|פה|דיברנו)$/i,
        /^שלום[,!]?\s+(?:אני\s+)?([א-תa-zA-Z]{2,12})$/i,
        /^היי[,!]?\s+(?:אני\s+)?([א-תa-zA-Z]{2,12})$/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m && m[1]) {
            const candidate = m[1].trim();
            if (NOT_A_NAME.has(candidate)) continue;
            if (candidate.length > 7 && /^[מלתיה]/.test(candidate)) continue;
            return candidate;
        }
    }
    return null;
}

function detectAllGenres(text) {
    const t = text.toLowerCase();
    const found = [];
    if (t.includes('אפרו') || t.includes('afro house') || t.includes('afrohouse'))          found.push('אפרו-האוס');
    if (t.includes('מלודיק') || t.includes('melodic techno') || t.includes('melodic'))      found.push('מלודיק טכנו');
    if (t.includes('מזרחי') || t.includes('oriental') || t.includes('רמיקס מזרחי'))         found.push('רמיקס מזרחית');
    if (t.includes('פסי') || t.includes('פסיכדלי') || t.includes('psytrance') || t.includes('psy trance') || t.includes('טראנס') || t.includes('trance')) found.push('פסי טראנס');
    if (t.includes('מיינסטרים') || t.includes('mainstream') || t.includes('קומרשיאל') || t.includes('commercial')) found.push('מיינסטרים');
    if (t.includes('טכנו') || t.includes('techno'))                                          found.push('טכנו');
    if (t.includes('האוס') || t.includes(' house') || t.startsWith('house'))                found.push('האוס');
    return found;
}

function detectGender(text) {
    const femaleMarkers = ['מתעניינת','מחפשת','צריכה','רוצה ל','שמחה','מוכנה','מתחילה','מגיעה','אוהבת','עובדת','גרה','באה','ניסיתי ל','התחלתי','אני ת'];
    const maleMarkers   = ['מתעניין','מחפש','צריך','שמח','מוכן','מתחיל','מגיע','אוהב','עובד','גר','בא ל'];
    if (femaleMarkers.some(w => text.includes(w))) return 'female';
    if (maleMarkers.some(w => text.includes(w)))   return 'male';
    return null;
}

async function scanForCRMData(phone, userText, history = []) {
    const updates = {};
    const email   = extractEmail(userText);
    if (email) { updates.email = email; console.log(`📋 CRM: אימייל — ${email}`); }

    let name = extractName(userText);
    if (!name) {
        const lastBot = [...history].reverse().find(m => m.role === 'assistant');
        const askedForName = lastBot && /מה שמ/.test(lastBot.content);
        if (askedForName) {
            const standalone = userText.trim().match(/^([א-תa-zA-Z]{2,15})$/);
            if (standalone && !NOT_A_NAME.has(standalone[1])) name = standalone[1];
        }
    }
    if (name) { updates.name = name; console.log(`📋 CRM: שם — ${name}`); }

    const lower = userText.toLowerCase();
    if (lower.includes('הפק') || lower.includes('ableton') || lower.includes('cubase') || lower.includes('production')) {
        updates.interest = 'production';
    } else if (lower.includes("דיג'י") || lower.includes('dj') || lower.includes('תקלוט') || lower.includes('מיקסר')) {
        updates.interest = 'dj';
    }

    const newGenres = detectAllGenres(userText);
    if (newGenres.length > 0) {
        if (!leadCache.has(phone)) leadCache.set(phone, { genres: new Set(), gender: null });
        const cache = leadCache.get(phone);
        newGenres.forEach(g => cache.genres.add(g));
        updates.genre = [...cache.genres].join(', ');
        console.log(`📋 CRM: סגנון — ${updates.genre}`);
    }

    const gender = detectGender(userText);
    if (gender) {
        if (!leadCache.has(phone)) leadCache.set(phone, { genres: new Set(), gender: null });
        const cache = leadCache.get(phone);
        if (!cache.gender) {
            cache.gender = gender;
            updates.gender = gender;
            console.log(`📋 CRM: מגדר — ${gender}`);
        }
    }

    if (Object.keys(updates).length > 0) await updateLead(phone, updates);
}

// ── Webhook handler ───────────────────────────────────────────────────────────
async function handleWebhook(data) {
    // Only handle incoming text messages
    if (data.typeWebhook !== 'incomingMessageReceived') return;
    if (!data.messageData || data.messageData.typeMessage !== 'textMessage') return;

    const chatId    = data.senderData?.chatId || data.senderData?.sender;
    const msgId     = data.idMessage;
    const userText  = data.messageData?.textMessageData?.textMessage?.trim();
    const senderName = data.senderData?.senderName || null;

    if (!chatId || !userText || !msgId) return;

    // Ignore group chats
    if (chatId.endsWith('@g.us')) return;

    // Extract phone number
    const phoneNum = chatId.replace('@c.us', '').replace(/\D/g, '');

    // Block list
    if (BLOCKED.has(phoneNum)) return;

    // Dedup
    if (processedIds.has(msgId)) return;
    processedIds.add(msgId);
    if (processedIds.size > 500) processedIds.delete(processedIds.values().next().value);

    console.log(`\n📩 ${chatId} | "${userText}"`);

    // Unsubscribe
    if (isUnsubRequest(userText)) {
        BLOCKED.add(phoneNum);
        saveBlocked(BLOCKED);
        nudgeSent.delete(chatId);
        lastBotReply.delete(chatId);
        updateLead(phoneNum, { status: 'contacted', notes: '🚫 ביקש הסרה מהרשימות' }).catch(()=>{});
        await sendGreenMessage(chatId, 'הוסרת מקבלת הודעות WhatsApp שלנו ✅\nלא תקבל/י הודעות נוספות.');
        console.log(`🚫 הוסר: ${phoneNum}`);
        return;
    }

    // Reset nudge
    nudgeSent.delete(chatId);
    lastBotReply.delete(chatId);

    // Init conversation
    const isNew = !conversations.has(chatId);
    if (!conversations.has(chatId)) conversations.set(chatId, []);
    const history = conversations.get(chatId);

    // CRM
    upsertLead({ phone: phoneNum, whatsapp_name: senderName, source: 'whatsapp' }).catch(()=>{});
    scanForCRMData(phoneNum, userText, history).catch(()=>{});

    // First message — always send exact opening
    if (isNew) {
        const opening = `היי! הגעת למיני סטיבן — סטיבן כנראה קבור באולפן עכשיו 😄
אשמח לענות על שאלות ולעזור לך לקבוע זמן עם סטיבן.
מה שמך?`;
        history.push({ role: 'user', content: userText });
        history.push({ role: 'assistant', content: opening });
        await sendGreenMessage(chatId, opening);
        lastBotReply.set(chatId, Date.now());
        console.log('📤 פתיחה נשלחה');
        return;
    }

    // AI
    history.push({ role: 'user', content: userText });
    while (history.length > MAX_HISTORY) history.splice(0, 2);

    try {
        const reply = await getAIResponse(history, 'new_lead');
        history.push({ role: 'assistant', content: reply });
        await sendGreenMessage(chatId, reply);
        lastBotReply.set(chatId, Date.now());
        console.log('📤 נשלח');
    } catch (err) {
        console.error('❌ שגיאת AI:', err.message);
        await updateLead(phoneNum, {
            status: 'contacted',
            notes: `⚠️ שגיאה טכנית ${new Date().toLocaleString('he-IL')} — לחזור ללקוח`,
        }).catch(()=>{});
        history.pop();
        await sendGreenMessage(chatId,
`היי! קיבלנו את ההודעה שלך 🙏

נראה שיש אצלנו תקלה טכנית רגעית.

סטיבן יחזור אליך בהקדם — תוך שעות ספורות לכל היותר 🎧`
        );
    }
}

console.log('🚀 DROP Bot (Green API) מוכן!');
