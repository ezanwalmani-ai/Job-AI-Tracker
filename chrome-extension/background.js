// Save to My Job Tracker - MV3 Background Service Worker
// Handles paired Firestore persistence & duplicate checks without collecting passwords or automating portals.

const STORAGE_KEY = 'mjt_pairing_config';

async function loadDefaultConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('default-config.json'));
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

async function getPairingConfig() {
  const defaults = await loadDefaultConfig();
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...defaults, ...(stored[STORAGE_KEY] || {}) };
}

async function exchangeRefreshToken(apiKey, refreshToken) {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    }
  );
  const data = await res.json();
  if (!res.ok || !data.id_token) {
    throw new Error(
      data?.error?.message ||
        'Session pairing expired. Copy a fresh Pairing Code from My Job Tracker -> Connected Portals.'
    );
  }
  return {
    idToken: data.id_token,
    userId: data.user_id,
    refreshToken: data.refresh_token || refreshToken,
  };
}

function getTodayIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysIso(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + (days || 7));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function mapPortalNameToId(portalName, jobUrl) {
  const combined = `${portalName || ''} ${jobUrl || ''}`.toLowerCase();
  if (combined.includes('linkedin')) return { portalId: 'linkedin', portalName: 'LinkedIn' };
  if (combined.includes('indeed')) return { portalId: 'indeed', portalName: 'Indeed' };
  if (combined.includes('naukri')) return { portalId: 'naukri', portalName: 'Naukri' };
  if (combined.includes('workindia')) return { portalId: 'workindia', portalName: 'WorkIndia' };
  if (combined.includes('apna')) return { portalId: 'apna', portalName: 'Apna' };
  return { portalId: 'company_career', portalName: portalName || 'Company Career Page' };
}

function normalizeUrlForCompare(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'trk', 'trkInfo', 'refId', 'trackingId'].forEach(
      (k) => u.searchParams.delete(k)
    );
    const p = u.pathname.replace(/\/+$/, '');
    const qs = u.searchParams.toString();
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${p}${qs ? `?${qs}` : ''}`;
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, '');
  }
}

function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function readFsString(field) {
  return field && typeof field.stringValue === 'string' ? field.stringValue : '';
}

function readFsInt(field) {
  if (!field) return 0;
  if (typeof field.integerValue === 'string' || typeof field.integerValue === 'number') {
    return Number(field.integerValue) || 0;
  }
  return 0;
}

function readFsBool(field, fallback = false) {
  return field && typeof field.booleanValue === 'boolean' ? field.booleanValue : fallback;
}

async function checkDuplicateInFirestore(cfg, idToken, uid, candidate) {
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/${cfg.databaseId}/documents/users/${uid}:runQuery`;
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'jobApplications' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'userId' },
            op: 'EQUAL',
            value: { stringValue: uid },
          },
        },
        limit: 200,
      },
    }),
  });

  if (!res.ok) return null;
  const rows = await res.json();
  const targetUrl = normalizeUrlForCompare(candidate.jobUrl);
  const targetCompany = normalizeText(candidate.companyName);
  const targetTitle = normalizeText(candidate.jobTitle);
  const today = getTodayIsoDate();

  for (const row of rows) {
    const fields = row?.document?.fields;
    if (!fields) continue;
    const existingUrl = normalizeUrlForCompare(readFsString(fields.jobUrl));
    if (targetUrl && existingUrl && targetUrl === existingUrl) {
      return `Same job URL already saved (${readFsString(fields.companyName)} — ${readFsString(fields.jobTitle)})`;
    }
    const existingComp = normalizeText(readFsString(fields.companyName));
    const existingTitle = normalizeText(readFsString(fields.jobTitle));
    const existingDate = readFsString(fields.dateApplied).slice(0, 10);
    if (
      targetCompany &&
      targetTitle &&
      existingComp === targetCompany &&
      existingTitle === targetTitle &&
      (!existingDate || existingDate === today)
    ) {
      return `Duplicate application for ${readFsString(fields.jobTitle)} at ${readFsString(fields.companyName)} (${existingDate || 'today'})`;
    }
  }
  return null;
}

async function getExistingPortalDoc(cfg, idToken, uid, portalId) {
  const docUrl = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/${cfg.databaseId}/documents/users/${uid}/connectedPortals/${portalId}`;
  const res = await fetch(docUrl, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) return null;
  const doc = await res.json();
  return doc?.fields || null;
}

async function saveApplicationViaFirestore(payload) {
  const cfg = await getPairingConfig();
  if (!cfg.refreshToken || !cfg.apiKey || !cfg.projectId || !cfg.databaseId) {
    return { ok: false, needsPairing: true, error: 'Extension not paired yet.' };
  }

  const authInfo = await exchangeRefreshToken(cfg.apiKey, cfg.refreshToken);
  const uid = cfg.uid || authInfo.userId;
  if (authInfo.refreshToken && authInfo.refreshToken !== cfg.refreshToken) {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { ...cfg, refreshToken: authInfo.refreshToken, uid },
    });
  }

  const companyName = (payload.companyName || '').trim().slice(0, 200);
  const jobTitle = (payload.jobTitle || '').trim().slice(0, 200);
  const jobLocation = (payload.jobLocation || '').trim().slice(0, 200) || 'Not specified';
  const jobUrl = (payload.jobUrl || '').trim().slice(0, 2000);
  const jobDescription = (payload.jobDescription || '').trim().slice(0, 60000);
  const didApply = Boolean(payload.didApply);
  const portalMeta = mapPortalNameToId(payload.portalName, jobUrl);

  if (!companyName || !jobTitle) {
    throw new Error('Company name and job title are required.');
  }

  const dupReason = await checkDuplicateInFirestore(cfg, authInfo.idToken, uid, {
    companyName,
    jobTitle,
    jobUrl,
  });
  if (dupReason) {
    return { ok: false, duplicate: true, error: dupReason };
  }

  const dateApplied = getTodayIsoDate();
  const followUpDate = addDaysIso(dateApplied, Number(cfg.defaultFollowUpDays) || 7);
  const appId = `app_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const status = didApply ? 'Applied – Manually Recorded' : 'Saved';
  const nowIso = new Date().toISOString();

  const existingPortal = await getExistingPortalDoc(cfg, authInfo.idToken, uid, portalMeta.portalId);
  const nextCount = (existingPortal ? readFsInt(existingPortal.importedCount) : 0) + 1;

  const dbRoot = `projects/${cfg.projectId}/databases/${cfg.databaseId}/documents`;
  const appDocPath = `${dbRoot}/users/${uid}/jobApplications/${appId}`;
  const portalDocPath = `${dbRoot}/users/${uid}/connectedPortals/${portalMeta.portalId}`;

  const writes = [
    {
      update: {
        name: appDocPath,
        fields: {
          id: { stringValue: appId },
          userId: { stringValue: uid },
          companyName: { stringValue: companyName },
          jobTitle: { stringValue: jobTitle },
          jobDescription: {
            stringValue: jobDescription || `${jobTitle} at ${companyName} (${jobLocation})`,
          },
          jobLocation: { stringValue: jobLocation },
          jobUrl: { stringValue: jobUrl },
          hrEmail: { stringValue: '' },
          applicationSource: { stringValue: portalMeta.portalName },
          applicationMethod: { stringValue: 'portal' },
          captureMethod: { stringValue: 'chrome_extension' },
          confirmationEvidence: {
            stringValue: didApply
              ? `User confirmed application submission on ${portalMeta.portalName} via browser extension (${nowIso.slice(0, 10)})`
              : `Saved from ${portalMeta.portalName} via browser extension (${nowIso.slice(0, 10)})`,
          },
          needsReview: { booleanValue: false },
          dateApplied: { stringValue: dateApplied },
          lastCommunicationDate: { stringValue: dateApplied },
          followUpDate: { stringValue: followUpDate },
          applicationStatus: { stringValue: status },
          notes: { stringValue: (payload.notes || '').trim().slice(0, 10000) },
          aiSummary: {
            stringValue: `Captured from ${portalMeta.portalName} browser tab (${status}).`,
          },
          keyRequirements: { arrayValue: { values: [] } },
          applicationResumeId: { stringValue: '' },
          gmailThreadId: { stringValue: '' },
        },
      },
      updateTransforms: [
        { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
    },
    {
      update: {
        name: portalDocPath,
        fields: {
          id: { stringValue: portalMeta.portalId },
          userId: { stringValue: uid },
          portalId: { stringValue: portalMeta.portalId },
          portalName: { stringValue: portalMeta.portalName },
          status: { stringValue: 'connected' },
          connectionMethod: { stringValue: 'chrome_extension' },
          gmailDetectionEnabled: {
            booleanValue: existingPortal ? readFsBool(existingPortal.gmailDetectionEnabled, false) : false,
          },
          extensionCaptureEnabled: { booleanValue: true },
          csvImportEnabled: {
            booleanValue: existingPortal ? readFsBool(existingPortal.csvImportEnabled, false) : false,
          },
          lastSyncedAt: { stringValue: nowIso },
          lastSyncSummary: {
            stringValue: `Extension captured "${jobTitle}" at ${companyName} (${status})`,
          },
          lastTestedAt: { stringValue: nowIso },
          importedCount: { integerValue: String(nextCount) },
          extensionVerifiedAt: { stringValue: nowIso },
          gmailVerifiedAt: {
            stringValue: existingPortal ? readFsString(existingPortal.gmailVerifiedAt) : '',
          },
          lastImportFileName: {
            stringValue: existingPortal ? readFsString(existingPortal.lastImportFileName) : '',
          },
        },
      },
      updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
    },
  ];

  const commitRes = await fetch(
    `https://firestore.googleapis.com/v1/${dbRoot}:commit`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authInfo.idToken}`,
      },
      body: JSON.stringify({ writes }),
    }
  );

  const commitData = await commitRes.json();
  if (!commitRes.ok) {
    throw new Error(commitData?.error?.message || `Failed to save to My Job Tracker (HTTP ${commitRes.status})`);
  }

  return {
    ok: true,
    applicationId: appId,
    status,
    portalName: portalMeta.portalName,
  };
}

async function testPairingAndMarkVerified() {
  const cfg = await getPairingConfig();
  if (!cfg.refreshToken || !cfg.apiKey || !cfg.projectId || !cfg.databaseId) {
    throw new Error('Paste your Pairing Code first.');
  }
  const authInfo = await exchangeRefreshToken(cfg.apiKey, cfg.refreshToken);
  return {
    ok: true,
    email: cfg.email || '',
    uid: cfg.uid || authInfo.userId,
    appUrl: cfg.appUrl || '',
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'SAVE_JOB_TO_FIRESTORE') {
    saveApplicationViaFirestore(message.payload)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || 'Save failed' }));
    return true;
  }

  if (message.type === 'TEST_PAIRING') {
    testPairingAndMarkVerified()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || 'Pairing verification failed' }));
    return true;
  }

  if (message.type === 'GET_APP_CONFIG') {
    getPairingConfig()
      .then((cfg) => sendResponse({ ok: true, config: cfg }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});
