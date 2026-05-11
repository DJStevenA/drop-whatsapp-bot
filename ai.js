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

// Triage the FIRST incoming WhatsApp message from a new lead.
// Replaces the legacy 1/2/3 menu (dropped 2026-05-11 per Steven): if the message
// is plausibly about Steven's services we engage directly; if it's clearly
// off-topic we stay silent and ping admin.
// Returns { interested: boolean, language: 'he' | 'en' }.
// Biased toward 'interested' — a bare "היי" / "hi" counts as a lead. Only
// label not_interested when it's clearly spam, wrong number, or unrelated.
async function classifyNewLead(text) {
    try {
        const res = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 30,
            system: `You triage the FIRST WhatsApp message to Steven Angel — a DJ-lessons and music-production teacher in Israel.

Output EXACTLY two tokens separated by a single space and nothing else:
<interested|not_interested> <he|en>

interested = the sender plausibly wants Steven's services (DJ lessons, music production, studio time, prices, scheduling, ghost production, mentoring, Ableton help), OR is a generic greeting / opener ("היי", "שלום", "hi", "hello", "מה קורה"). Default to interested when ambiguous.
not_interested = clearly off-topic: spam, wrong number, unrelated B2B pitch, recruiter, vendor, another bot, mass-marketing blast.

The language token reflects the language of the sender's message ('he' for Hebrew, 'en' for English; pick 'he' if mixed/unclear).`,
            messages: [{ role: 'user', content: text }],
        });
        const raw = (res.content[0].text || '').trim().toLowerCase();
        const [intentTok, langTok] = raw.split(/\s+/);
        return {
            interested: intentTok !== 'not_interested',
            language:   langTok === 'en' ? 'en' : 'he',
        };
    } catch (err) {
        console.error('❌ classifyNewLead failed:', err.message);
        return { interested: true, language: 'he' }; // safe default: engage
    }
}

module.exports = { getAIResponse, isOffTopic, classifyNewLead };
