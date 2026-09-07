// IndexedDB。端末の中だけにデータを置く。サーバーには何も送らない（AI呼び出しを除く）。

const NAME = 'moppara';
const VERSION = 1;

let _db = null;

/** ブラウザに「このデータを勝手に捨てないでくれ」と申請する。iOSは渋いが、通れば残る。 */
export async function requestPersist() {
  try {
    if (!navigator.storage?.persist) return { supported: false, persisted: false };
    const already = await navigator.storage.persisted?.();
    const persisted = already || await navigator.storage.persist();
    return { supported: true, persisted };
  } catch { return { supported: false, persisted: false }; }
}

/** 設定だけは localStorage にも写しておく。片方が飛んでももう片方から戻す。 */
const MIRROR = 'moppara-settings-backup';
export function mirrorSettings(v) {
  try { localStorage.setItem(MIRROR, JSON.stringify(v)); } catch { /* 容量超過などは黙って諦める */ }
}
export function readMirror() {
  try { return JSON.parse(localStorage.getItem(MIRROR) || 'null'); } catch { return null; }
}

export let storageError = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    // 別タブが古い版を掴んでいる・削除が保留中、といった場合 open は
    // onblocked のまま黙って止まる。放置すると起動が完了せず画面が空になる。
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      storageError = msg;
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('保存領域を開けませんでした（時間切れ）'), 2500);
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };

    const req = indexedDB.open(NAME, VERSION);
    req.onblocked = () => fail('ほかのタブでこのアプリが開いています。そちらを閉じてから開き直してください。');
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('meals')) {
        const s = db.createObjectStore('meals', { keyPath: 'id' });
        s.createIndex('day', 'day');
      }
      if (!db.objectStoreNames.contains('weights')) db.createObjectStore('weights', { keyPath: 'day' });
      if (!db.objectStoreNames.contains('activities')) {
        const s = db.createObjectStore('activities', { keyPath: 'id' });
        s.createIndex('day', 'day');
      }
      if (!db.objectStoreNames.contains('chat')) db.createObjectStore('chat', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('presets')) db.createObjectStore('presets', { keyPath: 'id' });
    };
    req.onsuccess = () => { _db = req.result; done(_db); };
    req.onerror = () => fail(req.error?.message || '保存領域を開けませんでした');
  });
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        if (req) { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }
        else t.oncomplete = () => resolve();
      })
  );
}

const put = (store, val) => tx(store, 'readwrite', (s) => s.put(val));
const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
const all = (store) => tx(store, 'readonly', (s) => s.getAll());
const one = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const byIndex = (store, index, key) =>
  tx(store, 'readonly', (s) => s.index(index).getAll(IDBKeyRange.only(key)));

// ---- kv（設定） ----
export const getKV = (k) => tx('kv', 'readonly', (s) => s.get(k));
export const setKV = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));

// ---- 食事 ----
export const putMeal = (m) => put('meals', m);
export const delMeal = (id) => del('meals', id);
export const mealsOf = (day) => byIndex('meals', 'day', day).then(sortByAt);
export const allMeals = () => all('meals').then(sortByAt);

// ---- 体重 ----
export const putWeight = (w) => put('weights', w);
export const delWeight = (day) => del('weights', day);
export const allWeights = () => all('weights').then((a) => a.sort((x, y) => x.day.localeCompare(y.day)));
export const weightOf = (day) => one('weights', day);

// ---- 運動 ----
export const putActivity = (a) => put('activities', a);
export const delActivity = (id) => del('activities', id);
export const activitiesOf = (day) => byIndex('activities', 'day', day).then(sortByAt);
export const allActivities = () => all('activities');

// ---- チャット ----
export const putChat = (m) => put('chat', m);
export const delChat = (id) => del('chat', id);
export const allChat = () => all('chat').then(sortByAt);
export async function trimChat(keep = 300) {
  const rows = await allChat();
  if (rows.length <= keep) return;
  for (const r of rows.slice(0, rows.length - keep)) await del('chat', r.id);
}

// ---- いつもの（プリセット） ----
export const putPreset = (p) => put('presets', p);
export const delPreset = (id) => del('presets', id);
export const allPresets = () =>
  all('presets').then((a) => a.sort((x, y) => (y.useCount || 0) - (x.useCount || 0)));

function sortByAt(rows) {
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// ---- まるごと出し入れ ----
export async function exportAll() {
  return {
    format: 'moppara-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: await getKV('settings'),
    meals: await all('meals'),
    weights: await all('weights'),
    activities: await all('activities'),
    presets: await all('presets'),
    chat: await all('chat'),
  };
}

export async function importAll(data, { replace = false } = {}) {
  if (!data || data.format !== 'moppara-export') throw new Error('この形式のファイルは読めません');
  if (replace) {
    const db = await open();
    for (const s of ['meals', 'weights', 'activities', 'presets', 'chat']) {
      await new Promise((res, rej) => {
        const t = db.transaction(s, 'readwrite');
        t.objectStore(s).clear();
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    }
  }
  if (data.settings) await setKV('settings', data.settings);
  for (const m of data.meals || []) await put('meals', m);
  for (const w of data.weights || []) await put('weights', w);
  for (const a of data.activities || []) await put('activities', a);
  for (const p of data.presets || []) await put('presets', p);
  for (const c of data.chat || []) await put('chat', c);
}

export async function wipeAll() {
  const db = await open();
  for (const s of ['meals', 'weights', 'activities', 'presets', 'chat', 'kv']) {
    await new Promise((res, rej) => {
      const t = db.transaction(s, 'readwrite');
      t.objectStore(s).clear();
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }
}
