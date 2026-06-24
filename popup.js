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
// Status: 'dead' | 'valid' | 'warn' | 'timeout' | 'login'
async function checkUrl(url, timeout = 9000) {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeout);

    let res;
    try {
      res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    } catch (e) {
      clearTimeout(tid);
      if (e.name === 'AbortError') return { status: 'timeout', code: 'timeout' };
      // Network failure (DNS, refused connection, SSL)
      return { status: 'dead', code: 'network' };
    }
    clearTimeout(tid);

    if (res.status === 405) {
      // HEAD blocked — fall back to GET
      try {
        const ctrl2 = new AbortController();
        const tid2 = setTimeout(() => ctrl2.abort(), timeout);
        res = await fetch(url, { method: 'GET', signal: ctrl2.signal, redirect: 'follow' });
        clearTimeout(tid2);
      } catch (e2) {
        if (e2.name === 'AbortError') return { status: 'timeout', code: 'timeout' };
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

const websiteUrl = 'https://danwoodruffconsulting.github.io/bookmark-gardening-manager/#legal';
['btn-website', 'btn-website-title', 'btn-website-footer'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: websiteUrl, active: true }); });
});

const btnAudit          = document.getElementById('btn-audit');
const auditProgress     = document.getElementById('audit-progress');
const auditBar          = document.getElementById('audit-bar');
const auditProgressText = document.getElementById('audit-progress-text');
const auditResults      = document.getElementById('audit-results');
const auditDeadSection  = document.getElementById('audit-dead-section');
const auditCount        = document.getElementById('audit-count');
const btnDeleteDead     = document.getElementById('btn-delete-dead');
const deadSelectAll     = document.getElementById('dead-select-all');
const deadList          = document.getElementById('dead-list');
const auditSlowSection  = document.getElementById('audit-slow-section');
const auditSlowCount    = document.getElementById('audit-slow-count');
const btnDeleteSlow     = document.getElementById('btn-delete-slow');
const slowSelectAll     = document.getElementById('slow-select-all');
const slowList          = document.getElementById('slow-list');
const auditLoginSection = document.getElementById('audit-login-section');
const auditLoginCount   = document.getElementById('audit-login-count');
const btnDeleteLogin    = document.getElementById('btn-delete-login');
const loginSelectAll    = document.getElementById('login-select-all');
const loginList         = document.getElementById('login-list');
const auditEmpty        = document.getElementById('audit-empty');
const auditScanNote     = document.getElementById('audit-scan-note');

let deadBookmarks  = [];
let slowBookmarks  = [];
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

// ── Select-all / deselect-all wiring ───────────────────────────────────────
function updateSelectAllLabel(selectAllEl) {
  const label = selectAllEl.closest('.select-all-label');
  if (label) label.lastChild.textContent = selectAllEl.checked ? ' Deselect all' : ' Select all';
}

function syncSelectAll(selectAllEl, listEl) {
  const all = listEl.querySelectorAll('input[type="checkbox"]');
  const checked = listEl.querySelectorAll('input[type="checkbox"]:checked');
  selectAllEl.checked = all.length > 0 && checked.length === all.length;
  selectAllEl.indeterminate = checked.length > 0 && checked.length < all.length;
  updateSelectAllLabel(selectAllEl);
}

function wireSelectAll(selectAllEl, listEl) {
  selectAllEl.addEventListener('change', () => {
    listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = selectAllEl.checked; });
    selectAllEl.indeterminate = false;
    updateSelectAllLabel(selectAllEl);
  });
  listEl.addEventListener('change', () => syncSelectAll(selectAllEl, listEl));
}

wireSelectAll(deadSelectAll, deadList);
wireSelectAll(slowSelectAll, slowList);
wireSelectAll(loginSelectAll, loginList);

function renderAuditResults() {
  deadList.innerHTML = '';
  slowList.innerHTML = '';
  loginList.innerHTML = '';
  auditDeadSection.classList.add('hidden');
  auditSlowSection.classList.add('hidden');
  auditLoginSection.classList.add('hidden');
  auditEmpty.classList.add('hidden');
  auditResults.classList.add('hidden');

  if (!deadBookmarks.length && !slowBookmarks.length && !loginBookmarks.length) {
    auditEmpty.classList.remove('hidden');
    return;
  }
  if (deadBookmarks.length) {
    auditCount.textContent = `${deadBookmarks.length} dead bookmark${deadBookmarks.length !== 1 ? 's' : ''} found`;
    deadBookmarks.forEach(bm => deadList.appendChild(makeBmItem(bm, 'dead', '', 'Dead')));
    auditDeadSection.classList.remove('hidden');
  }
  if (slowBookmarks.length) {
    auditSlowCount.textContent = `${slowBookmarks.length} bookmark${slowBookmarks.length !== 1 ? 's' : ''} timed out`;
    slowBookmarks.forEach(bm => slowList.appendChild(makeBmItem(bm, 'slow', 'slow', 'Timeout')));
    auditSlowSection.classList.remove('hidden');
  }
  if (loginBookmarks.length) {
    auditLoginCount.textContent = `${loginBookmarks.length} bookmark${loginBookmarks.length !== 1 ? 's' : ''} require login`;
    loginBookmarks.forEach(bm => loginList.appendChild(makeBmItem(bm, 'login', 'login', 'Login?')));
    auditLoginSection.classList.remove('hidden');
  }
  syncSelectAll(deadSelectAll, deadList);
  syncSelectAll(slowSelectAll, slowList);
  syncSelectAll(loginSelectAll, loginList);
  auditResults.classList.remove('hidden');
}

function saveAuditSession(complete, checkedCount, totalCount) {
  chrome.storage.session.set({ [AUDIT_SESSION_KEY]: {
    complete,
    checkedCount,
    totalCount,
    deadBookmarks,
    slowBookmarks,
    loginBookmarks,
    timestamp: Date.now(),
  }});
}

btnAudit.addEventListener('click', async () => {
  btnAudit.disabled = true;
  auditResults.classList.add('hidden');
  auditDeadSection.classList.add('hidden');
  auditSlowSection.classList.add('hidden');
  auditLoginSection.classList.add('hidden');
  auditEmpty.classList.add('hidden');
  auditScanNote.classList.add('hidden');
  auditProgress.classList.remove('hidden');
  deadList.innerHTML = '';
  slowList.innerHTML = '';
  loginList.innerHTML = '';
  deadBookmarks  = [];
  slowBookmarks  = [];
  loginBookmarks = [];

  await chrome.storage.session.remove(AUDIT_SESSION_KEY);

  const all = await getAllBookmarks();

  // First pass — 9 s timeout; hard failures go to dead, timeouts go to slow for re-check
  for (let i = 0; i < all.length; i += BATCH) {
    const slice = all.slice(i, i + BATCH);
    const batch = await Promise.all(slice.map(bm => checkUrl(bm.url).then(r => ({ bm, ...r }))));
    for (const r of batch) {
      if (r.status === 'dead')    deadBookmarks.push(r.bm);
      else if (r.status === 'timeout') slowBookmarks.push(r.bm);
      else if (r.status === 'login')   loginBookmarks.push(r.bm);
    }
    const done = Math.min(i + BATCH, all.length);
    auditBar.style.width = Math.round((done / all.length) * 100) + '%';
    auditProgressText.textContent = `Checking ${done} of ${all.length}…`;
    saveAuditSession(false, done, all.length);
  }

  // Second pass — 25 s timeout for sites that were slow the first time
  if (slowBookmarks.length) {
    const candidates = [...slowBookmarks];
    slowBookmarks = [];
    auditBar.style.width = '0%';
    for (let i = 0; i < candidates.length; i += BATCH) {
      const slice = candidates.slice(i, i + BATCH);
      const batch = await Promise.all(slice.map(bm => checkUrl(bm.url, 25000).then(r => ({ bm, ...r }))));
      for (const r of batch) {
        if (r.status === 'dead')         deadBookmarks.push(r.bm);
        else if (r.status === 'timeout') slowBookmarks.push(r.bm);
        else if (r.status === 'login')   loginBookmarks.push(r.bm);
        // valid/warn → site is live, omit from results
      }
      const done = Math.min(i + BATCH, candidates.length);
      auditBar.style.width = Math.round((done / candidates.length) * 100) + '%';
      auditProgressText.textContent = `Verifying ${done} of ${candidates.length} slow site${candidates.length !== 1 ? 's' : ''}…`;
    }
  }

  saveAuditSession(true, all.length, all.length);
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
    if (!slowBookmarks.length && !loginBookmarks.length) { auditResults.classList.add('hidden'); auditEmpty.classList.remove('hidden'); }
  } else {
    auditCount.textContent = `${deadBookmarks.length} dead bookmark${deadBookmarks.length !== 1 ? 's' : ''} found`;
    syncSelectAll(deadSelectAll, deadList);
  }
});

btnDeleteSlow.addEventListener('click', async () => {
  const checked = [...slowList.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.dataset.id);
  if (!checked.length) return;
  if (!confirm(`Permanently remove ${checked.length} timed-out bookmark${checked.length !== 1 ? 's' : ''}?`)) return;

  for (const id of checked) {
    try { await chrome.bookmarks.remove(id); } catch (_) {}
  }
  checked.forEach(id => slowList.querySelector(`li[data-id="${id}"]`)?.remove());

  slowBookmarks = slowBookmarks.filter(bm => !checked.includes(bm.id));
  saveAuditSession(true, 0, 0);
  if (!slowBookmarks.length) {
    auditSlowSection.classList.add('hidden');
    if (!deadBookmarks.length && !loginBookmarks.length) { auditResults.classList.add('hidden'); auditEmpty.classList.remove('hidden'); }
  } else {
    auditSlowCount.textContent = `${slowBookmarks.length} bookmark${slowBookmarks.length !== 1 ? 's' : ''} timed out`;
    syncSelectAll(slowSelectAll, slowList);
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
    if (!deadBookmarks.length && !slowBookmarks.length) { auditResults.classList.add('hidden'); auditEmpty.classList.remove('hidden'); }
  } else {
    auditLoginCount.textContent = `${loginBookmarks.length} bookmark${loginBookmarks.length !== 1 ? 's' : ''} require login`;
    syncSelectAll(loginSelectAll, loginList);
  }
});

// ── USAGE TAB ─────────────────────────────────────────────────────────────
const btnScanUnused = document.getElementById('btn-scan-unused');
const thresholdSel = document.getElementById('threshold');
const usageResults = document.getElementById('usage-results');
const usageCount = document.getElementById('usage-count');
const btnDeleteUnused = document.getElementById('btn-delete-unused');
const unusedSelectAll = document.getElementById('unused-select-all');
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
  syncSelectAll(unusedSelectAll, unusedList);
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
    syncSelectAll(unusedSelectAll, unusedList);
  }
});

wireSelectAll(unusedSelectAll, unusedList);

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
    if      (groupBy === 'domain')      renderDomainReport(all);
    else if (groupBy === 'smart-topic') renderTopicReport(all);
    else if (groupBy === 'smart-org')   renderOrgReport(all);
    else if (groupBy === 'smart-type')  renderTypeReport(all);
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
        <span class="group-toggle">▸</span>
      </div>
    </div>
    <div class="group-body">
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

// Shared card renderer for label→bookmarks groups
function renderGroupCards(groups, emptyMsg) {
  if (!groups.length) {
    reportGroups.innerHTML = `<p class="desc">${esc(emptyMsg)}</p>`;
    return;
  }
  for (const [label, bms] of groups) {
    const card = document.createElement('div');
    card.className = 'group-card';
    card.innerHTML = `
      <div class="group-header">
        <div>
          <span class="group-title">${esc(label)}</span>
          <span class="group-meta"> · ${bms.length} bookmark${bms.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="group-actions">
          <button class="btn ghost btn-del-grp">Delete all</button>
          <span class="group-toggle">▸</span>
        </div>
      </div>
      <div class="group-body">
        <ul>
          ${bms.map(bm => `<li data-id="${bm.id}">
            <a href="${esc(bm.url)}" target="_blank" title="${esc(bm.url)}">${esc(bm.title || bm.url)}</a>
          </li>`).join('')}
        </ul>
      </div>`;
    card.querySelector('.group-header').addEventListener('click', e => {
      if (e.target.closest('.btn-del-grp')) return;
      card.querySelector('.group-body').classList.toggle('open');
      card.querySelector('.group-toggle').textContent =
        card.querySelector('.group-body').classList.contains('open') ? '▾' : '▸';
    });
    card.querySelector('.btn-del-grp').addEventListener('click', async () => {
      if (!confirm(`Delete all ${bms.length} bookmarks in "${label}"?`)) return;
      for (const bm of bms) {
        try { await chrome.bookmarks.remove(bm.id); } catch (_) {}
      }
      card.remove();
    });
    reportGroups.appendChild(card);
  }
}

function renderDomainReport(bookmarks) {
  const map = {};
  for (const bm of bookmarks) {
    let domain;
    try { domain = new URL(bm.url).hostname.replace(/^www\./, ''); }
    catch (_) { domain = '(invalid URL)'; }
    if (!map[domain]) map[domain] = [];
    map[domain].push(bm);
  }
  const groups = Object.entries(map).sort((a, b) => b[1].length - a[1].length);
  renderGroupCards(groups, 'No bookmarks found.');
}

// ── Smart: By Topic ────────────────────────────────────────────────────────
const TOPIC_RULES = [
  [/youtube\.com|vimeo\.com|twitch\.tv|netflix\.com|hulu\.com|dailymotion\.com|\/watch\?v=/, 'Video & Media'],
  [/aws\.amazon\.com|console\.aws|amazonaws\.com|cloud\.google\.com|portal\.azure|digitalocean\.com|heroku\.com|vercel\.|netlify\./, 'Cloud & DevOps'],
  [/\/docs\/|\/documentation\/|\/api\/|\/reference\/|docs\.|developer\.|devdocs\.io|readthedocs|mdn\.|wikipedia\.org|wikimedia\.org/, 'Docs & Reference'],
  [/github\.com|gitlab\.com|bitbucket\.org|stackoverflow\.com|stackexchange\.com|codepen\.io|npmjs\.com|pypi\.org/, 'Code & Dev Tools'],
  [/twitter\.com|x\.com|linkedin\.com|facebook\.com|instagram\.com|reddit\.com|mastodon\.|threads\.net/, 'Social Media'],
  [/amazon\.|ebay\.|etsy\.|shopify\.|walmart\.|target\.|\/product\/|\/shop\/|\/cart\//, 'Shopping'],
  [/paypal\.|stripe\.|coinbase\.|robinhood\.|fidelity\.|schwab\.|bank|\/invest|\/trading|mortgage/, 'Finance'],
  [/medium\.com|substack\.|nytimes\.|bbc\.|cnn\.|theguardian\.|techcrunch\.|wired\.|\/article\/|\/blog\//, 'News & Articles'],
  [/gmail\.|mail\.|outlook\.|slack\.|notion\.|trello\.|atlassian\.|jira\.|confluence\.|asana\.|monday\.com/, 'Productivity'],
];

function classifyTopic(bm) {
  let text = '';
  try {
    const u = new URL(bm.url);
    text = u.hostname.replace(/^www\./, '') + u.pathname + ' ' + (bm.title || '').toLowerCase();
  } catch (_) { text = (bm.title || '').toLowerCase(); }
  for (const [re, label] of TOPIC_RULES) {
    if (re.test(text)) return label;
  }
  return 'Other';
}

function renderTopicReport(bookmarks) {
  const map = {};
  for (const bm of bookmarks) {
    const topic = classifyTopic(bm);
    if (!map[topic]) map[topic] = [];
    map[topic].push(bm);
  }
  const groups = Object.entries(map).sort((a, b) => b[1].length - a[1].length);
  renderGroupCards(groups, 'No bookmarks found.');
}

// ── Smart: By Organization ─────────────────────────────────────────────────
// Collapses subdomains into a single parent brand (mail/docs/drive.google.com → Google).

// Multi-part public suffixes where the registrable name is the 3rd-from-last label.
const MULTI_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'co.jp', 'co.kr', 'co.in', 'co.za', 'co.il',
  'com.br', 'com.mx', 'com.cn', 'com.sg', 'com.hk', 'com.tr',
  'edu.cn', 'gov.cn', 'org.br',
]);

function getOrganization(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_) { return '(invalid URL)'; }
  const parts = host.split('.');
  if (parts.length < 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  const brandIdx = MULTI_TLDS.has(lastTwo) ? parts.length - 3 : parts.length - 2;
  const brand = parts[brandIdx];
  if (!brand) return host;
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

function renderOrgReport(bookmarks) {
  const map = {};
  for (const bm of bookmarks) {
    const org = getOrganization(bm.url);
    if (!map[org]) map[org] = [];
    map[org].push(bm);
  }
  const groups = Object.entries(map).sort((a, b) => b[1].length - a[1].length);
  renderGroupCards(groups, 'No bookmarks found.');
}

// ── Smart: By Site Type ────────────────────────────────────────────────────
const BLOG_RE = /medium\.com|substack\.com|wordpress\.|blogspot\.|\.blog(?:[\/:]|$)|tumblr\.com|ghost\.io|dev\.to|hashnode\./;

function classifySiteType(url) {
  let host, full;
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '').toLowerCase();
    full = host + u.pathname.toLowerCase();
  } catch (_) { return 'Other'; }

  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(host) || /\.gob\.[a-z]{2}$/.test(host)) return 'Government';
  if (/\.edu(\.[a-z]{2})?$/.test(host) || /\.ac\.[a-z]{2}$/.test(host))        return 'Education';
  if (BLOG_RE.test(full) || /\/blog(?:[\/?#]|$)/.test(full))                    return 'Blogs & Personal';
  if (/\.org(\.[a-z]{2})?$/.test(host))                                         return 'Nonprofit (.org)';
  if (/\.(com|co|io|net|biz|shop|store|app|ai)(\.[a-z]{2})?$/.test(host))       return 'Commercial';
  return 'Other';
}

const TYPE_ORDER = ['Commercial', 'Nonprofit (.org)', 'Education', 'Government', 'Blogs & Personal', 'Other'];

function renderTypeReport(bookmarks) {
  const map = {};
  for (const bm of bookmarks) {
    const type = classifySiteType(bm.url);
    if (!map[type]) map[type] = [];
    map[type].push(bm);
  }
  const groups = TYPE_ORDER.filter(k => map[k]).map(k => [k, map[k]]);
  renderGroupCards(groups, 'No bookmarks found.');
}

// ── Session restore ───────────────────────────────────────────────────────
async function restoreAuditSession() {
  const stored = await chrome.storage.session.get(AUDIT_SESSION_KEY);
  const session = stored[AUDIT_SESSION_KEY];
  if (!session) return;

  deadBookmarks  = session.deadBookmarks  || [];
  slowBookmarks  = session.slowBookmarks  || [];
  loginBookmarks = session.loginBookmarks || [];

  if (!session.complete && session.totalCount > 0) {
    auditScanNote.textContent =
      `Scan was interrupted at ${session.checkedCount} of ${session.totalCount} bookmarks — results may be incomplete.`;
    auditScanNote.classList.remove('hidden');
  }

  if (deadBookmarks.length || slowBookmarks.length || loginBookmarks.length) {
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

// ── Resizable popup (remembers size) ────────────────────────────────────────
(function initResize() {
  // Width is fixed; only the height is resizable. Chrome caps popups at 600 tall.
  const MIN_H = 300, MAX_H = 600;
  const SIZE_KEY = 'popupHeight';
  const handle = document.getElementById('resize-handle');
  if (!handle) return;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Restore the last height the user picked.
  chrome.storage.local.get(SIZE_KEY).then(stored => {
    const h = stored[SIZE_KEY];
    if (h) document.body.style.height = clamp(h, MIN_H, MAX_H) + 'px';
  });

  let startY, startH, dragging = false;

  handle.addEventListener('pointerdown', e => {
    dragging = true;
    startY = e.clientY;
    startH = document.body.getBoundingClientRect().height;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    const h = clamp(startH + (e.clientY - startY), MIN_H, MAX_H);
    document.body.style.height = h + 'px';
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    const h = Math.round(document.body.getBoundingClientRect().height);
    chrome.storage.local.set({ [SIZE_KEY]: h });
  }

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
})();
