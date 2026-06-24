'use strict';

const USAGE_KEY = 'bookmarkUsage';
const INSTALL_KEY = 'installDate';
const BATCH = 6; // concurrent URL checks
const AUDIT_SESSION_KEY  = 'auditSession';
const UNUSED_SESSION_KEY = 'unusedSession';

// ── Login-redirect detection ───────────────────────────────────────────────
const LOGIN_PATH_RE = /\/(login|signin|sign-in|authenticate|sso|auth\/|session\/new|users\/sign_in|account\/login)(?:[/?#]|$)/i;
const LOGIN_QUERY_RE = /[?&](next|return|redirect|returnUrl|ReturnUrl|continue|back)=/i;
const LOGIN_HOSTS = [
  'accounts.google.com', 'login.microsoftonline.com', 'login.live.com',
  'auth.atlassian.com', 'id.atlassian.com', 'login.salesforce.com',
];

function isLoginRedirect(origUrl, finalUrl) {
  if (!finalUrl || finalUrl === origUrl) return false;
  try {
    const f = new URL(finalUrl);
    const o = new URL(origUrl);
    if (f.hostname !== o.hostname && LOGIN_HOSTS.includes(f.hostname)) return true;
    if (LOGIN_PATH_RE.test(f.pathname)) return true;
    if (LOGIN_QUERY_RE.test(f.search)) return true;
  } catch (_) {}
  return false;
}

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── Bookmark tree helpers ──────────────────────────────────────────────────
function flattenBookmarks(nodes, list = []) {
  for (const node of nodes) {
    if (node.url) list.push(node);
    if (node.children) flattenBookmarks(node.children, list);
  }
  return list;
}

function getFolderTree(nodes, depth = 0) {
  const folders = [];
  for (const node of nodes) {
    if (!node.url && node.children) {
      const bookmarks = node.children.filter(c => c.url);
      const subFolders = getFolderTree(node.children, depth + 1);
      folders.push({ id: node.id, title: node.title || '(Unnamed)', bookmarks, subFolders, depth });
    }
  }
  return folders;
}

async function getAllBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  return flattenBookmarks(tree);
}

// ── URL validation ─────────────────────────────────────────────────────────
// Status: 'dead' | 'valid' | 'warn' (auth/forbidden/server-error kept, we never delete those)
async function checkUrl(url) {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 9000);

    let res;
    try {
      res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    } catch (e) {
      clearTimeout(tid);
      if (e.name === 'AbortError') return { status: 'dead', code: 'timeout' };
      // Network failure (DNS, refused connection, SSL)
      return { status: 'dead', code: 'network' };
    }
    clearTimeout(tid);

    if (res.status === 405) {
      // HEAD blocked — fall back to GET
      try {
        const ctrl2 = new AbortController();
        const tid2 = setTimeout(() => ctrl2.abort(), 9000);
        res = await fetch(url, { method: 'GET', signal: ctrl2.signal, redirect: 'follow' });
        clearTimeout(tid2);
      } catch (_) {
        return { status: 'dead', code: 'network' };
      }
    }

    const code = res.status;
    if (code === 404 || code === 410) return { status: 'dead', code };
    // 4xx auth/forbidden or 5xx transient → warn but keep
    if (code >= 400) return { status: 'warn', code };
    // Successful response that redirected to a login page
    if (res.redirected && isLoginRedirect(url, res.url)) return { status: 'login', code };
    return { status: 'valid', code };
  } catch (_) {
    return { status: 'dead', code: 'error' };
  }
}

async function checkBatch(bookmarks, onProgress) {
  const results = [];
  for (let i = 0; i < bookmarks.length; i += BATCH) {
    const slice = bookmarks.slice(i, i + BATCH);
    const batch = await Promise.all(slice.map(bm => checkUrl(bm.url).then(r => ({ bm, ...r }))));
    results.push(...batch);
    onProgress(Math.min(i + BATCH, bookmarks.length), bookmarks.length);
  }
  return results;
}

// ── AUDIT TAB ─────────────────────────────────────────────────────────────
document.getElementById('btn-donate').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://square.link/u/edbLSm7R', active: true });
});

const btnAudit          = document.getElementById('btn-audit');
const auditProgress     = document.getElementById('audit-progress');
const auditBar          = document.getElementById('audit-bar');
const auditProgressText = document.getElementById('audit-progress-text');
const auditResults      = document.getElementById('audit-results');
const auditDeadSection  = document.getElementById('audit-dead-section');
const auditCount        = document.getElementById('audit-count');
const btnDeleteDead     = document.getElementById('btn-delete-dead');
const deadList          = document.getElementById('dead-list');
const auditLoginSection = document.getElementById('audit-login-section');
const auditLoginCount   = document.getElementById('audit-login-count');
const btnDeleteLogin    = document.getElementById('btn-delete-login');
const loginList         = document.getElementById('login-list');
const auditEmpty        = document.getElementById('audit-empty');
const auditScanNote     = document.getElementById('audit-scan-note');

let deadBookmarks  = [];
let loginBookmarks = [];

function makeBmItem(bm, statusClass, badgeClass, badgeText) {
  const li = document.createElement('li');
  li.className = `bm-item ${statusClass}`;
  li.dataset.id = bm.id;
  li.innerHTML = `
    <input type="checkbox" checked data-id="${bm.id}">
    <div class="bm-info">
      <div class="bm-title" title="${esc(bm.title)}">${esc(bm.title || '(no title)')}</div>
      <div class="bm-url" title="${esc(bm.url)}">${esc(bm.url)}</div>
    </div>
    <button class="btn-open-url" title="Open in new tab">↗</button>
    <span class="bm-badge ${badgeClass}">${badgeText}</span>`;
  li.querySelector('.btn-open-url').addEventListener('click', () => openUrl(bm.url));
  return li;
}

function renderAuditResults() {
  deadList.innerHTML = '';
  loginList.innerHTML = '';
  auditDeadSection.classList.add('hidden');
  auditLoginSection.classList.add('hidden');
  auditEmpty.classList.add('hidden');
  auditResults.classList.add('hidden');

  if (!deadBookmarks.length && !loginBookmarks.length) {
    auditEmpty.classList.remove('hidden');
    return;
  }
  if (deadBookmarks.length) {
    auditCount.textContent = `${deadBookmarks.length} dead bookmark${deadBookmarks.length !== 1 ? 's' : ''} found`;
    deadBookmarks.forEach(bm => deadList.appendChild(makeBmItem(bm, 'dead', '', 'Dead')));
    auditDeadSection.classList.remove('hidden');
  }
  if (loginBookmarks.length) {
    auditLoginCount.textContent = `${loginBookmarks.length} bookmark${loginBookmarks.length !== 1 ? 's' : ''} require login`;
    loginBookmarks.forEach(bm => loginList.appendChild(makeBmItem(bm, 'login', 'login', 'Login?')));
    auditLoginSection.classList.remove('hidden');
  }
  auditResults.classList.remove('hidden');
}

function saveAuditSession(complete, checkedCount, totalCount) {
  chrome.storage.session.set({ [AUDIT_SESSION_KEY]: {
    complete,
    checkedCount,
    totalCount,
    deadBookmarks,
    loginBookmarks,
    timestamp: Date.now(),
  }});
}

btnAudit.addEventListener('click', async () => {
  btnAudit.disabled = true;
  auditResults.classList.add('hidden');
  auditDeadSection.classList.add('hidden');
  auditLoginSection.classList.add('hidden');
  auditEmpty.classList.add('hidden');
  auditScanNote.classList.add('hidden');
  auditProgress.classList.remove('hidden');
  deadList.innerHTML = '';
  loginList.innerHTML = '';
  deadBookmarks  = [];
  loginBookmarks = [];

  await chrome.storage.session.remove(AUDIT_SESSION_KEY);

  const all = await getAllBookmarks();

  for (let i = 0; i < all.length; i += BATCH) {
    const slice = all.slice(i, i + BATCH);
    const batch = await Promise.all(slice.map(bm => checkUrl(bm.url).then(r => ({ bm, ...r }))));
    for (const r of batch) {
      if (r.status === 'dead') deadBookmarks.push(r.bm);
      else if (r.status === 'login') loginBookmarks.push(r.bm);
    }
    const done = Math.min(i + BATCH, all.length);
    auditBar.style.width = Math.round((done / all.length) * 100) + '%';
    auditProgressText.textContent = `Checking ${done} of ${all.length}…`;
    saveAuditSession(done >= all.length, done, all.length);
  }

  auditProgress.classList.add('hidden');
  renderAuditResults();
  btnAudit.disabled = false;
});

btnDeleteDead.addEventListener('click', async () => {
  const checked = [...deadList.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.dataset.id);
  if (!checked.length) return;
  if (!confirm(`Permanently remove ${checked.length} dead bookmark${checked.length !== 1 ? 's' : ''}?`)) return;

  for (const id of checked) {
    try { await chrome.bookmarks.remove(id); } catch (_) {}
  }
  checked.forEach(id => deadList.querySelector(`li[data-id="${id}"]`)?.remove());

  deadBookmarks = deadBookmarks.filter(bm => !checked.includes(bm.id));
  saveAuditSession(true, 0, 0);
  if (!deadBookmarks.length) {
    auditDeadSection.classList.add('hidden');
    if (!loginBookmarks.length) { auditResults.classList.add('hidden'); auditEmpty.classList.remove('hidden'); }
  } else {
    auditCount.textContent = `${deadBookmarks.length} dead bookmark${deadBookmarks.length !== 1 ? 's' : ''} found`;
  }
});

btnDeleteLogin.addEventListener('click', async () => {
  const checked = [...loginList.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.dataset.id);
  if (!checked.length) return;
  if (!confirm(`Permanently remove ${checked.length} login-required bookmark${checked.length !== 1 ? 's' : ''}?`)) return;

  for (const id of checked) {
    try { await chrome.bookmarks.remove(id); } catch (_) {}
  }
  checked.forEach(id => loginList.querySelector(`li[data-id="${id}"]`)?.remove());

  loginBookmarks = loginBookmarks.filter(bm => !checked.includes(bm.id));
  saveAuditSession(true, 0, 0);
  if (!loginBookmarks.length) {
    auditLoginSection.classList.add('hidden');
    if (!deadBookmarks.length) { auditResults.classList.add('hidden'); auditEmpty.classList.remove('hidden'); }
  } else {
    auditLoginCount.textContent = `${loginBookmarks.length} bookmark${loginBookmarks.length !== 1 ? 's' : ''} require login`;
  }
});

// ── USAGE TAB ─────────────────────────────────────────────────────────────
const btnScanUnused = document.getElementById('btn-scan-unused');
const thresholdSel = document.getElementById('threshold');
const usageResults = document.getElementById('usage-results');
const usageCount = document.getElementById('usage-count');
const btnDeleteUnused = document.getElementById('btn-delete-unused');
const unusedList = document.getElementById('unused-list');
const usageEmpty = document.getElementById('usage-empty');

let unusedBookmarks = [];

function daysSince(ts) {
  return (Date.now() - ts) / 86400000;
}

async function isUnused(bm, thresholdVal, usage, installDate) {
  const data = usage[bm.id];

  if (thresholdVal === 'never') {
    return !data || !data.visitCount;
  }

  const days = parseInt(thresholdVal, 10);

  if (!data || !data.lastVisited) {
    // Never visited — only flag it if the extension has been tracking longer than the threshold
    return daysSince(installDate) >= days;
  }

  return daysSince(data.lastVisited) >= days;
}

function renderUnusedResults() {
  unusedList.innerHTML = '';
  usageResults.classList.add('hidden');
  usageEmpty.classList.add('hidden');

  if (!unusedBookmarks.length) {
    usageEmpty.classList.remove('hidden');
    return;
  }
  usageCount.textContent = `${unusedBookmarks.length} unused bookmark${unusedBookmarks.length !== 1 ? 's' : ''}`;
  unusedBookmarks.forEach(({ bm, data }) => {
    const lastLabel = data?.lastVisited
      ? `Last visited ${Math.round(daysSince(data.lastVisited))} days ago`
      : 'Never visited';
    const visitsLabel = data?.visitCount ? `${data.visitCount} visit${data.visitCount !== 1 ? 's' : ''}` : 'No visits recorded';

    const li = document.createElement('li');
    li.className = 'bm-item unused';
    li.dataset.id = bm.id;
    li.innerHTML = `
      <input type="checkbox" checked data-id="${bm.id}">
      <div class="bm-info">
        <div class="bm-title" title="${esc(bm.title)}">${esc(bm.title || '(no title)')}</div>
        <div class="bm-url" title="${esc(bm.url)}">${esc(bm.url)}</div>
        <div class="bm-meta">${lastLabel} · ${visitsLabel}</div>
      </div>
      <span class="bm-badge warn">Unused</span>`;
    unusedList.appendChild(li);
  });
  usageResults.classList.remove('hidden');
}

btnScanUnused.addEventListener('click', async () => {
  btnScanUnused.disabled = true;
  usageResults.classList.add('hidden');
  usageEmpty.classList.add('hidden');
  unusedList.innerHTML = '';
  unusedBookmarks = [];

  const [all, stored, installStored] = await Promise.all([
    getAllBookmarks(),
    chrome.storage.local.get(USAGE_KEY),
    chrome.storage.local.get(INSTALL_KEY),
  ]);

  const usage = stored[USAGE_KEY] || {};
  const installDate = installStored[INSTALL_KEY] || Date.now();
  const thresholdVal = thresholdSel.value;

  // Enrich with Chrome's own browsing history for bookmarks the extension hasn't tracked yet
  await Promise.all(
    all
      .filter(bm => bm.url && !usage[bm.id]?.lastVisited)
      .map(async bm => {
        try {
          const visits = await chrome.history.getVisits({ url: bm.url });
          if (!visits.length) return;
          const lastVisit = Math.max(...visits.map(v => v.visitTime));
          usage[bm.id] = {
            ...(usage[bm.id] || {}),
            url: bm.url,
            visitCount: (usage[bm.id]?.visitCount || 0) + visits.length,
            lastVisited: lastVisit,
            fromChromeHistory: true,
          };
        } catch (_) {}
      })
  );

  for (const bm of all) {
    if (await isUnused(bm, thresholdVal, usage, installDate)) {
      unusedBookmarks.push({ bm, data: usage[bm.id] });
    }
  }

  chrome.storage.session.set({ [UNUSED_SESSION_KEY]: {
    unusedBookmarks,
    threshold: thresholdVal,
    timestamp: Date.now(),
  }});

  renderUnusedResults();
  btnScanUnused.disabled = false;
});

btnDeleteUnused.addEventListener('click', async () => {
  const thresholdVal = thresholdSel.value;
  const label = thresholdVal === 'never' ? 'never visited' : `not used in ${thresholdVal} days`;
  const checked = [...unusedList.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.dataset.id);
  if (!checked.length) return;
  if (!confirm(`Permanently remove ${checked.length} bookmark${checked.length !== 1 ? 's' : ''} that are ${label}?`)) return;

  for (const id of checked) {
    try { await chrome.bookmarks.remove(id); } catch (_) {}
  }

  checked.forEach(id => {
    const li = unusedList.querySelector(`li[data-id="${id}"]`);
    if (li) li.remove();
  });

  unusedBookmarks = unusedBookmarks.filter(({ bm }) => !checked.includes(bm.id));
  chrome.storage.session.set({ [UNUSED_SESSION_KEY]: {
    unusedBookmarks,
    threshold: thresholdSel.value,
    timestamp: Date.now(),
  }});
  if (!unusedBookmarks.length) {
    usageResults.classList.add('hidden');
    usageEmpty.classList.remove('hidden');
  } else {
    usageCount.textContent = `${unusedBookmarks.length} unused bookmark${unusedBookmarks.length !== 1 ? 's' : ''}`;
  }
});

// ── REPORT TAB ────────────────────────────────────────────────────────────
const btnReport = document.getElementById('btn-report');
const groupBySel = document.getElementById('group-by');
const reportResults = document.getElementById('report-results');
const reportGroups = document.getElementById('report-groups');

btnReport.addEventListener('click', async () => {
  btnReport.disabled = true;
  reportGroups.innerHTML = '';
  reportResults.classList.add('hidden');

  const groupBy = groupBySel.value;
  const tree = await chrome.bookmarks.getTree();

  if (groupBy === 'folder') {
    renderFolderReport(tree);
  } else {
    const all = flattenBookmarks(tree);
    renderDomainReport(all);
  }

  reportResults.classList.remove('hidden');
  btnReport.disabled = false;
});

function renderFolderReport(tree) {
  const folders = getFolderTree(tree);
  if (!folders.length) {
    reportGroups.innerHTML = '<p class="desc">No folders found.</p>';
    return;
  }
  folders.forEach(f => renderFolderCard(f, reportGroups));
}

function renderFolderCard(folder, container) {
  const totalLeafs = countLeafs(folder);
  const card = document.createElement('div');
  card.className = 'group-card';
  card.style.marginLeft = folder.depth * 8 + 'px';

  card.innerHTML = `
    <div class="group-header">
      <div>
        <span class="group-title">${esc(folder.title)}</span>
        <span class="group-meta"> · ${totalLeafs} bookmark${totalLeafs !== 1 ? 's' : ''}</span>
      </div>
      <div class="group-actions">
        <button class="btn ghost btn-del-group" data-folder-id="${folder.id}" title="Delete entire folder">Delete folder</button>
        <span class="group-toggle">▾</span>
      </div>
    </div>
    <div class="group-body open">
      <ul>
        ${folder.bookmarks.map(bm => `
          <li>
            <a href="${esc(bm.url)}" target="_blank" title="${esc(bm.url)}">${esc(bm.title || bm.url)}</a>
          </li>`).join('')}
        ${!folder.bookmarks.length ? '<li style="color:var(--muted)">No bookmarks directly in this folder</li>' : ''}
      </ul>
    </div>`;

  card.querySelector('.group-header').addEventListener('click', (e) => {
    if (e.target.closest('.btn-del-group')) return;
    card.querySelector('.group-body').classList.toggle('open');
    card.querySelector('.group-toggle').textContent =
      card.querySelector('.group-body').classList.contains('open') ? '▾' : '▸';
  });

  card.querySelector('.btn-del-group').addEventListener('click', async () => {
    if (!confirm(`Delete the entire "${folder.title}" folder and all its contents? This cannot be undone.`)) return;
    try {
      await chrome.bookmarks.removeTree(folder.id);
      card.remove();
    } catch (e) {
      alert('Could not delete folder: ' + e.message);
    }
  });

  container.appendChild(card);

  // Recurse into subfolders
  folder.subFolders.forEach(sub => renderFolderCard(sub, container));
}

function countLeafs(folder) {
  let n = folder.bookmarks.length;
  folder.subFolders.forEach(sub => { n += countLeafs(sub); });
  return n;
}

function renderDomainReport(bookmarks) {
  const groups = {};
  for (const bm of bookmarks) {
    let domain;
    try { domain = new URL(bm.url).hostname.replace(/^www\./, ''); }
    catch (_) { domain = '(invalid URL)'; }
    if (!groups[domain]) groups[domain] = [];
    groups[domain].push(bm);
  }

  const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);

  if (!sorted.length) {
    reportGroups.innerHTML = '<p class="desc">No bookmarks found.</p>';
    return;
  }

  sorted.forEach(([domain, bms]) => {
    const card = document.createElement('div');
    card.className = 'group-card';
    card.innerHTML = `
      <div class="group-header">
        <div>
          <span class="group-title">${esc(domain)}</span>
          <span class="group-meta"> · ${bms.length} bookmark${bms.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="group-actions">
          <button class="btn ghost btn-del-domain">Delete all</button>
          <span class="group-toggle">▾</span>
        </div>
      </div>
      <div class="group-body open">
        <ul>
          ${bms.map(bm => `
            <li data-id="${bm.id}">
              <a href="${esc(bm.url)}" target="_blank" title="${esc(bm.url)}">${esc(bm.title || bm.url)}</a>
            </li>`).join('')}
        </ul>
      </div>`;

    card.querySelector('.group-header').addEventListener('click', (e) => {
      if (e.target.closest('.btn-del-domain')) return;
      card.querySelector('.group-body').classList.toggle('open');
      card.querySelector('.group-toggle').textContent =
        card.querySelector('.group-body').classList.contains('open') ? '▾' : '▸';
    });

    card.querySelector('.btn-del-domain').addEventListener('click', async () => {
      if (!confirm(`Delete all ${bms.length} bookmarks from "${domain}"?`)) return;
      for (const bm of bms) {
        try { await chrome.bookmarks.remove(bm.id); } catch (_) {}
      }
      card.remove();
    });

    reportGroups.appendChild(card);
  });
}

// ── Session restore ───────────────────────────────────────────────────────
async function restoreAuditSession() {
  const stored = await chrome.storage.session.get(AUDIT_SESSION_KEY);
  const session = stored[AUDIT_SESSION_KEY];
  if (!session) return;

  deadBookmarks  = session.deadBookmarks  || [];
  loginBookmarks = session.loginBookmarks || [];

  if (!session.complete && session.totalCount > 0) {
    auditScanNote.textContent =
      `Scan was interrupted at ${session.checkedCount} of ${session.totalCount} bookmarks — results may be incomplete.`;
    auditScanNote.classList.remove('hidden');
  }

  if (deadBookmarks.length || loginBookmarks.length) {
    renderAuditResults();
  } else if (session.complete) {
    auditEmpty.classList.remove('hidden');
  }
}

async function restoreUnusedSession() {
  const stored = await chrome.storage.session.get(UNUSED_SESSION_KEY);
  const session = stored[UNUSED_SESSION_KEY];
  if (!session) return;

  unusedBookmarks = session.unusedBookmarks || [];
  if (session.threshold) thresholdSel.value = session.threshold;
  renderUnusedResults();
}

restoreAuditSession();
restoreUnusedSession();

// ── Util ──────────────────────────────────────────────────────────────────
function openUrl(url) {
  chrome.tabs.create({ url, active: false });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
