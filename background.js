// Background service worker: settings, privacy, and LLM proxy

const STORAGE_KEYS = {
  apiKey: 'openai_api_key',
  privacy: 'privacy_settings',
  voice: 'voice_settings',
  enabledSites: 'enabled_sites'
};

const DEFAULT_PRIVACY = {
  redactPII: true
};

const DEFAULT_VOICE = {
  lang: 'en-US',
  rate: 0.9,
  pitch: 1
};

async function getFromStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

async function setInStorage(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function getOriginFromUrl(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch (e) {
    return null;
  }
}

function redactPII(text) {
  if (!text) return text;
  // Very simple redactors for MVP
  let redacted = text;
  // Emails
  redacted = redacted.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]');
  // Phone numbers (US-centric)
  redacted = redacted.replace(/\+?\d?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[PHONE_REDACTED]');
  // SSN-like
  redacted = redacted.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN_REDACTED]');
  // Street numbers (weak heuristic, keep context minimal)
  redacted = redacted.replace(/\b\d{1,5} [\w\s.]+\b/g, '[ADDRESS_REDACTED]');
  return redacted;
}

async function callOpenAI({ apiKey, systemPrompt, userPrompt, jsonMode = false }) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || '';
  return content;
}

function simpleExplain(field) {
  const label = field.label || field.name || field.type || 'this field';
  const help = field.help ? ` ${field.help}` : '';
  const typeHints = {
    email: ' It expects your email address.',
    tel: ' It expects your phone number.',
    number: ' It expects a number.',
    date: ' It expects a date.',
    select: ' Please choose one of the options.'
  };
  const typ = field.type?.toLowerCase();
  const typeHelp = typeHints[typ] || '';
  return `The field "${label}" asks for information.${typeHelp}${help} Would you like help filling it?`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const raw = await getFromStorage(Object.values(STORAGE_KEYS));
    const apiKey = raw?.[STORAGE_KEYS.apiKey];
    const privacy = raw?.[STORAGE_KEYS.privacy] || DEFAULT_PRIVACY;
    const voice = raw?.[STORAGE_KEYS.voice] || DEFAULT_VOICE;
    const enabledSites = raw?.[STORAGE_KEYS.enabledSites] || {};
    const tabUrl = sender?.url || sender?.tab?.url || '';
    const origin = message.origin || getOriginFromUrl(tabUrl);
    const siteEnabled = origin ? Boolean(enabledSites[origin]) : false;

    if (message.type === 'get-settings') {
      sendResponse({ ok: true, data: { privacy: privacy || DEFAULT_PRIVACY, voice: voice || DEFAULT_VOICE, siteEnabled } });
      return;
    }

    if (message.type === 'set-enabled-for-site') {
      if (!origin) {
        sendResponse({ ok: false, error: 'Cannot determine origin' });
        return;
      }
      const newMap = { ...(enabledSites || {}), [origin]: Boolean(message.enabled) };
      await setInStorage({ [STORAGE_KEYS.enabledSites]: newMap });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'explain-field') {
      const field = message.field;
      if (!apiKey) {
        // Local explanation fallback
        sendResponse({ ok: true, explanation: simpleExplain(field), usedLLM: false });
        return;
      }
      const systemPrompt = 'You simplify online form fields for seniors. Be brief, friendly, and concrete. Use plain language.';
      const payload = JSON.stringify({
        label: field.label,
        help: field.help,
        placeholder: field.placeholder,
        type: field.type
      });
      const userPrompt = `Explain the form field in 1 sentence, then ask if they want help. Field: ${privacy?.redactPII ? redactPII(payload) : payload}`;
      try {
        const content = await callOpenAI({ apiKey, systemPrompt, userPrompt, jsonMode: false });
        sendResponse({ ok: true, explanation: content, usedLLM: true });
      } catch (e) {
        sendResponse({ ok: true, explanation: simpleExplain(field), usedLLM: false, fallbackError: String(e) });
      }
      return;
    }

    if (message.type === 'clarify-value') {
      const { field, userSpeech } = message;
      const systemPrompt = 'You are a form assistant. Return strict JSON with keys: intent (fill|clarify|reject), needs_clarification (boolean), clarified_question (string), proposed_value (string|null), confidence (0-1), reasons (string). Keep it short.';
      const payload = JSON.stringify({ field, userSpeech });
      if (!apiKey) {
        // Local minimal behavior: echo back
        sendResponse({ ok: true, result: { intent: 'fill', needs_clarification: false, clarified_question: '', proposed_value: userSpeech || '', confidence: 0.6, reasons: 'No LLM configured, echoing user input.' }, usedLLM: false });
        return;
      }
      const userPrompt = `User spoke an answer for a form field. ${privacy?.redactPII ? 'PII may be redacted.' : ''} Respond in JSON only. Input: ${privacy?.redactPII ? redactPII(payload) : payload}`;
      try {
        const content = await callOpenAI({ apiKey, systemPrompt, userPrompt, jsonMode: true });
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          parsed = { intent: 'clarify', needs_clarification: true, clarified_question: 'Could you please repeat that?', proposed_value: null, confidence: 0.1, reasons: 'Non-JSON response' };
        }
        sendResponse({ ok: true, result: parsed, usedLLM: true });
      } catch (e) {
        sendResponse({ ok: true, result: { intent: 'fill', needs_clarification: false, clarified_question: '', proposed_value: userSpeech || '', confidence: 0.5, reasons: 'LLM error, echoing input.' }, usedLLM: false, fallbackError: String(e) });
      }
      return;
    }

    if (message.type === 'save-settings') {
      const { apiKey: newKey, privacy: newPrivacy, voice: newVoice } = message;
      const toSet = {};
      if (typeof newKey === 'string') toSet[STORAGE_KEYS.apiKey] = newKey.trim();
      if (newPrivacy) toSet[STORAGE_KEYS.privacy] = { ...DEFAULT_PRIVACY, ...newPrivacy };
      if (newVoice) toSet[STORAGE_KEYS.voice] = { ...DEFAULT_VOICE, ...newVoice };
      await setInStorage(toSet);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message type' });
  })();
  return true; // Keep message channel open for async sendResponse
});


