// 今日タブ＝帳面。読むのが主で、書くのは「登録済み／修正」の形に揃える。
// 入力欄を出しっぱなしにしない（何度も登録できてしまうため）。

import { $, el, fmt, r0, r1, hhmm, uid, toast, undoToast, sumItems, jpDate, addDays } from '../util.js';
import * as db from '../db.js';
import { state, refresh, currentDay, targetDay, setViewDay, goToday, weightKg, recentMeals } from '../store.js';
import { reserveSlot } from './chat.js';

/** 過去日へ書くときは、その日の同じ時刻にする（時刻順の並びを崩さない）。 */
function stampFor(day) {
  const now = new Date();
  if (day === currentDay()) return now.toISOString();
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds()).toISOString();
}

let root, goTab = () => {};
let editing = null;   // 'weight' | 'activity' | meal.id
let openSlot = null;  // ＋を押して開いている区分

/** チャットの記録済みカードの「直す」から呼ばれる。 */
export function openMeal(id) { editing = id; goTab('today'); render(); }

export function mount({ navigate }) {
  root = $('#today-body');
  goTab = navigate;
}

export function render() {
  if (!root) return;
  root.textContent = '';

  if (!state.ready) {
    root.append(el('div', { class: 'banner' },
      `まだ聞けていないもの：${state.missing.join('・')}。これが埋まるまで上限カロリーは出せません。`,
      el('div', {}, el('button', { class: 'btn sm primary', onclick: () => goTab('chat') }, 'チャットで答える'))));
  }

  root.append(dateNav(), sectionMeals(), sectionWeight(), sectionActivity());
  if (state.presets.length) root.append(sectionPresets());
  root.append(el('div', { class: 'faint', style: 'padding:4px 0 8px' },
    '行をタップすると直せます。'));
}

// ---------------------------------------------------------------- 献立

const SLOTS = ['朝', '昼', '夜', '間食'];

/** 前後の日へ。昨日の食べ忘れを翌朝入れる、が一番ありがちな場面。 */
function dateNav() {
  // 子は el() に渡す。生の append は null を文字列 "null" にする（2回踏んだ）
  return el('div', { class: 'datenav' },
    el('button', { class: 'dn-btn', onclick: () => setViewDay(addDays(state.today, -1)) }, '‹'),
    el('span', { class: 'dn-day' }, state.isToday ? `今日　${jpDate(state.today)}` : jpDate(state.today)),
    el('button', { class: 'dn-btn', disabled: state.isToday, onclick: () => setViewDay(addDays(state.today, 1)) }, '›'),
    state.isToday ? null : el('button', { class: 'btn sm', onclick: () => goToday() }, '今日へ'));
}

function sectionMeals() {
  const box = el('div', { class: 'card' });
  box.append(el('h2', {}, state.isToday ? '今日の献立' : `${jpDate(state.today)} の献立`));

  for (const slot of SLOTS) {
    const rows = state.meals.filter((m) => m.slot === slot);
    const t = sumItems(rows.flatMap((m) => m.items));
    box.append(el('div', { class: 'slot' },
      el('span', { class: 'slot-name' }, slot),
      el('span', { class: 'slot-kcal' }, rows.length ? fmt(t.kcal) : '—'),
      el('button', {
        class: `slot-add ${openSlot === slot ? 'on' : ''}`,
        onclick: () => { openSlot = openSlot === slot ? null : slot; editing = null; render(); },
      }, openSlot === slot ? '×' : '＋')));
    if (openSlot === slot) box.append(addPanel(slot));
    for (const m of rows) box.append(editing === m.id ? mealEditor(m) : mealRow(m));
  }

  const all = sumItems(state.meals.flatMap((m) => m.items));
  box.append(el('div', { class: 'meal sum' },
    el('span', { class: 'm-slot' }, ''),
    el('span', { class: 'm-name' }, '計'),
    el('span', { class: 'm-kcal' }, fmt(all.kcal))));
  return box;
}

/**
 * ＋を押すと出る板。上から「よく食べるもの（1タップ）」「数値で入れる」「写真・文章で」。
 * AIを通さない道を先に置く。
 */
function addPanel(slot) {
  const panel = el('div', { class: 'addpanel' });

  const recentBox = el('div', { class: 'ap-recent' });
  panel.append(el('div', { class: 'ap-label' }, 'よく食べるもの'), recentBox);
  recentMeals(6).then((rs) => {
    if (!rs.length) { recentBox.append(el('span', { class: 'faint' }, 'まだありません')); return; }
    for (const r of rs) {
      const t = sumItems(r.items);
      recentBox.append(el('button', {
        class: 'chip again',
        onclick: async () => {
          const id = uid();
          await db.putMeal({ id, day: targetDay(), at: stampFor(targetDay()), slot, items: structuredClone(r.items), source: 'again' });
          openSlot = null;
          await refresh();
          undoToast(`${r.label} を ${slot} に記録しました`, async () => { await db.delMeal(id); await refresh(); });
        },
      }, el('b', {}, r.label.length > 14 ? r.label.slice(0, 14) + '…' : r.label), ` ${fmt(t.kcal)}`));
    }
  });

  const nm = el('input', { type: 'text', placeholder: '品名（例：プロテイン）' });
  const kc = el('input', { type: 'number', inputmode: 'numeric', placeholder: 'kcal' });
  const pp = el('input', { type: 'number', inputmode: 'decimal', placeholder: 'P g' });
  const ff = el('input', { type: 'number', inputmode: 'decimal', placeholder: 'F g' });
  const cc = el('input', { type: 'number', inputmode: 'decimal', placeholder: 'C g' });
  panel.append(
    el('div', { class: 'ap-label' }, '数値で入れる'),
    el('div', { class: 'ap-grid' }, nm, kc),
    el('div', { class: 'ap-grid3' }, pp, ff, cc),
    el('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:8px' },
      el('button', {
        class: 'btn sm primary',
        onclick: async () => {
          const kcal = Number(kc.value);
          if (!nm.value.trim() || kc.value === '' || !(kcal >= 0)) { toast('品名とkcalを入れてください'); return; }
          const id = uid();
          await db.putMeal({
            id, day: targetDay(), at: stampFor(targetDay()), slot, source: 'manual',
            items: [{ name: nm.value.trim(), amount: '', kcal: Math.round(kcal),
                      p: Number(pp.value) || 0, f: Number(ff.value) || 0, c: Number(cc.value) || 0 }],
          });
          openSlot = null;
          await refresh();
          undoToast(`${nm.value.trim()} を ${slot} に記録しました`, async () => { await db.delMeal(id); await refresh(); });
        },
      }, '登録')));

  panel.append(el('div', { class: 'ap-label' }, '写真・文章で'),
    el('button', {
      class: 'btn sm', style: 'width:100%',
      onclick: () => { reserveSlot(slot); openSlot = null; goTab('chat'); },
    }, `チャットで ${slot} を記録する`));
  return panel;
}

function mealRow(m) {
  const t = sumItems(m.items);
  return el('div', { class: 'meal', onclick: () => { editing = m.id; render(); } },
    el('span', { class: 'm-slot' }, `${hhmm(m.at)}`),
    el('span', { class: 'm-body' },
      el('div', { class: 'm-name' }, m.items.map((i) => i.name).join('・')),
      el('div', { class: 'm-macro' },
        [m.slot, m.items.map((i) => i.amount).filter(Boolean).join(' ／ '),
         `P ${r1(t.p)} F ${r1(t.f)} C ${r1(t.c)}`].filter(Boolean).join('　'))),
    el('span', { class: 'm-kcal' }, fmt(t.kcal)));
}

/** 行をタップすると開く。品目ごとのkcalを直すとPFCも比例で動く。 */
function mealEditor(m) {
  const items = m.items.map((i) => ({ ...i, b: { kcal: i.kcal || 1, p: i.p, f: i.f, c: i.c } }));
  let dirty = false;
  const box = el('div', { class: 'mealedit' });

  const save = async () => {
    await db.putMeal({ ...m, slot: slot.value, items: items.map(({ name, amount, kcal, p, f, c }) => ({ name, amount, kcal, p, f, c })) });
    editing = null;
    await refresh();
    toast('直しました');
  };

  // 入力欄・ボタン以外を叩いたら「閉じたい」と受け取る。
  // 変えた内容は捨てずに保存してから閉じる（「やめる」は捨てる側の道として残す）。
  box.addEventListener('click', (e) => {
    if (e.target.closest('input, select, button, textarea, label, a')) return;
    if (dirty) save(); else { editing = null; render(); }
  });

  const slot = el('select', { style: 'width:auto;padding:5px 9px;font-size:14px' },
    ...['朝', '昼', '夜', '間食'].map((x) => el('option', { value: x, selected: x === m.slot }, x)));
  slot.addEventListener('change', () => { dirty = true; });

  box.append(el('div', { class: 'mhead' },
    el('span', { class: 'faint' }, `${hhmm(m.at)} の記録`), slot));

  const totalKcal = el('b');
  const totalMacro = el('span', { class: 'faint' });
  const recalc = () => {
    const t = sumItems(items);
    totalKcal.textContent = `${fmt(t.kcal)} kcal`;
    totalMacro.textContent = `P ${r1(t.p)}　F ${r1(t.f)}　C ${r1(t.c)}`;
  };

  for (const it of items) {
    const inp = el('input', { type: 'number', inputmode: 'numeric', step: '10', value: String(it.kcal) });
    inp.addEventListener('input', () => {
      dirty = true;
      const v = Math.max(0, Number(inp.value) || 0);
      const k = v / (it.b.kcal || 1);
      it.kcal = v;
      it.p = Math.round(it.b.p * k * 10) / 10;
      it.f = Math.round(it.b.f * k * 10) / 10;
      it.c = Math.round(it.b.c * k * 10) / 10;
      recalc();
    });
    box.append(el('div', { class: 'mrow' },
      el('span', { class: 'n' }, it.name, it.amount ? el('small', {}, it.amount) : null),
      inp));
  }
  recalc();

  box.append(el('div', { class: 'mtot' }, totalMacro, totalKcal));
  box.append(el('div', { class: 'macts' },
    el('button', { class: 'btn sm danger', onclick: () => removeMeal(m) }, '消す'),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'btn sm', onclick: () => { editing = null; render(); } }, 'やめる'),
    el('button', { class: 'btn sm primary', onclick: save }, '保存')));
  box.append(el('div', { class: 'faint', style: 'font-size:11.5px;padding-top:9px' },
    '欄の外を押しても閉じます（直した分は残ります）'));
  return box;
}

async function removeMeal(m) {
  await db.delMeal(m.id);
  editing = null;
  await refresh();
  undoToast('献立を消しました', async () => { await db.putMeal(m); await refresh(); });
}

// ---------------------------------------------------------------- 体重

function sectionWeight() {
  const box = el('div', { class: 'card' });
  box.append(el('h2', {}, '体重'));
  const w = state.weight;

  if (editing === 'weight' || !w) {
    if (editing !== 'weight' && !w) {
      box.append(el('div', { class: 'state empty' },
        el('span', { class: 's-time' }, '— —'),
        el('span', { class: 's-val' }, state.isToday ? '今日の体重を入れる' : 'この日の体重を入れる'),
        el('button', { class: 's-fix', onclick: () => { editing = 'weight'; render(); } }, 'ひらく')));
      return box;
    }
    const kg = el('input', { type: 'number', step: '0.1', inputmode: 'decimal', value: w?.kg ?? '', placeholder: String(weightKg() ?? '') });
    const fat = el('input', { type: 'number', step: '0.1', inputmode: 'decimal', value: w?.fatPct ?? '', placeholder: '体脂肪率 %' });
    box.append(el('div', { class: 'editline' }, kg, fat,
      el('span', { class: 'btns' },
        el('button', { class: 'btn sm', onclick: () => { editing = null; render(); } }, 'やめる'),
        el('button', {
          class: 'btn sm primary',
          onclick: async () => {
            const v = Number(kg.value);
            if (!(v > 20 && v < 300)) { toast('体重を確認してください'); return; }
            await db.putWeight({ day: targetDay(), kg: r1(v), fatPct: Number(fat.value) || null, at: stampFor(targetDay()) });
            editing = null;
            await refresh();
            toast('記録しました');
          },
        }, '登録'))));
    setTimeout(() => kg.focus(), 0);
    return box;
  }

  box.append(el('div', { class: 'state' },
    el('span', { class: 's-time' }, hhmm(w.at)),
    el('span', { class: 's-val' },
      el('b', {}, r1(w.kg)),
      el('span', {}, `kg${w.fatPct ? `　体脂肪 ${r1(w.fatPct)}%` : ''}`)),
    el('button', { class: 's-fix', onclick: () => { editing = 'weight'; render(); } }, '修正')));

  const g = state.settings.goal.targetWeightKg;
  if (g) {
    box.append(el('div', { class: 'faint', style: 'padding-top:8px' },
      `目標 ${g}kg まであと ${r1(Math.max(0, w.kg - g))}kg`));
  }
  return box;
}

// ---------------------------------------------------------------- 運動

function sectionActivity() {
  const box = el('div', { class: 'card' });
  box.append(el('h2', {}, '運動'));

  for (const a of state.activities) {
    box.append(el('div', { class: 'state' },
      el('span', { class: 's-time' }, hhmm(a.at)),
      el('span', { class: 's-val' },
        el('b', {}, fmt(a.kcal)),
        el('span', {}, `kcal　${a.name}${a.minutes ? ` ${r0(a.minutes)}分` : ''}`)),
      el('button', {
        class: 's-fix',
        onclick: async () => {
          await db.delActivity(a.id);
          await refresh();
          undoToast('運動を消しました', async () => { await db.putActivity(a); await refresh(); });
        },
      }, '消す')));
  }

  if (editing === 'activity') {
    const nm = el('input', { type: 'text', placeholder: '例：ランニング' });
    const kc = el('input', { type: 'number', inputmode: 'numeric', placeholder: 'kcal' });
    box.append(el('div', { class: 'editline' }, nm, kc,
      el('span', { class: 'btns' },
        el('button', { class: 'btn sm', onclick: () => { editing = null; render(); } }, 'やめる'),
        el('button', {
          class: 'btn sm primary',
          onclick: async () => {
            const v = Number(kc.value);
            if (!nm.value.trim() || !(v > 0)) { toast('種目と消費カロリーを入れてください'); return; }
            await db.putActivity({ id: uid(), day: targetDay(), at: stampFor(targetDay()), name: nm.value.trim(), kcal: r0(v), minutes: null });
            editing = null;
            await refresh();
          },
        }, '登録'))));
    setTimeout(() => nm.focus(), 0);
  } else {
    box.append(el('div', { class: 'state empty' },
      el('span', { class: 's-time' }, '— —'),
      el('span', { class: 's-val' }, state.activities.length ? '運動をもう1件つける' : 'チャットで「30分走った」でも入ります'),
      el('button', { class: 's-fix', onclick: () => { editing = 'activity'; render(); } }, 'ひらく')));
  }

  if (!state.settings.addExerciseToBudget && state.activities.length) {
    box.append(el('div', { class: 'faint', style: 'padding-top:8px' }, '設定で「上限に足す」を切ってあるので、上限には反映していません。'));
  }
  return box;
}

// ---------------------------------------------------------------- いつもの

function sectionPresets() {
  const box = el('div', { class: 'card' });
  box.append(el('h2', {}, 'いつもの'));
  for (const p of state.presets) {
    const t = sumItems(p.items);
    box.append(el('div', { class: 'state' },
      el('span', { class: 's-time' }, ''),
      el('span', { class: 's-val' }, el('b', {}, fmt(t.kcal)), el('span', {}, `kcal　${p.name}`)),
      el('span', { style: 'display:flex;gap:6px' },
        el('button', {
          class: 's-fix',
          onclick: async () => {
            const id = uid();
            const rec = { id, day: targetDay(), at: stampFor(targetDay()), slot: slotNow(), items: structuredClone(p.items), source: 'preset' };
            await db.putMeal(rec);
            await db.putPreset({ ...p, useCount: (p.useCount || 0) + 1 });
            await refresh();
            undoToast(`${p.name} をつけました`, async () => { await db.delMeal(id); await refresh(); });
          },
        }, 'つける'),
        el('button', {
          class: 's-fix',
          onclick: async () => {
            await db.delPreset(p.id);
            await refresh();
            undoToast(`${p.name} を消しました`, async () => { await db.putPreset(p); await refresh(); });
          },
        }, '消す'))));
  }
  return box;
}

function slotNow() {
  const h = new Date().getHours();
  return h < 10 ? '朝' : h < 15 ? '昼' : h < 22 ? '夜' : '間食';
}
