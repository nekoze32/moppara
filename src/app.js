// 起動と画面の切り替え。

import { $, $$, el, fmt, r0, clamp, jpDate, uid, toast } from './util.js';
import * as db from './db.js';
import { init as initStore, onChange, state, remaining, refresh, currentDay, hasKey } from './store.js';
import * as welcome from './views/welcome.js';
import * as chat from './views/chat.js';
import * as today from './views/today.js';
import * as trend from './views/trend.js';
import * as settings from './views/settings.js';

let current = 'chat';

async function boot() {
  settings.applyTheme();
  await initStore();

  welcome.mount({ navigate });
  chat.mount({ navigate });
  today.mount({ navigate });
  trend.mount();
  settings.mount();

  $$('#tabbar .tab').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.go)));
  $('#statusbar').addEventListener('click', () => navigate('today'));
  $('#statusbar').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') navigate('today'); });

  onChange(() => {
    paintStatusBar();
    chat.onDataChanged();
    if (current === 'today') today.render();
    if (current === 'trend') trend.render();
  });

  paintStatusBar();

  if (state.storageError) {
    const w = $('#warnbar');
    w.textContent = '';
    w.append(
      el('div', {}, `記録を保存できません：${state.storageError}`),
      el('div', { style: 'margin-top:3px;opacity:.85' },
        'ほかのタブでこのアプリを開いていないか確かめて、開き直してください。いま入れたものは残りません。'));
    w.hidden = false;
  }

  await handleHash();
  window.addEventListener('hashchange', handleHash);

  // 日付が変わったら今日を切り替える
  setInterval(() => { if (state.today !== currentDay()) refresh(); }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.today !== currentDay()) refresh();
  });

  if (!hasKey()) navigate('welcome');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function navigate(name) {
  current = name;
  document.body.classList.toggle('onboarding', name === 'welcome');
  for (const s of $$('.screen')) s.hidden = s.dataset.screen !== name;
  for (const b of $$('#tabbar .tab')) b.classList.toggle('is-on', b.dataset.go === name);
  if (name === 'welcome') welcome.render();
  if (name === 'today') today.render();
  if (name === 'trend') trend.render();
  if (name === 'settings') settings.render();
}

function paintStatusBar() {
  const bar = $('#statusbar');
  const setLabel = (t) => { $('#sb-label').textContent = t; };

  if (!state.ready) {
    bar.classList.remove('over', 'tight');
    bar.classList.add('setup');
    setLabel('設定がまだです');
    $('#sb-date').textContent = jpDate(state.today);
    $('#sb-bar').textContent = '';
    const m0 = $('#sb-macros');
    m0.textContent = '';
    m0.append(el('span', { class: 'sb-setup' },
      `あと ${state.missing.join('・')}。チャットで教えてください。`));
    return;
  }
  bar.classList.remove('setup');

  const rem = remaining();
  const b = state.budget;
  const over = rem.kcal < 0;
  const tight = !over && rem.pct > 0.85;
  bar.classList.toggle('over', over);
  bar.classList.toggle('tight', tight);

  setLabel(over ? '超過' : '残り');
  // 数字が変わったときだけ小さく動かす。無音で書き換わると気づけない。
  const kcalEl = $('#sb-kcal');
  const next = over ? `+${fmt(-rem.kcal)}` : fmt(rem.kcal);
  if (kcalEl.textContent !== next) {
    kcalEl.textContent = next;
    kcalEl.classList.remove('changed');
    void kcalEl.offsetWidth;          // アニメーションを鳴らし直す
    kcalEl.classList.add('changed');
  }
  $('#sb-unit').textContent = 'kcal';
  $('#sb-date').textContent = jpDate(state.today);
  $('#sb-detail').textContent =
    `上限 ${fmt(b?.budget)} ／ 摂取 ${fmt(state.eaten.kcal)}` + (b?.exercise ? ` ／ 運動 +${fmt(b.exercise)}` : '');

  // PFCは1本のレールに束ねる。摂取したぶんだけ色が伸びる。
  // 幅はグラムでなく kcal 換算（P4/F9/C4）。でないと脂質1gと炭水化物1gが同じ幅になり、
  // 見た目が炭水化物に偏る。カロリー基準なら帯の数字と話が合う。
  const rail = $('#sb-bar');
  rail.textContent = '';
  const t = state.targets || { p: 0, f: 0, c: 0 };
  const KC = { p: 4, f: 9, c: 4 };
  const totalKcal = t.p * KC.p + t.f * KC.f + t.c * KC.c || 1;
  for (const [k, got, tgt] of [['p', state.eaten.p, t.p], ['f', state.eaten.f, t.f], ['c', state.eaten.c, t.c]]) {
    const share = ((tgt * KC[k]) / totalKcal) * 100;           // その栄養素が持つ幅
    const fill = clamp(tgt > 0 ? got / tgt : 0, 0, 1) * share; // うち摂った分
    rail.append(el('i', { class: k, style: `width:${fill.toFixed(1)}%` }));
  }

  const m = $('#sb-macros');
  m.textContent = '';
  for (const [label, v, cls] of [['P', rem.p, 'm-p'], ['F', rem.f, 'm-f'], ['C', rem.c, 'm-c']]) {
    m.append(el('span', { class: cls }, el('em', {}), `${label} 残り `, el('b', {}, `${v}g`)));
  }
}

// ---------------------------------------------------------------- ショートカット連携
// 例: .../#health?ae=520&w=72.4   （iPhoneの「ショートカット」から開く）

async function handleHash() {
  const h = location.hash || '';
  if (!h.startsWith('#health')) return;
  const q = new URLSearchParams(h.slice(h.indexOf('?') + 1));
  const ae = Number(q.get('ae'));
  const w = Number(q.get('w'));
  const done = [];

  if (ae > 0) {
    const day = currentDay();
    const acts = await db.activitiesOf(day);
    const prev = acts.find((a) => a.source === 'health');
    if (prev) await db.delActivity(prev.id);
    await db.putActivity({
      id: uid(), day, at: new Date().toISOString(),
      name: 'ヘルスケア（アクティブエネルギー）', kcal: r0(ae), minutes: null, source: 'health',
    });
    done.push(`運動 ${fmt(ae)}kcal`);
  }
  if (w > 20 && w < 300) {
    await db.putWeight({ day: currentDay(), kg: Math.round(w * 10) / 10, fatPct: null, at: new Date().toISOString() });
    done.push(`体重 ${Math.round(w * 10) / 10}kg`);
  }

  history.replaceState(null, '', location.pathname + location.search);
  if (done.length) {
    await refresh();
    toast(`ヘルスケアから取り込みました：${done.join(' / ')}`, 3200);
    navigate('today');
  }
}

boot();
