require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT_NEW_LEAD, SYSTEM_PROMPT_NEW_LEAD_EN } = require('./system_prompt');

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// בחירת system prompt לפי סוג הבוט וגם לפי שפה ('he' / 'en').
// עד 2026-04-30 הפונקציה התעלמה מ-language וכל הלידים האנגליים קיבלו את
// הפרומפט העברי בפועל — תוקן בסשן הזה.
function getSystemPrompt(botType, language = 'he') {
    if (botType === 'new_lead') {
        return language === 'en' ? SYSTEM_PROMPT_NEW_LEAD_EN : SYSTEM_PROMPT_NEW_LEAD;
    }
    // 'existing' / unknown — placeholder until SYSTEM_PROMPT_EXISTING is built
    return language === 'en' ? SYSTEM_PROMPT_NEW_LEAD_EN : SYSTEM_PROMPT_NEW_LEAD;
}

/**
 * @param {Array}  history  - [{role, content}, ...]
 * @param {string} botType  - 'new_lead' | 'existing'
 * @param {string} language - 'he' | 'en' (sticky per conversation, set from menu choice)
 */
async function getAIResponse(history, botType = 'new_lead', language = 'he') {
    const response = await anthropic.messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
        max_tokens: 600,
        system: getSystemPrompt(botType, language),
        messages: history,
    });

    return response.content[0].text;
}

/**
 * Classify whether the conversation is relevant to the service
 * (DJ lessons / studio booking with Steven).
 * Returns true if the person seems off-topic / uninterested / a bot.
 * Uses claude-haiku for speed and low cost.
 */
async function isOffTopic(history) {
    // Only classify after at least 2 user messages
    const userMsgs = history.filter(m => m.role === 'user');
    if (userMsgs.length < 2) return false;

    // Last 4 messages are enough context
    const recentHistory = history.slice(-4);

    try {
        const res = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 10,
            system: `You classify WhatsApp conversations for a DJ lessons booking bot.
Reply with exactly one word: "relevant" or "not_relevant".
"relevant" = the person seems interested in DJ lessons, music production, studio time, or booking Steven.
"not_relevant" = the person is clearly off-topic (wrong number, another bot, spam, unrelated business, or completely uninterested).`,
            messages: recentHistory,
        });
        const verdict = res.content[0].text.trim().toLowerCase();
        return verdict === 'not_relevant';
    } catch (err) {
        console.error('❌ isOffTopic classification failed:', err.message);
        return false; // on error, assume relevant (safe default)
    }
}

/**
 * Handoff summary — fires when Steven manually replies to a lead in a thread that
 * was previously bot-driven. The bot then sends this 2-3 line recap into the chat
 * so both Steven and the lead are on the same page.
 *
 * @param {Array}  history  - [{role, content}, ...] — the bot↔lead history before Steven joined
 * @param {string} language - 'he' | 'en'
 */
async function generateHandoffSummary(history, language = 'he') {
    if (!Array.isArray(history) || history.length === 0) return null;

    const sys = language === 'en'
        ? `Steven Angel (the real human producer) just joined a WhatsApp thread that was running on his AI assistant. Generate a short context recap so he doesn't have to scroll. Output EXACTLY this format — plain text, no emojis, no greeting:

Quick recap now that Steven is here:
- What the client wants: <one short line>
- What they've shared: <one short line>
- What's still open: <one short line>

Total under 60 words. Use plain dashes for bullets. Reply in English.`
        : `סטיבן אנג'ל (המפיק עצמו, אדם אמיתי) הצטרף עכשיו לשרשור ווטסאפ שעד עכשיו רץ בו הסוכן AI. תייצר recap קצר שיעזור לו להיכנס לתמונה בלי לגלול. הפורמט מדויק, טקסט פשוט, בלי אימוגים, בלי ברכה:

סיכום קצר עכשיו שסטיבן בשיחה:
- הליד מחפש: <שורה אחת קצרה>
- מה ששיתפו עד עכשיו: <שורה אחת קצרה>
- מה שעוד פתוח: <שורה אחת קצרה>

עד 60 מילים. בולטים עם מקפים. כתוב בעברית.`;

    // Compress history into a single user message for the summarizer
    const transcript = history.map(m => {
        const who = m.role === 'user' ? 'Lead' : 'Bot';
        return `${who}: ${m.content}`;
    }).join('\n');

    try {
        const res = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 250,
            system: sys,
            messages: [{ role: 'user', content: transcript }],
        });
        return res.content?.[0]?.text?.trim() || null;
    } catch (err) {
        console.error('❌ generateHandoffSummary error:', err.message);
        return null;
    }
}

module.exports = { getAIResponse, isOffTopic, generateHandoffSummary };
