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

// ── Saved contacts (bot ignores these) ────────────────────────────────────────
let savedContacts = new Set();

async function loadSavedContacts() {
    const url = `${GREEN_URL}/waInstance${GREEN_INSTANCE}/getContacts/${GREEN_TOKEN}`;
    return new Promise((resolve) => {
        const u = new URL(url);
        https.get({ hostname: u.hostname, path: u.pathname }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const contacts = JSON.parse(d);
                    savedContacts = new Set(
                        contacts
                            .filter(c => c.isMyContact && c.type === 'contact')
                            .map(c => c.id.replace('@c.us', '').replace(/\D/g, ''))
                    );
                    console.log(`📱 אנשי קשר שמורים: ${savedContacts.size}`);
                } catch (e) { console.error('❌ loadSavedContacts:', e.message); }
                resolve();
            });
        }).on('error', (e) => { console.error('❌ loadSavedContacts req:', e.message); resolve(); });
    });
}
loadSavedContacts();
setInterval(loadSavedContacts, 30 * 60 * 1000); // רענון כל 30 דקות

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


// Calendly booking handler
async function handleCalendlyWebhook(data) {
    const event = data.event;
    if (event !== 'invitee.created') return;
    const name      = data.payload?.invitee?.name || '';
    const eventName = data.payload?.event_type?.name || '';
    console.log(`📅 Calendly booking: ${name} — ${eventName}`);

    // Find most recent unbooked cal- click
    let matchedPhone = null, mostRecent = 0;
    for (const [phone, clicks] of clickTracker.entries()) {
        for (const [type, d] of Object.entries(clicks)) {
            if (type.startsWith('cal-') && !d.booked && d.clickedAt > mostRecent) {
                mostRecent = d.clickedAt; matchedPhone = phone;
            }
        }
    }
    if (matchedPhone) {
        const clicks = clickTracker.get(matchedPhone);
        for (const type of Object.keys(clicks)) { if (type.startsWith('cal-')) clicks[type].booked = true; }
        await updateLead(matchedPhone, {
            status: 'booked',
            notes: `✅ קבע: ${eventName} — ${new Date().toLocaleString('he-IL')}`,
            ...(name && { name }),
        }).catch(()=>{});
        console.log(`✅ Calendly matched → ${matchedPhone}`);
    } else {
        console.log(`⚠️ Calendly booking: לא מצאנו phone לקישור ${name}`);
    }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://localhost`);

    // Calendly webhook
    if (req.method === 'POST' && urlObj.pathname === '/calendly') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            res.writeHead(200); res.end('ok');
            try { await handleCalendlyWebhook(JSON.parse(body)); }
            catch (err) { console.error('❌ Calendly webhook error:', err.message); }
        }); return;
    }

    // WhatsApp webhook
    if (req.method === 'POST' && urlObj.pathname === '/webhook') {
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
        }); return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h2>✅ DROP Bot is running (Green API)</h2></body></html>');
});
server.listen(PORT, () => console.log(`🌐 Webhook server on port ${PORT}`));

// ── State ─────────────────────────────────────────────────────────────────────
const CONV_FILE = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'conversations.json')
    : path.join(__dirname, 'conversations.json');

function cleanOldTrackingUrls(text) {
    if (!text) return text;
    const BASE = 'https://drop-whatsapp-bot-production.up.railway.app';
    return text
        .replace(new RegExp(BASE.replace(/\./g,'\\.') + '/r\\?u=[^&]+&t=cal-phone[^\\s]*', 'g'), 'https://calendly.com/dj-steven-angel/phone?back=1')
        .replace(new RegExp(BASE.replace(/\./g,'\\.') + '/r\\?u=[^&]+&t=cal-60min[^\\s]*', 'g'), 'https://calendly.com/dj-steven-angel/60min?back=1')
        .replace(new RegExp(BASE.replace(/\./g,'\\.') + '/r\\?u=[^&]+&t=cal-zoom[^\\s]*', 'g'), 'https://calendly.com/dj-steven-angel/15-min-zoom?back=1')
        .replace(new RegExp(BASE.replace(/\./g,'\\.') + '/r\\?u=[^&]+&t=yt-canary[^\\s]*', 'g'), 'https://www.youtube.com/watch?v=sPArmZafsX8')
        .replace(new RegExp(BASE.replace(/\./g,'\\.') + '/r\\?u=[^&]+&t=yt-hugel[^\\s]*', 'g'), 'https://www.youtube.com/watch?v=tPYhltoFTZo')
        .replace(new RegExp(BASE.replace(/\./g,'\\.') + '/r\\?u=[^&]+&t=yt-swissa[^\\s]*', 'g'), 'https://youtu.be/64uzvnHU194');
}

function loadConversations() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'));
        const map = new Map(Object.entries(raw));
        // Clean old tracking URLs from saved history
        for (const [chatId, history] of map.entries()) {
            history.forEach(msg => { if (msg.content) msg.content = cleanOldTrackingUrls(msg.content); });
        }
        return map;
    } catch { return new Map(); }
}

function saveConversations(map) {
    try {
        const obj = {};
        for (const [k, v] of map.entries()) obj[k] = v;
        fs.writeFileSync(CONV_FILE, JSON.stringify(obj), 'utf8');
    } catch (e) { console.error('⚠️ saveConversations error:', e.message); }
}

const conversations = loadConversations();
const leadCache     = new Map();   // phone → { genres: Set, gender: null }
const processedIds  = new Set();   // prevent duplicate replies
const MAX_HISTORY   = 20;
console.log(`💾 טעינת היסטוריה: ${conversations.size} שיחות`);

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

// ── Nudge (2 שלבים) ───────────────────────────────────────────────────────────
const lastBotReply = new Map();
const nudgeStage   = new Map(); // chatId → { stage: 0|1|2, nudge1At: timestamp|null }

const NUDGE_DELAY_1 = 10 * 60 * 1000;        // 10 דקות → nudge 1
const NUDGE_DELAY_2 = 24 * 60 * 60 * 1000;   // 24 שעות אחרי nudge 1 → nudge 2

const NUDGE_MSG_1 = `היי! 😊 נראה שנעצרת — אני עדיין כאן אם יש לך שאלות על השיעורים עם סטיבן 🎧`;

function NUDGE_MSG_2(name) {
    return `היי${name ? ' ' + name : ''}! מיני סטיבן כאן 👋

ראיתי שהתחלנו לדבר לפני כמה זמן — רציתי לבדוק אם עדיין מתעניינ/ת בשיעורים עם סטיבן 😊

אם תרצ/י לקבוע שיחת הכרות קצרה של 15 דקות:
https://calendly.com/dj-steven-angel/15-min-zoom?back=1`;
}

function getNameFromHistory(chatId) {
    const history = conversations.get(chatId) || [];
    for (let i = 0; i < history.length - 1; i++) {
        if (history[i].role === 'assistant' && /מה שמ/.test(history[i].content)) {
            const reply = history[i + 1]?.content?.trim();
            const m = reply?.match(/^([א-תa-zA-Z]{2,12})$/);
            if (m && !NOT_A_NAME.has(m[1])) return m[1];
        }
    }
    return null;
}

async function checkNudges() {
    const now = Date.now();
    for (const [chatId, lastAt] of lastBotReply.entries()) {
        const state = nudgeStage.get(chatId) || { stage: 0, nudge1At: null };

        if (state.stage === 0 && now - lastAt >= NUDGE_DELAY_1) {
            try {
                await sendGreenMessage(chatId, NUDGE_MSG_1);
                nudgeStage.set(chatId, { stage: 1, nudge1At: Date.now() });
                console.log(`💬 Nudge 1 → ${chatId}`);
            } catch (err) { console.error(`❌ Nudge 1 failed (${chatId}):`, err.message); }

        } else if (state.stage === 1 && state.nudge1At && now - state.nudge1At >= NUDGE_DELAY_2) {
            const name = getNameFromHistory(chatId);
            try {
                await sendGreenMessage(chatId, NUDGE_MSG_2(name));
                nudgeStage.set(chatId, { stage: 2, nudge1At: state.nudge1At });
                lastBotReply.delete(chatId);
                console.log(`💬 Nudge 2 → ${chatId}`);
            } catch (err) { console.error(`❌ Nudge 2 failed (${chatId}):`, err.message); }
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

    // Saved contacts — bot only handles new leads (unsaved numbers)
    if (savedContacts.has(phoneNum)) return;

    // Dedup
    if (processedIds.has(msgId)) return;
    processedIds.add(msgId);
    if (processedIds.size > 500) processedIds.delete(processedIds.values().next().value);

    console.log(`\n📩 ${chatId} | "${userText}"`);

    // Unsubscribe
    if (isUnsubRequest(userText)) {
        BLOCKED.add(phoneNum);
        saveBlocked(BLOCKED);
        nudgeStage.delete(chatId);
        lastBotReply.delete(chatId);
        updateLead(phoneNum, { status: 'contacted', notes: '🚫 ביקש הסרה מהרשימות' }).catch(()=>{});
        await sendGreenMessage(chatId, 'הוסרת מקבלת הודעות WhatsApp שלנו ✅\nלא תקבל/י הודעות נוספות.');
        console.log(`🚫 הוסר: ${phoneNum}`);
        return;
    }

    // Reset nudge
    nudgeStage.delete(chatId);
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
        saveConversations(conversations);
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
        saveConversations(conversations);
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
