// 帯をタップすると開く内訳。
// 上限や目標の数字が「どこから来たのか」を見せる場所。ここが無いと、設定を変えても
// なぜ数字が動いたのか分からない。

import { $, el, fmt, r0, r1, jpDate, sumItems } from '../util.js';
import { state, remaining, weightKg } from '../store.js';
import { ACTIVITY_LEVELS } from '../nutrition.js';

let nav = null;
let wrap = null;

export function mount(opts) {
  nav = opts.navigate;
  wrap = $('#sheet');
  // 外側（暗い部分）をタップしたら閉じる。中身のタップは拾わない。
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

export function isOpen() { return !!wrap && !wrap.hidden; }

export function open() {
  if (!wrap) return;
  paint();
  wrap.hidden = false;
  void wrap.offsetHeight;   // ここで一度レイアウトさせる。rAF待ちにすると裏タブで開いたとき透明のままになる
  wrap.classList.add('on');
}

export function close() {
  if (!isOpen()) return;
  wrap.classList.remove('on');
  setTimeout(() => { if (!wrap.classList.contains('on')) wrap.hidden = true; }, 220);
}

/** 開いたまま記録が増えたときのために、中身だけ差し替える。 */
export function onDataChanged() { if (isOpen()) paint(); }

function paint() {
  wrap.textContent = '';
  wrap.append(card());
}

// ---------------------------------------------------------------- 部品

function row(label, value, cls) {
  return el('div', { class: `d-row${cls ? ' ' + cls : ''}` }, el('span', {}, label), el('b', {}, value));
}

function sec(title, ...kids) {
  return el('div', { class: 'd-sec' }, el('h3', {}, title), ...kids);
}

function note(text) { return el('p', { class: 'd-note' }, text); }

// ---------------------------------------------------------------- 中身

function card() {
  const box = el('div', { class: 'sheet' });
  box.append(el('div', { class: 'sheet-grip' }));
  box.append(el('div', { class: 'sheet-head' },
    el('h2', {}, state.isToday ? '今日の内訳' : `${jpDate(state.today)}の内訳`),
    el('button', { class: 'sheet-x', 'aria-label': '閉じる', onclick: close }, '✕')));

  const body = el('div', { class: 'sheet-body' });
  box.append(body);

  if (!state.ready) {
    body.append(
      note(`上限はまだ出せません。${state.missing.join('・')}が分かれば計算できます。`),
      el('div', { class: 'd-foot' },
        el('button', { class: 'btn primary', onclick: () => { close(); nav('settings'); } }, '設定で入れる')));
    return box;
  }

  const b = state.budget;
  const rem = remaining();
  const t = state.targets;
  const kg = weightKg();
  const s = state.settings;

  // ---- いまの数字
  body.append(el('div', { class: 'd-top' },
    el('div', {}, el('em', {}, '上限'), el('b', {}, fmt(b.budget))),
    el('div', {}, el('em', {}, '摂取'), el('b', {}, fmt(state.eaten.kcal))),
    el('div', { class: rem.kcal < 0 ? 'over' : '' }, el('em', {}, '残り'), el('b', {}, fmt(rem.kcal)))));

  // ---- 上限の作り方
  const lv = ACTIVITY_LEVELS.find((l) => l.key === s.profile.activity) || ACTIVITY_LEVELS[0];
  const life = r0(b.base - b.bmr);
  const budgetRows = [
    row(`基礎代謝（${kg}kg・${s.profile.heightCm}cm）`, fmt(b.bmr)),
    row(`生活で動く分（×${lv.factor}）`, `+${fmt(life)}`),
    row('1日に使う分', fmt(b.base), 'sum'),
  ];
  if (b.deficit > 0) budgetRows.push(row(`減らす分（${r1(b.paceKgPerWeek)}kg／週）`, `−${fmt(b.deficit)}`));
  else if (b.deficit < 0) budgetRows.push(row(`増やす分（${r1(Math.abs(b.paceKgPerWeek))}kg／週）`, `+${fmt(-b.deficit)}`));
  if (b.exercise > 0) {
    budgetRows.push(s.addExerciseToBudget
      ? row('運動で足した分', `+${fmt(b.exercise)}`)
      : row('運動（上限には足さない設定）', `${fmt(b.exercise)}`, 'muted'));
  }
  budgetRows.push(row('上限', fmt(b.budget), 'sum total'));
  body.append(sec('上限の作り方', ...budgetRows));

  if (b.cappedByFloor) {
    body.append(note('目標のペースどおりに引くと基礎代謝を割るので、割らないところで止めています。目標の日を後ろへずらすと、この上限は上がります。'));
  }
  if (b.paceTooFast) {
    body.append(note('週1kgを超えるペースを要求されています。落ちるのは水分と筋肉が中心になりがちです。目標の日を延ばすことをおすすめします。'));
  }

  // ---- PFCの決め方
  const anchor = Number(s.goal.targetWeightKg) || kg;
  const macros = [
    ['p', 'P たんぱく質', t.p, state.eaten.p, `目標体重 ${anchor}kg × ${r1(s.macro.proteinGPerKg)}g`],
    ['f', 'F 脂質', t.f, state.eaten.f, `上限の ${Math.round(s.macro.fatPctOfKcal * 100)}%`],
    ['c', 'C 炭水化物', t.c, state.eaten.c, 'PとFを引いた残り'],
  ];
  const macBox = macros.map(([k, label, tgt, got, rule]) => {
    const over = got - tgt;
    return el('div', { class: 'd-mac' },
      el('div', { class: 'd-mac-h' },
        el('i', { class: `dot ${k}` }),
        el('span', {}, label),
        el('b', {}, `${fmt(got)} / ${fmt(tgt)} g`),
        over > 0.5 ? el('em', {}, `+${fmt(r0(over))}`) : null),
      el('div', { class: 'd-mac-s' }, rule));
  });
  body.append(sec('PFCの決め方', ...macBox));

  // ---- 今日どこで使ったか
  const bySlot = new Map();
  for (const m of state.meals) {
    const k = m.slot || 'その他';
    bySlot.set(k, (bySlot.get(k) || 0) + sumItems(m.items).kcal);
  }
  const slotRows = ['朝', '昼', '夜', '間食'].map((k) => {
    const v = bySlot.get(k);
    return row(k, v ? fmt(r0(v)) : '—', v ? '' : 'muted');
  });
  for (const [k, v] of bySlot) {
    if (!['朝', '昼', '夜', '間食'].includes(k)) slotRows.push(row(k, fmt(r0(v))));
  }
  if (state.activities.length) {
    const names = state.activities.map((a) => a.name).filter(Boolean).join('・');
    slotRows.push(row(`運動${names ? `（${names}）` : ''}`, `+${fmt(state.exerciseKcal)}`, 'ex'));
  }
  body.append(sec('この日の使いみち', ...slotRows));

  // ---- 行き先
  body.append(el('div', { class: 'd-foot' },
    el('button', { class: 'btn', onclick: () => { close(); nav('today'); } }, '記録を見る'),
    el('button', { class: 'btn', onclick: () => { close(); nav('settings'); } }, '目標を見直す')));

  return box;
}
