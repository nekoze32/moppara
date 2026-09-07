// チャット。ここが全ての入口：写真・一言の記録も、体重も、運動も、相談も。

import { $, el, uid, toast, shrinkImage, sumItems, fmt, r1 } from '../util.js';
import * as db from '../db.js';
import { state, refresh, currentDay, recentDays, hasKey } from '../store.js';
import { ask, AIError } from '../ai.js';
import { contextBlock } from '../prompts.js';

let logEl, inputEl, sendBtn, chipsEl, previewEl, previewImg;
let attached = null;   // {dataUrl}
let busy = false;
let goTab = () => {};

export function mount({ navigate }) {
  goTab = navigate;
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

  restore();
  renderChips();
}

export function onDataChanged() {
  renderChips();
}

// ---------------------------------------------------------------- 履歴

async function restore() {
  const rows = (await db.allChat()).slice(-60);
  logEl.textContent = '';
  if (!rows.length) {
    greet();
    return;
  }
  let lastDay = '';
  for (const r of rows) {
    const day = r.at.slice(0, 10);
    if (day !== lastDay) { logEl.append(el('div', { class: 'msg sys' }, dayLabel(day))); lastDay = day; }
    if (r.role === 'user') logEl.append(userBubble(r.text, r.thumb));
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
  const lines = [
    'こんにちは。食べたものを写真か一言で送ってください。',
    '',
    '  ・写真を撮る（カメラのボタン）',
    '  ・「かけそばとおにぎり1個」',
    '  ・「体重72.4」「30分走った」',
    '  ・「今夜の外食どこがいい？」',
    '',
    'どれもこの入力欄で受け付けます。',
  ];
  logEl.append(el('div', { class: 'msg ai' }, lines.join('\n')));
}

// ---------------------------------------------------------------- 入力

async function onPickPhoto(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const dataUrl = await shrinkImage(file, 800, 0.72);
    attached = { dataUrl };
    previewImg.src = dataUrl;
    previewEl.hidden = false;
    inputEl.focus();
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
  const chips = [];
  for (const p of (state.presets || []).slice(0, 3)) chips.push(`いつもの${p.name}`);
  if (!state.weight) chips.push('体重を記録');
  chips.push(state.eaten.kcal > 0 ? '残りで何が食べられる？' : '今日の食事プランを立てて');
  for (const c of chips) {
    chipsEl.append(el('button', { class: 'chip', onclick: () => quick(c) }, c));
  }
}

function quick(label) {
  if (label === '体重を記録') { inputEl.value = '体重 '; inputEl.focus(); return; }
  inputEl.value = label;
  send();
}

// ---------------------------------------------------------------- 送信

async function send() {
  if (busy) return;
  const text = inputEl.value.trim();
  if (!text && !attached) return;

  if (!hasKey()) {
    logEl.append(el('div', { class: 'msg err' }, 'APIキーがまだ設定されていません。設定タブで入れてください。'));
    scrollDown();
    goTab('settings');
    return;
  }

  const img = attached?.dataUrl || null;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  clearAttachment();

  const thumb = img ? await thumbnail(img) : null;
  logEl.append(userBubble(text, thumb));
  scrollDown();
  await db.putChat({ id: uid(), at: new Date().toISOString(), role: 'user', text: text || '（写真）', thumb });

  await deliver(text, img);
}

/** 送信の本体。失敗しても同じ引数で呼び直せるようにしてある。 */
async function deliver(text, img) {
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
    const history = (await db.allChat()).slice(-9, -1).map((r) => ({ role: r.role, text: r.text }));

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

    // 体重・運動は迷いようがないのでその場で入れる
    const side = [];
    if (out.weight) {
      await db.putWeight({ day: currentDay(), kg: out.weight.kg, fatPct: out.weight.fatPct, at });
      side.push(`体重 ${out.weight.kg}kg を記録`);
    }
    if (out.activity) {
      await db.putActivity({ id: uid(), day: currentDay(), at, name: out.activity.name, kcal: out.activity.kcal, minutes: out.activity.minutes });
      side.push(`${out.activity.name} ${fmt(out.activity.kcal)}kcal を記録`);
    }
    if (side.length) await refresh();

    if (out.reply) {
      logEl.append(el('div', { class: 'msg ai' }, out.reply));
      await db.putChat({ id: uid(), at: new Date().toISOString(), role: 'assistant', text: out.reply });
    }
    if (side.length) logEl.append(el('div', { class: 'msg sys' }, side.join(' / ')));

    if (out.meal) logEl.append(proposeCard(out.meal, { thumb: img ? await thumbnail(img) : null, fromPhoto: !!img }));

    await db.trimChat(300);
    scrollDown();
  } catch (err) {
    thinking.remove();
    const msg = err instanceof AIError ? err.message
      : err.name === 'TypeError' ? '通信できませんでした。電波を確認してください。'
      : err.message || '不明なエラーです。';
    // 打ち直させない。同じ内容をそのまま送り直せるようにする。
    const again = el('button', { class: 'btn sm', style: 'margin-top:8px' }, 'もう一度送る');
    const box = el('div', { class: 'msg err' }, msg, el('div', {}, again));
    again.addEventListener('click', () => { box.remove(); deliver(text, img); });
    logEl.append(box);
    scrollDown();
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  busy = b;
  sendBtn.disabled = b;
}

function userBubble(text, thumb) {
  const n = el('div', { class: 'msg user' });
  if (thumb) n.append(el('img', { src: thumb, alt: '送った写真' }));
  if (text) n.append(document.createTextNode(text));
  return n;
}

function scrollDown() {
  requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; });
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

// ---------------------------------------------------------------- 記録の確認カード

function proposeCard(meal, { thumb = null, fromPhoto = false } = {}) {
  const items = meal.items.map((i) => ({ ...i, baseKcal: i.kcal || 1, baseP: i.p, baseF: i.f, baseC: i.c }));
  const card = el('div', { class: 'propose' });

  const totalRow = el('div', { class: 'p-macros' });
  const kcalOut = el('b');

  function recalc() {
    const t = sumItems(items);
    kcalOut.textContent = `${fmt(t.kcal)} kcal`;
    totalRow.textContent = '';
    totalRow.append(kcalOut, ` ／ P ${r1(t.p)}g　F ${r1(t.f)}g　C ${r1(t.c)}g`);
  }

  const slotSel = el('select', { style: 'width:auto;padding:3px 7px;font-size:13px;border-radius:8px' },
    ...['朝', '昼', '夜', '間食'].map((s) => el('option', { value: s, selected: s === meal.slot }, s)));

  card.append(el('div', { class: 'p-head' },
    el('div', { class: 'p-title' }, '記録しますか'),
    el('div', { style: 'display:flex;gap:6px;align-items:center' },
      slotSel,
      el('span', { class: `p-conf ${meal.confidence === 'low' ? 'low' : ''}` },
        meal.confidence === 'high' ? '推定：高' : meal.confidence === 'low' ? '推定：粗い' : '推定：中'))
  ));

  items.forEach((it, idx) => {
    const input = el('input', { type: 'number', inputmode: 'numeric', value: String(it.kcal), min: '0', step: '10' });
    input.addEventListener('input', () => {
      const v = Math.max(0, Number(input.value) || 0);
      const ratio = v / (it.baseKcal || 1);
      it.kcal = v;
      it.p = Math.round(it.baseP * ratio * 10) / 10;
      it.f = Math.round(it.baseF * ratio * 10) / 10;
      it.c = Math.round(it.baseC * ratio * 10) / 10;
      recalc();
    });
    card.append(el('div', { class: 'p-item' },
      el('div', { class: 'n' }, it.name, it.amount ? el('small', {}, it.amount) : null),
      input));
    void idx;
  });

  card.append(totalRow);
  recalc();

  if (meal.assumptions?.length) {
    card.append(el('div', { class: 'p-assume' }, '仮定：' + meal.assumptions.join(' / ')));
  }

  const actions = el('div', { class: 'p-actions' });
  const cancel = el('button', { class: 'btn ghost' }, 'やめる');
  const ok = el('button', { class: 'btn primary' }, '記録する');
  actions.append(cancel, ok);
  card.append(actions);

  cancel.addEventListener('click', () => card.remove());

  ok.addEventListener('click', async () => {
    ok.disabled = true;
    const id = uid();
    await db.putMeal({
      id,
      day: currentDay(),
      at: new Date().toISOString(),
      slot: slotSel.value,
      items: items.map(({ name, amount, kcal, p, f, c }) => ({ name, amount, kcal, p, f, c })),
      thumb,
      source: fromPhoto ? 'photo' : 'text',
    });
    await refresh();
    card.classList.add('done');
    actions.remove();
    const t = sumItems(items);
    const done = el('div', { class: 'p-actions' },
      el('span', { class: 'faint', style: 'flex:1;align-self:center' }, `記録しました（残り ${fmt((state.budget?.budget || 0) - state.eaten.kcal)} kcal）`),
      el('button', { class: 'btn sm ghost' }, 'いつもの に登録'));
    done.lastChild.addEventListener('click', () => savePreset(items, done.lastChild));
    card.append(done);
    void t;
    toast('記録しました');
  });

  return card;
}

async function savePreset(items, btn) {
  const suggested = items.map((i) => i.name).join('と');
  const name = prompt('「いつもの◯◯」の◯◯にあたる名前を入れてください', suggested);
  if (!name) return;
  const existing = (await db.allPresets()).find((p) => p.name === name);
  await db.putPreset({
    id: existing?.id || uid(),
    name,
    items: items.map(({ name: n, amount, kcal, p, f, c }) => ({ name: n, amount, kcal, p, f, c })),
    useCount: (existing?.useCount || 0) + 1,
    updatedAt: new Date().toISOString(),
  });
  await refresh();
  btn.textContent = '登録しました';
  btn.disabled = true;
}
