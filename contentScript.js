// Content script: overlay UI, field detection, TTS/STT, and confirm-to-fill flow

(function() {
  let currentFieldIndex = 0;
  let fields = [];
  let lastProposedValue = '';
  let settings = { privacy: { redactPII: true }, voice: { lang: 'en-US', rate: 0.9, pitch: 1 }, siteEnabled: false };

  function queryFields() {
    const candidates = Array.from(document.querySelectorAll('input, textarea, select'));
    const map = candidates
      .filter(el => !el.disabled && el.offsetParent !== null)
      .map((el) => {
        const id = el.getAttribute('id');
        const labelEl = id ? document.querySelector(`label[for="${id}"]`) : el.closest('label');
        const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
        const helpId = el.getAttribute('aria-describedby');
        const help = helpId ? (document.getElementById(helpId)?.innerText?.trim() || '') : '';
        return {
          element: el,
          name: el.getAttribute('name') || '',
          type: (el.getAttribute('type') || el.tagName || '').toLowerCase(),
          label: (labelEl?.innerText || aria || '').trim(),
          placeholder: el.getAttribute('placeholder') || '',
          help
        };
      });
    return map;
  }

  function highlightField(index) {
    clearHighlights();
    const f = fields[index];
    if (!f) return;
    f.element.style.outline = '3px solid #2f80ed';
    f.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function clearHighlights() {
    fields.forEach(f => { f.element.style.outline = ''; });
  }

  function speak(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = settings.voice.rate || 0.9;
      u.pitch = settings.voice.pitch || 1;
      u.lang = settings.voice.lang || 'en-US';
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (_) {
      // ignore
    }
  }

  function listenOnce() {
    return new Promise((resolve, reject) => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return reject(new Error('Speech recognition not supported in this browser.'));
      const rec = new SR();
      rec.lang = settings.voice.lang || 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => resolve(e.results[0][0].transcript);
      rec.onerror = (e) => reject(e.error || 'speech_error');
      rec.onend = () => {};
      rec.start();
    });
  }

  function setValue(el, value) {
    if (!el) return;
    if (el.tagName === 'SELECT') {
      el.value = value;
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = Boolean(value);
    } else {
      el.value = value ?? '';
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function createOverlay() {
    if (document.getElementById('form-buddy-shadow-host')) return;
    const host = document.createElement('div');
    host.id = 'form-buddy-shadow-host';
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.bottom = '16px';
    host.style.right = '16px';
    host.style.zIndex = '2147483647';
    const shadow = host.attachShadow({ mode: 'open' });

    const container = document.createElement('div');
    container.className = 'fb-container';
    container.innerHTML = `
      <div class="fb-card">
        <div class="fb-title">Form Buddy</div>
        <div class="fb-text" id="fbText">Ready to help. Highlighting the first field.</div>
        <div class="fb-row">
          <button id="fbExplain" class="fb-btn">Explain</button>
          <button id="fbSpeak" class="fb-btn">Speak Answer</button>
          <button id="fbConfirm" class="fb-btn fb-primary">Confirm & Fill</button>
        </div>
        <div class="fb-row fb-small">
          <button id="fbPrev" class="fb-link">Prev</button>
          <button id="fbNext" class="fb-link">Next</button>
          <button id="fbClose" class="fb-link">Close</button>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `${getOverlayCss()}`;

    shadow.appendChild(style);
    shadow.appendChild(container);
    document.documentElement.appendChild(host);

    const $ = (id) => shadow.getElementById(id);
    const textEl = $("fbText");
    $("fbExplain").addEventListener('click', async () => {
      const f = fields[currentFieldIndex];
      if (!f) return;
      textEl.textContent = 'Explaining the field...';
      const res = await sendBg({ type: 'explain-field', field: stripElement(f) });
      const msg = res?.explanation || 'This field collects information. Would you like help?';
      textEl.textContent = msg;
      speak(msg);
    });
    $("fbSpeak").addEventListener('click', async () => {
      const f = fields[currentFieldIndex];
      if (!f) return;
      try {
        textEl.textContent = 'Listening... please speak after the beep.';
        speak('Please speak now.');
        const transcript = await listenOnce();
        const res = await sendBg({ type: 'clarify-value', field: stripElement(f), userSpeech: transcript });
        const r = res?.result || {};
        if (r.needs_clarification && r.clarified_question) {
          textEl.textContent = r.clarified_question;
          speak(r.clarified_question);
          lastProposedValue = '';
        } else if (r.proposed_value) {
          lastProposedValue = r.proposed_value;
          const confirmMsg = `I will put “${r.proposed_value}” into ${f.label || 'this field'}. Is that correct?`;
          textEl.textContent = confirmMsg;
          speak(confirmMsg);
        } else {
          textEl.textContent = 'I am not sure. Please try again.';
          speak('I am not sure. Please try again.');
        }
      } catch (e) {
        const err = String(e || 'error');
        textEl.textContent = 'Voice not available or an error occurred.';
        console.warn('Form Buddy listen error:', err);
      }
    });
    $("fbConfirm").addEventListener('click', async () => {
      const f = fields[currentFieldIndex];
      if (!f) return;
      if (!lastProposedValue) {
        textEl.textContent = 'There is nothing to confirm yet.';
        return;
      }
      setValue(f.element, lastProposedValue);
      const doneMsg = 'Filled. Moving to the next field.';
      textEl.textContent = doneMsg;
      speak(doneMsg);
      currentFieldIndex = Math.min(currentFieldIndex + 1, fields.length - 1);
      highlightField(currentFieldIndex);
    });
    $("fbPrev").addEventListener('click', () => {
      currentFieldIndex = Math.max(0, currentFieldIndex - 1);
      highlightField(currentFieldIndex);
    });
    $("fbNext").addEventListener('click', () => {
      currentFieldIndex = Math.min(fields.length - 1, currentFieldIndex + 1);
      highlightField(currentFieldIndex);
    });
    $("fbClose").addEventListener('click', () => {
      destroyOverlay();
    });
  }

  function getOverlayCss() {
    return `
      .fb-container { all: initial; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
      .fb-card { background: #111827; color: #fff; border-radius: 12px; padding: 12px; width: 320px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); border: 1px solid #374151; }
      .fb-title { font-weight: 700; font-size: 16px; margin-bottom: 8px; }
      .fb-text { font-size: 15px; line-height: 1.4; margin-bottom: 10px; }
      .fb-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
      .fb-btn { flex: 1; background: #1f2937; color: #fff; border: 1px solid #374151; padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 14px; }
      .fb-btn:hover { background: #111827; }
      .fb-primary { background: #2563eb; border-color: #1d4ed8; }
      .fb-primary:hover { background: #1d4ed8; }
      .fb-link { background: transparent; border: none; color: #93c5fd; cursor: pointer; font-size: 13px; }
      .fb-small { margin-top: 4px; justify-content: flex-end; gap: 12px; }
    `;
  }

  function destroyOverlay() {
    clearHighlights();
    const host = document.getElementById('form-buddy-shadow-host');
    if (host) host.remove();
  }

  function stripElement(f) {
    const { element, ...rest } = f;
    return rest;
  }

  function sendBg(payload) {
    return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
  }

  async function initIfEnabled() {
    try {
      const res = await sendBg({ type: 'get-settings' });
      settings = res?.data ? res.data : settings;
      if (!settings.siteEnabled) return; // Do nothing unless enabled for this site
      fields = queryFields();
      if (fields.length === 0) return;
      currentFieldIndex = 0;
      createOverlay();
      highlightField(currentFieldIndex);
      speak('Form Buddy is ready to help.');
    } catch (e) {
      // ignore
    }
  }

  // Listen for explicit start command from popup
  chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    if (msg && msg.type === 'form-buddy-start') {
      initIfEnabled();
    }
  });

  // Passive init on load for enabled sites
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initIfEnabled, 300);
  });
})();


