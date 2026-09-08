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
/**
 * 帯の畳み込み。帯は中身の上に重ねてあり、縮んでも下の領域は動かない。
 * 縮む量 --c は時間でなくスクロール量から決める（一覧：上からの距離、チャット：下端からの距離）。
 * 入力欄のフォーカス（キーボード）だけはスクロールが無いので、260msの補間で寄せる。
 */
function bindCollapse() {
  const bar = $('#statusbar');
  const hero = $('.hero');
  const foot = $('.sb-foot');
  let range = 110;
  let scrollC = 0, focusC = 0, tween = null;

  // 開いた状態の帯の高さ。中身の高さは --c に関係なく測れる
  const measure = () => {
    const cs = getComputedStyle(bar);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const heroH = hero.offsetHeight + foot.offsetHeight;
    // 画面の4割より高い帯はあり得ない（本番の別環境で 857px を返した例あり）。
    // 誤った値で中身を画面外へ押し出すより、前回の正しい値を使い続けるほうが安全。
    // innerHeight は非表示のタブで 0 になることがある（本番の検証ペインで実測）。0 を基準にすると正しい値まで捨てる
    if (heroH <= 0 || heroH > Math.max(innerHeight, 480) * 0.4) return;
    bar.style.setProperty('--hero-h', `${heroH}px`);
    document.documentElement.style.setProperty('--bar-h', `${Math.round(pad + heroH)}px`);
    range = Math.max(60, heroH - 44);     // 畳み切ったときに1行（約44px）が残る
  };
  const paint = () => {
    const c = Math.max(scrollC, focusC);
    bar.style.setProperty('--fold', c.toFixed(3));
    bar.classList.toggle('pill-active', c > 0.6);
  };

  const watchTop = (node) => node.addEventListener('scroll', () => {
    scrollC = clamp(node.scrollTop / range, 0, 1); paint();
  }, { passive: true });
  const watchBottom = (node) => node.addEventListener('scroll', () => {
    const d = node.scrollHeight - node.scrollTop - node.clientHeight;
    scrollC = clamp(d / range, 0, 1); paint();
  }, { passive: true });
  for (const s of $$('.scroll')) watchTop(s);
  watchBottom($('#chat-log'));

  const tweenFocus = (to) => {
    if (tween) cancelAnimationFrame(tween);
    const from = focusC, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 260);
      const e = 1 - Math.pow(1 - k, 3);
      focusC = from + (to - from) * e; paint();
      if (k < 1) tween = requestAnimationFrame(step); else tween = null;
    };
    tween = requestAnimationFrame(step);
  };
  const input = $('#chat-input');
  input.addEventListener('focus', () => tweenFocus(1));
  input.addEventListener('blur', () => tweenFocus(0));

  bar.__measure = measure;
  bar.__recheck = () => {
    const log = $('#screen-chat:not([hidden]) #chat-log');
    if (log) scrollC = clamp((log.scrollHeight - log.scrollTop - log.clientHeight) / range, 0, 1);
    else { const cur = $('.screen:not([hidden]) .scroll'); scrollC = cur ? clamp(cur.scrollTop / range, 0, 1) : 0; }
    paint();
  };
  measure();
  window.addEventListener('resize', measure);
  if (document.fonts?.ready) document.fonts.ready.then(measure);
  paint();
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
  queueMicrotask(() => bar.__measure?.());
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
    $('#mini-pfc').textContent = '';
    return;
  }
  bar.classList.remove('setup');

  const rem = remaining();
  const b = state.budget;
  // PFCの目標と摂取。帯の本体とpillの両方で使うので、どちらより先に用意する
  const t = state.targets || { p: 0, f: 0, c: 0 };
  const macros = [['p', state.eaten.p, t.p], ['f', state.eaten.f, t.f], ['c', state.eaten.c, t.c]];
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
  // 縮めた帯の右側は、数字でなく小さなバー3本（達成率が一目で分かる）
  const mp = $('#mini-pfc');
  mp.textContent = '';
  for (const [k, got, tgt] of macros) {
    const ratio = tgt > 0 ? got / tgt : 0;
    mp.append(el('span', { class: `${k}${ratio > 1.001 ? ' over' : ''}` },
      k.toUpperCase(), el('i', { class: 'sbar' }, el('b', { style: `width:${(clamp(ratio, 0, 1) * 100).toFixed(0)}%` }))));
  }

  // リング：食べた割合
  const C = 251.3;
  const pct = clamp(rem.pct, 0, 1);
  const ring = $('#sb-ring');
  ring.setAttribute('stroke-dasharray', `${(C * pct).toFixed(1)} ${C}`);
  ring.classList.toggle('over', over);
  ring.classList.toggle('tight', tight);
  $('#sb-pct').textContent = `${Math.round(rem.pct * 100)}%`;

  // PFCは「摂取／目標」のバー。残りの数字だけでは目標の何割か分からない。超えたら朱。
  const m = $('#sb-macros');
  m.textContent = '';
  for (const [k, got, tgt] of macros) {
    const ratio = tgt > 0 ? got / tgt : 0;
    const w = clamp(ratio, 0, 1) * 100;
    const isOver = ratio > 1.001;
    m.append(el('div', { class: `mrow ${k}${isOver ? ' over' : ''}` },
      el('span', { class: 'ml' }, k.toUpperCase()),
      el('i', { class: 'bar' }, el('b', { style: `width:${w.toFixed(0)}%` })),
      el('span', { class: 'v' }, el('b', {}, `${r0(got)}`), ` / ${r0(tgt)} g`, isOver ? el('em', {}, ` +${r0(got - tgt)}`) : null)));
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
