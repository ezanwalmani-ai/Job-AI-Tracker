const STORAGE_KEY = 'mjt_pairing_config';

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function encodeBase64Url(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodePairingCode(raw) {
  const cleaned = raw.trim().replace(/^mjt_pair_/, '');
  const padded = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function fallbackExtractOnActiveTab() {
  const h = window.location.hostname.toLowerCase();
  let portalName = 'Company Career Page';
  if (h.includes('linkedin.com')) portalName = 'LinkedIn';
  else if (h.includes('indeed.com')) portalName = 'Indeed';
  else if (h.includes('naukri.com')) portalName = 'Naukri';
  else if (h.includes('workindia.in')) portalName = 'WorkIndia';
  else if (h.includes('apna.co')) portalName = 'Apna';

  const h1 = document.querySelector('h1');
  const ogSite = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || '';
  return {
    portalName,
    jobTitle: (h1?.innerText || document.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    companyName: (ogSite || h.replace(/^www\./, '').split('.')[0]).trim().slice(0, 200),
    jobLocation: '',
    jobDescription: (document.querySelector('main, article')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
    jobUrl: window.location.href,
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  const portalEl = document.getElementById('portal');
  const companyEl = document.getElementById('company');
  const titleEl = document.getElementById('title');
  const locationEl = document.getElementById('location');
  const urlEl = document.getElementById('url');
  const notesEl = document.getElementById('notes');
  const saveBtn = document.getElementById('save-btn');
  const webBtn = document.getElementById('web-btn');
  const statusEl = document.getElementById('status-msg');
  const pairingPill = document.getElementById('pairing-pill');
  const pairingCodeEl = document.getElementById('pairing-code');
  const pairBtn = document.getElementById('pair-btn');
  const pairingStatusEl = document.getElementById('pairing-status');
  const pairingDetails = document.getElementById('pairing-section');

  let capturedDescription = '';
  let currentAppUrl = 'https://jobaitracker.netlify.app';

  function updatePairingUi(cfg) {
    if (cfg?.appUrl) currentAppUrl = cfg.appUrl;
    if (cfg?.refreshToken && cfg?.uid) {
      pairingPill.textContent = cfg.email ? `Paired (${cfg.email.split('@')[0]})` : 'Paired';
      pairingPill.className = 'pill pill-ok';
    } else {
      pairingPill.textContent = 'Not Paired';
      pairingPill.className = 'pill pill-warn';
      pairingDetails.open = true;
    }
  }

  chrome.runtime.sendMessage({ type: 'GET_APP_CONFIG' }, (res) => {
    if (res?.ok) updatePairingUi(res.config);
  });

  // Extract visible job info from active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url?.startsWith('http')) {
      urlEl.value = tab.url;
      chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_JOB' }, async (resp) => {
        if (!chrome.runtime.lastError && resp?.ok && resp.data) {
          const d = resp.data;
          if (d.portalName) portalEl.value = d.portalName;
          if (d.companyName) companyEl.value = d.companyName;
          if (d.jobTitle) titleEl.value = d.jobTitle;
          if (d.jobLocation) locationEl.value = d.jobLocation;
          if (d.jobUrl) urlEl.value = d.jobUrl;
          capturedDescription = d.jobDescription || '';
        } else {
          // On arbitrary company career sites where content script isn't pre-injected
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: fallbackExtractOnActiveTab,
            });
            const d = results?.[0]?.result;
            if (d) {
              portalEl.value = d.portalName;
              companyEl.value = d.companyName;
              titleEl.value = d.jobTitle;
              locationEl.value = d.jobLocation;
              urlEl.value = d.jobUrl;
              capturedDescription = d.jobDescription || '';
            }
          } catch {
            // User can still enter fields manually
          }
        }
      });
    }
  } catch {
    // Ignore restricted chrome:// pages
  }

  function buildPayload() {
    const appliedChoice =
      document.querySelector('input[name="applyChoice"]:checked')?.value === 'applied';
    return {
      portalName: portalEl.value,
      companyName: clean(companyEl.value),
      jobTitle: clean(titleEl.value),
      jobLocation: clean(locationEl.value) || 'Not specified',
      jobUrl: clean(urlEl.value),
      notes: clean(notesEl.value),
      jobDescription: capturedDescription,
      didApply: appliedChoice,
      capturedAt: new Date().toISOString(),
    };
  }

  saveBtn.addEventListener('click', () => {
    const payload = buildPayload();
    if (!payload.companyName || !payload.jobTitle) {
      statusEl.className = 'status-msg err';
      statusEl.textContent = 'Company Name and Job Title are required.';
      return;
    }

    saveBtn.disabled = true;
    statusEl.className = 'status-msg';
    statusEl.textContent = 'Checking duplicates and saving...';

    chrome.runtime.sendMessage({ type: 'SAVE_JOB_TO_FIRESTORE', payload }, (res) => {
      saveBtn.disabled = false;
      if (chrome.runtime.lastError) {
        statusEl.className = 'status-msg err';
        statusEl.textContent = chrome.runtime.lastError.message;
        return;
      }
      if (res?.ok) {
        statusEl.className = 'status-msg ok';
        statusEl.textContent = `Saved (${res.status}) to My Job Tracker!`;
      } else if (res?.needsPairing) {
        statusEl.className = 'status-msg err';
        statusEl.textContent =
          'Not paired yet. Paste your Pairing Code below or click "Quick-Save in Web App".';
        pairingDetails.open = true;
      } else {
        statusEl.className = 'status-msg err';
        statusEl.textContent = res?.error || 'Could not save job.';
      }
    });
  });

  webBtn.addEventListener('click', () => {
    const payload = buildPayload();
    const encoded = encodeBase64Url(payload);
    chrome.tabs.create({ url: `${currentAppUrl.replace(/\/+$/, '')}/?extCapture=${encoded}` });
  });

  pairBtn.addEventListener('click', async () => {
    const raw = pairingCodeEl.value.trim();
    if (!raw) {
      pairingStatusEl.className = 'status-msg err';
      pairingStatusEl.textContent = 'Paste a Pairing Code first.';
      return;
    }
    try {
      const parsed = decodePairingCode(raw);
      if (!parsed.refreshToken || !parsed.uid || !parsed.apiKey) {
        throw new Error('Invalid Pairing Code format.');
      }
      await chrome.storage.local.set({ [STORAGE_KEY]: parsed });
      pairingStatusEl.className = 'status-msg';
      pairingStatusEl.textContent = 'Verifying connection...';

      chrome.runtime.sendMessage({ type: 'TEST_PAIRING' }, (res) => {
        if (res?.ok) {
          pairingStatusEl.className = 'status-msg ok';
          pairingStatusEl.textContent = `Verified & paired for ${res.email || res.uid}.`;
          updatePairingUi(parsed);
        } else {
          pairingStatusEl.className = 'status-msg err';
          pairingStatusEl.textContent = res?.error || 'Verification failed.';
        }
      });
    } catch (err) {
      pairingStatusEl.className = 'status-msg err';
      pairingStatusEl.textContent = err?.message || 'Invalid Pairing Code.';
    }
  });
});
