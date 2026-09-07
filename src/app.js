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
  if (!state.ready) {
    bar.classList.remove('over', 'tight');
    $('#sb-kcal').textContent = '—';
    $('#statusbar .sb-unit').textContent = 'まだ計算できません';
    $('#sb-date').textContent = jpDate(state.today);
    const m0 = $('#sb-macros');
    m0.textContent = '';
    m0.append(el('span', {}, `チャットで ${state.missing.join('・')} を教えてください`));
    $('#sb-bar-fill').style.width = '0%';
    return;
  }
  const rem = remaining();
  const over = rem.kcal < 0;
  const tight = !over && rem.pct > 0.85;
  bar.classList.toggle('over', over);
  bar.classList.toggle('tight', tight);

  $('#sb-kcal').textContent = over ? `+${fmt(-rem.kcal)}` : fmt(rem.kcal);
  $('#statusbar .sb-unit').textContent = over ? 'kcal 超過' : 'kcal 残り';
  $('#sb-date').textContent = `${jpDate(state.today)}　上限 ${fmt(state.budget?.budget)}`;

  const m = $('#sb-macros');
  m.textContent = '';
  const rows = [['P', rem.p, 'm-p'], ['F', rem.f, 'm-f'], ['C', rem.c, 'm-c']];
  for (const [label, v, cls] of rows) {
    m.append(el('span', { class: cls }, `${label} 残り `, el('b', {}, `${v}g`)));
  }

  const fill = $('#sb-bar-fill');
  fill.style.width = `${clamp(rem.pct * 100, 0, 100)}%`;
  fill.classList.toggle('over', over);
  fill.classList.toggle('tight', tight);
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
