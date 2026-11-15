// Save to My Job Tracker - Content Script
// Reads only currently visible page details when the user triggers Save.
// Never bypasses login/CAPTCHA, never scrapes in the background, and never auto-submits forms.

(function () {
  if (window.__mjtContentInitialized) return;
  window.__mjtContentInitialized = true;

  function detectPortalName(hostname) {
    const h = (hostname || '').toLowerCase();
    if (h.includes('linkedin.com')) return 'LinkedIn';
    if (h.includes('indeed.com')) return 'Indeed';
    if (h.includes('naukri.com')) return 'Naukri';
    if (h.includes('workindia.in')) return 'WorkIndia';
    if (h.includes('apna.co')) return 'Apna';
    return 'Company Career Page';
  }

  function cleanText(str) {
    return String(str || '').replace(/\s+/g, ' ').trim();
  }

  function pickFirstText(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = cleanText(el.innerText || el.textContent || '');
          if (text) return text;
        }
      } catch {
        // ignore invalid selector
      }
    }
    return '';
  }

  function extractJsonLdJobPosting() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const parsed = JSON.parse(s.textContent || '{}');
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          const typeVal = item?.['@type'];
          if (
            typeVal === 'JobPosting' ||
            (Array.isArray(typeVal) && typeVal.includes('JobPosting'))
          ) {
            const locObj = Array.isArray(item.jobLocation) ? item.jobLocation[0] : item.jobLocation;
            const addr = locObj?.address || {};
            const locParts = [addr.addressLocality, addr.addressRegion].filter(Boolean);
            return {
              jobTitle: cleanText(item.title),
              companyName: cleanText(item.hiringOrganization?.name),
              jobLocation: cleanText(locParts.join(', ')),
              jobDescription: cleanText(
                String(item.description || '').replace(/<[^>]+>/g, ' ')
              ),
            };
          }
        }
      } catch {
        // ignore malformed JSON-LD
      }
    }
    return null;
  }

  function extractVisibleJobDetails() {
    const portalName = detectPortalName(window.location.hostname);
    const jsonLd = extractJsonLdJobPosting();

    let jobTitle = jsonLd?.jobTitle || '';
    let companyName = jsonLd?.companyName || '';
    let jobLocation = jsonLd?.jobLocation || '';
    let jobDescription = jsonLd?.jobDescription || '';

    if (portalName === 'LinkedIn') {
      jobTitle =
        jobTitle ||
        pickFirstText([
          '.job-details-jobs-unified-top-card__job-title h1',
          '.jobs-unified-top-card__job-title',
          'h1.t-24',
          'h1',
        ]);
      companyName =
        companyName ||
        pickFirstText([
          '.job-details-jobs-unified-top-card__company-name a',
          '.job-details-jobs-unified-top-card__company-name',
          '.jobs-unified-top-card__company-name a',
          '.jobs-unified-top-card__company-name',
        ]);
      jobLocation =
        jobLocation ||
        pickFirstText([
          '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
          '.jobs-unified-top-card__bullet',
          '.job-details-jobs-unified-top-card__tertiary-description-container',
        ]);
      jobDescription =
        jobDescription ||
        pickFirstText(['#job-details', '.jobs-description__content', '.jobs-box__html-content']);
    } else if (portalName === 'Indeed') {
      jobTitle =
        jobTitle ||
        pickFirstText([
          '[data-testid="jobsearch-JobInfoHeader-title"] span',
          '[data-testid="jobsearch-JobInfoHeader-title"]',
          '.jobsearch-JobInfoHeader-title',
          'h1',
        ]);
      companyName =
        companyName ||
        pickFirstText([
          '[data-testid="inlineHeader-companyName"] a',
          '[data-testid="inlineHeader-companyName"]',
          '[data-company-name="true"]',
        ]);
      jobLocation =
        jobLocation ||
        pickFirstText([
          '[data-testid="inlineHeader-companyLocation"]',
          '[data-testid="job-location"]',
        ]);
      jobDescription =
        jobDescription || pickFirstText(['#jobDescriptionText', '.jobsearch-JobComponent-description']);
    } else if (portalName === 'Naukri') {
      jobTitle =
        jobTitle ||
        pickFirstText(['h1[class*="jd-header-title"]', '.styles_jd-header-title__rZwM1', 'h1']);
      companyName =
        companyName ||
        pickFirstText(['[class*="jd-header-comp-name"] a', '[class*="jd-header-comp-name"]']);
      jobLocation =
        jobLocation ||
        pickFirstText(['[class*="jhc__location"] span', '[class*="loc"]', '[class*="location"]']);
      jobDescription =
        jobDescription || pickFirstText(['[class*="job-desc"]', 'section[class*="JDC"]']);
    } else if (portalName === 'WorkIndia' || portalName === 'Apna') {
      jobTitle = jobTitle || pickFirstText(['h1', 'h2']);
      companyName =
        companyName ||
        pickFirstText([
          '[class*="company"]',
          '[data-testid*="company"]',
          'header p',
        ]);
      jobLocation =
        jobLocation ||
        pickFirstText(['[class*="location"]', '[data-testid*="location"]']);
      jobDescription =
        jobDescription ||
        pickFirstText(['[class*="description"]', 'main']);
    } else {
      jobTitle = jobTitle || pickFirstText(['h1', 'meta[property="og:title"]']);
      companyName =
        companyName ||
        document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
        window.location.hostname.replace(/^www\./, '').split('.')[0];
      jobLocation = jobLocation || pickFirstText(['[class*="location"]', '[data-automation-id="locations"]']);
      jobDescription = jobDescription || pickFirstText(['main', 'article', 'body']);
    }

    if (!jobTitle) {
      jobTitle = cleanText((document.title || '').split('|')[0].split('-')[0]);
    }

    return {
      companyName: cleanText(companyName).slice(0, 200),
      jobTitle: cleanText(jobTitle).slice(0, 200),
      jobLocation: cleanText(jobLocation).slice(0, 200),
      jobDescription: cleanText(jobDescription).slice(0, 8000),
      jobUrl: window.location.href,
      portalName,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'EXTRACT_JOB') {
      sendResponse({ ok: true, data: extractVisibleJobDetails() });
      return true;
    }
    return false;
  });

  // Floating Save Button on supported portals only
  const SUPPORTED_HOST = /(linkedin\.com|indeed\.com|naukri\.com|workindia\.in|apna\.co)$/i;
  if (!SUPPORTED_HOST.test(window.location.hostname.replace(/^www\./, '').split('.').slice(-2).join('.'))) {
    return;
  }

  const hostEl = document.createElement('div');
  hostEl.id = 'mjt-floating-host';
  hostEl.style.all = 'initial';
  hostEl.style.position = 'fixed';
  hostEl.style.bottom = '20px';
  hostEl.style.right = '20px';
  hostEl.style.zIndex = '2147483645';
  const shadow = hostEl.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      .btn-fab {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: #1d4ed8;
        color: #ffffff;
        border: none;
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.22);
      }
      .btn-fab:hover { background: #1e40af; }
      .card {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        width: 340px;
        max-width: calc(100vw - 32px);
        background: #ffffff;
        color: #0f172a;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        padding: 14px;
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.22);
      }
      .card-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      .card-title { font-size: 14px; font-weight: 700; }
      .close-btn {
        background: none;
        border: none;
        font-size: 16px;
        cursor: pointer;
        color: #64748b;
        padding: 2px 6px;
      }
      label { display: block; font-size: 11px; font-weight: 600; color: #475569; margin: 8px 0 3px; }
      input[type="text"] {
        width: 100%;
        box-sizing: border-box;
        padding: 7px 9px;
        font-size: 12px;
        border: 1px solid #cbd5e1;
        border-radius: 7px;
      }
      .radio-row {
        margin-top: 10px;
        padding: 8px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        font-size: 12px;
      }
      .radio-item { display: flex; align-items: center; gap: 6px; margin: 4px 0; cursor: pointer; }
      .actions { display: flex; gap: 8px; margin-top: 12px; }
      .save-btn {
        flex: 1;
        background: #1d4ed8;
        color: #fff;
        border: none;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .web-btn {
        background: #fff;
        color: #1e293b;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .status { font-size: 11px; margin-top: 8px; line-height: 1.4; }
      .ok { color: #047857; }
      .err { color: #b91c1c; }
    </style>
    <div id="mjt-root">
      <button type="button" class="btn-fab" id="mjt-open">Save to My Job Tracker</button>
    </div>
  `;

  document.documentElement.appendChild(hostEl);

  const root = shadow.getElementById('mjt-root');

  function renderFab() {
    root.innerHTML = `<button type="button" class="btn-fab" id="mjt-open">Save to My Job Tracker</button>`;
    shadow.getElementById('mjt-open').addEventListener('click', renderCard);
  }

  function encodePayloadBase64(obj) {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    bytes.forEach((b) => {
      bin += String.fromCharCode(b);
    });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function renderCard() {
    const info = extractVisibleJobDetails();
    root.innerHTML = `
      <div class="card">
        <div class="card-hdr">
          <span class="card-title">Save to My Job Tracker (${info.portalName})</span>
          <button type="button" class="close-btn" id="mjt-close" aria-label="Close">&times;</button>
        </div>
        <label>Company Name</label>
        <input type="text" id="mjt-company" />
        <label>Job Title</label>
        <input type="text" id="mjt-title" />
        <label>Location</label>
        <input type="text" id="mjt-loc" />
        <div class="radio-row">
          <label class="radio-item"><input type="radio" name="mjt-applied" value="applied" checked /> I have applied to this job</label>
          <label class="radio-item"><input type="radio" name="mjt-applied" value="saved" /> Save job only (not applied yet)</label>
        </div>
        <div class="actions">
          <button type="button" class="save-btn" id="mjt-save">Save Record</button>
          <button type="button" class="web-btn" id="mjt-web">Open Web App</button>
        </div>
        <div class="status" id="mjt-status"></div>
      </div>
    `;

    shadow.getElementById('mjt-company').value = info.companyName;
    shadow.getElementById('mjt-title').value = info.jobTitle;
    shadow.getElementById('mjt-loc').value = info.jobLocation;
    shadow.getElementById('mjt-close').addEventListener('click', renderFab);

    const statusEl = shadow.getElementById('mjt-status');

    function collectPayload() {
      const appliedChecked =
        shadow.querySelector('input[name="mjt-applied"]:checked')?.value === 'applied';
      return {
        companyName: shadow.getElementById('mjt-company').value.trim(),
        jobTitle: shadow.getElementById('mjt-title').value.trim(),
        jobLocation: shadow.getElementById('mjt-loc').value.trim(),
        jobDescription: info.jobDescription,
        jobUrl: info.jobUrl,
        portalName: info.portalName,
        didApply: appliedChecked,
        capturedAt: new Date().toISOString(),
      };
    }

    shadow.getElementById('mjt-web').addEventListener('click', () => {
      const payload = collectPayload();
      chrome.runtime.sendMessage({ type: 'GET_APP_CONFIG' }, (res) => {
        const appUrl = (res?.config?.appUrl || 'https://jobaitracker.netlify.app').replace(/\/+$/, '');
        const encoded = encodePayloadBase64(payload);
        window.open(`${appUrl}/?extCapture=${encoded}`, '_blank', 'noopener');
      });
    });

    shadow.getElementById('mjt-save').addEventListener('click', () => {
      const payload = collectPayload();
      if (!payload.companyName || !payload.jobTitle) {
        statusEl.className = 'status err';
        statusEl.textContent = 'Enter both Company Name and Job Title.';
        return;
      }
      statusEl.className = 'status';
      statusEl.textContent = 'Saving...';

      chrome.runtime.sendMessage({ type: 'SAVE_JOB_TO_FIRESTORE', payload }, (res) => {
        if (chrome.runtime.lastError) {
          statusEl.className = 'status err';
          statusEl.textContent = chrome.runtime.lastError.message;
          return;
        }
        if (res?.ok) {
          statusEl.className = 'status ok';
          statusEl.textContent = `Saved (${res.status}) to My Job Tracker.`;
        } else if (res?.needsPairing) {
          statusEl.className = 'status err';
          statusEl.textContent =
            'Not paired yet. Click "Open Web App" above or paste your Pairing Code in the extension popup.';
        } else {
          statusEl.className = 'status err';
          statusEl.textContent = res?.error || 'Could not save job.';
        }
      });
    });
  }

  shadow.getElementById('mjt-open').addEventListener('click', renderCard);
})();
