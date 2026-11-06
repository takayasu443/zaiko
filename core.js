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
  /** 持ち出し先（ステージ）。「その他」のときだけ名前を入れる */
  const STAGES = ['交配舎', '分娩舎', '離乳舎', '肥育舎', '洗浄チーム', '水小屋（柴田）', 'その他'];
  const EXPECTED_STATUS = ['waiting', 'received', 'cancelled'];
  const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
  const DAY = 86400e3;
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
      if (e.stage != null && !isStr(e.stage, 50)) bad('持ち出し先');
      if (e.note != null && !isStr(e.note, 2000)) bad('メモ');
      if (e.name != null && !isStr(e.name, 300)) bad('品名');
      if (e.unit != null && !isStr(e.unit, 50)) bad('単位');
      if (e.expectedId != null && !isId(e.expectedId)) bad('入荷予定ID');
      if (e.type === 'void') { if (!isId(e.ref) || e.qty !== 0) bad('取消の参照先'); }
      else if (!isId(e.itemId) || e.qty < (e.type === 'set' ? 0 : 1)) bad('品目・数量');
      seen.add(e.id);
    });
    return value;
  }

  const strOr = (bad, v, max, d) => (v == null ? d : (isStr(v, max) ? v : bad('文字項目')));
  const intOr = (bad, v, d, why) => (v == null ? d : (isInt(v) && v >= 0 ? v : bad(why)));

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
      return {
        id: it.id, name: it.name,
        spec: strOr(bad, it.spec, 200, ''), unit: strOr(bad, it.unit, 50, '個'),
        category: CATEGORIES.includes(it.category) ? it.category : bad('種別'),
        location: strOr(bad, it.location, 50, LOCATIONS[0]), supplier: strOr(bad, it.supplier, 100, ''), note: strOr(bad, it.note, 500, ''),
        min: intOr(bad, it.min, 0, '発注点'),
        useDays: intOr(bad, it.useDays, 0, '使用間隔'),
        alertMutedUntil: intOr(bad, it.alertMutedUntil, 0, 'アラート解除日時'),
        active: it.active == null ? true : (typeof it.active === 'boolean' ? it.active : bad('使用中フラグ')),
        updatedAt: intOr(bad, it.updatedAt, 0, '更新日時'),
      };
    });
  }

  /** 入荷予定（受け入れ確認リスト）の検証 */
  function validateExpected(value) {
    if (!Array.isArray(value)) throw new Error('入荷予定の形式が不正です');
    const seen = new Set();
    return value.map((x, i) => {
      const bad = (why) => { throw new Error(`入荷予定 ${i + 1}件目が不正です：${why}`); };
      if (!x || typeof x !== 'object') bad('空');
      if (!isId(x.id)) bad('ID');
      if (seen.has(x.id)) bad('ID重複 ' + x.id);
      seen.add(x.id);
      if (x.itemId != null && x.itemId !== '' && !isId(x.itemId)) bad('品目ID');
      if (!isStr(x.name, 200) || !x.name) bad('品名');
      if (!isInt(x.qty) || x.qty < 1) bad('数量');
      return {
        id: x.id, itemId: x.itemId || '', name: x.name,
        spec: strOr(bad, x.spec, 200, ''), unit: strOr(bad, x.unit, 50, '個'), qty: x.qty,
        supplier: strOr(bad, x.supplier, 100, ''), location: strOr(bad, x.location, 50, ''),
        category: CATEGORIES.includes(x.category) ? x.category : '薬品',
        orderedAt: intOr(bad, x.orderedAt, 0, '発注日'), source: strOr(bad, x.source, 200, ''),
        status: EXPECTED_STATUS.includes(x.status) ? x.status : 'waiting',
        receivedAt: intOr(bad, x.receivedAt, 0, '入荷日'), receivedBy: strOr(bad, x.receivedBy, 200, ''),
        receivedEventId: x.receivedEventId == null || x.receivedEventId === '' ? '' : (isId(x.receivedEventId) ? x.receivedEventId : bad('入荷記録ID')),
        updatedAt: intOr(bad, x.updatedAt, 0, '更新日時'),
      };
    });
  }

  /** 共有設定（飼養頭数など） */
  function validateSettings(value) {
    const v = value && typeof value === 'object' ? value : {};
    const bad = (why) => { throw new Error('共有設定が不正です：' + why); };
    return { herd: intOr(bad, v.herd, 0, '飼養頭数'), updatedAt: intOr(bad, v.updatedAt, 0, '更新日時') };
  }

  /**
   * 入荷予定の進捗。qty は「発注数量」、受取済み数は入荷記録（expectedId 付き・取消除く）の合計から求める。
   * 予定側の status 更新に失敗したり2端末が同時に受け取っても、残数と在庫は記録から一意に決まる。
   */
  function expectedProgress(expected, events) {
    const { voided } = computeStock(events);
    const received = {};
    for (const e of events) if (e.type === 'in' && e.expectedId && !voided.has(e.id)) received[e.expectedId] = (received[e.expectedId] || 0) + e.qty;
    const out = {};
    for (const x of expected) { const r = received[x.id] || 0; out[x.id] = { received: r, remaining: Math.max(0, x.qty - r), done: r >= x.qty }; }
    return out;
  }
  /** 受取記録のID。同じ納品（同じ予定・同じ受取前数・同じ数量）なら端末が違っても同じIDになり、統合時に一度だけ数えられる */
  const receiptEventId = (expectedId, receivedBefore, qty) => `rx_${expectedId}_${receivedBefore}_${qty}`;

  /** 入荷済み・取消済みの古い予定は60日で落とす（全端末で同じ規則なので再出現しない） */
  function pruneExpected(list, now) {
    return list.filter((x) => x.status === 'waiting' || now - (x.updatedAt || 0) < 60 * DAY);
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

  /** ID付き文書（品目マスタ・入荷予定）の統合。updatedAt が新しい方を採用、同時刻なら内容(JSON)の大きい方で全端末一致させる */
  function mergeById(local, remote) {
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
  const mergeMaster = mergeById;

  /**
   * アラート計算（専務の要望）
   *  idle : 使うはずなのに動いていない（品目の「使用間隔の目安」日数を超えて持ち出しがない）
   *  over : 今週の持ち出しが過去の週平均の2倍以上（減りすぎ）
   *  under: 今週の持ち出しが過去の週平均の3割以下（使わな過ぎ）
   *  発注点以下(low)は在庫画面で別に表示。品目の alertMutedUntil までは出さない（「確認」ボタンで解除）
   */
  function computeAlerts(items, events, now) {
    const { stock, voided } = computeStock(events);
    const lastOut = {}, firstTs = {}, outs = {};
    for (const e of events) {
      if (e.type === 'void' || voided.has(e.id)) continue;
      if (!firstTs[e.itemId] || e.ts < firstTs[e.itemId]) firstTs[e.itemId] = e.ts;
      if (e.type === 'out') { (outs[e.itemId] = outs[e.itemId] || []).push(e); if (!lastOut[e.itemId] || e.ts > lastOut[e.itemId]) lastOut[e.itemId] = e.ts; }
    }
    const alerts = [];
    for (const it of items) {
      if (it.active === false || (it.alertMutedUntil || 0) > now) continue;
      const s = stock[it.id] || 0;
      if (it.useDays > 0 && s > 0) {
        const last = lastOut[it.id] || firstTs[it.id];
        if (last && now - last > it.useDays * DAY) {
          alerts.push({ itemId: it.id, kind: 'idle', text: `${Math.floor((now - last) / DAY)}日間 持ち出しがありません（目安 ${it.useDays}日ごと）` });
          continue;
        }
      }
      const f = firstTs[it.id]; const list = outs[it.id] || [];
      if (!f || now - f < 28 * DAY || !list.length) continue;
      const weekStart = now - 7 * DAY;
      const baseWeeks = Math.min(8, Math.floor((weekStart - f) / (7 * DAY)));
      if (baseWeeks < 3) continue;
      const baseStart = weekStart - baseWeeks * 7 * DAY;
      let recent = 0, base = 0;
      for (const e of list) { if (e.ts >= weekStart) recent += e.qty; else if (e.ts >= baseStart) base += e.qty; }
      const avg = base / baseWeeks;
      if (avg >= 1 && recent >= 3 && recent >= 2 * avg) alerts.push({ itemId: it.id, kind: 'over', text: `今週の持ち出し ${recent}${it.unit} が週平均 ${avg.toFixed(1)}${it.unit} の2倍以上です（減りすぎ）` });
      else if (avg >= 2 && recent <= 0.3 * avg) alerts.push({ itemId: it.id, kind: 'under', text: `今週の持ち出し ${recent}${it.unit} が週平均 ${avg.toFixed(1)}${it.unit} より大きく少ないです（使わな過ぎ）` });
    }
    return alerts;
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

  return { CATEGORIES, LOCATIONS, EVENT_TYPES, STAGES, EXPECTED_STATUS, ID_RE, DAY, fingerprint, readQty, validateEvents, validateItems, validateExpected, validateSettings, pruneExpected, orderEvents, computeStock, mergeEvents, mergeById, mergeMaster, computeAlerts, expectedProgress, receiptEventId, apiArg, b64url, unb64url, buildOrderText };
});
