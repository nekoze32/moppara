// チャット。ここが全ての入口：写真・一言の記録も、体重も、運動も、相談も。
// 推定の伝票は DOM でなく DB に持つ（開き直すと消えて「記録済みに見える」ため）。

import { $, el, uid, toast, undoToast, shrinkImage, sumItems, fmt, r1 } from '../util.js';
import * as db from '../db.js';
import { state, refresh, currentDay, targetDay, goToday, recentDays, recentMeals, hasKey, applySetup, noteRecord } from '../store.js';
import { ask, AIError } from '../ai.js';
import { contextBlock } from '../prompts.js';

let logEl, inputEl, sendBtn, chipsEl, previewEl, previewImg;
let attached = null;
let busy = false;
let goTab = () => {};
let openMealInToday = () => {};

export function mount({ navigate, editMeal }) {
  goTab = navigate;
  openMealInToday = editMeal || (() => navigate('today'));
  logEl = $('#chat-log');
  inputEl = $('#chat-input');
  sendBtn = $('#send-btn');
  chipsEl = $('#chips');
  previewEl = $('#attach-preview');
  previewImg = $('#attach-img');

  $('#photo-input').addEventListener('change', onPickPhoto);
  $('#attach-clear').addEventListener('click', clearAttachment);
  sendBtn.addEventListener('click', send);

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  });

  // 入力中にログ側を触ったら、キーボードを閉じる（欄の外＝終えたい意図）
  logEl.addEventListener('pointerdown', () => {
    if (document.activeElement === inputEl) inputEl.blur();
  }, { passive: true });

  restore();
  renderChips();
  paintDayNotice();
}

export function onDataChanged() { renderChips(); paintDayNotice(); }

/** 過去日を見ているときだけ、書き込み先を頭に出す。黙って昨日に入るのは事故のもと。 */
function paintDayNotice() {
  let n = $('#chat-daynotice');
  if (state.isToday) { n?.remove(); return; }
  if (!n) {
    n = el('div', { class: 'daynotice', id: 'chat-daynotice' });
    logEl.parentElement.insertBefore(n, logEl);
  }
  n.textContent = '';
  n.append(`${jpDateFull(state.today)} に記録します`,
    el('button', { class: 'btn sm', style: 'margin-left:10px', onclick: () => goToday() }, '今日に戻る'));
}
const jpDateFull = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${m}/${dd}`; };

// ---------------------------------------------------------------- 履歴

async function restore() {
  const rows = (await db.allChat()).slice(-60);
  logEl.textContent = '';
  if (!rows.length) { greet(); return; }
  let lastDay = '';
  for (const r of rows) {
    const day = r.at.slice(0, 10);
    if (day !== lastDay) { logEl.append(el('div', { class: 'msg sys' }, dayLabel(day))); lastDay = day; }
    if (r.role === 'user') logEl.append(userBubble(r.text, r.thumb));
    else if (r.role === 'proposal') logEl.append(proposeCard(r));   // 未確定も確定済みも復元する
    else logEl.append(el('div', { class: 'msg ai' }, r.text));
  }
  scrollDown();
}

function dayLabel(iso) {
  const d = new Date(iso + 'T00:00:00');
  const t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, t)) return '今日';
  const y = new Date(t); y.setDate(y.getDate() - 1);
  if (same(d, y)) return '昨日';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function greet() {
  const lines = state.ready
    ? ['こんにちは。食べたものを写真か一言で送ってください。', '',
       '  ・写真を撮る（撮ればそのまま解析します）',
       '  ・「かけそばとおにぎり1個」',
       '  ・「体重72.4」「30分走った」',
       '  ・「今夜の外食どこがいい？」', '',
       'よく食べるものは、下のボタンから1タップで入ります。']
    : ['はじめまして。', '',
       '1日にどれくらい食べていいかを出したいので、先に2つだけ教えてください。', '',
       '身長と、いまの体重はどれくらいですか。'];
  logEl.append(el('div', { class: 'msg ai' }, lines.join(String.fromCharCode(10))));
}

// ---------------------------------------------------------------- 入力

async function onPickPhoto(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const dataUrl = await shrinkImage(file, 800, 0.72);
    // 撮ったらそのまま解析する。「送信」を挟むと1タップ増えるだけ。
    clearAttachment();
    await sendWith('', dataUrl);
  } catch (err) {
    toast(err.message || '写真を読めませんでした');
  }
}

function clearAttachment() {
  attached = null;
  previewEl.hidden = true;
  previewImg.removeAttribute('src');
}

async function renderChips() {
  chipsEl.textContent = '';
  if (!state.ready) return;

  // 一度食べたものは、AIを通さず1タップで入れ直せるようにする。
  const recents = await recentMeals(8);
  for (const r of recents) {
    const t = sumItems(r.items);
    chipsEl.append(el('button', { class: 'chip again', onclick: () => logAgain(r) },
      el('b', {}, shorten(r.label)), ` ${fmt(t.kcal)}`));
  }
  if (!state.weight) {
    chipsEl.append(el('button', { class: 'chip', onclick: () => { inputEl.value = '体重 '; inputEl.focus(); } }, '体重'));
  }
  chipsEl.append(el('button', {
    class: 'chip',
    onclick: () => { inputEl.value = state.eaten.kcal > 0 ? '残りで何が食べられる？' : '今日の食事プランを立てて'; send(); },
  }, state.eaten.kcal > 0 ? '残りで何が食べられる？' : '今日のプラン'));
}

const shorten = (s, n = 14) => (s.length > n ? s.slice(0, n) + '…' : s);

async function logAgain(r) {
  const id = uid();
  await db.putMeal({
    id, day: targetDay(), at: stampFor(targetDay()),
    slot: slotNow(), items: structuredClone(r.items), source: 'again',
  });
  noteRecord(r.label, sumItems(r.items).kcal, sumItems(r.items).p);
  await refresh();
  const t = sumItems(r.items);
  logEl.append(el('div', { class: 'msg sys' },
    `${r.label} ${fmt(t.kcal)}kcal を記録（残り ${fmt(state.budget.budget - state.eaten.kcal)}）`));
  scrollDown();
  undoToast(`${shorten(r.label)} を記録しました`, async () => { await db.delMeal(id); await refresh(); });
}

let pendingSlot = null;   // 「今日」の各区分の＋から来たときだけ効く

/** 今日タブの「＋ 朝を記録」などから呼ぶ。次の1件だけこの区分にする。 */
export function reserveSlot(slot) { pendingSlot = slot; }
function takeSlot() { const s = pendingSlot; pendingSlot = null; return s; }
const slotByHour = () => { const h = new Date().getHours(); return h < 10 ? '朝' : h < 15 ? '昼' : h < 22 ? '夜' : '間食'; };
export function slotNow() { return takeSlot() || slotByHour(); }

/** 過去日へ書くときは、その日の同じ時刻にする（時刻順の並びを崩さない）。 */
function stampFor(day) {
  const now = new Date();
  if (day === currentDay()) return now.toISOString();
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds()).toISOString();
}

// ---------------------------------------------------------------- 送信

async function send() {
  const text = inputEl.value.trim();
  if (!text && !attached) return;
  const img = attached?.dataUrl || null;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  clearAttachment();
  await sendWith(text, img);
}

async function sendWith(text, img) {
  if (busy) return;
  if (!hasKey()) {
    logEl.append(el('div', { class: 'msg err' }, 'APIキーがまだ設定されていません。設定タブで入れてください。'));
    scrollDown();
    goTab('settings');
    return;
  }
  const thumb = img ? await thumbnail(img) : null;
  logEl.append(userBubble(text, thumb));
  scrollDown();
  await db.putChat({ id: uid(), at: new Date().toISOString(), role: 'user', text: text || '（写真）', thumb });
  await deliver(text, img, thumb);
}

async function deliver(text, img, thumb = null) {
  const at = new Date().toISOString();
  setBusy(true);

  const label = el('span', {}, img ? ' 写真を見ています' : ' 考えています');
  const thinking = el('div', { class: 'msg ai thinking' },
    el('span', { class: 'dots', html: '<span></span><span></span><span></span>' }), label);
  logEl.append(thinking);
  scrollDown();

  try {
    const recent = await recentDays(14);
    const context = contextBlock({ presets: state.presets, recent });
    const history = (await db.allChat()).slice(-9, -1)
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({ role: r.role, text: r.text }));

    const out = await ask({
      settings: state.settings, context, history, text, imageDataUrl: img,
      onRetry: ({ attempt, of, status, wait }) => {
        label.textContent = status === 429
          ? ` 立て込んでいます。${Math.round(wait / 1000)}秒待って${attempt + 1}回目（全${of}回）`
          : ` 向こうが混み合っています。やり直し中 ${attempt + 1}/${of}`;
        scrollDown();
      },
    });
    thinking.remove();

    const side = [];
    const wasReady = state.ready;
    const got = await applySetup(out.setup);
    if (got.length) side.push(`${got.join('・')}を登録`);
    if (out.weight) {
      await db.putWeight({ day: targetDay(), kg: out.weight.kg, fatPct: out.weight.fatPct, at: stampFor(targetDay()) });
      side.push(`体重 ${out.weight.kg}kg を記録`);
    }
    if (out.activity) {
      await db.putActivity({ id: uid(), day: targetDay(), at: stampFor(targetDay()), name: out.activity.name, kcal: out.activity.kcal, minutes: out.activity.minutes });
      side.push(`${out.activity.name} ${fmt(out.activity.kcal)}kcal を記録`);
    }
    if (side.length || out.weight || out.activity || got.length) await refresh();

    if (out.reply) {
      logEl.append(el('div', { class: 'msg ai' }, out.reply));
      await db.putChat({ id: uid(), at: new Date().toISOString(), role: 'assistant', text: out.reply });
    }
    if (side.length) logEl.append(el('div', { class: 'msg sys' }, side.join(' / ')));

    if (!wasReady && state.ready) {
      const t = state.targets, b = state.budget;
      const msg = ['これで計算できます。', '', `1日の上限　${fmt(b.budget)} kcal`,
        `P ${t.p}g　F ${t.f}g　C ${t.c}g`, '',
        '写真か一言を送れば記録します。上の帯にいつでも残りが出ます。'].join(String.fromCharCode(10));
      logEl.append(el('div', { class: 'msg ai' }, msg));
      await db.putChat({ id: uid(), at: new Date().toISOString(), role: 'assistant', text: msg });
    }

    if (out.meal) {
      // 「＋ 夜」から来たなら、その区分を優先する（AIは時刻から推測しているだけ）
      const reserved = takeSlot();
      if (reserved) out.meal.slot = reserved;
      // DOMだけに置くと開き直したとき消えて「記録済み」に見える。DBに持つ。
      const row = {
        id: uid(), at: new Date().toISOString(), role: 'proposal',
        text: '', status: 'pending', meal: out.meal, thumb, mealId: null,
      };
      await db.putChat(row);
      logEl.append(proposeCard(row));
    }

    await db.trimChat(300);
    scrollDown();
  } catch (err) {
    thinking.remove();
    const msg = err instanceof AIError ? err.message
      : err.name === 'TypeError' ? '通信できませんでした。電波を確認してください。'
      : err.message || '不明なエラーです。';
    const again = el('button', { class: 'btn sm', style: 'margin-top:8px' }, 'もう一度送る');
    const box = el('div', { class: 'msg err' }, msg, el('div', {}, again));
    again.addEventListener('click', () => { box.remove(); deliver(text, img, thumb); });
    logEl.append(box);
    scrollDown();
  } finally {
    setBusy(false);
  }
}

function setBusy(b) { busy = b; sendBtn.disabled = b; }

function userBubble(text, thumb) {
  const n = el('div', { class: 'msg user' });
  if (thumb) n.append(el('img', { src: thumb, alt: '送った写真' }));
  if (text) n.append(document.createTextNode(text));
  return n;
}

// 下寄せを justify-content に頼らなくなったので、開いた直後は自分で下端へ送る。
// フォントや写真で高さが後から変わるため、数回に分けて送る。
function scrollDown() {
  const go = () => { logEl.scrollTop = logEl.scrollHeight; };
  requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
  setTimeout(go, 80);
  setTimeout(go, 320);
}

async function thumbnail(dataUrl, px = 220) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, px / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      res(cv.toDataURL('image/jpeg', 0.65));
    };
    img.onerror = () => res(null);
    img.src = dataUrl;
  });
}

// ---------------------------------------------------------------- 推定の伝票

/** row は DB のチャット行（role:'proposal'）。状態で見た目が変わる。 */
function proposeCard(row) {
  if (row.status === 'saved') return savedCard(row);
  if (row.status === 'cancelled') return el('div', { class: 'msg sys' }, '記録しませんでした');

  const meal = row.meal;
  const items = meal.items.map((i) => ({ ...i, b: { kcal: i.kcal || 1, p: i.p, f: i.f, c: i.c } }));
  const card = el('div', { class: 'propose' });

  // 写真があれば上いっぱいに。kcalは写真の上に載せる
  const badge = el('b');
  if (row.thumb) {
    const pic = el('div', { class: 'pic' }, badge);
    pic.style.backgroundImage = `url(${row.thumb})`;
    card.append(pic);
  }

  const slot = el('select', { style: 'width:auto;padding:4px 8px;font-size:13px;border-radius:9px' },
    ...['朝', '昼', '夜', '間食'].map((s) => el('option', { value: s, selected: s === meal.slot }, s)));

  card.append(el('div', { class: 'p-head' },
    el('span', { class: 'p-title' }, '記録しますか'),
    el('span', { style: 'display:flex;gap:6px;align-items:center' }, slot,
      el('span', { class: `p-conf ${meal.confidence === 'low' ? 'low' : ''}` },
        meal.confidence === 'high' ? '確度 高' : meal.confidence === 'low' ? '確度 低' : '確度 中'))));

  const totalRow = el('div', { class: 'p-macros' });
  const recalc = () => {
    const t = sumItems(items.filter((i) => !i.removed));
    badge.textContent = `${fmt(t.kcal)} kcal`;
    totalRow.textContent = '';
    totalRow.append(el('b', {}, `${fmt(t.kcal)} kcal`), ` ／ P ${r1(t.p)}g　F ${r1(t.f)}g　C ${r1(t.c)}g`);
  };

  const scaleTo = (it, v) => {
    const k = Math.max(0, v) / (it.b.kcal || 1);
    it.kcal = Math.max(0, Math.round(v));
    it.p = Math.round(it.b.p * k * 10) / 10;
    it.f = Math.round(it.b.f * k * 10) / 10;
    it.c = Math.round(it.b.c * k * 10) / 10;
  };

  const rows = el('div', { class: 'p-body' });
  const drawRows = () => {
    rows.textContent = '';
    for (const it of items) {
      if (it.removed) continue;
      // 量は指で刻む。1回で元の25%（半分残したなら2回）
      const step = Math.max(10, Math.round(it.b.kcal * 0.25));
      const inp = el('input', { type: 'number', inputmode: 'numeric', value: String(it.kcal), min: '0' });
      inp.addEventListener('input', () => { scaleTo(it, Number(inp.value) || 0); recalc(); });
      const dec = el('button', { onclick: () => { scaleTo(it, it.kcal - step); inp.value = String(it.kcal); recalc(); } }, '−');
      const inc = el('button', { onclick: () => { scaleTo(it, it.kcal + step); inp.value = String(it.kcal); recalc(); } }, '＋');
      rows.append(el('div', { class: 'p-item' },
        el('div', { class: 'n' }, it.name, it.amount ? el('small', {}, it.amount) : null,
          el('div', { class: 'p-mul' },
            el('button', { class: 'mul del', onclick: () => { it.removed = true; drawRows(); recalc(); } }, '外す'))),
        el('div', { class: 'stp' }, dec, inp, inc)));
    }
  };
  drawRows();
  card.append(rows, totalRow);
  recalc();

  if (meal.assumptions?.length) card.append(el('div', { class: 'p-assume' }, '仮定：' + meal.assumptions.join(' / ')));

  const actions = el('div', { class: 'p-actions' });
  actions.append(
    el('button', {
      class: 'btn ghost',
      onclick: async () => { await db.putChat({ ...row, status: 'cancelled' }); card.replaceWith(el('div', { class: 'msg sys' }, '記録しませんでした')); },
    }, 'やめる'),
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        const kept = items.filter((i) => !i.removed).map(({ name, amount, kcal, p, f, c }) => ({ name, amount, kcal, p, f, c }));
        if (!kept.length) { toast('品目が残っていません'); return; }
        const mealId = uid();
        await db.putMeal({
          id: mealId, day: targetDay(), at: stampFor(targetDay()),
          slot: slot.value, items: kept, thumb: row.thumb || null, source: row.thumb ? 'photo' : 'text',
        });
        const saved = { ...row, status: 'saved', mealId, meal: { ...meal, slot: slot.value, items: kept } };
        await db.putChat(saved);
        noteRecord(kept.map((i) => i.name).join('・'), sumItems(kept).kcal, sumItems(kept).p);
        await refresh();
        card.replaceWith(savedCard(saved));
        toast('記録しました');
      },
    }, '記録する'));
  card.append(actions);
  return card;
}

/** 記録済み。ここでは数字を触らせない（触れてもDBは変わらないため）。 */
function savedCard(row) {
  const t = sumItems(row.meal.items);
  const card = el('div', { class: 'propose done' });
  if (row.thumb) {
    const pic = el('div', { class: 'pic' }, el('b', {}, `${fmt(t.kcal)} kcal`));
    pic.style.backgroundImage = `url(${row.thumb})`;
    card.append(pic);
  }
  card.append(el('div', { class: 'p-head' },
    el('span', { class: 'p-title' }, `記録済み　${row.meal.slot}`),
    el('span', { class: 'p-conf' }, `${fmt(t.kcal)} kcal`)));
  card.append(el('div', { class: 'p-saved' },
    row.meal.items.map((i) => `${i.name}${i.amount ? `（${i.amount}）` : ''}`).join('・')));
  card.append(el('div', { class: 'p-macros' }, `P ${r1(t.p)}g　F ${r1(t.f)}g　C ${r1(t.c)}g`));
  card.append(el('div', { class: 'p-actions' },
    el('button', { class: 'btn ghost sm', onclick: () => openMealInToday(row.mealId) }, '直す'),
    el('button', { class: 'btn ghost sm', onclick: () => savePreset(row.meal.items) }, 'いつもの に登録')));
  return card;
}

async function savePreset(items) {
  const suggested = items.map((i) => i.name).join('と');
  const name = prompt('「いつもの◯◯」の◯◯にあたる名前を入れてください', suggested);
  if (!name) return;
  const existing = (await db.allPresets()).find((p) => p.name === name);
  await db.putPreset({
    id: existing?.id || uid(), name,
    items: items.map(({ name: n, amount, kcal, p, f, c }) => ({ name: n, amount, kcal, p, f, c })),
    useCount: (existing?.useCount || 0) + 1, updatedAt: new Date().toISOString(),
  });
  await refresh();
  toast('いつもの に登録しました');
}
