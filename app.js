'use strict';

const API = 'https://api.github.com';
const PER_PAGE = 30;
const $ = (s) => document.querySelector(s);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存不可でも動作は継続 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
};

const state = {
  token: store.get('gh_token') || '',
  repo: store.get('gh_repo') || '',
  repos: [],
  issues: [],
  page: 1,
  hasMore: false,
  filter: 'open',
  repoLabels: [],
  selected: new Set(),
  busy: false,
};

/* ---------- 小さなユーティリティ(innerHTMLは使わずXSSを避ける) ---------- */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c);
  return n;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2800);
}

function textColorFor(hex) {
  const h = /^[0-9a-f]{6}$/i.test(hex) ? hex : '888888';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#1f2328' : '#ffffff';
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

/* ---------- GitHub API ---------- */
async function gh(path, opts = {}) {
  let res;
  try {
    res = await fetch(path.startsWith('http') ? path : API + path, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: 'Bearer ' + state.token,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new Error('ネットワークに接続できません(オフラインの可能性があります)');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* noop */ }
    if (res.status === 401) throw new Error('トークンが無効か期限切れです。設定から入れ直してください。');
    if (res.status === 403) throw new Error('権限不足、またはレート制限です。' + (detail ? '(' + detail + ')' : ''));
    if (res.status === 404) throw new Error('見つかりません。リポジトリ名かトークンの対象リポジトリ設定を確認してください。');
    if (res.status === 410) throw new Error('このリポジトリではIssueが無効化されています。');
    if (res.status === 422) throw new Error('入力内容をGitHubが受け付けませんでした。' + (detail ? '(' + detail + ')' : ''));
    throw new Error(`GitHub APIエラー (${res.status}) ${detail}`);
  }
  return res;
}

async function ghAll(path, maxPages) {
  const out = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let p = 1; p <= maxPages; p++) {
    const res = await gh(`${path}${sep}per_page=100&page=${p}`);
    const data = await res.json();
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

/* ---------- 接続・設定 ---------- */
function openSettings(msg) {
  $('#tokenInput').value = '';
  $('#loginStatus').textContent = msg || (state.token ? '接続済みです。トークンを入れ替える場合は新しい値を入力してください。' : '');
  $('#settingsDialog').showModal();
}

async function saveToken() {
  const v = $('#tokenInput').value.trim();
  if (!v) { $('#loginStatus').textContent = 'トークンを入力してください。'; return; }
  const prev = state.token;
  state.token = v;
  $('#saveToken').disabled = true;
  try {
    const me = await (await gh('/user')).json();
    store.set('gh_token', v);
    $('#settingsDialog').close();
    toast(`${me.login} として接続しました`);
    await loadRepos();
  } catch (e) {
    state.token = prev;
    $('#loginStatus').textContent = e.message;
  } finally {
    $('#saveToken').disabled = false;
  }
}

function logout() {
  store.del('gh_token');
  store.del('gh_repo');
  state.token = ''; state.repo = ''; state.repos = []; state.issues = [];
  $('#repoInput').value = '';
  closeCombo(false);
  renderIssues();
  $('#fab').disabled = true;
  $('#loginStatus').textContent = 'トークンを削除しました。';
}

/* ---------- リポジトリ ---------- */
async function loadRepos() {
  if (!state.token) return;
  try {
    const repos = await ghAll('/user/repos?sort=pushed&affiliation=owner', 10);
    state.repos = repos.filter((r) => r.has_issues);
    renderCombo();
    if (state.repo && state.repos.some((r) => r.full_name === state.repo)) {
      $('#repoInput').value = state.repo;
      await selectRepo(state.repo);
    } else if (state.repo) {
      state.repo = ''; store.del('gh_repo'); $('#repoInput').value = '';
    }
  } catch (e) {
    toast(e.message, true);
  }
}

async function selectRepo(fullName) {
  state.repo = fullName;
  store.set('gh_repo', fullName);
  state.selected.clear();
  $('#fab').disabled = false;
  await Promise.all([loadIssues(true), loadLabels()]);
}

async function loadLabels() {
  try {
    state.repoLabels = await ghAll(`/repos/${state.repo}/labels`, 5);
  } catch (e) {
    state.repoLabels = [];
    toast('ラベルを取得できませんでした: ' + e.message, true);
  }
  renderLabelPicker();
}

/* ---------- Issue一覧 ---------- */
async function loadIssues(reset) {
  if (!state.repo || state.busy) return;
  state.busy = true;
  $('#reloadBtn').classList.add('spin');
  try {
    if (reset) { state.page = 1; state.issues = []; }
    const res = await gh(`/repos/${state.repo}/issues?state=${state.filter}&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${state.page}`);
    const raw = await res.json();
    state.hasMore = raw.length === PER_PAGE;
    // /issues はPull Requestも返すので除外
    state.issues.push(...raw.filter((i) => !i.pull_request));
    renderIssues();
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.busy = false;
    $('#reloadBtn').classList.remove('spin');
  }
}

function renderIssues() {
  const list = $('#issueList');
  const empty = $('#emptyMsg');
  list.replaceChildren(...state.issues.map(issueItem));
  $('#moreBtn').hidden = !state.hasMore;
  if (!state.token) { empty.hidden = false; empty.textContent = '右上の⚙からGitHubトークンを設定してください。'; }
  else if (!state.repo) { empty.hidden = false; empty.textContent = 'リポジトリを選択してください。'; }
  else if (!state.issues.length) { empty.hidden = false; empty.textContent = 'Issueはありません。'; }
  else empty.hidden = true;
}

function issueItem(i) {
  const closed = i.state === 'closed';
  const tags = (i.labels || []).map((l) => {
    const name = typeof l === 'string' ? l : l.name;
    const color = (typeof l === 'string' ? '' : l.color) || '888888';
    return el('span', { class: 'tag', style: `background:#${color};color:${textColorFor(color)}` }, name);
  });
  return el('li', { class: 'issue' },
    el('div', {},
      el('span', { class: 'dot' + (closed ? ' closed' : ''), title: closed ? 'クローズ' : 'オープン' }),
      el('a', { class: 'title', href: i.html_url, target: '_blank', rel: 'noopener noreferrer' }, i.title)),
    el('div', { class: 'meta' },
      el('span', {}, '#' + i.number),
      el('span', {}, '更新 ' + fmtDate(i.updated_at)),
      i.comments ? el('span', {}, '💬 ' + i.comments) : null),
    tags.length ? el('div', { class: 'tags' }, tags) : null);
}

/* ---------- 新規Issue ---------- */
function renderLabelPicker() {
  const known = new Map(state.repoLabels.map((l) => [l.name, l.color]));
  const names = [...state.repoLabels.map((l) => l.name)];
  for (const s of state.selected) if (!known.has(s)) names.push(s); // 追加した新規ラベル
  $('#labelPicker').replaceChildren(...names.map((n) => {
    const color = known.get(n) || '888888';
    const b = el('button', { type: 'button', class: 'pick', 'aria-pressed': String(state.selected.has(n)) },
      el('span', { class: 'sw', style: `background:#${color}` }), n);
    b.addEventListener('click', () => {
      if (state.selected.has(n)) state.selected.delete(n); else state.selected.add(n);
      renderLabelPicker();
    });
    return b;
  }));
  if (!names.length) $('#labelPicker').append(el('span', { class: 'muted small' }, 'このリポジトリにラベルはまだありません。'));
}

function addCustomLabel() {
  const input = $('#customLabel');
  const v = input.value.trim().replace(/,$/, '');
  if (!v) return;
  const exist = state.repoLabels.find((l) => l.name.toLowerCase() === v.toLowerCase());
  state.selected.add(exist ? exist.name : v);
  input.value = '';
  renderLabelPicker();
}

function openNew() {
  if (!state.repo) return;
  $('#newRepoName').textContent = state.repo;
  renderLabelPicker();
  $('#newDialog').showModal();
  $('#titleInput').focus();
}

async function submitNew(e) {
  e.preventDefault();
  const title = $('#titleInput').value.trim();
  if (!title) return;
  const body = $('#bodyInput').value;
  const labels = [...state.selected];
  const btn = $('#submitBtn');
  btn.disabled = true; btn.textContent = '作成中…';
  try {
    const res = await gh(`/repos/${state.repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title, ...(body.trim() ? { body } : {}), ...(labels.length ? { labels } : {}) }),
    });
    const issue = await res.json();
    toast(`#${issue.number} を作成しました`);
    $('#titleInput').value = ''; $('#bodyInput').value = '';
    state.selected.clear();
    $('#newDialog').close();
    if (state.filter !== 'closed') { state.issues.unshift(issue); renderIssues(); }
    if (labels.some((n) => !state.repoLabels.some((l) => l.name === n))) loadLabels(); // 新規ラベルを反映
  } catch (err) {
    toast(err.message, true); // 入力内容は残す
  } finally {
    btn.disabled = false; btn.textContent = 'Issueを作成';
  }
}

/* ---------- イベント ---------- */
/* ---------- リポジトリ・コンボボックス(▾で一覧表示/入力で絞り込み/キーボード操作対応) ---------- */
const combo = { open: false, query: '', active: -1, items: [] };

function comboItems() {
  const q = combo.query.toLowerCase();
  return q ? state.repos.filter((r) => r.full_name.toLowerCase().includes(q)) : state.repos;
}

function renderCombo() {
  const box = $('#repoListbox');
  const input = $('#repoInput');
  combo.items = comboItems();
  if (combo.active >= combo.items.length) combo.active = combo.items.length - 1;
  if (!combo.items.length) {
    box.replaceChildren(el('li', { class: 'combo-empty' },
      state.repos.length ? '該当するリポジトリがありません' : 'リポジトリがありません'));
    input.removeAttribute('aria-activedescendant');
    return;
  }
  box.replaceChildren(...combo.items.map((r, idx) => {
    const li = el('li', {
      id: 'repo-opt-' + idx, role: 'option',
      class: 'combo-opt' + (idx === combo.active ? ' active' : ''),
      'aria-selected': String(r.full_name === state.repo),
    }, el('span', { class: 'combo-name' }, r.full_name), r.private ? el('span', { class: 'combo-badge' }, 'private') : null);
    li.addEventListener('click', () => chooseRepo(r.full_name));
    return li;
  }));
  if (combo.active >= 0) input.setAttribute('aria-activedescendant', 'repo-opt-' + combo.active);
  else input.removeAttribute('aria-activedescendant');
}

function scrollActive() {
  const li = document.getElementById('repo-opt-' + combo.active);
  if (li) li.scrollIntoView({ block: 'nearest' });
}

function openCombo(showAll) {
  if (showAll) combo.query = '';
  combo.open = true;
  $('#repoListbox').hidden = false;
  $('#repoInput').setAttribute('aria-expanded', 'true');
  $('#repoToggle').setAttribute('aria-expanded', 'true');
  combo.items = comboItems();
  // 全件表示のときは現在の選択位置、絞り込み中は先頭をハイライト
  combo.active = showAll ? combo.items.findIndex((r) => r.full_name === state.repo) : (combo.items.length ? 0 : -1);
  renderCombo();
  scrollActive();
}

function closeCombo(revert) {
  combo.open = false;
  combo.query = '';
  $('#repoListbox').hidden = true;
  $('#repoInput').setAttribute('aria-expanded', 'false');
  $('#repoToggle').setAttribute('aria-expanded', 'false');
  if (revert) $('#repoInput').value = state.repo; // 選ばずに閉じたら元の表示に戻す
}

function chooseRepo(name) {
  closeCombo(false);
  $('#repoInput').value = name;
  $('#repoInput').blur(); // スマホのキーボードを閉じる
  if (name !== state.repo) selectRepo(name);
}

$('#repoInput').addEventListener('click', (e) => {
  if (!combo.open) { openCombo(true); e.target.select(); }
});
$('#repoInput').addEventListener('input', (e) => {
  combo.query = e.target.value.trim();
  openCombo(false);
});
$('#repoInput').addEventListener('keydown', (e) => {
  if (e.isComposing) return; // 日本語入力の変換中は何もしない
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!combo.open) { openCombo(true); return; }
    const n = combo.items.length;
    if (!n) return;
    combo.active = e.key === 'ArrowDown' ? (combo.active + 1) % n : (combo.active - 1 + n) % n;
    renderCombo();
    scrollActive();
  } else if (e.key === 'Enter') {
    if (combo.open && combo.items[combo.active]) { e.preventDefault(); chooseRepo(combo.items[combo.active].full_name); }
  } else if (e.key === 'Escape') {
    if (combo.open) { e.preventDefault(); closeCombo(true); }
  } else if (e.key === 'Tab') {
    closeCombo(true);
  }
});
$('#repoToggle').addEventListener('click', () => { if (combo.open) closeCombo(true); else openCombo(true); });
$('#repoListbox').addEventListener('mousedown', (e) => e.preventDefault()); // 入力欄のフォーカスを保つ
document.addEventListener('click', (e) => {
  if (combo.open && !$('#repoCombo').contains(e.target)) closeCombo(true);
});
$('#reloadBtn').addEventListener('click', () => { if (state.repo) { loadIssues(true); loadLabels(); } else loadRepos(); });
$('#moreBtn').addEventListener('click', () => { state.page++; loadIssues(false); });
document.querySelectorAll('.chip-tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.chip-tab').forEach((x) => x.classList.toggle('active', x === b));
  state.filter = b.dataset.state;
  loadIssues(true);
}));
$('#fab').addEventListener('click', openNew);
$('#newClose').addEventListener('click', () => $('#newDialog').close());
$('#newForm').addEventListener('submit', submitNew);
$('#addLabelBtn').addEventListener('click', addCustomLabel);
$('#customLabel').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addCustomLabel(); }
});
$('#settingsBtn').addEventListener('click', () => openSettings());
$('#settingsClose').addEventListener('click', () => $('#settingsDialog').close());
$('#settingsForm').addEventListener('submit', (e) => { e.preventDefault(); saveToken(); });
$('#logoutBtn').addEventListener('click', logout);

/* ---------- 起動 ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
renderIssues();
$('#repoInput').value = state.repo;
if (state.token) loadRepos(); else openSettings('はじめに、GitHubのトークンを設定します。');
