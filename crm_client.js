/**
 * CRM Client — calls the Railway CRM API from the WhatsApp bot
 */

require('dotenv').config({ override: true });

const CRM_URL = process.env.CRM_API_URL;   // e.g. https://drop-crm.up.railway.app
const API_KEY = process.env.CRM_API_KEY;

async function post(path, body) {
    const res = await fetch(`${CRM_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify(body),
    });
    return res.json();
}

async function patch(path, body) {
    const res = await fetch(`${CRM_URL}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify(body),
    });
    return res.json();
}

async function get(path) {
    const res = await fetch(`${CRM_URL}${path}`, {
        headers: { 'x-api-key': API_KEY },
    });
    return res.json();
}

// ── Public API ────────────────────────────────────────────────────────────────

async function upsertLead({ phone, whatsapp_name, source = 'whatsapp' }) {
    try {
        return await post('/api/leads', { phone, whatsapp_name, source });
    } catch (e) {
        console.error('CRM upsertLead error:', e.message);
    }
}

async function updateLead(phone, fields) {
    try {
        const p = phone.replace('@c.us', '').replace(/\D/g, '');
        return await patch(`/api/leads/${p}`, fields);
    } catch (e) {
        console.error('CRM updateLead error:', e.message);
    }
}

async function getPendingFollowups() {
    try {
        const result = await get('/api/followups');
        return Array.isArray(result) ? result : [];
    } catch (e) {
        return [];
    }
}

function extractEmail(text) {
    const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return match ? match[0] : null;
}

module.exports = { upsertLead, updateLead, getPendingFollowups, extractEmail };
