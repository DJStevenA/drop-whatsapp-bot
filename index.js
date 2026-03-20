require('dotenv').config({ override: true });
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { getAIResponse } = require('./ai');
const { upsertLead, updateLead, getPendingFollowups, extractEmail } = require('./crm_client');

const conversations = new Map();
const leadCache     = new Map();   // userId → { genres: Set, gender: null }
const processedIds  = new Set();   // prevent duplicate replies
const MAX_HISTORY   = 20;
const BOT_NEW_LEAD  = 'new_lead';
const BOT_EXISTING  = 'existing';

// ── Blocked numbers (env + persistent file) ───────────────────────────────────
const BLOCKED_FILE = path.join(__dirname, 'blocked.json');
function loadBlocked() {
    try { return new Set(JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'))); }
    catch { return new Set((process.env.BLOCKED_NUMBERS || '').split(',').filter(Boolean)); }
}
function saveBlocked(set) {
    fs.writeFileSync(BLOCKED_FILE, JSON.stringify([...set]), 'utf8');
}
const BLOCKED = loadBlocked();

// ── Unsubscribe keywords ───────────────────────────────────────────────────────
const UNSUB_KEYWORDS = ['הסר', 'הסר אותי', 'הסר אותי מהרשימות', 'stop', 'unsubscribe'];
function isUnsubRequest(text) {
    const t = text.trim().toLowerCase();
    return UNSUB_KEYWORDS.some(k => t === k || t.startsWith(k + ' '));
}

// ── Nudge state: one re-ignite message after 10 min silence ───────────────────
const lastBotReply = new Map();   // userId → timestamp of last bot reply
const nudgeSent    = new Set();   // userId → already nudged, wait for reply
const NUDGE_DELAY  = 10 * 60 * 1000; // 10 minutes

const NUDGE_MSG = `היי! 😊 עדיין כאן אם יש לך שאלות על השיעורים עם סטיבן 🎧`;

// ── Follow-up message ─────────────────────────────────────────────────────────
const FOLLOWUP_MSG = (name) =>
`היי${name ? ' ' + name : ''}! מיני סטיבן כאן 👋

רק בדקתי אם עדיין מתעניינ/ת בשיעורים עם סטיבן?

אם יש שאלות — אני כאן 😊
ואם תרצ/י לקבוע שיחה קצרה:
https://calendly.com/dj-steven-angel/15-min-zoom?back=1`;

// ── WhatsApp client ───────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});

client.on('qr', (qr) => {
    console.log('\n📱 סרוק QR:\n');
    qrcode.generate(qr, { small: true });
});
client.on('authenticated', () => console.log('✅ מאומת!'));
client.on('ready', () => {
    console.log('🚀 הבוט פעיל!');

    // Nudge checker — runs every minute
    setInterval(checkNudges, 60 * 1000);

    // CRM follow-ups — only when CRM is configured
    if (process.env.CRM_API_URL && !process.env.CRM_API_URL.includes('YOUR-APP')) {
        setInterval(sendPendingFollowups, 60 * 60 * 1000);
        sendPendingFollowups();
    }
});
client.on('disconnected', (r) => console.log('⚠️ התנתק:', r));

// ── Nudge checker ─────────────────────────────────────────────────────────────
async function checkNudges() {
    const now = Date.now();
    for (const [userId, sentAt] of lastBotReply.entries()) {
        if (nudgeSent.has(userId)) continue;
        if (now - sentAt < NUDGE_DELAY) continue;

        try {
            await client.sendMessage(userId, NUDGE_MSG);
            nudgeSent.add(userId);
            lastBotReply.delete(userId);
            console.log(`💬 Nudge נשלח → ${userId}`);
        } catch (err) {
            console.error(`❌ Nudge נכשל (${userId}):`, err.message);
        }
    }
}

// ── Follow-up sender ──────────────────────────────────────────────────────────
async function sendPendingFollowups() {
    const leads = await getPendingFollowups();
    if (leads.length === 0) return;

    console.log(`\n📬 שולח ${leads.length} פולו-אפים...`);
    for (const lead of leads) {
        try {
            const chatId = lead.phone + '@c.us';
            const msg    = FOLLOWUP_MSG(lead.name || lead.whatsapp_name);
            await client.sendMessage(chatId, msg);

            await updateLead(lead.phone, {
                followup_count:   (lead.followup_count || 0) + 1,
                last_followup_at: new Date().toISOString(),
                status:           'contacted',
            });
            console.log(`📤 פולו-אפ נשלח → ${lead.phone}`);
        } catch (err) {
            console.error(`❌ פולו-אפ נכשל (${lead.phone}):`, err.message);
        }
    }
}

// ── Bot type ──────────────────────────────────────────────────────────────────
async function getBotType(message) {
    try {
        const contact = await message.getContact();
        return contact.isMyContact ? BOT_EXISTING : BOT_NEW_LEAD;
    } catch { return BOT_NEW_LEAD; }
}

// ── Extract name from message ─────────────────────────────────────────────────
// Words that are NOT names but could be captured by "אני X" patterns
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
            // Skip words that look like Hebrew verbs (start with מ/ל/ת/י and > 5 chars)
            if (candidate.length > 7 && /^[מלתיה]/.test(candidate)) continue;
            return candidate;
        }
    }
    return null;
}

// ── Detect all genres mentioned in a message ──────────────────────────────────
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

// ── Detect gender from Hebrew grammar ─────────────────────────────────────────
function detectGender(text) {
    const femaleMarkers = ['מתעניינת','מחפשת','צריכה','רוצה ל','שמחה','מוכנה','מתחילה','מגיעה','אוהבת','עובדת','גרה','באה','ניסיתי ל','התחלתי','אני ת'];
    const maleMarkers   = ['מתעניין','מחפש','צריך','שמח','מוכן','מתחיל','מגיע','אוהב','עובד','גר','בא ל'];
    if (femaleMarkers.some(w => text.includes(w))) return 'female';
    if (maleMarkers.some(w => text.includes(w)))   return 'male';
    return null;
}

// ── Scan message for CRM data ─────────────────────────────────────────────────
async function scanForCRMData(phone, userText, history = []) {
    const updates = {};
    const email   = extractEmail(userText);
    if (email) { updates.email = email; console.log(`📋 CRM: אימייל — ${email}`); }

    let name = extractName(userText);

    // If no name found via patterns, check if bot just asked "מה שמך?"
    // and user replied with a short standalone word — treat it as the name
    if (!name) {
        const lastBot = [...history].reverse().find(m => m.role === 'assistant');
        const askedForName = lastBot && /מה שמ/.test(lastBot.content);
        if (askedForName) {
            const standalone = userText.trim().match(/^([א-תa-zA-Z]{2,15})$/);
            if (standalone && !NOT_A_NAME.has(standalone[1])) {
                name = standalone[1];
            }
        }
    }

    if (name) { updates.name = name; console.log(`📋 CRM: שם — ${name}`); }

    const lower = userText.toLowerCase();
    if (lower.includes('הפק') || lower.includes('ableton') || lower.includes('cubase') || lower.includes('production')) {
        updates.interest = 'production';
    } else if (lower.includes("דיג'י") || lower.includes('dj') || lower.includes('תקלוט') || lower.includes('מיקסר')) {
        updates.interest = 'dj';
    }

    // Accumulate all genres (merge new with previously seen for this user)
    const newGenres = detectAllGenres(userText);
    if (newGenres.length > 0) {
        if (!leadCache.has(phone)) leadCache.set(phone, { genres: new Set(), gender: null });
        const cache = leadCache.get(phone);
        newGenres.forEach(g => cache.genres.add(g));
        updates.genre = [...cache.genres].join(', ');
        console.log(`📋 CRM: סגנון — ${updates.genre}`);
    }

    // Gender detection from Hebrew grammar
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

// ── Main message handler ──────────────────────────────────────────────────────
client.on('message', async (message) => {
    if (message.fromMe) return;
    if (message.from === 'status@broadcast') return;
    // Ignore group chats — only reply to direct (1-on-1) messages
    if (message.from.endsWith('@g.us')) return;
    if (message.isGroupMsg) return;
    // Blocked numbers
    const phoneNum = message.from.replace('@c.us', '').replace(/\D/g, '');
    if (BLOCKED.has(phoneNum)) return;
    // Prevent processing the same message twice (e.g. multiple processes / WA replay)
    if (processedIds.has(message.id._serialized)) return;
    processedIds.add(message.id._serialized);
    if (processedIds.size > 500) {
        const first = processedIds.values().next().value;
        processedIds.delete(first);
    }

    const userId   = message.from;
    const userText = message.body?.trim();
    if (!userText) return;

    // ── Unsubscribe request ────────────────────────────────────────────────────
    if (isUnsubRequest(userText)) {
        BLOCKED.add(phoneNum);
        saveBlocked(BLOCKED);
        nudgeSent.delete(userId);
        lastBotReply.delete(userId);
        updateLead(userId, { status: 'contacted', notes: '🚫 ביקש הסרה מהרשימות' }).catch(()=>{});
        await message.reply('הוסרת מקבלת הודעות WhatsApp שלנו ✅\nלא תקבל/י הודעות נוספות.');
        console.log(`🚫 הוסר מרשימות: ${phoneNum}`);
        return;
    }

    // User replied — reset nudge state
    nudgeSent.delete(userId);
    lastBotReply.delete(userId);

    const botType = await getBotType(message);
    console.log(`\n📩 ${userId} | ${botType === BOT_NEW_LEAD ? '🆕 ליד חדש' : '👤 קיים'} | "${userText}"`);

    if (botType === BOT_EXISTING) { console.log('   ⏭️ לקוח קיים — לא מגיב'); return; }

    // Init conversation history (needed before scanForCRMData)
    if (!conversations.has(userId)) conversations.set(userId, []);
    const history = conversations.get(userId);

    // Save to CRM (fire-and-forget — לא חוסם את הבוט)
    const contact = await message.getContact();
    upsertLead({ phone: phoneNum, whatsapp_name: contact.pushname || null, source: 'whatsapp' }).catch(()=>{});
    scanForCRMData(phoneNum, userText, history).catch(()=>{});

    // AI response
    history.push({ role: 'user', content: userText });
    while (history.length > MAX_HISTORY) history.splice(0, 2);

    try {
        const reply = await getAIResponse(history, BOT_NEW_LEAD);
        history.push({ role: 'assistant', content: reply });
        await message.reply(reply);
        lastBotReply.set(userId, Date.now());   // start nudge countdown
        console.log('📤 נשלח');
    } catch (err) {
        console.error('❌ שגיאת AI:', err.message);

        await updateLead(userId, {
            status: 'contacted',
            notes: `⚠️ שגיאה טכנית ${new Date().toLocaleString('he-IL')} — לחזור ללקוח`,
        });

        history.pop();

        await message.reply(
`היי! קיבלנו את ההודעה שלך 🙏

נראה שיש אצלנו תקלה טכנית רגעית.

סטיבן יחזור אליך בהקדם — תוך שעות ספורות לכל היותר 🎧`
        );
    }
});

console.log('⏳ מאתחל...\n');
client.initialize();
