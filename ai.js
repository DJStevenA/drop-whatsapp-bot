require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT_NEW_LEAD } = require('./system_prompt');

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// בחירת system prompt לפי סוג הבוט
function getSystemPrompt(botType) {
    switch (botType) {
        case 'new_lead':
            return SYSTEM_PROMPT_NEW_LEAD;
        case 'existing':
            // TODO: לייבא SYSTEM_PROMPT_EXISTING כשיהיה מוכן
            return SYSTEM_PROMPT_NEW_LEAD; // placeholder
        default:
            return SYSTEM_PROMPT_NEW_LEAD;
    }
}

/**
 * @param {Array}  history  - [{role, content}, ...]
 * @param {string} botType  - 'new_lead' | 'existing'
 */
async function getAIResponse(history, botType = 'new_lead') {
    const response = await anthropic.messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
        max_tokens: 600,
        system: getSystemPrompt(botType),
        messages: history,
    });

    return response.content[0].text;
}

module.exports = { getAIResponse };
