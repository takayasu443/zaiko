/* CM農場 在庫アプリ  共通ロジック（画面に依存しない部分）
 * ブラウザでは window.ZKCore、Node では module.exports として使える。tools/test_core.js で単体テストする。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ZKCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const CATEGORIES = ['薬品', '飼料', '器具'];
  const LOCATIONS = ['事務所前', 'コンテナ左', 'コンテナ右', '冷蔵庫'];
  const EVENT_TYPES = ['in', 'out', 'set', 'void'];
  const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
  const isId = (v) => typeof v === 'string' && ID_RE.test(v);
  const isInt = (v) => Number.isSafeInteger(v);
  const isStr = (v, max) => typeof v === 'string' && v.length <= max;

  /** 文字列の指紋（FNV-1a 32bit + 長さ）。送信済み内容と現在値の比較に使う */
  function fingerprint(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0') + ':' + str.length;
  }

  /** 数量入力の検証。整数の文字列だけ受け付け、それ以外は例外 */
  function readQty(raw, type) {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) throw new Error('数量は整数で入力してください');
    const n = Number(raw.trim());
    const min = type === 'set' ? 0 : 1;
    if (!isInt(n) || n < min) throw new Error(type === 'set' ? '数量は0以上で入力してください' : '数量は1以上で入力してください');
    return n;
  }

  /** 記録ファイル全体を検証。1件でも不正なら全体を拒否する（部分反映しない） */
  function validateEvents(value) {
    if (!Array.isArray(value)) throw new Error('記録の形式が不正です（配列ではありません）');
    const seen = new Set();
    value.forEach((e, i) => {
      const bad = (why) => { throw new Error(`記録 ${i + 1}件目が不正です：${why}`); };
      if (!e || typeof e !== 'object') bad('空');
      if (!isId(e.id)) bad('ID');
      if (seen.has(e.id)) bad('ID重複 ' + e.id);
      if (!isId(e.dev)) bad('端末ID');
      if (!isInt(e.ts) || e.ts < 0) bad('日時');
      if (!EVENT_TYPES.includes(e.type)) bad('種類');
      if (!isInt(e.qty)) bad('数量');
      if (e.user != null && !isStr(e.user, 200)) bad('担当者');
      if (e.note != null && !isStr(e.note, 2000)) bad('メモ');
      if (e.name != null && !isStr(e.name, 300)) bad('品名');
      if (e.unit != null && !isStr(e.unit, 50)) bad('単位');
      if (e.type === 'void') { if (!isId(e.ref) || e.qty !== 0) bad('取消の参照先'); }
      else if (!isId(e.itemId) || e.qty < (e.type === 'set' ? 0 : 1)) bad('品目・数量');
      seen.add(e.id);
    });
    return value;
  }

  /** 品目マスタ全体を検証し、欠けている項目は既定値で補った新しい配列を返す */
  function validateItems(value) {
    if (!Array.isArray(value)) throw new Error('品目マスタの形式が不正です');
    const seen = new Set();
    return value.map((it, i) => {
      const bad = (why) => { throw new Error(`品目 ${i + 1}件目が不正です：${why}`); };
      if (!it || typeof it !== 'object') bad('空');
      if (!isId(it.id)) bad('ID');
      if (seen.has(it.id)) bad('ID重複 ' + it.id);
      seen.add(it.id);
      if (!isStr(it.name, 200) || !it.name) bad('品名');
      const str = (v, max, d) => (v == null ? d : (isStr(v, max) ? v : bad('文字項目')));
      const out = {
        id: it.id, name: it.name,
        spec: str(it.spec, 200, ''), unit: str(it.unit, 50, '個'),
        category: CATEGORIES.includes(it.category) ? it.category : bad('種別'),
        location: str(it.location, 50, LOCATIONS[0]), supplier: str(it.supplier, 100, ''), note: str(it.note, 500, ''),
        min: it.min == null ? 0 : (isInt(it.min) && it.min >= 0 ? it.min : bad('発注点')),
        active: it.active == null ? true : (typeof it.active === 'boolean' ? it.active : bad('使用中フラグ')),
        updatedAt: it.updatedAt == null ? 0 : (isInt(it.updatedAt) && it.updatedAt >= 0 ? it.updatedAt : bad('更新日時')),
      };
      return out;
    });
  }

  /** 全端末で同じ順になる並べ方（時刻→ID）。同時刻の棚卸と持出でも結果が揃う */
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function orderEvents(events) { return [...events].sort((a, b) => a.ts - b.ts || cmp(a.id, b.id)); }

  /** 在庫計算。取消された記録は除外。棚卸(set)はその時点で数量を置き換える */
  function computeStock(events) {
    const voided = new Set();
    for (const e of events) if (e.type === 'void' && e.ref) voided.add(e.ref);
    const stock = {};
    for (const e of orderEvents(events)) {
      if (e.type === 'void' || voided.has(e.id)) continue;
      const cur = stock[e.itemId] || 0;
      if (e.type === 'out') stock[e.itemId] = cur - e.qty;
      else if (e.type === 'in') stock[e.itemId] = cur + e.qty;
      else if (e.type === 'set') stock[e.itemId] = e.qty;
    }
    return { stock, voided };
  }

  /** 記録の統合（IDで重複排除）。新しい配列と追加件数を返す。元の配列は変更しない */
  function mergeEvents(local, remote) {
    const ids = new Set(local.map((e) => e.id));
    const added = [];
    for (const e of remote) if (!ids.has(e.id)) { ids.add(e.id); added.push(e); }
    return { events: added.length ? local.concat(added) : local, added: added.length };
  }

  /** 品目マスタの統合。updatedAt が新しい方を採用、同時刻なら内容(JSON)の大きい方で全端末一致させる */
  function mergeMaster(local, remote) {
    const byId = new Map(local.map((it) => [it.id, it]));
    let changed = false;
    for (const r of remote) {
      const l = byId.get(r.id);
      if (!l) { byId.set(r.id, r); changed = true; continue; }
      const lu = l.updatedAt || 0, ru = r.updatedAt || 0;
      const takeRemote = ru > lu || (ru === lu && JSON.stringify(r) > JSON.stringify(l));
      if (takeRemote && JSON.stringify(r) !== JSON.stringify(l)) { byId.set(r.id, r); changed = true; }
    }
    return { items: changed ? [...byId.values()] : local, changed };
  }

  /** Dropbox-API-Arg ヘッダ用：非ASCIIを \uXXXX に */
  const apiArg = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

  /** 発注候補テキスト（仕入先別） */
  function buildOrderText(low, stock, dateLabel) {
    const bySup = {};
    for (const it of low) (bySup[it.supplier || '（仕入先未設定）'] = bySup[it.supplier || '（仕入先未設定）'] || []).push(it);
    let t = `【発注候補】${dateLabel} CM農場 在庫アプリ\n`;
    for (const sup of Object.keys(bySup).sort()) {
      t += `\n■ ${sup}\n`;
      for (const it of bySup[sup]) t += `・${it.name}${it.spec ? '（' + it.spec + '）' : ''}  在庫${stock[it.id] || 0}${it.unit} / 発注点${it.min}  [${it.location}]\n`;
    }
    return t;
  }

  return { CATEGORIES, LOCATIONS, EVENT_TYPES, ID_RE, fingerprint, readQty, validateEvents, validateItems, orderEvents, computeStock, mergeEvents, mergeMaster, apiArg, b64url, unb64url, buildOrderText };
});
