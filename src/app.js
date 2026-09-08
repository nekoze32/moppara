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
  chat.mount({ navigate, editMeal: (id) => today.openMeal(id) });
  today.mount({ navigate });
  trend.mount();
  settings.mount();

  $$('#tabbar .tab').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.go)));
  $('#statusbar').addEventListener('click', () => navigate('today'));
  $('#fab').addEventListener('click', () => { if (current !== 'chat') navigate('chat'); $('#photo-input').click(); });
  $('#statusbar').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') navigate('today'); });

  onChange(() => {
    paintStatusBar();
    chat.onDataChanged();
    if (current === 'today') today.render();
    if (current === 'trend') trend.render();
  });

  paintStatusBar();
  bindCollapse();

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
  setInterval(() => { if (state.realToday !== currentDay()) refresh(); }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.realToday !== currentDay()) refresh();
  });

  navigate(hasKey() ? 'chat' : 'welcome');   // 初回もここを通す。通さないとFABが出ない

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/**
 * 上部の帯は縦幅を取る。下へスクロールしたら畳み、上に戻れば開く。
 * チャットは下寄せで scrollTop が動きにくいので、入力欄のフォーカスでも畳む。
 * 40px で畳み 10px で開く（ヒステリシス）。境目で震えないため。
 */
function bindCollapse() {
  const bar = $('#statusbar');
  let byScroll = false, byFocus = false;
  const apply = () => bar.classList.toggle('compact', byScroll || byFocus);

  // 一覧系：上から40pxで畳み、10px未満で開く
  const watchTop = (node) => {
    node.addEventListener('scroll', () => {
      const y = node.scrollTop;
      if (!byScroll && y > 40) { byScroll = true; apply(); }
      else if (byScroll && y < 10) { byScroll = false; apply(); }
    }, { passive: true });
  };
  // チャット：下端が基準。過去ログへ40px以上さかのぼったら畳み、下端に戻れば開く
  const watchBottom = (node) => {
    node.addEventListener('scroll', () => {
      const d = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (!byScroll && d > 40) { byScroll = true; apply(); }
      else if (byScroll && d < 10) { byScroll = false; apply(); }
    }, { passive: true });
  };
  for (const s of $$('.scroll')) watchTop(s);
  watchBottom($('#chat-log'));

  const input = $('#chat-input');
  input.addEventListener('focus', () => { byFocus = true; apply(); });
  input.addEventListener('blur', () => { byFocus = false; apply(); });

  bar.__recheck = () => {
    const log = $('#screen-chat:not([hidden]) #chat-log');
    if (log) byScroll = (log.scrollHeight - log.scrollTop - log.clientHeight) > 40;
    else { const cur = $('.screen:not([hidden]) .scroll'); byScroll = !!cur && cur.scrollTop > 40; }
    apply();
  };
}

function navigate(name) {
  current = name;
  document.body.classList.toggle('onboarding', name === 'welcome');
  $('#fab').hidden = !(name === 'chat' || name === 'today');
  for (const s of $$('.screen')) s.hidden = s.dataset.screen !== name;
  for (const b of $$('#tabbar .tab')) b.classList.toggle('is-on', b.dataset.go === name);
  if (name === 'welcome') welcome.render();
  $('#statusbar').__recheck?.();
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
    $('#sb-detail').textContent = '';
    const m0 = $('#sb-macros');
    m0.textContent = '';
    m0.append(el('div', { class: 'sb-setup' }, `あと ${state.missing.join('・')}。チャットで教えてください。`));
    $('#mini-label').textContent = '設定がまだです';
    $('#mini-date').textContent = jpDate(state.today);
    return;
  }
  bar.classList.remove('setup');

  const rem = remaining();
  const b = state.budget;
  const over = rem.kcal < 0;
  const tight = !over && rem.pct > 0.85;
  bar.classList.toggle('over', over);
  bar.classList.toggle('tight', tight);

  setLabel(state.isToday ? (over ? '超過' : '残り') : (over ? `${jpDate(state.today)} の超過` : `${jpDate(state.today)} の残り`));

  // 数字が変わったときだけ小さく動かす
  const kcalEl = $('#sb-kcal');
  const next = over ? `+${fmt(-rem.kcal)}` : fmt(rem.kcal);
  if (kcalEl.textContent !== next) {
    kcalEl.textContent = next;
    kcalEl.classList.remove('changed');
    void kcalEl.offsetWidth;
    kcalEl.classList.add('changed');
  }
  $('#sb-unit').textContent = 'kcal';
  $('#mini-kcal').textContent = next;
  $('#mini-label').textContent = $('#sb-label').textContent;
  $('#mini-date').textContent = state.isToday ? jpDate(state.today) : '過去の日';

  // リング：食べた割合
  const C = 251.3;
  const pct = clamp(rem.pct, 0, 1);
  const ring = $('#sb-ring');
  ring.setAttribute('stroke-dasharray', `${(C * pct).toFixed(1)} ${C}`);
  ring.classList.toggle('over', over);
  ring.classList.toggle('tight', tight);
  $('#sb-pct').textContent = `${Math.round(rem.pct * 100)}%`;

  // PFCは3枚の小さなタイル。幅はそれぞれの達成率
  const t = state.targets || { p: 0, f: 0, c: 0 };
  const m = $('#sb-macros');
  m.textContent = '';
  for (const [k, got, tgt, v] of [['p', state.eaten.p, t.p, rem.p], ['f', state.eaten.f, t.f, rem.f], ['c', state.eaten.c, t.c, rem.c]]) {
    const w = clamp(tgt > 0 ? got / tgt : 0, 0, 1) * 100;
    m.append(el('div', { class: `mac ${k}` },
      el('i', {}, el('b', { style: `width:${w.toFixed(0)}%` })),
      el('span', {}, k.toUpperCase(), el('em', {}, `${v}`))));
  }

  $('#sb-date').textContent = state.isToday ? jpDate(state.today) : '過去の日を見ています';
  $('#sb-detail').textContent =
    `上限 ${fmt(b?.budget)} ／ 摂取 ${fmt(state.eaten.kcal)}` + (b?.exercise ? ` ／ 運動 +${fmt(b.exercise)}` : '');
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
