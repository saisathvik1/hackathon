async function load() {
  const { openai_api_key, privacy_settings, voice_settings } = await chrome.storage.local.get(['openai_api_key', 'privacy_settings', 'voice_settings']);
  document.getElementById('apiKey').value = openai_api_key || '';
  const p = privacy_settings || { redactPII: true };
  document.getElementById('redactPII').checked = Boolean(p.redactPII);
  const v = voice_settings || { lang: 'en-US', rate: 0.9, pitch: 1 };
  document.getElementById('lang').value = v.lang || 'en-US';
  document.getElementById('rate').value = String(v.rate ?? 0.9);
  document.getElementById('pitch').value = String(v.pitch ?? 1);
}

async function save() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const privacy = { redactPII: document.getElementById('redactPII').checked };
  const voice = {
    lang: document.getElementById('lang').value,
    rate: parseFloat(document.getElementById('rate').value) || 0.9,
    pitch: parseFloat(document.getElementById('pitch').value) || 1
  };
  await chrome.runtime.sendMessage({ type: 'save-settings', apiKey, privacy, voice });
  const status = document.getElementById('status');
  status.textContent = 'Saved';
  setTimeout(() => (status.textContent = ''), 1500);
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  document.getElementById('save').addEventListener('click', save);
});


