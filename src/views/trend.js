// 推移タブ。体重の線と、日別摂取カロリーの棒。
// 配色は dataviz の validate_palette で検証済み（styles.css の --chart-1/--chart-2 参照）。

import { $, el, fmt, r0, r1, jpDate, clamp } from '../util.js';
import { state, recentDays, weightKg, saveSettings, expenditureFloor, setViewDay } from '../store.js';
import { movingAverage, expenditureNeeds } from '../nutrition.js';

let root;
let range = 30;

let goTab = () => {};
export function mount({ navigate } = {}) { root = $('#trend-body'); if (navigate) goTab = navigate; }

/** その日を今日タブで開く。気になった日を ‹ で何十回も遡らせない */
async function openDay(day) {
  await setViewDay(day);
  goTab('today');
}

export async function render() {
  if (!root) return;
  // 振り返りと実測は期間の切り替えに関係なく直近4週を使うので、多いほうで1回だけ読む
  const all = await recentDays(Math.max(range, 29));
  const rows = all.slice(-range);
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

  // ---- この7日 ----
  root.append(weekCard(all));

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

  // ---- 実測の消費カロリー ----
  if (state.ready) root.append(expenditureCard(all));

  // ---- 数値で見る ----
  const tbl = el('details', { class: 'acc' });
  tbl.append(el('summary', {}, '数値で見る'));
  tbl.append(el('div', { class: 'acc-body', style: 'overflow-x:auto' }, table(rows)));
  root.append(tbl);
}

// ---------------------------------------------------------------- この7日

// 今日はまだ途中なので、昨日までの7日で振り返る。AIは呼ばない。
function weekCard(all) {
  const week = all.slice(-8, -1);
  const prev = all.slice(-15, -8);
  const b = state.budget;
  const t = state.targets;
  const logged = week.filter((r) => r.meals > 0);
  const card = el('div', { class: 'card' });
  card.append(el('h2', {}, 'この7日'));
  const box = el('div', { class: 'wk' });
  card.append(box);
  box.append(el('div', { class: 'wk-range' }, `${jpDate(week[0].day)}〜${jpDate(week[week.length - 1].day)}（今日は入れない）`));

  if (!logged.length) {
    box.append(el('div', { class: 'wk-line' }, 'この7日は記録がありません。'));
    return card;
  }

  // 過去の上限は保存していないので、いまの上限（運動を除く）＋その日の運動で近似する
  const addEx = state.settings.addExerciseToBudget && !b?.adaptive;
  const plain = (b?.budget || 0) - (b?.exerciseAdded || 0);
  const dayBudget = (r) => plain + (addEx ? r.exercise : 0);
  const avg = logged.reduce((a, r) => a + r.kcal, 0) / logged.length;
  const avgBudget = logged.reduce((a, r) => a + dayBudget(r), 0) / logged.length;
  const within = logged.filter((r) => r.kcal <= dayBudget(r)).length;
  const avgP = logged.reduce((a, r) => a + r.p, 0) / logged.length;

  // 1回ずつだと水分のぶれをそのまま拾うので、両週とも2回以上あるときだけ比べる
  const wAvg = (rs) => {
    const w = rs.filter((r) => r.weight != null);
    return w.length >= 2 ? w.reduce((a, r) => a + r.weight, 0) / w.length : null;
  };
  const wNow = wAvg(week), wPrev = wAvg(prev);
  const dW = wNow != null && wPrev != null ? r1(wNow - wPrev) : null;

  const tiles = el('div', { class: 'wk-grid' });
  tiles.append(
    wkTile('平均摂取', fmt(avg), state.ready ? `上限 ${fmt(avgBudget)} kcal` : 'kcal', state.ready && avg > avgBudget ? 'over' : ''),
    wkTile('記録した日', `${logged.length}`, '／7日'),
    wkTile('上限の内', state.ready ? `${within}` : '—', `／${logged.length}日`),
    wkTile('平均P', fmt(avgP), t ? `目標 ${fmt(t.p)} g` : 'g', t && avgP < t.p * 0.9 ? 'low' : ''),
    wkTile('体重（7日平均）', dW == null ? '—' : `${dW > 0 ? '+' : ''}${dW}`, dW == null ? '週2回ずつ量ると出ます' : 'kg　先週比'));
  box.append(tiles);

  // ひとことだけ。数字の言い直しではなく、次に何をすればいいかを書く。
  let line;
  if (!state.ready) line = '上限が決まると、上限との差も出ます。';
  else if (logged.length < 5) line = `記録が${logged.length}日だけなので、平均はまだぶれます。`;
  else if (avg > avgBudget) line = `平均で上限を ${fmt(avg - avgBudget)} kcal 超えています。多かった日を1日だけ見直すと効きます。`;
  else if (t && avgP < t.p * 0.9) line = `カロリーは収まっています。たんぱく質が1日 ${fmt(t.p - avgP)}g ほど足りません。`;
  else line = 'カロリーもたんぱく質も、平均では目標どおりです。';
  box.append(el('div', { class: 'wk-line' }, line));
  return card;
}

function wkTile(label, value, sub, cls = '') {
  return el('div', { class: `wk-t ${cls}` }, el('em', {}, label), el('b', {}, value), el('span', {}, sub));
}

// ---------------------------------------------------------------- 実測の消費

function expenditureCard(all) {
  const s = state.settings;
  const b = state.budget;
  const xp = state.expenditure;
  const on = !!s.goal.useAdaptive;
  const card = el('div', { class: 'card' });
  card.append(el('h2', {}, '実測の消費カロリー'));
  const box = el('div', { class: 'xp' });
  card.append(box);

  box.append(el('div', { class: 'xp-nums' },
    el('div', { class: b.adaptive ? 'on' : '' }, el('em', {}, '実測'), el('b', {}, xp ? fmt(xp.kcal) : '—'), el('span', {}, 'kcal／日')),
    el('div', { class: b.adaptive ? '' : 'on' }, el('em', {}, '式（Mifflin）'), el('b', {}, fmt(b.formulaBase)), el('span', {}, 'kcal／日'))));
  box.append(el('div', { class: 'xp-why' }, '直近4週の「食べた量」と「体重の動き」から逆算した、実際に使っている量です。'));

  if (xp) {
    const conf = { high: '高', medium: '中', low: '低' }[xp.confidence];
    const diff = xp.kcal - b.formulaBase;
    box.append(el('div', { class: 'xp-meta' },
      el('span', { class: `xp-conf ${xp.confidence}` }, `確かさ ${conf}`),
      `記録${xp.loggedDays}日・体重${xp.weighIns}回・${xp.spanDays}日間　式より${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}`));
    if (xp.excluded) box.append(el('div', { class: 'xp-meta' }, `記録が少なすぎる${xp.excluded}日は、書き忘れとみなして外しました。`));
    if (xp.confidence === 'low') box.append(el('div', { class: 'xp-meta' }, '確かさが「中」になるまでは、上限には使いません。'));
  } else {
    const need = expenditureNeeds(all, { floorKcal: expenditureFloor(s, weightKg() ?? 70), today: state.realToday });
    const parts = [];
    if (need.days) parts.push(`食事の記録${need.days}日`);
    if (need.weights) parts.push(`体重${need.weights}回`);
    else if (need.span) parts.push(`体重を量る期間${need.span}日`);
    box.append(el('div', { class: 'xp-meta' }, `まだ出せません。あと${parts.join('・')}で出せます。`));
    if (need.excluded) box.append(el('div', { class: 'xp-meta' }, `記録が少なすぎる${need.excluded}日は、書き忘れとみなして数えていません。`));
  }

  box.append(el('div', { class: 'xp-foot' },
    el('span', {}, b.adaptive ? 'いまの上限は実測から' : on ? '実測が使えるようになったら切り替えます' : 'いまの上限は式から'),
    el('button', {
      class: `btn sm${on ? '' : ' primary'}`,
      // 保存すると refresh → 購読でこのタブが描き直される
      onclick: (e) => { e.currentTarget.disabled = true; saveSettings({ goal: { ...s.goal, useAdaptive: !on } }); },
    }, on ? '式に戻す' : '上限に使う')));
  return card;
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
  tip.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') tip.hidden = true; });
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
    // 指で触ると離した瞬間に pointerleave が来て、読む前に消えていた。指のときは残す
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && e.relatedTarget !== tip) tip.hidden = true; });
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
  tip.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') tip.hidden = true; });
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
        ? `${jpDate(r.day)}　${fmt(r.kcal)}kcal（P${r0(r.p)} F${r0(r.f)} C${r0(r.c)}） ›`
        : `${jpDate(r.day)}　記録なし ›`;
      tip.onclick = () => openDay(r.day);
      tip.classList.add('go');
      tip.style.left = `${(cx / W) * 100}%`;
      tip.style.top = `${(y(Math.max(r.kcal, budget * 0.2)) / H) * 100}%`;
      tip.hidden = false;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    // 指で触ると離した瞬間に pointerleave が来て、読む前に消えていた。指のときは残す
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && e.relatedTarget !== tip) tip.hidden = true; });
    svg.append(hit);
  });

  // 上限ライン（最前面）
  svg.append(svgEl('line', { class: 'refline', x1: ML, x2: W - MR, y1: y(budget), y2: y(budget) }));

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
    tb.append(el('tr', { class: 'tap', onclick: () => openDay(r.day) },
      el('td', {}, jpDate(r.day), ' ›'),
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
