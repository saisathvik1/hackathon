async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function init() {
  const statusEl = document.getElementById('status');
  const enableCb = document.getElementById('enableSite');
  const tab = await getActiveTab();
  const bgSettings = await chrome.runtime.sendMessage({ type: 'get-settings', origin: new URL(tab.url).origin });
  enableCb.checked = Boolean(bgSettings?.data?.siteEnabled);
  enableCb.addEventListener('change', async (e) => {
    await chrome.runtime.sendMessage({ type: 'set-enabled-for-site', enabled: e.target.checked, origin: new URL(tab.url).origin });
    statusEl.textContent = e.target.checked ? 'Enabled for this site' : 'Disabled for this site';
    setTimeout(() => (statusEl.textContent = ''), 1500);
  });

  document.getElementById('startBtn').addEventListener('click', async () => {
    if (!enableCb.checked) {
      statusEl.textContent = 'Enable the site first';
      setTimeout(() => (statusEl.textContent = ''), 1500);
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: 'form-buddy-start' });
    window.close();
  });

  document.getElementById('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

document.addEventListener('DOMContentLoaded', init);


