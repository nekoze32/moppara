// 今日タブ。上限・摂取・残り、食事の明細、体重と運動。

import { $, el, fmt, r0, r1, hhmm, uid, toast, sumItems, clamp } from '../util.js';
import * as db from '../db.js';
import { state, remaining, refresh, currentDay, weightKg } from '../store.js';
import { jpDate } from '../util.js';

let root, goTab = () => {};

export function mount({ navigate }) {
  root = $('#today-body');
  goTab = navigate;
}

export function render() {
  if (!root) return;
  const rem = remaining();
  const b = state.budget;
  root.textContent = '';

  const needsSetup = !state.settings.profile.heightCm
    || (state.settings.goal.mode !== 'maintain' && !state.settings.goal.targetWeightKg);
  if (needsSetup) {
    root.append(el('div', { class: 'banner' },
      '身長・体重・目標がまだ空です。ここを埋めないと上限カロリーが正しく出ません。',
      el('div', {}, el('button', { class: 'btn sm primary', onclick: () => goTab('settings') }, '設定を開く'))));
  }

  // ---- リングと内訳 ----
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'row', style: 'margin-bottom:12px' },
    el('h2', { style: 'margin:0' }, jpDate(state.today)),
    el('span', { class: 'faint' }, `上限 ${fmt(b?.budget)} kcal`)));

  card.append(el('div', { class: 'ring-wrap' },
    ring(rem.pct, rem.kcal),
    el('div', { class: 'stack', style: 'flex:1;min-width:0' },
      macroBar('p', 'P', state.eaten.p, state.targets?.p),
      macroBar('f', 'F', state.eaten.f, state.targets?.f),
      macroBar('c', 'C', state.eaten.c, state.targets?.c))));

  const detail = [
    `生活消費 ${fmt(b?.base)}`,
    b?.deficit ? `目標の赤字 −${fmt(b.deficit)}` : null,
    b?.exercise ? `運動 +${fmt(b.exercise)}` : null,
    `摂取 ${fmt(state.eaten.kcal)}`,
  ].filter(Boolean).join('　/　');
  card.append(el('div', { class: 'faint', style: 'margin-top:12px' }, detail));

  if (b?.paceTooFast) {
    card.append(el('div', { class: 'banner', style: 'margin:10px 0 0' },
      `目標日までに ${r1(b.paceKgPerWeek)}kg/週 のペースが必要です。週1kgを超える減量は続きません。目標日を延ばすか目標体重を見直してください。`));
  } else if (b?.cappedByFloor) {
    card.append(el('div', { class: 'banner', style: 'margin:10px 0 0' },
      '目標どおりの赤字だと基礎代謝を割るので、上限を安全側に引き上げています。'));
  }
  root.append(card);

  // ---- 食事 ----
  const meals = el('div', { class: 'card' });
  meals.append(el('div', { class: 'row', style: 'margin-bottom:6px' },
    el('h2', { style: 'margin:0' }, '食事'),
    el('button', { class: 'btn sm', onclick: () => goTab('chat') }, '＋ 追加')));
  if (!state.meals.length) {
    meals.append(el('div', { class: 'empty' }, 'まだ記録がありません。\nチャットに写真か一言を送ってください。'));
  } else {
    for (const m of state.meals) meals.append(mealRow(m));
  }
  root.append(meals);

  // ---- 体重 ----
  const w = el('div', { class: 'card' });
  w.append(el('h2', {}, '体重'));
  const wInput = el('input', {
    type: 'number', step: '0.1', inputmode: 'decimal',
    value: state.weight?.kg ?? '', placeholder: String(weightKg() ?? ''),
  });
  const fInput = el('input', { type: 'number', step: '0.1', inputmode: 'decimal', value: state.weight?.fatPct ?? '', placeholder: '体脂肪率' });
  w.append(el('div', { class: 'grid2' },
    el('div', { class: 'field', style: 'margin:0' }, el('label', {}, '今日の体重 (kg)'), wInput),
    el('div', { class: 'field', style: 'margin:0' }, el('label', {}, '体脂肪率 (%) 任意'), fInput)));
  w.append(el('button', {
    class: 'btn sm primary', style: 'margin-top:10px',
    onclick: async () => {
      const kg = Number(wInput.value);
      if (!(kg > 20 && kg < 300)) { toast('体重を確認してください'); return; }
      await db.putWeight({ day: currentDay(), kg: r1(kg), fatPct: Number(fInput.value) || null, at: new Date().toISOString() });
      await refresh();
      toast('体重を記録しました');
    },
  }, '記録する'));
  if (state.weight && state.latestWeight && state.settings.goal.targetWeightKg) {
    const diff = r1(state.weight.kg - state.settings.goal.targetWeightKg);
    w.append(el('div', { class: 'faint', style: 'margin-top:9px' },
      `目標 ${state.settings.goal.targetWeightKg}kg まであと ${diff > 0 ? diff : 0}kg`));
  }
  root.append(w);

  // ---- 運動 ----
  const a = el('div', { class: 'card' });
  a.append(el('div', { class: 'row', style: 'margin-bottom:8px' },
    el('h2', { style: 'margin:0' }, '運動'),
    el('span', { class: 'faint' }, state.settings.addExerciseToBudget ? '上限に加算する設定' : '上限に加算しない設定')));
  if (!state.activities.length) {
    a.append(el('div', { class: 'faint' }, 'まだありません。チャットで「30分走った」でも入ります。'));
  } else {
    for (const x of state.activities) {
      a.append(el('div', { class: 'meal' },
        el('div', { class: 'm-body' },
          el('div', { class: 'm-top' },
            el('span', { class: 'm-name' }, x.name + (x.minutes ? `（${r0(x.minutes)}分）` : '')),
            el('span', { class: 'm-kcal' }, `${fmt(x.kcal)} kcal`)),
          el('div', { class: 'm-slot' }, hhmm(x.at))),
        el('button', {
          class: 'm-del', 'aria-label': '削除',
          onclick: async () => { await db.delActivity(x.id); await refresh(); },
        }, '×')));
    }
  }
  const aName = el('input', { type: 'text', placeholder: '例：ランニング' });
  const aKcal = el('input', { type: 'number', inputmode: 'numeric', placeholder: 'kcal' });
  a.append(el('div', { class: 'grid2', style: 'margin-top:10px' }, aName, aKcal));
  a.append(el('button', {
    class: 'btn sm', style: 'margin-top:8px',
    onclick: async () => {
      const kcal = Number(aKcal.value);
      if (!aName.value.trim() || !(kcal > 0)) { toast('種目と消費カロリーを入れてください'); return; }
      await db.putActivity({ id: uid(), day: currentDay(), at: new Date().toISOString(), name: aName.value.trim(), kcal: r0(kcal), minutes: null });
      aName.value = ''; aKcal.value = '';
      await refresh();
    },
  }, '追加'));
  root.append(a);

  // ---- いつもの ----
  if (state.presets.length) {
    const p = el('div', { class: 'card' });
    p.append(el('h2', {}, 'いつもの'));
    for (const preset of state.presets) {
      const t = sumItems(preset.items);
      p.append(el('div', { class: 'meal' },
        el('div', { class: 'm-body' },
          el('div', { class: 'm-top' },
            el('span', { class: 'm-name' }, preset.name),
            el('span', { class: 'm-kcal' }, `${fmt(t.kcal)} kcal`)),
          el('div', { class: 'm-macro' }, `P ${r1(t.p)} / F ${r1(t.f)} / C ${r1(t.c)}`)),
        el('button', {
          class: 'btn sm', style: 'align-self:center',
          onclick: async () => {
            await db.putMeal({
              id: uid(), day: currentDay(), at: new Date().toISOString(),
              slot: slotNow(), items: structuredClone(preset.items), source: 'preset',
            });
            await db.putPreset({ ...preset, useCount: (preset.useCount || 0) + 1 });
            await refresh();
            toast(`${preset.name} を記録しました`);
          },
        }, '記録'),
        el('button', {
          class: 'm-del', 'aria-label': '削除',
          onclick: async () => { if (confirm(`「${preset.name}」を消しますか`)) { await db.delPreset(preset.id); await refresh(); } },
        }, '×')));
    }
    root.append(p);
  }
}

function slotNow() {
  const h = new Date().getHours();
  return h < 10 ? '朝' : h < 15 ? '昼' : h < 22 ? '夜' : '間食';
}

function mealRow(m) {
  const t = sumItems(m.items);
  return el('div', { class: 'meal' },
    m.thumb ? el('img', { src: m.thumb, alt: '' }) : null,
    el('div', { class: 'm-body' },
      el('div', { class: 'm-top' },
        el('span', { class: 'm-slot' }, `${m.slot}　${hhmm(m.at)}`),
        el('span', { class: 'm-kcal' }, `${fmt(t.kcal)} kcal`)),
      el('div', { class: 'm-name' }, m.items.map((i) => i.name + (i.amount ? `(${i.amount})` : '')).join('・')),
      el('div', { class: 'm-macro' }, `P ${r1(t.p)}　F ${r1(t.f)}　C ${r1(t.c)}`)),
    el('button', {
      class: 'm-del', 'aria-label': '削除',
      onclick: async () => { await db.delMeal(m.id); await refresh(); },
    }, '×'));
}

function macroBar(kind, label, got, target) {
  const pct = target > 0 ? clamp((got / target) * 100, 0, 100) : 0;
  return el('div', { class: `macro ${kind}` },
    el('span', { class: 'lbl' }, label),
    el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${pct}%` })),
    el('span', { class: 'val' }, `${r0(got)} / ${r0(target)}g`));
}

function ring(pct, remainKcal) {
  const R = 46, C = 2 * Math.PI * R;
  const p = clamp(pct, 0, 1);
  const cls = pct > 1 ? 'over' : pct > 0.85 ? 'tight' : '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('viewBox', '0 0 112 112');
  svg.innerHTML = `
    <circle class="bgc" cx="56" cy="56" r="${R}" fill="none" stroke-width="9"/>
    <circle class="fgc ${cls}" cx="56" cy="56" r="${R}" fill="none" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${(C * p).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 56 56)"/>
    <text class="ring-num" x="56" y="54" text-anchor="middle">${fmt(remainKcal)}</text>
    <text class="ring-cap" x="56" y="68" text-anchor="middle">kcal ${remainKcal < 0 ? 'オーバー' : '残り'}</text>`;
  return svg;
}
