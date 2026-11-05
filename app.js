/* CM農場 在庫アプリ（入出庫）  v1.2.2
 * - スマホ1台でも動く（データは端末内に保存）
 * - Dropbox連携を設定すると、全員のスマホが同じDropboxフォルダを介して自動で同期される
 * - 端末ごとに自分の記録ファイルだけを書くので、同時に使っても上書き事故が起きない
 * - 共通ロジックは core.js（検証・在庫計算・統合・アラート）。この file は画面と保存・同期の制御。
 *
 * v1.2.0（2026-11-05 専務の要望を反映）
 *   ・持ち出しは「名前」ではなく「持ち出し先（交配舎・分娩舎・離乳舎・肥育舎・洗浄チーム・水小屋・その他）」で記録。その他のときだけ名前
 *   ・入荷待ち（発注済み・未着）を共有し、届いたら「入荷した」ボタン1つで入荷記録。PCの発注書から tools/zaiko_sync.py で登録
 *   ・アラート：使うはずなのに動いていない／減りすぎ／使わな過ぎ。「確認」ボタンで1週間非表示（全員に共有）
 *   ・飼養頭数（共有設定）
 * v1.1.0 コードレビュー対応（未送信の指紋判定・保存失敗の扱い・取込検証・復元ファイル・更新ボタン方式 など）
 */
(() => {
'use strict';

const APP_VERSION = '1.2.2';
const C = window.ZKCore;
const { CATEGORIES, LOCATIONS, STAGES, DAY, fingerprint, readQty, validateEvents, validateItems, validateExpected, validateSettings, pruneExpected, mergeEvents, mergeById, apiArg, b64url, unb64url } = C;
const DEFAULT_USERS = ['富樫', '富士', '宮本', '直人', '土居', '福田', '千葉'];
const LS = { items: 'zk_items', events: 'zk_events', cfg: 'zk_cfg', device: 'zk_device', users: 'zk_users', pkce: 'zk_pkce', revs: 'zk_revs', dismiss: 'zk_dismiss', sent: 'zk_sent', recovery: 'zk_recovery', expected: 'zk_expected', settings: 'zk_settings' };

// ---------- 保存まわり ----------
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
/** 失敗したら例外。呼び出し側が「保存できなかった」と扱えるようにする */
const writeLS = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); };
/** 失敗を通知だけして続ける版（設定など、記録以外に使う） */
const save = (k, v) => { try { writeLS(k, v); return true; } catch (e) { toast('端末への保存に失敗しました: ' + e.message, 4000); return false; } };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const catClass = (c) => (CATEGORIES.includes(c) ? c : '');
const typeClass = (t) => (['in', 'out', 'set'].includes(t) ? t : '');
const TYPE_LABEL = { out: '持出', in: '入荷', set: '棚卸' };

let deviceId = load(LS.device, null);
if (!deviceId || !C.ID_RE.test(deviceId)) { deviceId = 'd' + uid(); save(LS.device, deviceId); }

const state = {
  items: [], events: [], expected: [], settings: { herd: 0, updatedAt: 0 },
  users: load(LS.users, DEFAULT_USERS.slice()),
  cfg: Object.assign({
    user: '', pollSec: 30, liffId: '', lastStage: '',
    dropbox: { appKey: '', basePath: '/CM農場在庫アプリ', refreshToken: '', accessToken: '', expiresAt: 0, account: '', pathRoot: '' }
  }, load(LS.cfg, {})),
  revs: load(LS.revs, {}),                      // Dropbox上のファイルrev（変更のないファイルは再取得しない）
  sent: Object.assign({ events: '', master: '', expected: '', settings: '', base: '' }, load(LS.sent, {})),   // 最後に送信した内容の指紋
  recovery: load(LS.recovery, []),              // 復元で持ち込んだ他端末の記録（送信待ち）
  tab: 'out',
  filters: { q: '', loc: '', cat: '', lowOnly: false, logType: '', logLimit: 400 },
  sync: { status: 'off', last: 0, msg: '', busy: false },
  installPrompt: null, swWaiting: null, updateRequested: false,
};
// 起動時の読み込み（壊れていても落ちないように検証つき）
try { state.items = validateItems(load(LS.items, null) || []); } catch (e) { console.warn('品目マスタを読めませんでした', e); state.items = []; }
if (!state.items.length) {
  state.items = validateItems((window.DEFAULT_ITEMS || []).map((it) => Object.assign({}, it, { updatedAt: 0 })));
  save(LS.items, state.items);
}
try { state.events = validateEvents(load(LS.events, [])); } catch (e) { console.warn('記録の一部を読めませんでした', e); state.events = (load(LS.events, []) || []).filter((x) => x && x.id); }
try { state.expected = pruneExpected(validateExpected(load(LS.expected, [])), Date.now()); } catch (e) { console.warn('入荷予定を読めませんでした', e); state.expected = []; }
try { state.settings = validateSettings(load(LS.settings, {})); } catch (e) { state.settings = { herd: 0, updatedAt: 0 }; }

const persistItems = () => writeLS(LS.items, state.items);
const persistEvents = () => writeLS(LS.events, state.events);
const persistExpected = () => writeLS(LS.expected, state.expected);
const persistSettings = () => writeLS(LS.settings, state.settings);
const persistMeta = () => { save(LS.cfg, state.cfg); save(LS.users, state.users); save(LS.revs, state.revs); save(LS.sent, state.sent); save(LS.recovery, state.recovery); };

/** 別タブなどが先に保存した記録を取り込んでから書く（上書き事故の防止） */
function reloadEventsFromStorage() {
  let stored; try { stored = validateEvents(load(LS.events, [])); } catch (e) { return 0; }
  const m = mergeEvents(state.events, stored);
  if (m.added) { state.events = m.events; stockCache = null; }
  return m.added;
}
window.addEventListener('storage', (e) => {
  if (e.key === LS.events) { if (reloadEventsFromStorage()) { if (state.tab !== 'settings') render(); else updateHeader(); } }
  if (e.key === LS.items) { try { const r = mergeById(state.items, validateItems(load(LS.items, []))); if (r.changed) { state.items = r.items; render(); } } catch (err) { } }
  if (e.key === LS.expected) { try { const r = mergeById(state.expected, validateExpected(load(LS.expected, []))); if (r.changed) { state.expected = r.items; render(); } } catch (err) { } }
});

// ---------- 在庫計算（記録が変わるまで使い回す） ----------
let stockCache = null;
function computeStock() {
  const key = state.events.length + ':' + (state.events.length ? state.events[state.events.length - 1].id : '');
  if (!stockCache || stockCache.key !== key) stockCache = Object.assign({ key }, C.computeStock(state.events));
  return stockCache;
}
const itemById = (id) => state.items.find((i) => i.id === id);
const isLow = (it, s) => it.min > 0 && (s[it.id] || 0) <= it.min;
const waitingExpected = () => state.expected.filter((x) => x.status === 'waiting');
const currentAlerts = () => C.computeAlerts(state.items, state.events, Date.now());

/** 記録を1件追加。端末に保存できたときだけ state に反映する。失敗時は例外 */
function addEvent(ev) {
  const it = ev.itemId ? itemById(ev.itemId) : null;
  ev = Object.assign({ id: uid(), ts: Date.now(), user: state.cfg.user || '', dev: deviceId }, ev, it ? { name: it.name, unit: it.unit } : {});
  validateEvents([ev]);
  reloadEventsFromStorage();
  const next = state.events.concat([ev]);
  writeLS(LS.events, next);               // ← ここで失敗したら例外。state は変えない
  state.events = next; stockCache = null;
  scheduleSync(); updateHeader();
  return ev;
}
const SAVE_FAIL_MSG = '端末に保存できませんでした（空き容量を確認してください）。入力はそのまま残しています';

/** 品目マスタを更新して保存（失敗時は元に戻して例外） */
function updateItems(mutate) {
  const prev = state.items;
  const next = prev.map((x) => Object.assign({}, x));
  mutate(next);
  validateItems(next);
  state.items = next;
  try { persistItems(); } catch (e) { state.items = prev; throw e; }
  scheduleSync();
}
function updateExpected(mutate) {
  const prev = state.expected;
  const next = prev.map((x) => Object.assign({}, x));
  mutate(next);
  validateExpected(next);
  state.expected = next;
  try { persistExpected(); } catch (e) { state.expected = prev; throw e; }
  scheduleSync();
}

// ---------- 画面部品 ----------
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
let lastFocus = null;
function openSheet(html) {
  const s = $('#sheet'); lastFocus = document.activeElement;
  $('.sheet-body', s).innerHTML = html; s.classList.remove('hidden');
  const h = $('.sheet-body h2', s); if (h) { h.id = 'sheet-title'; s.setAttribute('aria-labelledby', 'sheet-title'); }
  return $('.sheet-body', s);
}
function closeSheet() { $('#sheet').classList.add('hidden'); if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { } } }
const sheetOpen = () => !$('#sheet').classList.contains('hidden');
$('.sheet-bg').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });

const fmtTime = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fmtDate = (ts) => { const d = new Date(ts); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]})`; };
const fmtMD = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
const fmtDT = (ts) => `${fmtMD(ts)} ${fmtTime(ts)}`;

function tags(it) {
  return `<span class="tag ${catClass(it.category)}">${esc(it.category)}</span><span class="tag loc">${esc(it.location)}</span>` +
    (it.supplier ? `<span class="tag">${esc(it.supplier)}</span>` : '');
}
function filterChips(withCat = true) {
  const f = state.filters;
  const chip = (key, val, label) => `<button class="chip ${f[key] === val ? 'active' : ''}" data-f="${esc(key)}" data-v="${esc(val)}">${esc(label)}</button>`;
  let h = `<div class="chips">${chip('loc', '', '全ての場所')}${LOCATIONS.map((l) => chip('loc', l, l)).join('')}</div>`;
  if (withCat) h += `<div class="chips" style="padding-top:0">${chip('cat', '', '全ての種別')}${CATEGORIES.map((c) => chip('cat', c, c)).join('')}</div>`;
  return h;
}
function bindChips(root, onChange) {
  root.querySelectorAll('.chip[data-f]').forEach((b) => b.addEventListener('click', () => {
    state.filters[b.dataset.f] = b.dataset.v;
    root.querySelectorAll(`.chip[data-f="${b.dataset.f}"]`).forEach((x) => x.classList.toggle('active', x === b));
    onChange();
  }));
}
function filteredItems(includeInactive = false) {
  const f = state.filters; const q = f.q.trim().toLowerCase();
  return state.items.filter((it) => (includeInactive || it.active !== false) &&
    (!f.loc || it.location === f.loc) && (!f.cat || it.category === f.cat) &&
    (!q || (it.name + ' ' + it.spec + ' ' + it.supplier).toLowerCase().includes(q)));
}
function itemRow(it, s, extra = '') {
  const n = s[it.id] || 0;
  return `<button class="item ${isLow(it, s) ? 'low' : ''}" data-id="${esc(it.id)}">
    <div class="grow"><div class="nm">${esc(it.name)}</div><div class="sp">${esc(it.spec || '')} ${tags(it)}</div>${extra}</div>
    <div class="qty">${n}<small>${esc(it.unit)}</small></div></button>`;
}
/** 履歴表示用：品目が消えていても記録時の品名で表示 */
const evName = (e) => { const it = e.itemId && itemById(e.itemId); return it ? it.name : (e.name || '(削除済み品目)'); };
const evUnit = (e) => { const it = e.itemId && itemById(e.itemId); return it ? it.unit : (e.unit || ''); };
/** 「誰が／どこへ」の表示：持ち出しは持ち出し先、その他のときは名前も */
const evWho = (e) => (e.type === 'out' && e.stage) ? (e.stage + (e.stage === 'その他' && e.user ? '・' + e.user : '')) : (e.user || '—');

// ---------- タブ：持ち出し／入荷 ----------
function renderPick(mode) {
  const isOut = mode === 'out';
  view.innerHTML = `
    <h2>${isOut ? '📤 持ち出し登録' : '📥 入荷登録'} <span class="muted small">タップして数量を入れる</span></h2>
    ${isOut ? '' : '<div id="expected-box"></div>'}
    <input class="search" id="q" type="search" placeholder="品名・規格・仕入先で検索" value="${esc(state.filters.q)}" autocomplete="off">
    ${filterChips()}
    <div id="recent"></div>
    <div class="list" id="list"></div>`;
  const list = $('#list'); const recent = $('#recent');
  if (!isOut) renderExpectedBox();
  const draw = () => {
    const { stock } = computeStock();
    const items = filteredItems();
    list.innerHTML = items.length ? items.map((it) => itemRow(it, stock)).join('') : `<div class="empty">該当する品目がありません。<br>設定 → 品目マスタ から追加できます。</div>`;
    recent.innerHTML = '';
    if (!state.filters.q) {
      const seen = new Set(); const rec = [];
      for (let i = state.events.length - 1; i >= 0 && rec.length < 6; i--) {
        const e = state.events[i];
        if (e.type !== mode || seen.has(e.itemId)) continue;
        const it = itemById(e.itemId); if (!it || it.active === false) continue;
        if ((state.filters.loc && it.location !== state.filters.loc) || (state.filters.cat && it.category !== state.filters.cat)) continue;
        seen.add(e.itemId); rec.push(it);
      }
      if (rec.length) recent.innerHTML = `<h3>最近${isOut ? '持ち出した' : '入荷した'}もの</h3><div class="list" style="margin-bottom:12px">${rec.map((it) => itemRow(it, stock)).join('')}</div>`;
    }
    view.querySelectorAll('.list .item[data-id]').forEach((b) => b.addEventListener('click', () => openQtySheet(itemById(b.dataset.id), mode)));
  };
  $('#q').addEventListener('input', (e) => { state.filters.q = e.target.value; draw(); });
  bindChips(view, draw);
  draw();
}

/** 持ち出し／入荷の数量入力。持ち出しは「持ち出し先」を必ず選ぶ（その他のときだけ名前） */
function openQtySheet(it, mode) {
  if (!it) return;
  const isOut = mode === 'out'; const { stock } = computeStock(); const cur = stock[it.id] || 0;
  const stageSel = { v: state.cfg.lastStage || '' };
  const body = openSheet(`
    <h2>${esc(it.name)}</h2>
    <div class="muted small">${esc(it.spec || '')} ${tags(it)}</div>
    <div class="row" style="margin-top:8px"><div class="grow">現在の在庫</div><div style="font-size:20px;font-weight:700">${cur} ${esc(it.unit)}</div></div>
    ${isOut ? `<div class="field"><label>持ち出し先（どこで使う）</label>
      <div class="user-grid" id="stages">${STAGES.map((s) => `<button type="button" class="${s === stageSel.v ? 'active' : ''}" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>
      <div class="field ${stageSel.v === 'その他' ? '' : 'hidden'}" id="other-wrap"><label for="other-name">名前（その他のときは必ず）</label><input id="other-name" list="names" value="${esc(state.cfg.user)}" maxlength="50" placeholder="例：千葉"><datalist id="names">${state.users.map((u) => `<option value="${esc(u)}">`).join('')}</datalist></div>` : ''}
    <div class="stepper"><button id="minus" aria-label="1減らす">−</button><input id="qty" type="number" inputmode="numeric" min="1" step="1" value="1" aria-label="数量"><button id="plus" aria-label="1増やす">＋</button></div>
    <div class="quick">${[1, 2, 5, 10].map((n) => `<button data-q="${n}">${n}</button>`).join('')}</div>
    <div class="field"><label for="note">メモ（任意）</label><input id="note" type="text" placeholder="${isOut ? '例：豚房番号、用途' : '例：伝票番号'}" maxlength="200"></div>
    <button class="btn ${isOut ? 'out' : 'in'}" id="go">${isOut ? '持ち出しを登録' : '入荷を登録'}${!isOut && state.cfg.user ? '（' + esc(state.cfg.user) + '）' : ''}</button>
    <button class="btn secondary" id="cancel" style="margin-top:8px">やめる</button>`);
  const qty = $('#qty', body);
  const setQ = (n) => { qty.value = String(Math.max(1, Math.round(n) || 1)); };
  $('#minus', body).onclick = () => setQ(+qty.value - 1);
  $('#plus', body).onclick = () => setQ(+qty.value + 1);
  body.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => setQ(+b.dataset.q));
  if (isOut) body.querySelectorAll('#stages button').forEach((b) => b.onclick = () => {
    stageSel.v = b.dataset.s;
    body.querySelectorAll('#stages button').forEach((x) => x.classList.toggle('active', x === b));
    $('#other-wrap', body).classList.toggle('hidden', stageSel.v !== 'その他');
    if (stageSel.v === 'その他') $('#other-name', body).focus();
  });
  $('#cancel', body).onclick = closeSheet;
  $('#go', body).onclick = () => {
    let n; try { n = readQty(qty.value, mode); } catch (e) { toast(e.message); qty.focus(); return; }
    const ev = { type: mode, itemId: it.id, qty: n, note: $('#note', body).value.trim() };
    if (isOut) {
      if (!stageSel.v) { toast('持ち出し先を選んでください'); return; }
      ev.stage = stageSel.v;
      if (stageSel.v === 'その他') {
        const nm = $('#other-name', body).value.trim();
        if (!nm) { toast('「その他」のときは名前を入れてください'); $('#other-name', body).focus(); return; }
        ev.user = nm; if (!state.users.includes(nm)) { state.users.push(nm); save(LS.users, state.users); }
      }
      if (cur - n < 0 && !confirm(`在庫(${cur})より多い数です。このまま登録しますか？\n（在庫数が合っていない場合は、あとで「在庫」→ 棚卸 で直せます）`)) return;
    }
    try { addEvent(ev); }
    catch (e) { console.error(e); toast(SAVE_FAIL_MSG, 6000); return; }     // 画面は閉じない
    if (isOut && state.cfg.lastStage !== stageSel.v) { state.cfg.lastStage = stageSel.v; save(LS.cfg, state.cfg); }
    closeSheet();
    const after = computeStock().stock[it.id] || 0;
    toast(`${isOut ? ev.stage + ' へ持ち出し' : '入荷'} ${it.name} ${n}${it.unit}（在庫 ${after}）`);
    render();
  };
  setTimeout(() => qty.select(), 50);
}

// ---------- 入荷待ち（発注済み・未着） ----------
function renderExpectedBox() {
  const box = $('#expected-box'); if (!box) return;
  const waiting = waitingExpected().sort((a, b) => (b.orderedAt || 0) - (a.orderedAt || 0) || a.supplier.localeCompare(b.supplier));
  const groups = new Map();
  for (const x of waiting) { const k = `${x.supplier || '（仕入先不明）'}|${x.orderedAt ? fmtMD(x.orderedAt) : ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  let html = `<div class="card" style="background:#f3fbf5;border-color:#b7e4c7"><div class="row"><h3 style="margin:0" class="grow">📦 入荷待ち（発注済み・未着）${waiting.length ? ` <span class="tag">${waiting.length}件</span>` : ''}</h3><button class="btn sm secondary" id="exp-add">予定を追加</button></div>`;
  if (!waiting.length) html += `<p class="muted small" style="margin:6px 0 0">発注書から登録すると、ここに並びます。届いたら「入荷した」を押すだけで入荷記録になります。</p>`;
  for (const [k, list] of groups) {
    const [sup, md] = k.split('|');
    html += `<div class="row" style="margin-top:10px"><div class="grow"><b>${esc(sup)}</b> <span class="muted small">${md ? md + ' 発注' : ''}・${list.length}件</span></div><button class="btn sm in" data-exp-all="${esc(k)}">全部入荷</button></div>`;
    for (const x of list) {
      const known = x.itemId && itemById(x.itemId);
      html += `<div class="log" style="align-items:center"><div class="what"><b>${esc(x.name)}</b> <span class="muted small">${esc(x.spec)}</span>${known ? '' : ' <span class="tag" style="background:#fff3cd;color:#7a5a00">品目未登録</span>'}<div class="muted small">${x.qty}${esc(x.unit)}${x.location ? '・' + esc(x.location) : ''}</div></div>
        <button class="btn sm in" data-exp="${esc(x.id)}">入荷した</button><button data-exp-cancel="${esc(x.id)}" aria-label="取消" title="この予定を取消">×</button></div>`;
    }
  }
  html += '</div>';
  box.innerHTML = html;
  $('#exp-add', box).onclick = openExpectedAddSheet;
  box.querySelectorAll('[data-exp]').forEach((b) => b.onclick = () => openReceiveSheet(state.expected.find((x) => x.id === b.dataset.exp)));
  box.querySelectorAll('[data-exp-all]').forEach((b) => b.onclick = () => receiveAll(groups.get(b.dataset.expAll) || []));
  box.querySelectorAll('[data-exp-cancel]').forEach((b) => b.onclick = () => {
    const x = state.expected.find((y) => y.id === b.dataset.expCancel); if (!x) return;
    if (!confirm(`「${x.name} ${x.qty}${x.unit}」の入荷予定を取り消しますか？（届かない・発注取消のとき）`)) return;
    try { updateExpected((list) => { const t = list.find((y) => y.id === x.id); t.status = 'cancelled'; t.updatedAt = Date.now(); }); } catch (e) { toast(SAVE_FAIL_MSG, 6000); return; }
    toast('取り消しました'); render();
  });
}
/** 入荷予定に対応する品目を決める（未登録なら作る） */
function resolveExpectedItem(x) {
  let it = x.itemId && itemById(x.itemId);
  if (!it) {
    const norm = (s) => String(s || '').replace(/[\s　]/g, '').toLowerCase();
    it = state.items.find((i) => norm(i.name) === norm(x.name) && norm(i.spec) === norm(x.spec)) || state.items.find((i) => norm(i.name) === norm(x.name));
  }
  if (it) {
    if (it.active === false) updateItems((list) => { const t = list.find((i) => i.id === it.id); t.active = true; t.updatedAt = Date.now(); });
    return itemById(it.id);
  }
  const created = { id: 'i' + uid(), name: x.name, spec: x.spec || '', unit: x.unit || '個', category: x.category || '薬品', location: x.location || LOCATIONS[0], supplier: x.supplier || '', note: '入荷予定から自動追加', min: 0, useDays: 0, alertMutedUntil: 0, active: true, updatedAt: Date.now() };
  updateItems((list) => { list.push(created); });
  return itemById(created.id);
}
function receiveExpected(x, n, who) {
  const it = resolveExpectedItem(x);
  const ev = addEvent({ type: 'in', itemId: it.id, qty: n, user: who || state.cfg.user || '', note: `入荷（${x.supplier || '仕入先不明'}）`, expectedId: x.id });
  updateExpected((list) => {
    const t = list.find((y) => y.id === x.id); const now = Date.now();
    if (n < t.qty) { t.qty -= n; t.updatedAt = now; }                       // 一部入荷：残りは待ちのまま
    else { t.status = 'received'; t.receivedAt = now; t.receivedBy = who || state.cfg.user || ''; t.receivedEventId = ev.id; t.updatedAt = now; }
  });
  return it;
}
function openReceiveSheet(x) {
  if (!x) return;
  const body = openSheet(`
    <h2>入荷：${esc(x.name)}</h2>
    <div class="muted small">${esc(x.spec)} ${x.supplier ? '／' + esc(x.supplier) : ''} ${x.orderedAt ? '／' + fmtMD(x.orderedAt) + ' 発注' : ''}</div>
    <p class="small muted">届いた数を確認して「入荷を登録」。予定より少なければ残りは入荷待ちに残ります。</p>
    <div class="stepper"><button id="minus" aria-label="1減らす">−</button><input id="qty" type="number" inputmode="numeric" min="1" step="1" value="${x.qty}" aria-label="数量"><button id="plus" aria-label="1増やす">＋</button></div>
    <div class="field"><label for="who">受け取った人（任意）</label><input id="who" list="names" value="${esc(state.cfg.user)}" maxlength="50"><datalist id="names">${state.users.map((u) => `<option value="${esc(u)}">`).join('')}</datalist></div>
    <button class="btn in" id="go">入荷を登録</button>
    <button class="btn secondary" id="cancel" style="margin-top:8px">やめる</button>`);
  const qty = $('#qty', body);
  $('#minus', body).onclick = () => { qty.value = String(Math.max(1, (+qty.value || 1) - 1)); };
  $('#plus', body).onclick = () => { qty.value = String((+qty.value || 0) + 1); };
  $('#cancel', body).onclick = closeSheet;
  $('#go', body).onclick = () => {
    let n; try { n = readQty(qty.value, 'in'); } catch (e) { toast(e.message); return; }
    if (n > x.qty && !confirm(`予定（${x.qty}）より多い数です。このまま登録しますか？`)) return;
    let it; try { it = receiveExpected(x, n, $('#who', body).value.trim()); } catch (e) { console.error(e); toast(SAVE_FAIL_MSG, 6000); return; }
    closeSheet(); toast(`入荷 ${it.name} ${n}${it.unit} を登録（在庫 ${computeStock().stock[it.id] || 0}）`); render();
  };
}
function receiveAll(list) {
  if (!list.length) return;
  if (!confirm(`${list.length}件を予定どおりの数量で入荷登録します。よろしいですか？\n（数が違う品目があれば、個別に「入荷した」で登録してください）`)) return;
  let ok = 0;
  try { for (const x of list) { receiveExpected(x, x.qty, state.cfg.user || ''); ok++; } }
  catch (e) { console.error(e); toast(`${ok}件登録したところで保存に失敗しました`, 6000); render(); return; }
  toast(`${ok}件の入荷を登録しました`); render();
}
function openExpectedAddSheet() {
  const sel = { it: null };
  const body = openSheet(`
    <h2>入荷予定を追加</h2>
    <p class="small muted">発注した品目と数量を入れると「入荷待ち」に並びます（全員に共有）。まとめて登録するときは PC の発注書から tools/zaiko_sync.py を使うと早いです。</p>
    <div class="field"><label for="ex-q">品目を検索</label><input id="ex-q" class="search" placeholder="品名で検索" autocomplete="off"></div>
    <div class="list" id="ex-list" style="max-height:200px;overflow:auto"></div>
    <div class="field"><label>選んだ品目</label><div id="ex-sel" class="pre">未選択</div></div>
    <div class="row">
      <div class="field grow"><label for="ex-qty">数量</label><input id="ex-qty" type="number" inputmode="numeric" min="1" step="1" value="1"></div>
      <div class="field grow"><label for="ex-sup">仕入先</label><input id="ex-sup" maxlength="100"></div>
    </div>
    <button class="btn" id="save" disabled>入荷待ちに追加</button>
    <button class="btn secondary" id="cancel" style="margin-top:8px">やめる</button>`);
  const lst = $('#ex-list', body);
  const draw = () => {
    const q = $('#ex-q', body).value.trim().toLowerCase();
    const items = state.items.filter((i) => i.active !== false && (!q || (i.name + i.spec + i.supplier).toLowerCase().includes(q))).slice(0, 8);
    lst.innerHTML = items.map((i) => `<button class="item" data-id="${esc(i.id)}"><div class="grow"><div class="nm">${esc(i.name)}</div><div class="sp">${esc(i.spec)} ${tags(i)}</div></div></button>`).join('');
    lst.querySelectorAll('.item').forEach((b) => b.onclick = () => { sel.it = itemById(b.dataset.id); $('#ex-sel', body).textContent = `${sel.it.name} ${sel.it.spec}（${sel.it.unit}）`; $('#ex-sup', body).value = sel.it.supplier; $('#save', body).disabled = false; });
  };
  $('#ex-q', body).oninput = draw; draw();
  $('#cancel', body).onclick = closeSheet;
  $('#save', body).onclick = () => {
    if (!sel.it) return;
    let n; try { n = readQty($('#ex-qty', body).value, 'in'); } catch (e) { toast(e.message); return; }
    const now = Date.now();
    const x = { id: 'x' + uid(), itemId: sel.it.id, name: sel.it.name, spec: sel.it.spec, unit: sel.it.unit, qty: n, supplier: $('#ex-sup', body).value.trim(), location: sel.it.location, category: sel.it.category, orderedAt: now, source: 'app', status: 'waiting', receivedAt: 0, receivedBy: '', receivedEventId: '', updatedAt: now };
    try { updateExpected((list) => { list.push(x); }); } catch (e) { toast(SAVE_FAIL_MSG, 6000); return; }
    closeSheet(); toast('入荷待ちに追加しました'); render();
  };
}

// ---------- タブ：在庫 ----------
function renderStock() {
  const { stock, voided } = computeStock();
  const active = state.items.filter((i) => i.active !== false);
  const low = active.filter((i) => isLow(i, stock));
  const alerts = currentAlerts();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const outToday = state.events.filter((e) => e.type === 'out' && e.ts >= today.getTime() && !voided.has(e.id)).length;
  view.innerHTML = `
    <h2>📦 在庫一覧</h2>
    <div class="sum">
      <div class="card"><div class="n">${active.length}</div><div class="l">品目</div></div>
      <div class="card" ${low.length ? 'style="border-color:#f5c2c7"' : ''}><div class="n" style="color:${low.length ? 'var(--danger)' : 'inherit'}">${low.length}</div><div class="l">発注点以下</div></div>
      <div class="card"><div class="n">${outToday}</div><div class="l">今日の持ち出し（件）</div></div>
    </div>
    ${alerts.length ? `<div class="card" style="background:#fff4e5;border-color:#ffd8a8"><h3 style="margin:0 0 6px">⚠ アラート（${alerts.length}）${state.settings.herd ? ` <span class="muted small">飼養頭数 ${state.settings.herd}頭</span>` : ''}</h3>
      ${alerts.map((a) => { const it = itemById(a.itemId); return it ? `<div class="log" style="align-items:center"><div class="what"><b>${esc(it.name)}</b> <span class="tag loc">${esc(it.location)}</span><div class="small">${esc(a.text)}</div></div><button class="btn sm secondary" data-ack="${esc(it.id)}">確認</button></div>` : ''; }).join('')}
      <p class="muted small" style="margin:6px 0 0">「確認」を押すと1週間表示されません（全員の画面で）。使用間隔の目安は品目の編集で設定できます。</p></div>` : ''}
    <div class="row" style="margin-bottom:8px">
      <button class="btn sm" id="share-order" ${low.length ? '' : 'disabled'}>発注候補を共有（${low.length}）</button>
      <button class="btn sm secondary" id="low-only">${state.filters.lowOnly ? '全部表示' : '発注点以下だけ'}</button>
    </div>
    <input class="search" id="q" type="search" placeholder="品名・規格・仕入先で検索" value="${esc(state.filters.q)}" autocomplete="off">
    ${filterChips()}
    <div class="list" id="list"></div>
    <p class="muted small">発注点（これ以下になったら発注）と使用間隔の目安は、品目をタップ → 「品目を編集」で設定できます。</p>`;
  view.querySelectorAll('[data-ack]').forEach((b) => b.onclick = () => {
    try { updateItems((list) => { const t = list.find((i) => i.id === b.dataset.ack); t.alertMutedUntil = Date.now() + 7 * DAY; t.updatedAt = Date.now(); }); } catch (e) { toast(SAVE_FAIL_MSG, 6000); return; }
    toast('確認しました（1週間非表示）'); renderStock(); updateHeader();
  });
  const list = $('#list');
  const draw = () => {
    const s = computeStock().stock;
    let items = filteredItems();
    if (state.filters.lowOnly) items = items.filter((i) => isLow(i, s));
    list.innerHTML = items.length ? items.map((it) => itemRow(it, s, it.min > 0 ? `<div class="small muted">発注点 ${it.min}</div>` : '')).join('') : `<div class="empty">該当なし</div>`;
    list.querySelectorAll('.item').forEach((b) => b.onclick = () => openItemSheet(itemById(b.dataset.id)));
  };
  $('#q').addEventListener('input', (e) => { state.filters.q = e.target.value; draw(); });
  $('#low-only').onclick = () => { state.filters.lowOnly = !state.filters.lowOnly; renderStock(); };
  $('#share-order').onclick = () => shareText(C.buildOrderText(low, stock, fmtDate(Date.now())), '発注候補リスト');
  bindChips(view, draw);
  draw();
}

async function shareText(text, title) {
  try {
    if (navigator.share) { await navigator.share({ title, text }); return; }
    await navigator.clipboard.writeText(text); toast('コピーしました（LINE等に貼り付けてください）');
  } catch (e) {
    if (e.name === 'AbortError') return;
    const b = openSheet(`<h2>${esc(title)}</h2><div class="pre">${esc(text)}</div><button class="btn secondary" id="close" style="margin-top:10px">閉じる</button>`);
    $('#close', b).onclick = closeSheet;
  }
}

function openItemSheet(it) {
  if (!it) return;
  const { stock, voided } = computeStock(); const cur = stock[it.id] || 0;
  const hist = state.events.filter((e) => e.itemId === it.id && e.type !== 'void').sort((a, b) => b.ts - a.ts).slice(0, 10);
  const body = openSheet(`
    <h2>${esc(it.name)}</h2>
    <div class="muted small">${esc(it.spec || '')} ${tags(it)}</div>
    <div class="row" style="margin:10px 0"><div class="grow">現在の在庫</div><div style="font-size:24px;font-weight:700;color:${isLow(it, stock) ? 'var(--danger)' : 'inherit'}">${cur} ${esc(it.unit)}</div></div>
    <div class="row">
      <button class="btn sm out" data-act="out">持ち出し</button>
      <button class="btn sm in" data-act="in">入荷</button>
      <button class="btn sm" data-act="set">棚卸(数を直す)</button>
      <button class="btn sm secondary" data-act="edit">品目を編集</button>
    </div>
    <h3>この品目の履歴</h3>
    ${hist.length ? hist.map((e) => `<div class="log ${voided.has(e.id) ? 'void' : ''}"><div class="when">${fmtDT(e.ts)}</div><div class="what"><span class="d ${typeClass(e.type)}">${TYPE_LABEL[e.type] || ''} ${e.qty}</span> ${esc(evWho(e))} <span class="muted small">${esc(e.note || '')}</span></div></div>`).join('') : '<div class="muted small">まだ記録がありません</div>'}
    <button class="btn secondary" id="close" style="margin-top:12px">閉じる</button>`);
  $('#close', body).onclick = closeSheet;
  body.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'out' || a === 'in') openQtySheet(it, a);
    else if (a === 'set') openSetSheet(it, cur);
    else openEditSheet(it);
  });
}
function openSetSheet(it, cur) {
  const pending = state.cfg.dropbox.refreshToken && state.sync.status !== 'ok';
  const body = openSheet(`
    <h2>棚卸：${esc(it.name)}</h2>
    <p class="muted small">実際に数えた在庫数を入れてください。記録上の在庫（${cur}）がこの数に置き換わります。</p>
    ${pending ? '<p class="small" style="color:var(--warn)">※ 他の端末の記録がまだ届いていない可能性があります（右上の⟳で同期してから棚卸すると正確です）</p>' : ''}
    <div class="stepper"><button id="minus" aria-label="1減らす">−</button><input id="qty" type="number" inputmode="numeric" min="0" step="1" value="${cur}" aria-label="在庫数"><button id="plus" aria-label="1増やす">＋</button></div>
    <div class="field"><label for="who">数えた人（任意）</label><input id="who" list="names" value="${esc(state.cfg.user)}" maxlength="50"><datalist id="names">${state.users.map((u) => `<option value="${esc(u)}">`).join('')}</datalist></div>
    <div class="field"><label for="note">メモ</label><input id="note" type="text" placeholder="例：月末棚卸" maxlength="200"></div>
    <button class="btn" id="go">この数で確定</button>
    <button class="btn secondary" id="cancel" style="margin-top:8px">やめる</button>`);
  const qty = $('#qty', body);
  $('#minus', body).onclick = () => { qty.value = String(Math.max(0, (+qty.value || 0) - 1)); };
  $('#plus', body).onclick = () => { qty.value = String((+qty.value || 0) + 1); };
  $('#cancel', body).onclick = closeSheet;
  $('#go', body).onclick = () => {
    let n; try { n = readQty(qty.value, 'set'); } catch (e) { toast(e.message); qty.focus(); return; }
    try { addEvent({ type: 'set', itemId: it.id, qty: n, user: $('#who', body).value.trim(), note: $('#note', body).value.trim() }); }
    catch (e) { console.error(e); toast(SAVE_FAIL_MSG, 6000); return; }
    closeSheet(); toast(`${it.name} の在庫を ${n} にしました`); render();
  };
}
function openEditSheet(it) {
  const isNew = !it;
  it = it || { id: 'i' + uid(), name: '', spec: '', unit: '個', category: '薬品', location: '事務所前', supplier: '', note: '', min: 0, useDays: 0, alertMutedUntil: 0, active: true };
  const opt = (arr, v) => arr.map((x) => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const body = openSheet(`
    <h2>${isNew ? '品目を追加' : '品目を編集'}</h2>
    <div class="field"><label for="f-name">品名 *</label><input id="f-name" value="${esc(it.name)}" maxlength="200"></div>
    <div class="field"><label for="f-spec">規格</label><input id="f-spec" value="${esc(it.spec)}" placeholder="例：100ml×5" maxlength="200"></div>
    <div class="row">
      <div class="field grow"><label for="f-unit">単位</label><input id="f-unit" value="${esc(it.unit)}" placeholder="個・箱・袋" maxlength="50"></div>
      <div class="field grow"><label for="f-min">発注点（0=未設定）</label><input id="f-min" type="number" inputmode="numeric" min="0" step="1" value="${it.min || 0}"></div>
    </div>
    <div class="row">
      <div class="field grow"><label for="f-cat">種別</label><select id="f-cat">${opt(CATEGORIES, it.category)}</select></div>
      <div class="field grow"><label for="f-loc">置き場</label><select id="f-loc">${opt(LOCATIONS, it.location)}</select></div>
    </div>
    <div class="field"><label for="f-sup">仕入先</label><input id="f-sup" value="${esc(it.supplier)}" list="sups" placeholder="アスコ・小田島・アグロ・大竹先生・食創" maxlength="100"><datalist id="sups">${[...new Set(state.items.map((i) => i.supplier).filter(Boolean))].map((s) => `<option value="${esc(s)}">`).join('')}</datalist></div>
    <div class="field"><label for="f-use">使用間隔の目安（日）：この日数を超えて持ち出しが無いとアラート（0=なし）</label><input id="f-use" type="number" inputmode="numeric" min="0" step="1" value="${it.useDays || 0}"></div>
    <div class="field"><label for="f-note">備考</label><input id="f-note" value="${esc(it.note || '')}" placeholder="例：土日納品不可" maxlength="500"></div>
    ${isNew ? '' : `<div class="field"><label><input type="checkbox" id="f-active" ${it.active !== false ? 'checked' : ''}> 在庫管理する（外すと一覧から隠れます）</label></div>`}
    <button class="btn" id="save">保存</button>
    <button class="btn secondary" id="cancel" style="margin-top:8px">やめる</button>`);
  $('#cancel', body).onclick = closeSheet;
  $('#save', body).onclick = () => {
    const name = $('#f-name', body).value.trim(); if (!name) { toast('品名を入れてください'); return; }
    let min, useDays;
    try { min = readQty($('#f-min', body).value || '0', 'set'); useDays = readQty($('#f-use', body).value || '0', 'set'); } catch (e) { toast('発注点・使用間隔は0以上の整数で入力してください'); return; }
    const next = Object.assign({}, it, {
      name, spec: $('#f-spec', body).value.trim(), unit: $('#f-unit', body).value.trim() || '個',
      min, useDays, category: $('#f-cat', body).value, location: $('#f-loc', body).value,
      supplier: $('#f-sup', body).value.trim(), note: $('#f-note', body).value.trim(),
      active: isNew ? true : $('#f-active', body).checked, updatedAt: Date.now(),
    });
    try { validateItems([next]); } catch (e) { toast(e.message, 4000); return; }
    try { updateItems((list) => { const i = list.findIndex((x) => x.id === next.id); if (i < 0) list.push(next); else list[i] = next; }); }
    catch (e) { toast(SAVE_FAIL_MSG, 6000); return; }
    closeSheet(); toast('保存しました'); render();
  };
}

// ---------- タブ：履歴 ----------
function renderLog() {
  const { voided } = computeStock();
  const f = state.filters;
  const chip = (v, l) => `<button class="chip ${f.logType === v ? 'active' : ''}" data-t="${esc(v)}">${l}</button>`;
  const all = state.events.filter((e) => e.type !== 'void' && (!f.logType || e.type === f.logType)).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  const evs = all.slice(0, f.logLimit);
  view.innerHTML = `
    <h2>🕒 履歴 <span class="muted small">全員分（同期済みのもの）</span></h2>
    <div class="chips">${chip('', '全て')}${chip('out', '持ち出し')}${chip('in', '入荷')}${chip('set', '棚卸')}</div>
    <div class="row" style="margin-bottom:8px"><button class="btn sm secondary" id="csv">CSVで書き出し</button><span class="muted small">${all.length}件中 ${evs.length}件を表示</span></div>
    <div id="list"></div>
    ${all.length > evs.length ? '<button class="btn secondary" id="more" style="margin-top:10px">続きを表示</button>' : ''}`;
  view.querySelectorAll('.chip[data-t]').forEach((b) => b.onclick = () => { f.logType = b.dataset.t; f.logLimit = 400; renderLog(); });
  $('#csv').onclick = exportCSV;
  const more = $('#more'); if (more) more.onclick = () => { f.logLimit += 400; renderLog(); };
  let html = '', lastDay = '';
  for (const e of evs) {
    const day = fmtDate(e.ts);
    if (day !== lastDay) { html += `<h3>${day}</h3>`; lastDay = day; }
    html += `<div class="log ${voided.has(e.id) ? 'void' : ''}">
      <div class="when">${fmtTime(e.ts)}<br>${esc(evWho(e))}</div>
      <div class="what"><span class="d ${typeClass(e.type)}">${TYPE_LABEL[e.type] || ''} ${e.qty}${esc(evUnit(e))}</span> ${esc(evName(e))}
        <div class="muted small">${esc((e.itemId && itemById(e.itemId) || {}).location || '')} ${esc(e.note || '')}</div></div>
      ${voided.has(e.id) ? '' : `<button data-void="${esc(e.id)}">取消</button>`}</div>`;
  }
  $('#list').innerHTML = html || '<div class="empty">まだ記録がありません</div>';
  view.querySelectorAll('[data-void]').forEach((b) => b.onclick = () => {
    if (!confirm('この記録を取り消しますか？（取消の記録が残ります）')) return;
    try { addEvent({ type: 'void', ref: b.dataset.void, itemId: null, qty: 0 }); } catch (e) { toast(SAVE_FAIL_MSG, 6000); return; }
    renderLog(); toast('取り消しました');
  });
}
function exportCSV() {
  const { voided } = computeStock();
  const rows = [['日時', '種類', '品名', '規格', '数量', '単位', '置き場', '持ち出し先', '担当', 'メモ', '取消']];
  for (const e of C.orderEvents(state.events.filter((e) => e.type !== 'void'))) {
    const it = (e.itemId && itemById(e.itemId)) || {};
    const d = new Date(e.ts);
    rows.push([`${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${fmtTime(e.ts)}`, { out: '持ち出し', in: '入荷', set: '棚卸' }[e.type], it.name || e.name || '', it.spec || '', e.qty, it.unit || e.unit || '', it.location || '', e.stage || '', e.user || '', e.note || '', voided.has(e.id) ? '取消' : '']);
  }
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadFile(`入出庫履歴_${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
}
async function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

// ---------- バックアップ復元 ----------
/** 復元：全件検証 → 件数を確認 → 取り込み → 他端末分は「復元ファイル」として共有待ちに入れる */
async function restoreBackup(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch (e) { toast('バックアップを読めません（JSONではありません）', 4000); return; }
  let events, items, expected;
  try {
    events = validateEvents(Array.isArray(d.events) ? d.events : []); items = validateItems(Array.isArray(d.items) ? d.items : []);
    expected = validateExpected(Array.isArray(d.expected) ? d.expected : []);
  } catch (e) { toast('バックアップの内容が不正です：' + e.message, 6000); return; }
  const have = new Set(state.events.map((e) => e.id));
  const newEvents = events.filter((e) => !have.has(e.id));
  const dup = events.length - newEvents.length;
  const foreign = newEvents.filter((e) => e.dev !== deviceId);
  const m = mergeById(state.items, items);
  const addedItems = m.items.length - state.items.length;
  const msg = `バックアップを取り込みます。\n\n追加される記録：${newEvents.length}件（うち他端末の記録 ${foreign.length}件）\nすでにある記録：${dup}件（重複は追加しません）\n追加される品目：${addedItems}件\n\n` +
    (foreign.length ? '他端末の記録は「復元ファイル」として Dropbox に送り、全員に共有されます。\n' : '') + '続けますか？';
  if (!confirm(msg)) return;
  const prev = { events: state.events, items: state.items, recovery: state.recovery, expected: state.expected };
  try {
    const me = mergeEvents(state.events, newEvents);
    state.events = me.events; state.items = m.items; stockCache = null;
    state.expected = mergeById(state.expected, expected).items;
    if (foreign.length) state.recovery = state.recovery.concat([{ id: uid(), name: `recovery-${deviceId}-${Date.now().toString(36)}.json`, events: foreign, createdAt: Date.now() }]);
    persistEvents(); persistItems(); persistExpected(); writeLS(LS.recovery, state.recovery);
    for (const u of (Array.isArray(d.users) ? d.users : [])) if (typeof u === 'string' && u && !state.users.includes(u)) state.users.push(u);
    save(LS.users, state.users);
  } catch (e) { Object.assign(state, prev); stockCache = null; toast(SAVE_FAIL_MSG, 6000); return; }
  scheduleSync();
  toast(`復元しました（記録 ${newEvents.length}件、品目 ${addedItems}件）` + (foreign.length ? '。他端末分は次の同期で共有されます' : ''), 5000);
  render();
}

// ---------- タブ：設定 ----------
function renderSettings() {
  const dbx = state.cfg.dropbox; const connected = !!dbx.refreshToken;
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const url = redirectUri();
  const pend = pendingSummary();
  view.innerHTML = `
    <h2>⚙️ 設定</h2>

    <div class="card">
      <h3 style="margin-top:0">あなたの名前（任意：入荷・棚卸の記録に残ります）</h3>
      <p class="small muted" style="margin:0 0 6px">持ち出しは名前ではなく「持ち出し先（交配舎・分娩舎…）」で記録します。「その他」のときだけ名前を入れます。</p>
      <div class="user-grid" id="users">${state.users.map((u) => `<button class="${u === state.cfg.user ? 'active' : ''}" data-u="${esc(u)}">${esc(u)}</button>`).join('')}</div>
      <div class="row" style="margin-top:8px"><input class="search grow" id="new-user" placeholder="名前を追加" maxlength="50"><button class="btn sm" id="add-user">追加</button><button class="btn sm secondary" id="clear-user">名前なし</button></div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">農場の共有設定</h3>
      <div class="row"><div class="field grow"><label for="herd">飼養頭数（頭）：アラートの参考値。全員に共有</label><input id="herd" type="number" inputmode="numeric" min="0" step="1" value="${state.settings.herd || 0}"></div><button class="btn sm" id="herd-save" style="margin-top:14px">保存</button></div>
      <p class="small muted" style="margin:0">入荷待ち：${waitingExpected().length}件（入荷タブに表示）</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">みんなで共有する（Dropbox同期）</h3>
      <div class="kv">
        <div>状態</div><div><span class="dot ${connected ? state.sync.status : 'off'}"></span> ${esc(syncLabel())}</div>
        <div>未送信</div><div>${esc(pend.text)}</div>
        <div>アカウント</div><div>${esc(dbx.account || '未接続')}</div>
        <div>この端末ID</div><div class="mono small">${esc(deviceId)}</div>
      </div>
      <details ${connected ? '' : 'open'} style="margin-top:8px"><summary>接続設定</summary>
        ${secure ? '' : '<p class="small" style="color:var(--danger)">※ Dropbox連携は https（またはlocalhost）で開いたときだけ使えます。</p>'}
        <div class="field"><label for="dbx-key">Dropbox App Key（管理者が dropbox.com/developers で作成）</label><input id="dbx-key" value="${esc(dbx.appKey)}" autocapitalize="off" autocomplete="off"></div>
        <div class="field"><label for="dbx-path">保存先フォルダ（Dropbox内のパス。チーム共有フォルダの中を推奨）</label><div class="row"><input id="dbx-path" class="grow" value="${esc(dbx.basePath)}" placeholder="/十勝野ポーク チーム フォルダ/CM農場在庫アプリ"><button class="btn sm secondary" id="dbx-pick" ${connected ? '' : 'disabled'}>一覧から選ぶ</button></div>${dbx.pathRoot ? '<p class="small muted" style="margin:4px 0 0">チームスペース（Dropbox Business）のフォルダを基準にしています</p>' : ''}</div>
        <div class="field"><label for="poll">自動更新の間隔（秒）</label><input id="poll" type="number" inputmode="numeric" min="10" value="${state.cfg.pollSec}"></div>
        <div class="row wrap">
          <button class="btn sm" id="dbx-save">保存</button>
          <button class="btn sm" id="dbx-login" ${secure ? '' : 'disabled'}>${connected ? 'Dropboxに再ログイン' : 'Dropboxでログイン'}</button>
          <button class="btn sm secondary" id="dbx-test" ${connected ? '' : 'disabled'}>接続テスト</button>
          <button class="btn sm secondary" id="dbx-logout" ${connected ? '' : 'disabled'}>切断</button>
        </div>
        <p class="small muted">このアプリの転送先URL（Dropbox App の Redirect URI に登録）：<span class="mono">${esc(url)}</span></p>
      </details>
      <details style="margin-top:8px"><summary>他の人のスマホを一発で設定する（招待リンク）</summary>
        <p class="small muted">この端末のDropbox接続と名前リストを含んだリンクを作ります。LINEで送って開いてもらうと、Dropboxログインなしで同じ設定になります。<b>リンクを持っている人は誰でもこのDropboxの保存先を読み書きできる</b>ので、社内の該当者だけに送ってください。漏れた疑いがあるときは Dropbox の「リンク済みアプリ」から解除すると全端末の接続が切れます。</p>
        <button class="btn sm" id="invite" ${connected ? '' : 'disabled'}>招待リンクを作る</button>
      </details>
    </div>

    <div class="card">
      <h3 style="margin-top:0">LINEで配る・ホーム画面に入れる</h3>
      <p class="small muted">このURLをLINEで送ると、タップ時にLINE内ブラウザではなく通常のブラウザで開き、そのまま「ホーム画面に追加」できます。</p>
      <div class="pre mono small">${esc(url + '?openExternalBrowser=1')}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="copy-url">URLをコピー／共有</button>${state.installPrompt ? '<button class="btn sm in" id="install">この端末にインストール</button>' : ''}</div>
      <details style="margin-top:8px"><summary>ホーム画面への入れ方</summary>
        <b>iPhone（Safari）</b><ol class="steps"><li>画面下の「共有」ボタン（□に↑）をタップ</li><li>「ホーム画面に追加」をタップ</li><li>右上の「追加」</li></ol>
        <b>Android（Chrome）</b><ol class="steps"><li>右上の「⋮」をタップ</li><li>「ホーム画面に追加」または「アプリをインストール」</li></ol>
      </details>
      <div class="field"><label for="liff">LINEミニアプリ（LIFF）ID — 任意。設定するとLINE内で開いたとき名前が自動で入ります</label><input id="liff" value="${esc(state.cfg.liffId)}" placeholder="1234567890-abcdefgh"></div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">品目マスタ（${state.items.filter((i) => i.active !== false).length}品目 管理中／全${state.items.length}品目）</h3>
      <div class="row wrap"><button class="btn sm" id="add-item">品目を追加</button><button class="btn sm secondary" id="reload-default">発注書の初期マスタを追加読込</button></div>
      <input class="search" id="mq" placeholder="品目を検索して編集（管理していない品目も出ます）" style="margin-top:8px">
      <div class="list" id="mlist" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">データ</h3>
      <div class="row wrap">
        <button class="btn sm secondary" id="backup">バックアップ(JSON)</button>
        <button class="btn sm secondary" id="restore">バックアップから復元</button>
        <button class="btn sm danger" id="wipe">この端末のデータを消す</button>
      </div>
      <input type="file" id="restore-file" accept="application/json,.json" class="hidden">
    </div>

    <div class="card small muted">
      CM農場 在庫アプリ v${APP_VERSION} ／ <button class="chip" id="check-update">更新を確認</button><br>
      ${connected ? 'Dropboxフォルダ：' + esc(dbx.basePath) : '同期未設定：このスマホの中だけに記録されています'}
    </div>`;

  // 名前
  view.querySelectorAll('#users button').forEach((b) => b.onclick = () => { state.cfg.user = b.dataset.u; persistMeta(); renderSettings(); updateHeader(); });
  $('#add-user').onclick = () => { const v = $('#new-user').value.trim().slice(0, 50); if (!v) return; if (!state.users.includes(v)) state.users.push(v); state.cfg.user = v; persistMeta(); renderSettings(); updateHeader(); };
  $('#clear-user').onclick = () => { state.cfg.user = ''; persistMeta(); renderSettings(); updateHeader(); };
  // 共有設定
  $('#herd-save').onclick = () => {
    let herd; try { herd = readQty($('#herd').value || '0', 'set'); } catch (e) { toast('飼養頭数は0以上の整数で入力してください'); return; }
    state.settings = { herd, updatedAt: Date.now() };
    try { persistSettings(); } catch (e) { toast(SAVE_FAIL_MSG, 6000); return; }
    scheduleSync(); toast('保存しました（全員に共有）');
  };
  // Dropbox
  const readDbxForm = () => {
    const newBase = ('/' + $('#dbx-path').value.trim().replace(/^\/+|\/+$/g, '')).replace(/\/+$/, '');
    if (newBase !== dbx.basePath) { state.revs = {}; }           // 保存先が変わったら取り直し・送り直し
    dbx.appKey = $('#dbx-key').value.trim(); dbx.basePath = newBase;
    state.cfg.pollSec = Math.max(10, Math.round(+$('#poll').value) || 30); state.cfg.liffId = $('#liff').value.trim(); persistMeta();
  };
  $('#dbx-save').onclick = () => { readDbxForm(); toast('保存しました'); startPolling(); scheduleSync(); };
  $('#dbx-pick').onclick = async () => {
    let folders;
    try { await refreshAccountInfo(); const r = await dbxRPC('files/list_folder', { path: '', recursive: false }); folders = r.entries.filter((e) => e['.tag'] === 'folder').map((e) => e.name); }
    catch (e) { toast('フォルダ一覧を取得できません：' + e.message, 5000); return; }
    const body = openSheet(`<h2>保存先フォルダを選ぶ</h2><p class="small muted">選んだフォルダの中に「CM農場在庫アプリ」フォルダを作って保存します。チームで共有しているフォルダを選んでください。</p>
      <div class="list">${folders.map((f) => `<button class="item" data-f="${esc(f)}"><div class="grow"><div class="nm">📁 ${esc(f)}</div></div></button>`).join('') || '<div class="empty">フォルダがありません</div>'}
      <button class="item" data-f=""><div class="grow"><div class="nm">（ルート直下に置く）</div></div></button></div>
      <button class="btn secondary" id="close" style="margin-top:10px">閉じる</button>`);
    $('#close', body).onclick = closeSheet;
    body.querySelectorAll('.item[data-f]').forEach((b) => b.onclick = () => { const f = b.dataset.f; $('#dbx-path').value = (f ? '/' + f : '') + '/CM農場在庫アプリ'; closeSheet(); readDbxForm(); toast('保存先を変更しました。右上の⟳で同期します'); scheduleSync(); renderSettings(); });
  };
  $('#dbx-login').onclick = () => { readDbxForm(); if (!dbx.appKey) { toast('App Key を入れてください'); return; } dbxLogin(); };
  $('#dbx-test').onclick = async () => {
    readDbxForm();
    let acct;
    try { await refreshAccountInfo(); acct = dbx.account; }
    catch (e) { toast('Dropbox認証エラー：' + e.message, 5000); return; }
    const ok = await syncNow(true, true);
    toast(ok ? `接続OK（${acct}）・同期も完了しました` : `認証はOK（${acct}）ですが同期でエラー：${state.sync.msg}`, 6000);
    renderSettings();
  };
  $('#dbx-logout').onclick = () => {
    if (!confirm('Dropboxとの接続を切りますか？（記録は端末に残ります）' + (pend.count ? `\n※ 未送信が ${pend.count}件 あります。切断すると共有されません。` : ''))) return;
    Object.assign(dbx, { refreshToken: '', accessToken: '', expiresAt: 0, account: '' }); state.revs = {}; persistMeta(); setSync('off'); renderSettings();
  };
  $('#invite').onclick = () => {
    const payload = { v: 1, appKey: dbx.appKey, basePath: dbx.basePath, pathRoot: dbx.pathRoot || '', refreshToken: dbx.refreshToken, users: state.users, liffId: state.cfg.liffId, pollSec: state.cfg.pollSec };
    const link = url + '?openExternalBrowser=1#setup=' + b64url(new TextEncoder().encode(JSON.stringify(payload)));
    shareText(`CM農場 在庫アプリの招待リンクです。タップして開き、「ホーム画面に追加」してください。\n${link}`, '在庫アプリ 招待リンク');
  };
  $('#copy-url').onclick = () => shareText(`CM農場 在庫アプリ\n${url}?openExternalBrowser=1\n開いたら「ホーム画面に追加」してください。`, '在庫アプリ');
  const inst = $('#install'); if (inst) inst.onclick = async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; renderSettings(); };
  $('#liff').onchange = readDbxForm;
  // 品目マスタ
  $('#add-item').onclick = () => openEditSheet(null);
  $('#reload-default').onclick = () => {
    const add = validateItems((window.DEFAULT_ITEMS || []).filter((d) => !itemById(d.id)).map((d) => Object.assign({}, d, { updatedAt: Date.now() })));
    if (!add.length) { toast('追加する品目はありません'); return; }
    try { updateItems((list) => { for (const a of add) list.push(a); }); } catch (e) { toast(SAVE_FAIL_MSG, 6000); return; }
    toast(`${add.length}品目を追加しました`); renderSettings();
  };
  const mlist = $('#mlist');
  const drawM = () => {
    const q = $('#mq').value.trim().toLowerCase();
    const items = state.items.filter((i) => !q || (i.name + i.spec + i.supplier).toLowerCase().includes(q)).slice(0, q ? 100 : 30);
    mlist.innerHTML = items.map((it) => `<button class="item" data-id="${esc(it.id)}" style="${it.active === false ? 'opacity:.5' : ''}"><div class="grow"><div class="nm">${esc(it.name)}${it.active === false ? ' <span class="tag">管理外</span>' : ''}</div><div class="sp">${esc(it.spec)} ${tags(it)} ${it.min ? '発注点' + it.min : ''} ${it.useDays ? '目安' + it.useDays + '日' : ''}</div></div><div class="muted">›</div></button>`).join('') + (!q && state.items.length > 30 ? '<div class="muted small" style="text-align:center">…検索して絞り込んでください</div>' : '');
    mlist.querySelectorAll('.item').forEach((b) => b.onclick = () => openEditSheet(itemById(b.dataset.id)));
  };
  $('#mq').oninput = drawM; drawM();
  // データ
  $('#backup').onclick = () => downloadFile(`在庫アプリ_バックアップ_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'cm-zaiko', version: APP_VERSION, device: deviceId, basePath: dbx.basePath, createdAt: new Date().toISOString(), items: state.items, events: state.events, expected: state.expected, settings: state.settings, users: state.users }, null, 1), 'application/json');
  $('#restore').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await restoreBackup(f); };
  $('#wipe').onclick = () => {
    const warn = pend.count ? `\n※ 未送信が ${pend.count}件 あります。消すと共有されません。先に右上の⟳で同期してください。` : '';
    if (!confirm('この端末のデータ（記録・設定）を全て消します。Dropbox上のデータは消えません。よろしいですか？' + warn)) return;
    for (const k of Object.values(LS)) localStorage.removeItem(k);
    location.reload();
  };
  $('#check-update').onclick = async () => { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) { await reg.update(); toast(state.swWaiting ? '新しい版があります。上の「更新」を押してください' : '最新版です'); } else toast('オフライン対応は https で開いたときに有効になります'); };
}

function openUserSheet(after) {
  const body = openSheet(`
    <h2>あなたの名前を選んでください</h2>
    <p class="muted small">入荷・棚卸の記録に「誰が」として残ります（あとで設定から変更できます）</p>
    <div class="user-grid" id="ug">${state.users.map((u) => `<button data-u="${esc(u)}">${esc(u)}</button>`).join('')}</div>
    <div class="row" style="margin-top:10px"><input class="search grow" id="nu" placeholder="リストにない場合は入力" maxlength="50"><button class="btn sm" id="nu-ok">決定</button></div>
    <button class="btn secondary" id="skip" style="margin-top:10px">名前なしで使う</button>`);
  const done = (u) => { state.cfg.user = u; if (u && !state.users.includes(u)) state.users.push(u); persistMeta(); updateHeader(); closeSheet(); after && after(); };
  body.querySelectorAll('#ug button').forEach((b) => b.onclick = () => done(b.dataset.u));
  $('#nu-ok', body).onclick = () => { const v = $('#nu', body).value.trim().slice(0, 50); if (v) done(v); };
  $('#skip', body).onclick = () => done('');
}

// ---------- 画面切替 ----------
function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  ({ out: () => renderPick('out'), in: () => renderPick('in'), stock: renderStock, log: renderLog, settings: renderSettings })[state.tab]();
  updateHeader();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.filters.q = ''; state.filters.logLimit = 400; render(); window.scrollTo(0, 0); }));

// ---------- 共有文書（品目マスタ・入荷予定・共有設定）と未送信の判定 ----------
const basePath = () => state.cfg.dropbox.basePath.replace(/\/+$/, '');
const ownEvents = () => C.orderEvents(state.events.filter((e) => e.dev === deviceId));
const ownText = () => JSON.stringify(ownEvents());
const DOCS = {
  master: { file: 'master.json', label: '品目マスタ', get: () => state.items, set: (v) => { state.items = v; }, validate: validateItems, merge: mergeById, persist: persistItems },
  expected: { file: 'expected.json', label: '入荷予定', get: () => state.expected, set: (v) => { state.expected = v; }, validate: (v) => pruneExpected(validateExpected(v), Date.now()), merge: mergeById, persist: persistExpected },
  settings: { file: 'settings.json', label: '共有設定', get: () => state.settings, set: (v) => { state.settings = v; }, validate: validateSettings,
    merge: (l, r) => ((r.updatedAt || 0) > (l.updatedAt || 0) ? { items: r, changed: true } : { items: l, changed: false }), persist: persistSettings },
};
const docText = (key) => JSON.stringify(DOCS[key].get());
const docPending = (key) => fingerprint(docText(key)) !== state.sent[key] || state.sent.base !== basePath();
const eventsPending = () => fingerprint(ownText()) !== state.sent.events || state.sent.base !== basePath();
const masterPending = () => docPending('master');
function pendingSummary() {
  if (!state.cfg.dropbox.refreshToken) return { count: 0, text: '（同期未設定）' };
  const parts = [];
  if (eventsPending()) parts.push('記録');
  for (const k of Object.keys(DOCS)) if (docPending(k)) parts.push(DOCS[k].label);
  if (state.recovery.length) parts.push(`復元ファイル${state.recovery.length}`);
  return { count: parts.length, text: parts.length ? parts.join('・') + ' が未送信' : 'なし' };
}
const anyPending = () => eventsPending() || Object.keys(DOCS).some(docPending) || state.recovery.length > 0;

function syncLabel() {
  const s = state.sync;
  if (!state.cfg.dropbox.refreshToken) return '端末のみ（未共有）';
  return { ok: '同期済み ' + (s.last ? fmtTime(s.last) : ''), busy: '同期中…', pending: '未送信あり', err: 'エラー: ' + s.msg, off: 'オフライン' }[s.status] || s.status;
}
function setSync(status, msg = '') { state.sync.status = status; state.sync.msg = msg; if (status === 'ok') state.sync.last = Date.now(); updateHeader(); }
function setBadge(tab, n) {
  const b = document.querySelector(`#tabs button[data-tab="${tab}"]`); let badge = b.querySelector('.badge');
  if (n) { if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; b.appendChild(badge); } badge.textContent = n; } else if (badge) badge.remove();
}
function updateHeader() {
  $('#who').textContent = state.cfg.user || '名前なし';
  $('#sync-label').textContent = syncLabel();
  const dot = $('#sync-dot'); dot.className = 'dot ' + (state.cfg.dropbox.refreshToken ? state.sync.status : 'off');
  $('#sync-btn').classList.toggle('spin', state.sync.busy);
  const { stock } = computeStock();
  const low = state.items.filter((i) => i.active !== false && isLow(i, stock)).length;
  setBadge('stock', low + currentAlerts().length);
  setBadge('in', waitingExpected().length);
}
$('#sync-btn').onclick = () => { if (!state.cfg.dropbox.refreshToken) { state.tab = 'settings'; render(); toast('Dropbox同期を設定すると全員で共有できます'); } else syncNow(true); };

// ---------- バナー（LINE内ブラウザ／インストール／更新） ----------
function showBanner(html, cls = '') { const b = $('#banner'); b.className = 'banner ' + cls; b.innerHTML = html; }
function hideBanner() { $('#banner').className = 'banner hidden'; }
function setupBanners() {
  const ua = navigator.userAgent; const dismissed = load(LS.dismiss, 0);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isLine = /\bLine\//i.test(ua);
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  if (state.swWaiting) {
    showBanner(`<span>新しいバージョンがあります（入力中の内容は先に登録してください）</span><button id="b-upd">更新</button>`, 'info');
    $('#b-upd').onclick = () => {
      if (sheetOpen() && !confirm('入力画面が開いています。登録していない内容は消えますが、更新しますか？')) return;
      state.updateRequested = true; state.swWaiting.postMessage('SKIP_WAITING');
    };
    return;
  }
  if (standalone || Date.now() - dismissed < 7 * 86400e3) { hideBanner(); return; }
  const dismiss = `<button class="x" id="b-x" aria-label="閉じる">×</button>`;
  if (isLine) {
    const u = new URL(location.href); u.searchParams.set('openExternalBrowser', '1');
    showBanner(`<span>LINEの中では「ホーム画面に追加」ができません。<b>通常のブラウザで開いて</b>ください。</span><a href="${esc(u.href)}" target="_blank" rel="noopener"><button>ブラウザで開く</button></a>`);
  } else if (state.installPrompt) {
    showBanner(`<span>アプリとしてホーム画面に入れると次から1タップで開けます</span><button id="b-inst">インストール</button>${dismiss}`, 'info');
    $('#b-inst').onclick = async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; hideBanner(); };
  } else if (isIOS) {
    showBanner(`<span>Safariの <b>共有</b>（□↑）→「<b>ホーム画面に追加</b>」でアプリとして使えます</span>${dismiss}`, 'info');
  } else { hideBanner(); return; }
  const x = $('#b-x'); if (x) x.onclick = () => { save(LS.dismiss, Date.now()); hideBanner(); };
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; setupBanners(); });

// ---------- Dropbox 認証 ----------
const redirectUri = () => (location.origin + location.pathname).replace(/index\.html$/, '');

async function dbxLogin() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  save(LS.pkce, { verifier, tab: state.tab });
  const p = new URLSearchParams({ client_id: state.cfg.dropbox.appKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline', redirect_uri: redirectUri() });
  location.href = 'https://www.dropbox.com/oauth2/authorize?' + p.toString();
}
async function dbxHandleRedirect() {
  const q = new URLSearchParams(location.search); const code = q.get('code'); const pk = load(LS.pkce, null);
  if (!code || !pk) return false;
  localStorage.removeItem(LS.pkce);
  history.replaceState(null, '', redirectUri());
  try {
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, grant_type: 'authorization_code', code_verifier: pk.verifier, client_id: state.cfg.dropbox.appKey, redirect_uri: redirectUri() }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error_description || j.error || r.statusText);
    Object.assign(state.cfg.dropbox, { accessToken: j.access_token, refreshToken: j.refresh_token || state.cfg.dropbox.refreshToken, expiresAt: Date.now() + (j.expires_in - 60) * 1000 });
    state.revs = {}; persistMeta();
    try { await refreshAccountInfo(); } catch (e) { }
    state.tab = 'settings'; toast('Dropboxに接続しました。保存先フォルダを確認してください', 4000);
  } catch (e) { toast('Dropbox認証エラー：' + e.message, 5000); }
  return true;
}
/** アカウント情報を取り直し、チームスペース（Dropbox Business）のときはパスの基準をチームスペースにする */
async function refreshAccountInfo() {
  const a = await dbxRPC('users/get_current_account', null);
  const d = state.cfg.dropbox;
  d.account = (a.email || a.name?.display_name || '') + (a.team ? `（${a.team.name}）` : '');
  const ri = a.root_info || {};
  d.pathRoot = ri.root_namespace_id && ri.home_namespace_id && ri.root_namespace_id !== ri.home_namespace_id ? ri.root_namespace_id : '';
  persistMeta();
  return a;
}
async function ensureToken() {
  const d = state.cfg.dropbox;
  if (!d.refreshToken) throw new Error('Dropbox未接続');
  if (d.accessToken && Date.now() < d.expiresAt) return d.accessToken;
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: d.refreshToken, client_id: d.appKey }) });
  const j = await r.json(); if (!r.ok) { if (j.error === 'invalid_grant') { d.refreshToken = ''; persistMeta(); } throw new Error(j.error_description || j.error || '認証の更新に失敗'); }
  d.accessToken = j.access_token; d.expiresAt = Date.now() + (j.expires_in - 60) * 1000; persistMeta();
  return d.accessToken;
}
class DbxError extends Error { constructor(status, body) { let m = body; try { const j = JSON.parse(body); m = j.error_summary || j.error?.['.tag'] || body; } catch (e) { } super(`${status} ${m}`); this.status = status; this.body = body; } }
// 通信は差し替え可能にしておく（テスト用）
/** Dropbox Business のチームスペースにあるフォルダを使うときは、パスの基準をチームスペースにする */
const pathRootHeader = () => (state.cfg.dropbox.pathRoot ? { 'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', root: state.cfg.dropbox.pathRoot }) } : {});
const net = {
  async rpc(path, arg) {
    const token = await ensureToken();
    const r = await fetch('https://api.dropboxapi.com/2/' + path, { method: 'POST', headers: Object.assign({ Authorization: 'Bearer ' + token }, path.startsWith('files/') ? pathRootHeader() : {}, arg === null ? {} : { 'Content-Type': 'application/json' }), body: arg === null ? undefined : JSON.stringify(arg) });
    if (!r.ok) throw new DbxError(r.status, await r.text());
    return r.json();
  },
  async download(path) {
    const token = await ensureToken();
    const r = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: Object.assign({ Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': apiArg({ path }) }, pathRootHeader()) });
    if (r.status === 409) { const t = await r.text(); if (t.includes('not_found')) return null; throw new DbxError(409, t); }
    if (!r.ok) throw new DbxError(r.status, await r.text());
    const meta = JSON.parse(r.headers.get('dropbox-api-result') || '{}');
    return { text: await r.text(), rev: meta.rev };
  },
  async upload(path, text, mode) {
    const token = await ensureToken();
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': apiArg({ path, mode: mode || 'overwrite', autorename: false, mute: true }) }, pathRootHeader()), body: new Blob([text]) });
    if (!r.ok) throw new DbxError(r.status, await r.text());
    return r.json();
  },
};
const dbxRPC = (p, a) => net.rpc(p, a);
const dbxDownload = (p) => net.download(p);
const dbxUpload = (p, t, m) => net.upload(p, t, m);
async function dbxList(path) {
  try {
    let r = await dbxRPC('files/list_folder', { path, recursive: false });
    let entries = r.entries;
    while (r.has_more) { r = await dbxRPC('files/list_folder/continue', { cursor: r.cursor }); entries = entries.concat(r.entries); }
    return entries.filter((e) => e['.tag'] === 'file');
  } catch (e) { if (e.status === 409 && /not_found/.test(e.body)) return []; throw e; }
}

// ---------- 同期 ----------
let syncTimer, pollTimer;
function scheduleSync() { if (!state.cfg.dropbox.refreshToken) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(false), 1200); }

/** 共有文書1つの取込→必要なら送信（競合したら取り直して最大3回） */
async function syncDoc(key, base, metaList, errors) {
  const doc = DOCS[key];
  const path = `${base}/${doc.file}`; const k = path.toLowerCase();
  const meta = metaList.find((f) => f.path_lower === k);
  let rev = meta ? meta.rev : null;
  if (meta && state.revs[k] !== meta.rev) {
    try {
      const dl = await dbxDownload(path);
      if (dl) {
        const r = doc.merge(doc.get(), doc.validate(JSON.parse(dl.text)));
        if (r.changed) { doc.set(r.items); doc.persist(); stockCache = null; }
        state.revs[k] = dl.rev; rev = dl.rev; save(LS.revs, state.revs);
      }
    } catch (e) { errors.push(`${doc.file}: ${e.message}`); return; }
  }
  if (!meta || docPending(key)) {
    let uploaded = false;
    for (let attempt = 0; attempt < 3 && !uploaded; attempt++) {
      const text = docText(key);
      try {
        const up = await dbxUpload(path, text, rev ? { '.tag': 'update', update: rev } : 'add');
        state.revs[k] = up.rev; state.sent[key] = fingerprint(text); uploaded = true;
      } catch (e) {
        if (e.status === 409 && /conflict/.test(e.body)) {
          const dl = await dbxDownload(path);
          if (dl) { const r = doc.merge(doc.get(), doc.validate(JSON.parse(dl.text))); if (r.changed) { doc.set(r.items); doc.persist(); } rev = dl.rev; state.revs[k] = dl.rev; }
          continue;
        }
        throw e;
      }
    }
    if (!uploaded) throw new Error(`${doc.label}の送信が競合して失敗しました。しばらくしてから再同期してください`);
  }
}

/**
 * 同期の本体。戻り値 true = 取込・送信とも完了（エラーなし）。
 * 「同期済み」は「読込・検証・端末保存・必要な送信が全て完了し、未送信がない」ときだけ。
 */
async function syncNow(manual, quiet) {
  const d = state.cfg.dropbox;
  if (!d.refreshToken || state.sync.busy) return false;
  if (!navigator.onLine) { setSync('off'); return false; }
  state.sync.busy = true; setSync('busy');
  const errors = []; let got = 0;
  try {
    const base = basePath();
    reloadEventsFromStorage();
    // 1) 他端末の記録を取り込む（変更のあったファイルだけ。全件検証して通ったものだけ反映し、rev は保存成功後に進める）
    const files = await dbxList(base + '/events');
    for (const f of files) {
      if (state.revs[f.path_lower] === f.rev) continue;
      try {
        const dl = await dbxDownload(f.path_lower); if (!dl) continue;
        const arr = validateEvents(JSON.parse(dl.text));
        const m = mergeEvents(state.events, arr);
        if (m.added) { state.events = m.events; stockCache = null; persistEvents(); got += m.added; }
        state.revs[f.path_lower] = dl.rev; save(LS.revs, state.revs);
      } catch (e) { errors.push(`${f.name}: ${e.message}`); }
    }
    // 2) 共有文書（品目マスタ・入荷予定・共有設定）
    const metaList = await dbxList(base);
    for (const key of Object.keys(DOCS)) await syncDoc(key, base, metaList, errors);
    // 3) この端末の記録を書く（自分のファイルだけ）。送った内容の指紋を記録し、送信中に増えた分は未送信として残す
    const myPath = `${base}/events/${deviceId}.json`;
    const remoteMine = files.find((f) => f.path_lower === myPath.toLowerCase());
    if (eventsPending() || (!remoteMine && ownEvents().length)) {
      const text = ownText();
      const up = await dbxUpload(myPath, text, 'overwrite');
      state.revs[myPath.toLowerCase()] = up.rev; state.sent.events = fingerprint(text);
    }
    state.sent.base = base;
    // 4) 復元で持ち込んだ他端末の記録（復元ファイルとして送信。ファイル名は固定なので再試行しても重複しない）
    for (const rec of state.recovery.slice()) {
      const path = `${base}/events/${rec.name}`;
      const up = await dbxUpload(path, JSON.stringify(rec.events), 'overwrite');
      state.revs[path.toLowerCase()] = up.rev;
      state.recovery = state.recovery.filter((r) => r.id !== rec.id);
      writeLS(LS.recovery, state.recovery);
    }
    persistMeta();
    if (errors.length) { setSync('err', errors[0] + (errors.length > 1 ? ` 他${errors.length - 1}件` : '')); }
    else if (anyPending()) { setSync('pending'); scheduleSync(); }
    else setSync('ok');
    if (got) { if (!quiet) toast(`他の端末の記録 ${got}件 を取り込みました`); if (state.tab !== 'settings') render(); else updateHeader(); }
    else if (manual && !quiet) toast(errors.length ? '一部のファイルを取り込めませんでした：' + errors[0] : (state.sync.status === 'pending' ? '送信待ちがあります。もう一度同期します' : '最新の状態です'), errors.length ? 6000 : 2200);
    else if (!manual && state.tab !== 'settings' && !sheetOpen()) render();   // 入荷予定・マスタの変更を画面に反映
    return errors.length === 0 && state.sync.status === 'ok';
  } catch (e) {
    console.error(e); setSync('err', e.message); if (manual && !quiet) toast('同期エラー：' + e.message, 6000);
    return false;
  } finally { state.sync.busy = false; updateHeader(); }
}
function startPolling() {
  clearInterval(pollTimer);
  if (!state.cfg.dropbox.refreshToken) return;
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') syncNow(false); }, Math.max(10, state.cfg.pollSec) * 1000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { syncNow(false); navigator.serviceWorker?.getRegistration().then((r) => r && r.update()); } });
window.addEventListener('online', () => syncNow(false));
window.addEventListener('offline', () => setSync('off'));

// 招待リンク（#setup=...）の取り込み
function handleSetupLink() {
  const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)/); if (!m) return;
  history.replaceState(null, '', redirectUri());
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64url(m[1])));
    if (typeof p.appKey !== 'string' || typeof p.refreshToken !== 'string' || !p.appKey || !p.refreshToken) throw new Error('リンクの内容が不正です');
    if (state.cfg.dropbox.refreshToken && !confirm('すでにDropbox接続があります。招待リンクの設定で上書きしますか？')) return;
    const basePathNew = typeof p.basePath === 'string' && p.basePath.startsWith('/') ? p.basePath : state.cfg.dropbox.basePath;
    Object.assign(state.cfg.dropbox, { appKey: p.appKey, basePath: basePathNew, refreshToken: p.refreshToken, accessToken: '', expiresAt: 0, account: '', pathRoot: typeof p.pathRoot === 'string' ? p.pathRoot : '' });
    if (Array.isArray(p.users)) for (const u of p.users) if (typeof u === 'string' && u && u.length <= 50 && !state.users.includes(u)) state.users.push(u);
    if (typeof p.liffId === 'string') state.cfg.liffId = p.liffId; if (Number.isInteger(p.pollSec) && p.pollSec >= 10) state.cfg.pollSec = p.pollSec;
    state.revs = {}; persistMeta(); toast('共有設定を取り込みました', 3500);
    setTimeout(() => refreshAccountInfo().catch(() => { }).then(() => syncNow(true)), 300);   // アカウント名とチームスペースの判定も取り直す
  } catch (e) { toast('招待リンクの読み込みに失敗：' + e.message, 5000); }
}

// LINEミニアプリ（LIFF）：設定されていれば名前を自動取得
async function initLiff() {
  if (!state.cfg.liffId || !/\bLine\//i.test(navigator.userAgent)) return;
  try {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    await window.liff.init({ liffId: state.cfg.liffId });
    if (window.liff.isLoggedIn()) { const p = await window.liff.getProfile(); if (p.displayName && !state.cfg.user) { state.cfg.user = p.displayName; if (!state.users.includes(p.displayName)) state.users.push(p.displayName); persistMeta(); updateHeader(); } }
  } catch (e) { console.warn('LIFF init failed', e); }
}

// サービスワーカー（オフライン対応＋更新は「更新」ボタンを押したときだけ）
async function initSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    const track = (w) => { if (!w) return; w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) { state.swWaiting = w; setupBanners(); } }); };
    if (reg.waiting && navigator.serviceWorker.controller) { state.swWaiting = reg.waiting; setupBanners(); }
    track(reg.installing); reg.addEventListener('updatefound', () => track(reg.installing));
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      if (state.updateRequested) { reloading = true; location.reload(); return; }
      showBanner(`<span>アプリが更新されました。画面を読み込み直してください</span><button id="b-reload">再読込</button>`, 'info');
      $('#b-reload').onclick = () => { if (!sheetOpen() || confirm('入力画面が開いています。読み込み直しますか？')) location.reload(); };
    });
    setInterval(() => reg.update(), 30 * 60 * 1000);
  } catch (e) { console.warn('SW登録失敗', e); }
}

// ---------- 起動 ----------
(async function main() {
  handleSetupLink();
  await dbxHandleRedirect();
  render();
  setupBanners();
  initSW();
  initLiff();
  if (state.cfg.dropbox.refreshToken) { syncNow(false); startPolling(); }
})();

// デバッグ・検証用（tools/ の手順とブラウザのコンソールから使う）
window.ZK = { state, syncNow, computeStock, dbxRPC, dbxList, dbxDownload, dbxUpload, apiArg, net, addEvent, pendingSummary, eventsPending, masterPending, docPending, restoreBackup, deviceId, version: APP_VERSION, currentAlerts, DOCS };
})();
