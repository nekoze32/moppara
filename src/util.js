// 小道具。日付・数値・DOM。

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

// ---- 日付（ローカル時刻ベース。UTCに寄せない） ----
export function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
const WD = ['日', '月', '火', '水', '木', '金', '土'];
export function jpDate(s) {
  const d = parseYmd(s);
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}
export function hhmm(iso) {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function daysBetween(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

// 何時までを「その日」とみなすか。深夜の食事を前日に付ける（既定 4時）
export function mealDay(dt = new Date(), cutoffHour = 4) {
  const d = new Date(dt);
  if (d.getHours() < cutoffHour) d.setDate(d.getDate() - 1);
  return ymd(d);
}

// ---- 数値 ----
export const r0 = (n) => Math.round(Number(n) || 0);
export const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const fmt = (n) => r0(n).toLocaleString('ja-JP');

// 食事の合計
export function sumItems(items = []) {
  return items.reduce(
    (a, it) => ({
      kcal: a.kcal + (Number(it.kcal) || 0),
      p: a.p + (Number(it.p) || 0),
      f: a.f + (Number(it.f) || 0),
      c: a.c + (Number(it.c) || 0),
    }),
    { kcal: 0, p: 0, f: 0, c: 0 }
  );
}
export function sumMeals(meals = []) {
  return meals.reduce(
    (a, m) => {
      const s = sumItems(m.items);
      return { kcal: a.kcal + s.kcal, p: a.p + s.p, f: a.f + s.f, c: a.c + s.c };
    },
    { kcal: 0, p: 0, f: 0, c: 0 }
  );
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- 写真 ----
// 長辺を maxPx に縮めて JPEG 化する。APIに送るトークン量と保存容量の両方が効く。
export function shrinkImage(file, maxPx = 800, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('写真を読めませんでした'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('写真を読めませんでした'));
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
export function dataUrlParts(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

let toastTimer = null;
export function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
