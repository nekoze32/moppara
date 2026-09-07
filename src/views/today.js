// 今日タブ＝帳面。読むのが主で、書くのは「登録済み／修正」の形に揃える。
// 入力欄を出しっぱなしにしない（何度も登録できてしまうため）。

import { $, el, fmt, r0, r1, hhmm, uid, toast, undoToast, sumItems, jpDate } from '../util.js';
import * as db from '../db.js';
import { state, refresh, currentDay, weightKg } from '../store.js';

let root, goTab = () => {};
let editing = null;   // 'weight' | 'activity' | meal.id

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

  root.append(sectionMeals(), sectionWeight(), sectionActivity());
  if (state.presets.length) root.append(sectionPresets());
  root.append(el('div', { class: 'faint', style: 'padding:4px 0 8px' },
    `${jpDate(state.today)}　行をタップすると直せます。`));
}

// ---------------------------------------------------------------- 献立

function sectionMeals() {
  const box = el('div', { class: 'card' });
  box.append(el('h2', {}, 'き ょ う の 献 立'));

  if (!state.meals.length) {
    box.append(el('div', { class: 'state empty' },
      el('span', { class: 's-time' }, '— —'),
      el('span', { class: 's-val' }, 'まだ何も食べていない'),
      el('button', { class: 's-fix', onclick: () => goTab('chat') }, '記録する')));
    return box;
  }

  for (const m of state.meals) {
    box.append(editing === m.id ? mealEditor(m) : mealRow(m));
  }
  const t = sumItems(state.meals.flatMap((m) => m.items));
  box.append(el('div', { class: 'meal sum' },
    el('span', { class: 'm-slot' }, ''),
    el('span', { class: 'm-name' }, '計'),
    el('span', { class: 'm-kcal' }, fmt(t.kcal))));
  return box;
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
  const box = el('div', { class: 'card', style: 'background:var(--surface2);padding:12px;margin-bottom:14px;border-radius:3px' });

  const slot = el('select', { style: 'width:auto;padding:4px 8px;font-size:13px' },
    ...['朝', '昼', '夜', '間食'].map((x) => el('option', { value: x, selected: x === m.slot }, x)));
  const total = el('b', { style: 'font-family:var(--num);font-variant-numeric:tabular-nums' });
  const recalc = () => { total.textContent = `${fmt(sumItems(items).kcal)} kcal`; };

  box.append(el('div', { class: 'row', style: 'margin-bottom:8px' },
    el('span', { class: 'faint' }, `${hhmm(m.at)} の記録を直す`), slot));

  for (const it of items) {
    const inp = el('input', { type: 'number', inputmode: 'numeric', step: '10', value: String(it.kcal), style: 'text-align:right' });
    inp.addEventListener('input', () => {
      const v = Math.max(0, Number(inp.value) || 0);
      const k = v / (it.b.kcal || 1);
      it.kcal = v;
      it.p = Math.round(it.b.p * k * 10) / 10;
      it.f = Math.round(it.b.f * k * 10) / 10;
      it.c = Math.round(it.b.c * k * 10) / 10;
      recalc();
    });
    box.append(el('div', { class: 'editline' },
      el('span', { style: 'font-size:13px;grid-column:span 2' }, it.name, it.amount ? el('small', { class: 'faint' }, `　${it.amount}`) : null),
      inp));
  }
  recalc();
  box.append(el('div', { class: 'row', style: 'padding:9px 0 12px;border-bottom:1px solid var(--line)' },
    el('span', { class: 'faint' }, '合計'), total));

  box.append(el('div', { style: 'display:flex;gap:8px;margin-top:12px' },
    el('button', { class: 'btn sm danger', onclick: () => removeMeal(m) }, '消す'),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'btn sm', onclick: () => { editing = null; render(); } }, 'やめる'),
    el('button', {
      class: 'btn sm primary',
      onclick: async () => {
        await db.putMeal({ ...m, slot: slot.value, items: items.map(({ name, amount, kcal, p, f, c }) => ({ name, amount, kcal, p, f, c })) });
        editing = null;
        await refresh();
        toast('直しました');
      },
    }, '保存')));
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
  box.append(el('h2', {}, 'た い じ ゅ う'));
  const w = state.weight;

  if (editing === 'weight' || !w) {
    if (editing !== 'weight' && !w) {
      box.append(el('div', { class: 'state empty' },
        el('span', { class: 's-time' }, '— —'),
        el('span', { class: 's-val' }, '今日の体重を入れる'),
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
            await db.putWeight({ day: currentDay(), kg: r1(v), fatPct: Number(fat.value) || null, at: new Date().toISOString() });
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
  box.append(el('h2', {}, 'う ご い た ぶ ん'));

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
            await db.putActivity({ id: uid(), day: currentDay(), at: new Date().toISOString(), name: nm.value.trim(), kcal: r0(v), minutes: null });
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
  box.append(el('h2', {}, 'い つ も の'));
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
            const rec = { id, day: currentDay(), at: new Date().toISOString(), slot: slotNow(), items: structuredClone(p.items), source: 'preset' };
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
