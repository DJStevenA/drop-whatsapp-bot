require('dotenv').config({ override: true });
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { getAIResponse, isOffTopic } = require('./ai');
const { upsertLead, updateLead, getPendingFollowups, extractEmail } = require('./crm_client');

// ── Green API config ──────────────────────────────────────────────────────────
const GREEN_URL      = process.env.GREEN_API_URL || 'https://7107.api.greenapi.com';
const GREEN_INSTANCE = process.env.GREEN_INSTANCE_ID || '7107570993';
const GREEN_TOKEN    = process.env.GREEN_API_TOKEN || '09288ed33d524aedbbdebb9ff47a977d4eb95ffd1c1d40dcbe';

// ── Contact check (bot only responds to NON-contacts) ─────────────────────────
// Uses getContactInfo per-message: contactName is non-empty ↔ saved in phone
async function isSavedContact(chatId) {
    const url  = `${GREEN_URL}/waInstance${GREEN_INSTANCE}/getContactInfo/${GREEN_TOKEN}`;
    const body = JSON.stringify({ chatId });
    return new Promise((resolve) => {
        const u = new URL(url);
        const req = https.request({
            hostname: u.hostname, path: u.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 5000,
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const info = JSON.parse(d);
                    // contactName is non-empty only when the number is saved in the phone's address book
                    resolve(typeof info.contactName === 'string' && info.contactName.trim() !== '');
                } catch { resolve(true); }  // parse error → treat as saved (safe default)
            });
        });
        req.on('error',   () => resolve(true));   // on error → treat as saved (safe default)
        req.on('timeout', () => { req.destroy(); resolve(true); }); // on timeout → treat as saved
        req.write(body); req.end();
    });
}


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


// ── Calendly booking handler ──────────────────────────────────────────────────
// phone → timestamp of last Calendly click (for matching bookings)
const calendlyClickLog = new Map(); // phone → { clickedAt, booked }

async function handleCalendlyWebhook(data) {
    const event = data.event;
    if (event !== 'invitee.created') return;
    const name      = data.payload?.invitee?.name || '';
    const eventName = data.payload?.event_type?.name || '';
    console.log(`📅 Calendly booking: ${name} — ${eventName}`);

    // Find most recent unbooked click
    let matchedPhone = null, mostRecent = 0;
    for (const [phone, d] of calendlyClickLog.entries()) {
        if (!d.booked && d.clickedAt > mostRecent) {
            mostRecent = d.clickedAt; matchedPhone = phone;
        }
    }
    if (matchedPhone) {
        calendlyClickLog.get(matchedPhone).booked = true;
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

    // Health check — used by UptimeRobot / Railway
    if (req.method === 'GET' && urlObj.pathname === '/health') {
        // Test Green API connectivity with a lightweight status call
        const statusUrl = `${GREEN_URL}/waInstance${GREEN_INSTANCE}/getStateInstance/${GREEN_TOKEN}`;
        const u = new URL(statusUrl);
        const checkGreen = () => new Promise((resolve) => {
            const req2 = https.get({ hostname: u.hostname, path: u.pathname, timeout: 5000 }, (r) => {
                let d = ''; r.on('data', c => d += c);
                r.on('end', () => {
                    try {
                        const body = JSON.parse(d);
                        resolve(body.stateInstance || 'unknown');
                    } catch { resolve('parse_error'); }
                });
            });
            req2.on('error', () => resolve('unreachable'));
            req2.on('timeout', () => { req2.destroy(); resolve('timeout'); });
        });

        const greenState = await checkGreen();
        const healthy = greenState === 'authorized';
        const payload = {
            status: healthy ? 'ok' : 'degraded',
            green_api: greenState,
            conversations: conversations.size,

            blocked: BLOCKED.size,
            uptime_seconds: Math.floor(process.uptime()),
        };
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
    }

    // Self-test: simulates a real message end-to-end (Claude + Green API)
    if (req.method === 'GET' && urlObj.pathname === '/selftest') {
        if (urlObj.searchParams.get('key') !== 'drop2026secret') { res.writeHead(403); res.end('forbidden'); return; }
        const results = { green_api: false, claude: false, webhook_parse: false };
        try {
            // 1. Green API check
            const gState = await new Promise((resolve) => {
                const u2 = new URL(`${GREEN_URL}/waInstance${GREEN_INSTANCE}/getStateInstance/${GREEN_TOKEN}`);
                https.get({ hostname: u2.hostname, path: u2.pathname, timeout: 5000 }, (r) => {
                    let d = ''; r.on('data', c => d += c);
                    r.on('end', () => { try { resolve(JSON.parse(d).stateInstance); } catch { resolve('error'); } });
                }).on('error', () => resolve('error'));
            });
            results.green_api = gState === 'authorized';

            // 2. Claude API check — minimal call
            const Anthropic = require('@anthropic-ai/sdk');
            const _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const testReply = await _anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 10,
                messages: [{ role: 'user', content: 'ping' }],
            });
            results.claude = testReply?.content?.length > 0;

            // 3. Webhook parse simulation
            const fakePayload = {
                typeWebhook: 'incomingMessageReceived',
                senderData: { chatId: 'test@c.us', senderName: 'Test' },
                idMessage: 'selftest_' + Date.now(),
                messageData: { textMessageData: { textMessage: 'test' } },
            };
            results.webhook_parse = !!(fakePayload.senderData?.chatId && fakePayload.messageData?.textMessageData?.textMessage);
        } catch (err) {
            results.error = err.message;
        }
        const allOk = results.green_api && results.claude && results.webhook_parse;
        res.writeHead(allOk ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: allOk ? 'all_ok' : 'degraded', ...results }));
        return;
    }

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

    // Admin: reset a conversation (GET /admin/reset?phone=972...&key=drop2026secret)
    if (req.method === 'GET' && urlObj.pathname === '/admin/reset') {
        if (urlObj.searchParams.get('key') !== 'drop2026secret') { res.writeHead(403); res.end('forbidden'); return; }
        const phone = urlObj.searchParams.get('phone');
        if (phone) {
            const chatId = phone + '@c.us';
            conversations.delete(chatId);
            saveConversations(conversations);
            console.log(`🗑️ שיחה אופסה: ${phone}`);
            res.writeHead(200); res.end(`reset: ${phone}`);
        } else {
            // Reset all
            conversations.clear();
            saveConversations(conversations);
            console.log('🗑️ כל השיחות אופסו');
            res.writeHead(200); res.end('all conversations reset');
        }
        return;
    }

    // Stats dashboard
    if (req.method === 'GET' && urlObj.pathname === '/stats') {
        if (urlObj.searchParams.get('key') !== 'drop2026secret') { res.writeHead(403); res.end('forbidden'); return; }

        let totalConvs = conversations.size;
        let totalUserMsgs = 0;
        let engaged = 0;       // >2 exchanges
        let hotLeads = 0;      // >6 exchanges
        let bookedCount = 0;

        for (const [, history] of conversations.entries()) {
            const userMsgs = history.filter(m => m.role === 'user').length;
            totalUserMsgs += userMsgs;
            if (userMsgs > 2)  engaged++;
            if (userMsgs > 6)  hotLeads++;
        }
        for (const [, d] of calendlyClickLog.entries()) {
            if (d.booked) bookedCount++;
        }
        const avgMsgs = totalConvs ? (totalUserMsgs / totalConvs).toFixed(1) : 0;
        const engRate = totalConvs ? Math.round((engaged / totalConvs) * 100) : 0;

        const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DROP Bot — Stats</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #fff; padding: 24px; }
  h1 { font-size: 1.4rem; margin-bottom: 24px; color: #aaa; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px; }
  .card { background: #1a1a1a; border-radius: 14px; padding: 20px 16px; text-align: center; }
  .card .num { font-size: 2.4rem; font-weight: 700; color: #fff; }
  .card .label { font-size: 0.78rem; color: #666; margin-top: 6px; }
  .card.green .num { color: #4ade80; }
  .card.yellow .num { color: #facc15; }
  .card.red .num { color: #f87171; }
  .card.blue .num { color: #60a5fa; }
  .updated { margin-top: 20px; font-size: 0.72rem; color: #444; text-align: center; }
</style>
</head>
<body>
<h1>📊 DROP Bot — לוח מדידה</h1>
<div class="grid">
  <div class="card blue"><div class="num">${totalConvs}</div><div class="label">שיחות שהתחילו</div></div>
  <div class="card green"><div class="num">${engaged}</div><div class="label">מעורבים (>2 הודעות)</div></div>
  <div class="card yellow"><div class="num">${hotLeads}</div><div class="label">לידים חמים (>6 הודעות)</div></div>
  <div class="card green"><div class="num">${bookedCount}</div><div class="label">קבעו שיחה</div></div>
  <div class="card"><div class="num">${avgMsgs}</div><div class="label">ממוצע הודעות לשיחה</div></div>
  <div class="card"><div class="num">${engRate}%</div><div class="label">אחוז מעורבות</div></div>
  <div class="card red"><div class="num">${BLOCKED.size}</div><div class="label">הוסרו מהרשימה</div></div>

</div>
<p class="updated">עודכן: ${new Date().toLocaleString('he-IL')}</p>
</body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
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

// ── Language detection + bilingual messages ──────────────────────────────────
// Detection: any Hebrew character → 'he', else any Latin letter → 'en', else 'he' (default)
// Conversation language is sticky: derived from the FIRST user message in history
function detectLanguage(text) {
    if (!text || typeof text !== 'string') return 'he';
    // Hebrew unicode block: U+0590 - U+05FF
    if (/[\u0590-\u05FF]/.test(text)) return 'he';
    // Latin letters → English. No letters at all (emoji-only, numbers) → default Hebrew.
    if (/[a-zA-Z]/.test(text)) return 'en';
    return 'he';
}

function getConversationLanguage(history) {
    if (!Array.isArray(history)) return 'he';
    const firstUser = history.find(m => m && m.role === 'user' && m.content);
    return detectLanguage(firstUser?.content || '');
}

// Bitly short link for the Calendly phone call (with whatsapp/bot UTMs)
// Created 2026-04-27 per Marketing Agent brief (briefs/2026-04-27/bitly_link_shortener_capability.md)
// Long URL: https://calendly.com/dj-steven-angel/phone?back=1&utm_source=whatsapp&utm_medium=bot&utm_campaign=calendly-phone
const CALENDLY_SHORT = 'https://bit.ly/48SkPqo';

// Menu message — sent to ALL new contacts (no language detection needed)
function getMenuMessage() {
    return `היי 😊 הגעתם למיני סטיבן 🎧

איך נוח לכם?

1️⃣  לדבר על לימודי די.ג'י / הפקה
2️⃣  לקבוע שיחה עם סטיבן:
👉 ${CALENDLY_SHORT}
3️⃣  Continue in English`;
}

// Soft reminder — sent ONCE 10 min after menu if user hasn't picked an option.
// Replaces the previous behavior of re-sending the full menu (felt like a duplicate).
function getMenuNudgeMessage() {
    return `רק להזכיר את האפשרויות 😊

1️⃣  לימודי די.ג'י / הפקה
2️⃣  שיחה עם סטיבן: ${CALENDLY_SHORT}
3️⃣  Continue in English`;
}

// After pressing 1 — Hebrew lessons flow
function getHebrewFlowOpening() {
    return `מגניב! 😊

אני מיני סטיבן — אשמח לענות על שאלות ולעזור לך לקבוע זמן עם סטיבן.

מה שמך?`;
}

// After pressing 3 — English flow
function getEnglishFlowOpening() {
    return `Hey! Happy to help.

I'm Mini Steven — Steven Angel's AI assistant. Steven is a signed producer (Moblack, MTGD, Sony) and Ableton Certified Trainer with 20+ years in electronic music.

What are you looking for — lessons, ghost production, or something else?`;
}

function getUnsubMessage(language) {
    return language === 'en'
        ? `You've been removed from our WhatsApp messages ✅\nYou won't receive any more messages from us.`
        : `הוסרת מקבלת הודעות WhatsApp שלנו ✅\nלא תקבל/י הודעות נוספות.`;
}

function getErrorFallbackMessage(language) {
    return language === 'en'
        ? `Hey! Got your message 🙏

We're having a small technical hiccup right now. Steven will get back to you here within a few hours at most 🙏`
        : `היי! קיבלנו את ההודעה שלך 🙏

נראה שיש אצלנו תקלה טכנית רגעית.

סטיבן יחזור אליך בהקדם — תוך שעות ספורות לכל היותר 🙏`;
}

function getDirectInterestQuestion(language) {
    return language === 'en'
        ? `Hey, just checking — are you interested in Steven's services? (yes/no)`
        : `היי, רק לוודא — האם אתה מתעניין בשיעורי DJ עם סטיבן? (כן/לא)`;
}

function getNudgeMessage1(language) {
    return language === 'en'
        ? `Hey! 😊 Just checking in — I'm still here if you have any questions about Steven's services or want to book a quick call`
        : `היי! 😊 נראה שנעצרת — אני עדיין כאן אם יש לך שאלות על השיעורים עם סטיבן`;
}

function getNudgeMessage2(name, language) {
    if (language === 'en') {
        return `Hey${name ? ' ' + name : ''}! Mini Steven here 👋

Just wanted to follow up — are you still interested in working with Steven?

If you'd like to book a quick 15-min Zoom call:
https://calendly.com/dj-steven-angel/15-min-zoom?back=1`;
    }
    return `היי${name ? ' ' + name : ''}! מיני סטיבן כאן 👋

ראיתי שהתחלנו לדבר לפני כמה זמן — רציתי לבדוק אם עדיין מתעניינ/ת בשיעורים עם סטיבן 😊

אם תרצ/י לקבוע שיחת הכרות קצרה של 15 דקות:
https://calendly.com/dj-steven-angel/15-min-zoom?back=1`;
}

function getFollowupMessage(name, language) {
    if (language === 'en') {
        return `Hey${name ? ' ' + name : ''}! Mini Steven here 👋

Just checking in — are you still interested in working with Steven?

If you have questions, I'm here 😊
And if you'd like to book a quick call:
https://calendly.com/dj-steven-angel/15-min-zoom?back=1`;
    }
    return `היי${name ? ' ' + name : ''}! מיני סטיבן כאן 👋

רק בדקתי אם עדיין מתעניינ/ת בשיעורים עם סטיבן?

אם יש שאלות — אני כאן 😊
ואם תרצ/י לקבוע שיחה קצרה:
https://calendly.com/dj-steven-angel/15-min-zoom?back=1`;
}

// ── Unsubscribe ───────────────────────────────────────────────────────────────
const UNSUB_KEYWORDS = [
    'הסר', 'הסר אותי', 'הסר אותי מהרשימות',
    'לא לשלוח', 'לא לשלוח הודעות', 'אל תשלח', 'אל תשלחי',
    'תפסיק', 'תפסיקי', 'תפסיק לשלוח', 'תפסיקי לשלוח',
    'לא מעוניין', 'לא מעוניינת', 'לא רלוונטי',
    'stop', 'unsubscribe',
];
function isUnsubRequest(text) {
    const t = text.trim().toLowerCase();
    // Exact match or starts with keyword — NOT includes, to avoid false positives
    // e.g. "לא מעוניין בזום אבל כן בפרונטלי" should NOT trigger unsub
    return UNSUB_KEYWORDS.some(k => t === k || t.startsWith(k + ' ') || t.startsWith(k + ',') || t.startsWith(k + '.'));
}

// ── Per-chat processing lock (prevents double replies) ────────────────────────
const processingLock = new Set(); // chatIds currently being processed

// ── Nudge (2 שלבים) ───────────────────────────────────────────────────────────
const NUDGE_FILE = path.join(__dirname, 'nudge_state.json');

function loadNudgeState() {
    try {
        const raw = JSON.parse(fs.readFileSync(NUDGE_FILE, 'utf8'));
        return {
            lastBotReply:  new Map(Object.entries(raw.lastBotReply  || {})),
            nudgeStage:    new Map(Object.entries(raw.nudgeStage    || {})),
            offTopicCount: new Map(Object.entries(raw.offTopicCount || {})),
            silenced:      new Set(raw.silenced || []),
            convMeta:      new Map(Object.entries(raw.convMeta      || {})),
        };
    } catch { return { lastBotReply: new Map(), nudgeStage: new Map(), offTopicCount: new Map(), silenced: new Set(), convMeta: new Map() }; }
}
function saveNudgeState() {
    try {
        const obj = {
            lastBotReply:  Object.fromEntries(lastBotReply),
            nudgeStage:    Object.fromEntries(nudgeStage),
            offTopicCount: Object.fromEntries(offTopicCount),
            silenced:      [...silenced],
            convMeta:      Object.fromEntries(convMeta),
        };
        fs.writeFileSync(NUDGE_FILE, JSON.stringify(obj), 'utf8');
    } catch (e) { console.error('❌ saveNudgeState:', e.message); }
}

const { lastBotReply, nudgeStage, offTopicCount, silenced, convMeta } = loadNudgeState();
console.log(`⏰ Nudge state loaded: ${lastBotReply.size} active timers, ${silenced.size} silenced`);

const NUDGE_DELAY_1 = 10 * 60 * 1000;        // 10 דקות → nudge 1
const NUDGE_DELAY_2 = 24 * 60 * 60 * 1000;   // 24 שעות אחרי nudge 1 → nudge 2

// (NUDGE_MSG_1 / NUDGE_MSG_2 moved to bilingual helpers above:
//  getNudgeMessage1(language) / getNudgeMessage2(name, language))

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
        const phoneNum = chatId.replace('@c.us', '').replace(/\D/g, '');

        // NEVER nudge blocked numbers
        if (BLOCKED.has(phoneNum)) { lastBotReply.delete(chatId); nudgeStage.delete(chatId); saveNudgeState(); continue; }

        const meta = convMeta.get(chatId) || { status: 'active', language: null };

        // ── MENU NUDGE: send a SHORT reminder once after 10 min, then stop ───
        // (previously re-sent the full menu, which felt like a duplicate to the user)
        if (meta.status === 'menu') {
            if (now - lastAt >= NUDGE_DELAY_1) {
                try {
                    await sendGreenMessage(chatId, getMenuNudgeMessage());
                    meta.status = 'menu_nudged';
                    convMeta.set(chatId, meta);
                    lastBotReply.delete(chatId); // no more nudges after this
                    saveNudgeState();
                    console.log(`📋 תזכורת תפריט → ${chatId}`);
                } catch (err) { console.error(`❌ Menu nudge failed (${chatId}):`, err.message); }
            }
            continue;
        }

        // ── ACTIVE CONVERSATION NUDGE (2 stages: 10min + 24h) ────────────────
        if (meta.status !== 'active' && meta.status !== null && meta.status !== undefined) continue;

        const state = nudgeStage.get(chatId) || { stage: 0, nudge1At: null };
        const history  = conversations.get(chatId) || [];
        const language = meta.language || getConversationLanguage(history);

        if (state.stage === 0 && now - lastAt >= NUDGE_DELAY_1) {
            try {
                await sendGreenMessage(chatId, getNudgeMessage1(language));
                nudgeStage.set(chatId, { stage: 1, nudge1At: Date.now() });
                saveNudgeState();
                console.log(`💬 Nudge 1 (${language}) → ${chatId}`);
            } catch (err) { console.error(`❌ Nudge 1 failed (${chatId}):`, err.message); }

        } else if (state.stage === 1 && state.nudge1At && now - state.nudge1At >= NUDGE_DELAY_2) {
            const name = getNameFromHistory(chatId);
            try {
                await sendGreenMessage(chatId, getNudgeMessage2(name, language));
                nudgeStage.set(chatId, { stage: 2, nudge1At: state.nudge1At });
                lastBotReply.delete(chatId);
                saveNudgeState();
                console.log(`💬 Nudge 2 (${language}) → ${chatId}`);
            } catch (err) { console.error(`❌ Nudge 2 failed (${chatId}):`, err.message); }
        }
    }
}
setInterval(checkNudges, 60 * 1000);

// ── Follow-up ─────────────────────────────────────────────────────────────────
// (FOLLOWUP_MSG moved to bilingual helper above: getFollowupMessage(name, language))

async function sendPendingFollowups() {
    const leads = await getPendingFollowups();
    if (!leads.length) return;
    console.log(`\n📬 שולח ${leads.length} פולו-אפים...`);
    for (const lead of leads) {
        try {
            const chatId = lead.phone + '@c.us';
            // Never follow-up saved contacts
            const saved = await isSavedContact(chatId);
            if (saved) {
                console.log(`👤 פולו-אפ דולג — קונטקט שמור: ${lead.phone}`);
                continue;
            }
            // Per-conversation language for the followup text
            const history  = conversations.get(chatId) || [];
            const language = getConversationLanguage(history);
            await sendGreenMessage(chatId, getFollowupMessage(lead.name || lead.whatsapp_name, language));
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
    // Only handle incoming messages (text, extended text, images with caption)
    if (data.typeWebhook !== 'incomingMessageReceived') return;
    const ALLOWED_TYPES = ['textMessage', 'extendedTextMessage', 'imageMessage'];
    if (!data.messageData || !ALLOWED_TYPES.includes(data.messageData.typeMessage)) return;

    const chatId    = data.senderData?.chatId || data.senderData?.sender;
    const msgId     = data.idMessage;
    const userText  = (
        data.messageData?.textMessageData?.textMessage ||
        data.messageData?.extendedTextMessageData?.text ||
        data.messageData?.imageMessage?.caption ||
        ''
    ).trim() || null;
    const senderName = data.senderData?.senderName || null;

    if (!chatId || !userText || !msgId) return;

    // Ignore group chats
    if (chatId.endsWith('@g.us')) return;

    // Extract phone number
    const phoneNum = chatId.replace('@c.us', '').replace(/\D/g, '');

    // Block list
    if (BLOCKED.has(phoneNum)) return;

    // Silenced (off-topic conversation — bot stopped engaging)
    if (silenced.has(chatId)) return;

    // Fast check: contactName in webhook payload — no API call needed
    if (data.senderData?.contactName) {
        console.log(`👤 Saved contact (webhook) — skipping: ${phoneNum}`);
        return;
    }

    // Fallback: getContactInfo API call
    const saved = await isSavedContact(chatId);
    if (saved) {
        console.log(`👤 Saved contact (API) — skipping: ${phoneNum}`);
        return;
    }


    // Dedup
    if (processedIds.has(msgId)) return;
    processedIds.add(msgId);
    if (processedIds.size > 500) processedIds.delete(processedIds.values().next().value);

    // Per-chat lock — prevents double reply if webhook fires twice simultaneously
    if (processingLock.has(chatId)) {
        console.log(`⏳ Already processing ${chatId} — skipping duplicate`);
        return;
    }
    processingLock.add(chatId);

    console.log(`\n📩 ${chatId} | "${userText}"`);

    // Unsubscribe
    if (isUnsubRequest(userText)) {
        BLOCKED.add(phoneNum);
        saveBlocked(BLOCKED);
        nudgeStage.delete(chatId);
        lastBotReply.delete(chatId);
        updateLead(phoneNum, { status: 'contacted', notes: '🚫 ביקש הסרה מהרשימות' }).catch(()=>{});
        // Detect language from the unsub text itself (no history yet at this point for new leads)
        const unsubLang = detectLanguage(userText);
        await sendGreenMessage(chatId, getUnsubMessage(unsubLang));
        console.log(`🚫 הוסר (${unsubLang}): ${phoneNum}`);
        processingLock.delete(chatId);
        return;
    }

    // Init conversation
    const isNew = !conversations.has(chatId);
    if (!conversations.has(chatId)) conversations.set(chatId, []);
    const history = conversations.get(chatId);

    // CRM
    upsertLead({ phone: phoneNum, whatsapp_name: senderName, source: 'whatsapp' }).catch(()=>{});

    // ── NEW CONTACT: send menu, wait for 1/3 ─────────────────────────────────
    if (isNew) {
        const menu = getMenuMessage();
        history.push({ role: 'user', content: userText });
        history.push({ role: 'assistant', content: menu });
        convMeta.set(chatId, { status: 'menu', language: null });
        saveConversations(conversations);
        await sendGreenMessage(chatId, menu);
        lastBotReply.set(chatId, Date.now());
        saveNudgeState();
        console.log(`📤 תפריט נשלח → ${phoneNum}`);
        processingLock.delete(chatId);
        return;
    }

    // ── MENU STATE: route by 1/3 ─────────────────────────────────────────────
    const meta = convMeta.get(chatId) || { status: 'active', language: null };
    if (meta.status === 'menu' || meta.status === 'menu_nudged') {
        const choice = userText.trim();
        if (choice === '1') {
            meta.status = 'active';
            meta.language = 'he';
            convMeta.set(chatId, meta);
            history.push({ role: 'user', content: userText });
            const opening = getHebrewFlowOpening();
            history.push({ role: 'assistant', content: opening });
            saveConversations(conversations);
            await sendGreenMessage(chatId, opening);
            lastBotReply.set(chatId, Date.now());
            nudgeStage.delete(chatId);
            saveNudgeState();
            console.log(`📤 עברית → ${phoneNum}`);
        } else if (choice === '2') {
            // User typed 2 → wants to schedule a call. Resend the bitly link prominently.
            // Keep status as menu/menu_nudged so they can still pick 1 or 3 later if needed.
            const reply = `מעולה 🙌 לחצו לקביעת זמן שיחה עם סטיבן:\n👉 ${CALENDLY_SHORT}`;
            history.push({ role: 'user', content: userText });
            history.push({ role: 'assistant', content: reply });
            saveConversations(conversations);
            await sendGreenMessage(chatId, reply);
            lastBotReply.set(chatId, Date.now());
            saveNudgeState();
            console.log(`📤 קלנדרי (bitly) → ${phoneNum}`);
        } else if (choice === '3') {
            meta.status = 'active';
            meta.language = 'en';
            convMeta.set(chatId, meta);
            history.push({ role: 'user', content: userText });
            const opening = getEnglishFlowOpening();
            history.push({ role: 'assistant', content: opening });
            saveConversations(conversations);
            await sendGreenMessage(chatId, opening);
            lastBotReply.set(chatId, Date.now());
            nudgeStage.delete(chatId);
            saveNudgeState();
            console.log(`📤 English → ${phoneNum}`);
        } else {
            // Not a valid choice — ignore, let nudge handle it
            console.log(`⏳ תפריט: לא זוהה ("${userText}") → ${phoneNum}`);
        }
        processingLock.delete(chatId);
        return;
    }

    // Reset nudge (user replied — cancel pending timers)
    nudgeStage.delete(chatId);
    lastBotReply.delete(chatId);
    saveNudgeState();

    scanForCRMData(phoneNum, userText, history).catch(()=>{});

    // Off-topic direct question: if we already asked "are you interested?" — check response
    const DIRECT_Q_KEY = chatId + ':directQ';
    if (offTopicCount.get(DIRECT_Q_KEY)) {
        const positive = /כן|yes|מעוניין|מעוניינת|interested|sure|בטח|אוקי|ok|בהחלט/i.test(userText);
        if (positive) {
            // Reset — they are interested, continue normally
            offTopicCount.delete(DIRECT_Q_KEY);
            offTopicCount.delete(chatId);
            saveNudgeState();
            console.log(`✅ Off-topic reset — user confirmed interest: ${chatId}`);
        } else {
            // Not interested — silence
            silenced.add(chatId);
            offTopicCount.delete(DIRECT_Q_KEY);
            offTopicCount.delete(chatId);
            saveNudgeState();
            console.log(`🔇 Silenced after no-interest reply: ${chatId}`);
            processingLock.delete(chatId);
            return;
        }
    }

    // AI
    history.push({ role: 'user', content: userText });
    while (history.length > MAX_HISTORY) history.splice(0, 2);

    // Language: use convMeta (set when user pressed 1/3), fallback to detection for old conversations
    const language = convMeta.get(chatId)?.language || getConversationLanguage(history);

    try {
        const reply = await getAIResponse(history, 'new_lead', language);
        history.push({ role: 'assistant', content: reply });
        saveConversations(conversations);
        await sendGreenMessage(chatId, reply);
        lastBotReply.set(chatId, Date.now());
        saveNudgeState();
        console.log(`📤 נשלח (${language})`);

        // Off-topic detection — runs in background, doesn't block the reply
        isOffTopic(history).then(offTopic => {
            if (!offTopic) {
                // Relevant — reset counter
                if (offTopicCount.get(chatId)) { offTopicCount.delete(chatId); saveNudgeState(); }
                return;
            }
            const count = (offTopicCount.get(chatId) || 0) + 1;
            offTopicCount.set(chatId, count);
            console.log(`🤔 Off-topic count ${count} for ${chatId}`);

            if (count >= 2) {
                // Send direct question once (bilingual)
                sendGreenMessage(chatId, getDirectInterestQuestion(language)).then(() => {
                    offTopicCount.set(DIRECT_Q_KEY, true);
                    saveNudgeState();
                    console.log(`❓ Direct question sent to ${chatId} (${language})`);
                }).catch(e => console.error('❌ Direct Q send failed:', e.message));
            } else {
                saveNudgeState();
            }
        }).catch(e => console.error('❌ isOffTopic error:', e.message));
    } catch (err) {
        console.error('❌ שגיאת AI:', err.message);
        await updateLead(phoneNum, {
            status: 'contacted',
            notes: `⚠️ שגיאה טכנית ${new Date().toLocaleString('he-IL')} — לחזור ללקוח`,
        }).catch(()=>{});
        history.pop();
        await sendGreenMessage(chatId, getErrorFallbackMessage(language));
    } finally {
        processingLock.delete(chatId);
    }
}

console.log('🚀 DROP Bot (Green API) מוכן!');
