// 推移タブ。体重の線と、日別摂取カロリーの棒。
// 配色は dataviz の validate_palette で検証済み（styles.css の --chart-1/--chart-2 参照）。

import { $, el, fmt, r0, r1, jpDate, clamp } from '../util.js';
import { state, recentDays, weightKg } from '../store.js';
import { movingAverage } from '../nutrition.js';

let root;
let range = 30;

export function mount() { root = $('#trend-body'); }

export async function render() {
  if (!root) return;
  const rows = await recentDays(range);
  root.textContent = '';

  // ---- 期間 ----
  const seg = el('div', { class: 'seg' });
  for (const n of [14, 30, 90]) {
    seg.append(el('button', {
      class: n === range ? 'on' : '',
      onclick: () => { range = n; render(); },
    }, `${n}日`));
  }
  root.append(seg);

  // ---- 進捗の見出し数字 ----
  root.append(progressCard(rows));

  // ---- 体重 ----
  const wRows = rows.filter((r) => r.weight != null).map((r) => ({ day: r.day, kg: r.weight }));
  const wCard = el('div', { class: 'card' });
  wCard.append(el('h2', {}, '体重'));
  if (wRows.length < 2) {
    wCard.append(el('div', { class: 'empty' }, '記録が2日ぶん貯まると線が引けます。\n毎朝、同じ条件で量るのが一番あてになります。'));
  } else {
    const chart = weightChart(wRows);
    wCard.append(chart);
    wCard.append(el('div', { class: 'legend' },
      legendItem('c1', '7日移動平均'),
      legendItem('ink', 'その日の実測'),
      chart.dataset.goalShown === '1' ? legendItem('dash', `目標 ${state.settings.goal.targetWeightKg}kg`) : null));
    const g2 = state.settings.goal.targetWeightKg;
    wCard.append(el('div', { class: 'faint', style: 'margin-top:8px' },
      (g2 && chart.dataset.goalShown !== '1' ? `目標の ${g2}kg はこの縦軸の外です。まず線の向きを見てください。 ` : '')
      + '日々の増減は水分でぶれます。'));
  }
  root.append(wCard);

  // ---- 摂取カロリー ----
  const kRows = rows.filter((r) => r.meals > 0);
  const kCard = el('div', { class: 'card' });
  kCard.append(el('h2', {}, '摂取カロリー'));
  if (!kRows.length) {
    kCard.append(el('div', { class: 'empty' }, 'まだ記録がありません。'));
  } else {
    const budget = state.budget?.budget || 0;
    kCard.append(kcalChart(rows, budget));
    kCard.append(el('div', { class: 'legend' },
      legendItem('c1', '上限の中'),
      legendItem('c2', '超えた分'),
      legendItem('dash', `いまの上限 ${fmt(budget)} kcal`)));
    const avg = kRows.reduce((a, r) => a + r.kcal, 0) / kRows.length;
    const over = kRows.filter((r) => r.kcal > budget).length;
    kCard.append(el('div', { class: 'faint', style: 'margin-top:8px' },
      `記録のある${kRows.length}日の平均 ${fmt(avg)} kcal　/　上限を超えた日 ${over}日`));
  }
  root.append(kCard);

  // ---- 数値で見る ----
  const tbl = el('details', { class: 'acc' });
  tbl.append(el('summary', {}, '数値で見る'));
  tbl.append(el('div', { class: 'acc-body', style: 'overflow-x:auto' }, table(rows)));
  root.append(tbl);
}

// ---------------------------------------------------------------- 見出し数字

function progressCard(rows) {
  const g = state.settings.goal;
  const now = weightKg();
  const withW = rows.filter((r) => r.weight != null);
  const card = el('div', { class: 'card' });

  const hero = el('div', { class: 'hero' });
  hero.append(heroNum(now != null ? `${r1(now)}` : '—', 'いまの体重 (kg)'));
  if (g.targetWeightKg && now != null) {
    const left = r1(Math.max(0, now - g.targetWeightKg));
    hero.append(heroNum(`${left}`, `目標まで (kg)`));
  }
  // 実測ペース：期間の最初と最後の移動平均から
  if (withW.length >= 4) {
    const avg = movingAverage(withW.map((r) => ({ day: r.day, kg: r.weight })), 7);
    const first = avg[0], last = avg[avg.length - 1];
    const days = Math.max(1, (new Date(last.day) - new Date(first.day)) / 86400000);
    const perWeek = ((last.avg - first.avg) / days) * 7;
    hero.append(heroNum(`${perWeek > 0 ? '+' : ''}${r1(perWeek)}`, '実測ペース (kg/週)'));
  }
  if (state.budget?.paceKgPerWeek) {
    hero.append(heroNum(`${r1(-state.budget.paceKgPerWeek)}`, '目標ペース (kg/週)'));
  }
  card.append(hero);

  if (g.targetDate) {
    const left = Math.round((new Date(g.targetDate) - new Date(state.today)) / 86400000);
    card.append(el('div', { class: 'faint', style: 'margin-top:10px' },
      left > 0 ? `目標の日まであと${left}日（${g.targetDate}）` : `目標の日（${g.targetDate}）は過ぎています`));
  }
  return card;
}

function heroNum(v, label) {
  return el('div', { class: 'h' }, el('div', { class: 'hv' }, v), el('div', { class: 'hl' }, label));
}

// ---------------------------------------------------------------- 体重チャート

function weightChart(rows) {
  const W = 340, H = 170, ML = 32, MR = 10, MT = 12, MB = 20;
  const iw = W - ML - MR, ih = H - MT - MB;
  const pts = movingAverage(rows, 7);
  const goal = Number(state.settings.goal.targetWeightKg) || null;

  const values = rows.map((r) => r.kg).concat(pts.map((p) => p.avg));
  let lo = Math.min(...values), hi = Math.max(...values);
  const span = Math.max(0.8, hi - lo);
  // 目標がデータの幅より遠いと軸が潰れて線の向きが読めない。その場合は軸に入れない。
  const showGoal = goal != null && goal > lo - span && goal < hi + span;
  if (showGoal) { lo = Math.min(lo, goal); hi = Math.max(hi, goal); }
  const pad = Math.max(0.4, (hi - lo) * 0.15);
  lo -= pad; hi += pad;

  const t0 = new Date(rows[0].day).getTime();
  const t1 = new Date(rows[rows.length - 1].day).getTime();
  const x = (day) => ML + (t1 === t0 ? iw / 2 : ((new Date(day).getTime() - t0) / (t1 - t0)) * iw);
  const y = (kg) => MT + ih - ((kg - lo) / (hi - lo)) * ih;

  const box = el('div', { class: 'chartbox' });
  const tip = el('div', { class: 'tip', hidden: true });
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '体重の推移' });

  // 目盛り
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    const yy = y(v);
    svg.append(svgEl('line', { class: 'gridline', x1: ML, x2: W - MR, y1: yy, y2: yy }));
    svg.append(svgEl('text', { class: 'tick', x: ML - 5, y: yy + 3, 'text-anchor': 'end' }, r1(v)));
  }

  // 目標ライン
  if (showGoal) {
    svg.append(svgEl('line', { class: 'refline', x1: ML, x2: W - MR, y1: y(goal), y2: y(goal) }));
    svg.append(svgEl('text', { class: 'reflabel', x: W - MR, y: y(goal) - 4, 'text-anchor': 'end' }, `目標 ${goal}`));
  }

  // 実測ドット（控えめ）
  for (const r of rows) {
    svg.append(svgEl('circle', { class: 'dot', cx: x(r.day), cy: y(r.kg), r: 2.4, opacity: '.75' }));
  }

  // 移動平均の線
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)} ${y(p.avg).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { class: 'lineW', d }));

  // 端の直接ラベル
  const last = pts[pts.length - 1];
  svg.append(svgEl('circle', { cx: x(last.day), cy: y(last.avg), r: 4, fill: 'var(--chart-1)', stroke: 'var(--surface)', 'stroke-width': 2 }));

  // 日付ラベル（両端）
  svg.append(svgEl('text', { class: 'tick', x: ML, y: H - 5 }, jpDate(rows[0].day)));
  svg.append(svgEl('text', { class: 'tick', x: W - MR, y: H - 5, 'text-anchor': 'end' }, jpDate(rows[rows.length - 1].day)));

  // 触れる的
  rows.forEach((r, i) => {
    const hw = iw / rows.length;
    const hit = svgEl('rect', { class: 'hit', x: clamp(x(r.day) - hw / 2, 0, W), y: MT, width: Math.max(hw, 14), height: ih });
    const show = () => {
      const p = pts[i];
      tip.textContent = `${jpDate(r.day)}　${r1(r.kg)}kg（平均 ${r1(p.avg)}）`;
      tip.style.left = `${(x(r.day) / W) * 100}%`;
      tip.style.top = `${(y(r.kg) / H) * 100}%`;
      tip.hidden = false;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    svg.append(hit);
  });

  box.dataset.goalShown = showGoal ? '1' : '0';
  box.append(svg, tip);
  return box;
}

// ---------------------------------------------------------------- カロリーチャート

function kcalChart(rows, budget) {
  const W = 340, H = 150, ML = 34, MR = 10, MT = 12, MB = 20;
  const iw = W - ML - MR, ih = H - MT - MB;
  const maxV = Math.max(budget * 1.15, ...rows.map((r) => r.kcal), 1);
  const y = (v) => MT + ih - (v / maxV) * ih;
  const slot = iw / rows.length;
  const bw = Math.max(3, Math.min(18, slot - 3));

  const box = el('div', { class: 'chartbox' });
  const tip = el('div', { class: 'tip', hidden: true });
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '日別の摂取カロリー' });

  for (let i = 0; i <= 2; i++) {
    const v = (maxV * i) / 2;
    svg.append(svgEl('line', { class: 'gridline', x1: ML, x2: W - MR, y1: y(v), y2: y(v) }));
    svg.append(svgEl('text', { class: 'tick', x: ML - 5, y: y(v) + 3, 'text-anchor': 'end' }, i === 0 ? '0' : fmt(v)));
  }

  rows.forEach((r, i) => {
    const cx = ML + slot * i + slot / 2;
    if (r.meals > 0 && r.kcal > 0) {
      const inPart = Math.min(r.kcal, budget);
      const overPart = Math.max(0, r.kcal - budget);
      const yIn = y(inPart);
      svg.append(svgEl('rect', {
        class: 'barIn', x: cx - bw / 2, y: yIn, width: bw, height: MT + ih - yIn, rx: 2.5,
      }));
      if (overPart > 0) {
        const yOver = y(r.kcal);
        svg.append(svgEl('rect', {
          class: 'barOver', x: cx - bw / 2, y: yOver, width: bw,
          height: Math.max(2, yIn - yOver - 2), rx: 2.5, // 2px の隙間で塗りを分ける
        }));
      }
    }
    const hit = svgEl('rect', { class: 'hit', x: cx - slot / 2, y: MT, width: slot, height: ih });
    const show = () => {
      tip.textContent = r.meals > 0
        ? `${jpDate(r.day)}　${fmt(r.kcal)}kcal（P${r0(r.p)} F${r0(r.f)} C${r0(r.c)}）`
        : `${jpDate(r.day)}　記録なし`;
      tip.style.left = `${(cx / W) * 100}%`;
      tip.style.top = `${(y(Math.max(r.kcal, budget * 0.2)) / H) * 100}%`;
      tip.hidden = false;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    svg.append(hit);
  });

  // 上限ライン（最前面）
  svg.append(svgEl('line', { class: 'refline', x1: ML, x2: W - MR, y1: y(budget), y2: y(budget) }));
  svg.append(svgEl('text', { class: 'reflabel', x: W - MR, y: y(budget) - 4, 'text-anchor': 'end' }, `上限 ${fmt(budget)}`));

  svg.append(svgEl('text', { class: 'tick', x: ML, y: H - 5 }, jpDate(rows[0].day)));
  svg.append(svgEl('text', { class: 'tick', x: W - MR, y: H - 5, 'text-anchor': 'end' }, jpDate(rows[rows.length - 1].day)));

  box.append(svg, tip);
  return box;
}

// ---------------------------------------------------------------- 表

function table(rows) {
  const t = el('table', { class: 'tbl' });
  t.append(el('thead', {}, el('tr', {},
    el('th', {}, '日'), el('th', {}, 'kcal'), el('th', {}, 'P'), el('th', {}, 'F'), el('th', {}, 'C'),
    el('th', {}, '運動'), el('th', {}, '体重'))));
  const tb = el('tbody');
  for (const r of [...rows].reverse()) {
    tb.append(el('tr', {},
      el('td', {}, jpDate(r.day)),
      el('td', {}, r.meals ? fmt(r.kcal) : '—'),
      el('td', {}, r.meals ? r0(r.p) : '—'),
      el('td', {}, r.meals ? r0(r.f) : '—'),
      el('td', {}, r.meals ? r0(r.c) : '—'),
      el('td', {}, r.exercise ? fmt(r.exercise) : '—'),
      el('td', {}, r.weight != null ? r1(r.weight) : '—')));
  }
  t.append(tb);
  return t;
}

// ---------------------------------------------------------------- SVG小道具

function legendItem(cls, label) {
  return el('span', {}, el('i', { class: cls }), label);
}

function svgEl(tag, attrs = {}, text) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = String(text);
  return n;
}
