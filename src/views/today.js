// 今日タブ＝帳面。読むのが主で、書くのは「登録済み／修正」の形に揃える。
// 入力欄を出しっぱなしにしない（何度も登録できてしまうため）。

import { $, el, fmt, r0, r1, hhmm, uid, toast, undoToast, sumItems, jpDate, addDays } from '../util.js';
import * as db from '../db.js';
import { state, refresh, currentDay, targetDay, setViewDay, goToday, weightKg, recentMeals, noteRecord, remaining, streakDays } from '../store.js';
import { reserveSlot } from './chat.js';
import { doExport, daysSinceExport } from './settings.js';

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

  root.append(dateNav(), momentCard(), sectionMeals(), sectionWeight(), sectionActivity());
  backupNudge();
  if (state.presets.length) root.append(sectionPresets());
  root.append(el('div', { class: 'faint', style: 'padding:4px 0 8px' },
    '行をタップすると直せます。'));
}

/**
 * 記録は端末にしか無い。2週間書き出していなければ一度だけ下に出す。
 * 消えてから気づいても戻せないので、黙っていない。
 */
function backupNudge() {
  const since = daysSinceExport();
  if (since != null && since < 14) return;
  const slot = el('div');
  root.append(slot);
  db.mealDays().then((days) => {
    if (!days.length) return;
    const firstDay = days[0];
    const kept = Math.round((Date.parse(currentDay()) - Date.parse(firstDay)) / 86400000);
    if (since == null && kept < 14) return;
    slot.append(el('div', { class: 'banner' },
      since == null ? `${kept}日分の記録が、この端末の中だけにあります。` : `最後に書き出してから${since}日たちました。`,
      el('div', {}, el('button', { class: 'btn sm primary', onclick: doExport }, 'いま書き出す'))));
  }).catch(() => { /* 催促が出ないだけ */ });
}

// ---------------------------------------------------------------- 献立

const SLOTS = ['朝', '昼', '夜', '間食'];

/** 記録した直後だけ出る。数字が減るだけで終わらせない。 */
function momentCard() {
  const r = state.lastRecord;
  if (!r || !state.isToday || Date.now() - r.at > 10 * 60 * 1000) return document.createDocumentFragment();
  const rem = remaining();
  let next;
  if (rem.kcal < 0) next = `今日は ${fmt(-rem.kcal)} kcal 超えました。明日で均せます。`;
  else if (rem.kcal < 300) next = `残り ${fmt(rem.kcal)} kcal。軽めの一品で締めるところです。`;
  else if (rem.f < 0) next = `残り ${fmt(rem.kcal)} kcal。脂質はもう超えたので、揚げ物を避けて鶏むね・魚・豆腐を。`;
  else if (rem.p > 25 && r.p < 20) next = `残り ${fmt(rem.kcal)} kcal。たんぱく質があと ${rem.p}g、肉か魚を。`;
  else if (rem.kcal >= 600) next = `残り ${fmt(rem.kcal)} kcal。定食が入ります。`;
  else next = `残り ${fmt(rem.kcal)} kcal。丼より、主菜と汁物くらいに。`;
  const names = String(r.label).split('・');
  const label = names.length > 3 ? `${names.slice(0, 2).join('・')} ほか${names.length - 2}品` : r.label;
  return el('div', { class: 'moment' },
    el('div', { class: 'chk' }, '✓'),
    el('div', { class: 'mt' }, `${label} を記録。`, el('b', {}, next)));
}

/** 品目が多い食事は「先頭2つ ほかN品」。全部並べると1行が画面3つ分になっていた */
function mealTitle(items) {
  const names = items.map((i) => i.name);
  return names.length <= 3 ? names.join('・') : `${names.slice(0, 2).join('・')} ほか${names.length - 2}品`;
}

/** 前後の日へ。昨日の食べ忘れを翌朝入れる、が一番ありがちな場面。 */
function dateNav() {
  // 子は el() に渡す。生の append は null を文字列 "null" にする（2回踏んだ）
  const streak = el('span', { class: 'dn-streak' });
  if (state.isToday) {
    streakDays().then(({ days, todayDone }) => {
      if (days < 2) return;
      streak.textContent = todayDone ? `${days}日連続` : `${days}日連続中。今日の分で${days + 1}日`;
    });
  }
  return el('div', { class: 'datenav' },
    el('button', { class: 'dn-btn', onclick: () => setViewDay(addDays(state.today, -1)) }, '‹'),
    el('span', { class: 'dn-day' }, state.isToday ? `今日　${jpDate(state.today)}` : jpDate(state.today), streak),
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
    if (!rows.length && openSlot !== slot) {
      const rem = remaining();
      box.append(el('div', { class: 'slot-empty', onclick: () => { openSlot = slot; editing = null; render(); } },
        el('span', {}, rem.kcal > 0 ? el('span', {}, 'まだ', el('b', {}, fmt(rem.kcal), ' kcal'), '入ります') : 'まだ記録なし'),
        el('span', {}, '›')));
    }
  }

  const all = sumItems(state.meals.flatMap((m) => m.items));
  box.append(el('div', { class: 'sumrow' }, el('span', {}, '計'), el('b', {}, fmt(all.kcal), ' kcal')));
  return box;
}

/**
 * ＋を押すと出る板。上から「よく食べるもの（1タップ）」「数値で入れる」「写真・文章で」。
 * AIを通さない道を先に置く。
 */
function addPanel(slot) {
  const panel = el('div', { class: 'addpanel' });

  // 朝は毎日ほぼ同じ、という人が多い。前日の同じ区分を丸ごと写せるようにする
  const prevDay = addDays(state.today, -1);
  const copyBox = el('div');
  panel.append(copyBox);
  db.mealsOf(prevDay).then((ms) => {
    const rows = ms.filter((m) => m.slot === slot);
    if (!rows.length) return;
    const t = sumItems(rows.flatMap((m) => m.items));
    copyBox.append(el('button', {
      class: 'btn sm', style: 'width:100%;margin-bottom:6px',
      onclick: async () => {
        const ids = [];
        for (const m of rows) {
          const id = uid(); ids.push(id);
          await db.putMeal({ id, day: targetDay(), at: stampFor(targetDay()), slot, items: structuredClone(m.items), thumb: m.thumb || null, source: 'copy' });
        }
        openSlot = null;
        noteRecord(`前日の${slot}`, t.kcal, t.p);
        await refresh();
        undoToast(`前日の${slot}（${fmt(t.kcal)} kcal）を写しました`, async () => { for (const id of ids) await db.delMeal(id); await refresh(); });
      },
    }, `前日の${slot}をそのまま（${fmt(t.kcal)} kcal）`));
  });

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
          noteRecord(r.label, sumItems(r.items).kcal, sumItems(r.items).p);
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
          noteRecord(nm.value.trim(), Math.round(kcal), Number(pp.value) || 0);
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
  const ph = el('div', { class: `ph s-${m.slot}${m.thumb ? ' has' : ''}` });
  if (m.thumb) ph.style.backgroundImage = `url(${m.thumb})`;
  return el('div', { class: 'meal', onclick: () => { editing = m.id; render(); } },
    ph,
    el('div', { class: 'm-body' },
      el('div', { class: 'm-slot' }, `${hhmm(m.at)}${m.items.length === 1 && m.items[0].amount ? '　' + m.items[0].amount : ''}`),
      el('div', { class: 'm-name' }, mealTitle(m.items)),
      el('div', { class: 'm-kcal' }, fmt(t.kcal), el('small', {}, 'kcal')),
      el('div', { class: 'm-macro' }, `P ${r1(t.p)}　F ${r1(t.f)}　C ${r1(t.c)}`)));
}

/** 行をタップすると開く。品目ごとのkcalを直すとPFCも比例で動く。 */
function mealEditor(m) {
  const items = m.items.map((i) => ({ ...i, b: { kcal: i.kcal || 1, p: i.p, f: i.f, c: i.c } }));
  let dirty = false;
  const box = el('div', { class: 'mealedit' });

  const save = async () => {
    const kept = items.filter((i) => !i.removed).map(({ name, amount, kcal, p, f, c }) => ({ name, amount, kcal, p, f, c }));
    if (!kept.length) { await removeMeal(m); return; }   // 全部外したなら食事ごと消す（取り消せる）
    await db.putMeal({ ...m, slot: slot.value, items: kept });
    editing = null;
    await refresh();
    toast('直しました');
  };

  // 入力欄・ボタン以外を叩いたら「閉じたい」と受け取る。
  // 変えた内容は捨てずに保存してから閉じる（「やめる」は捨てる側の道として残す）。
  box.addEventListener('click', (e) => {
    if (e.target.closest('input, select, button, textarea, label, a, .ufi, .m-add')) return;
    if (addName.value.trim() || addKcal.value) { toast('足す品目が入ったままです。「足す」を押すか、欄を空にしてください'); return; }
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
    const t = sumItems(items.filter((i) => !i.removed));
    totalKcal.textContent = `${fmt(t.kcal)} kcal`;
    totalMacro.textContent = `P ${r1(t.p)}　F ${r1(t.f)}　C ${r1(t.c)}`;
  };

  const list = el('div');
  const drawItem = (it) => {
    const inp = el('input', { type: 'number', inputmode: 'numeric', step: '10', value: String(it.kcal), 'aria-label': `${it.name} kcal` });
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
    const line = el('div', { class: 'mrow' },
      el('span', { class: 'n' }, it.name, it.amount ? el('small', {}, it.amount) : null),
      el('span', { class: 'ufi' }, inp, el('em', {}, 'kcal')),
      el('button', { class: 'm-x', 'aria-label': `${it.name}を外す`, onclick: () => { it.removed = true; dirty = true; line.remove(); recalc(); } }, '×'));
    list.append(line);
  };
  items.forEach(drawItem);
  box.append(list);

  // 食べ足したもの（食後のデザートなど）を同じ食事に足す。PFCは分からなければ0のまま
  const addName = el('input', { type: 'text', placeholder: '品目を足す', 'aria-label': '足す品目' });
  const addKcal = el('input', { type: 'number', inputmode: 'numeric', placeholder: 'kcal', 'aria-label': '足す品目 kcal' });
  box.append(el('div', { class: 'm-add' }, addName, addKcal,
    el('button', {
      class: 'btn sm', onclick: () => {
        const v = Number(addKcal.value);
        if (!addName.value.trim() || !(v >= 0) || addKcal.value === '') { toast('品名とkcalを入れてください'); return; }
        const it = { name: addName.value.trim(), amount: '', kcal: Math.round(v), p: 0, f: 0, c: 0, b: { kcal: Math.round(v) || 1, p: 0, f: 0, c: 0 } };
        items.push(it); drawItem(it); dirty = true; recalc();
        addName.value = ''; addKcal.value = '';
      },
    }, '足す')));
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
        el('button', { class: 's-fix', onclick: () => { editing = 'weight'; render(); } }, '入れる')));
      return box;
    }
    const kg = el('input', { type: 'number', step: '0.1', inputmode: 'decimal', value: w?.kg ?? '', placeholder: `体重 kg${weightKg() ? `（前回 ${weightKg()}）` : ''}`, 'aria-label': '体重 kg' });
    const fat = el('input', { type: 'number', step: '0.1', inputmode: 'decimal', value: w?.fatPct ?? '', placeholder: '体脂肪率 %（任意）', 'aria-label': '体脂肪率 %' });
    box.append(el('div', { class: 'editline' }, unitField('体重', kg, 'kg'), unitField('体脂肪率', fat, '%'),
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
    const nm = el('input', { type: 'text', placeholder: '例：ランニング', 'aria-label': '種目' });
    const kc = el('input', { type: 'number', inputmode: 'numeric', placeholder: '消費', 'aria-label': '消費カロリー kcal' });
    box.append(el('div', { class: 'editline' }, unitField('種目', nm, ''), unitField('消費', kc, 'kcal'),
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
      el('button', { class: 's-fix', onclick: () => { editing = 'activity'; render(); } }, '追加')));
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

/** 入力欄に見出しと単位を付ける。数字だけの箱では何を入れるのか分からなかった */
function unitField(label, input, unit) {
  return el('label', { class: 'ufield' }, el('span', { class: 'ufl' }, label),
    el('span', { class: 'ufi' }, input, unit ? el('em', {}, unit) : null));
}

function slotNow() {
  const h = new Date().getHours();
  return h < 10 ? '朝' : h < 15 ? '昼' : h < 22 ? '夜' : '間食';
}
