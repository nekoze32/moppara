// チャット。ここが全ての入口：写真・一言の記録も、体重も、運動も、相談も。
// 推定の伝票は DOM でなく DB に持つ（開き直すと消えて「記録済みに見える」ため）。

import { $, el, uid, toast, undoToast, shrinkImage, sumItems, fmt, r1, mealDay, addDays } from '../util.js';
import * as db from '../db.js';
import { state, refresh, currentDay, targetDay, goToday, recentDays, recentMeals, hasKey, applySetup, noteRecord } from '../store.js';
import { ask, AIError } from '../ai.js';
import { ACTIVITY_LEVELS } from '../nutrition.js';
import { contextBlock } from '../prompts.js';

let logEl, inputEl, sendBtn, chipsEl, previewEl, previewImg;
let attached = null;
let busy = false;
let goTab = () => {};
let openMealInToday = () => {};

export function mount({ navigate, editMeal }) {
  goTab = navigate;
  openMealInToday = editMeal || (() => navigate('today'));
  logEl = $('#chat-log');
  inputEl = $('#chat-input');
  sendBtn = $('#send-btn');
  chipsEl = $('#chips');
  previewEl = $('#attach-preview');
  previewImg = $('#attach-img');

  $('#photo-input').addEventListener('change', onPickPhoto);
  $('#attach-clear').addEventListener('click', clearAttachment);
  sendBtn.addEventListener('click', send);

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  });

  // 入力中にログ側を触ったら、キーボードを閉じる（欄の外＝終えたい意図）
  logEl.addEventListener('pointerdown', () => {
    if (document.activeElement === inputEl) inputEl.blur();
  }, { passive: true });

  restore();
  renderChips();
  paintDayNotice();
}

export function onDataChanged() { renderChips(); paintDayNotice(); }

/** 過去日を見ているときだけ、書き込み先を頭に出す。黙って昨日に入るのは事故のもと。 */
function paintDayNotice() {
  let n = $('#chat-daynotice');
  if (state.isToday) { n?.remove(); return; }
  if (!n) {
    n = el('div', { class: 'daynotice', id: 'chat-daynotice' });
    // 入力欄のすぐ上に置く。ログの上に置くと帯の高さぶん押し下げられ、小さい画面で入力欄が画面外に出た
    const comp = $('.composer');
    comp.insertBefore(n, comp.firstChild);
  }
  n.textContent = '';
  n.append(`${jpDateFull(state.today)} に記録します`,
    el('button', { class: 'btn sm', style: 'margin-left:10px', onclick: () => goToday() }, '今日に戻る'));
}
const jpDateFull = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${m}/${dd}`; };

// ---------------------------------------------------------------- 履歴

async function restore() {
  const rows = (await db.allChat()).slice(-60);
  logEl.textContent = '';
  if (!rows.length) { greet(); return; }
  let lastDay = '';
  for (const r of rows) {
    const day = mealDay(new Date(r.at), state.settings.dayCutoffHour);   // at はUTC。切り出すと朝9時前が前日に入る
    if (day !== lastDay) { logEl.append(el('div', { class: 'msg sys' }, dayLabel(day))); lastDay = day; }
    if (r.role === 'user') logEl.append(userBubble(r.text, r.thumb));
    else if (r.role === 'proposal') logEl.append(proposeCard(r));   // 未確定も確定済みも復元する
    else logEl.append(el('div', { class: 'msg ai' }, r.text));
  }
  scrollDown();
}

function dayLabel(day) {
  const today = currentDay();
  if (day === today) return '今日';
  if (day === addDays(today, -1)) return '昨日';
  const [, m, d] = day.split('-').map(Number);
  return `${m}月${d}日`;
}

function greet() {
  const lines = state.ready
    ? ['こんにちは。食べたものを写真か一言で送ってください。', '',
       '  ・写真を撮る（撮ればそのまま解析します。成分表示の写真も読めます）',
       '  ・「かけそばとおにぎり1個」',
       '  ・「体重72.4」「30分走った」',
       '  ・「今夜の外食どこがいい？」', '',
       'よく食べるものは、下のボタンから1タップで入ります。']
    : ['はじめまして。', '',
       '1日にどれくらい食べていいかを出すために、体のことを少しずつ聞きます（5項目・1分ほど）。', '',
       'まず、身長と、いまの体重はどれくらいですか。'];
  logEl.append(el('div', { class: 'msg ai' }, lines.join(String.fromCharCode(10))));
}

// ---------------------------------------------------------------- 入力

async function onPickPhoto(e) {
  // 料理と成分表示、定食の皿を分けて撮った、など1食で数枚になることがある。4枚まで1回で送る
  const files = [...(e.target.files || [])].slice(0, 4);
  e.target.value = '';
  if (!files.length) return;
  if (busy) { toast('前の返事を待っています。届いてから撮り直してください'); return; }
  try {
    const urls = [];
    for (const f of files) urls.push(await shrinkImage(f, 800, 0.72));
    // 撮ったらそのまま解析する。「送信」を挟むと1タップ増えるだけ。
    clearAttachment();
    await sendWith('', urls.length === 1 ? urls[0] : urls);
  } catch (err) {
    toast(err.message || '写真を読めませんでした');
  }
}

function clearAttachment() {
  attached = null;
  previewEl.hidden = true;
  previewImg.removeAttribute('src');
}

async function renderChips() {
  chipsEl.textContent = '';
  if (!state.ready) return;

  // 一度食べたものは、AIを通さず1タップで入れ直せるようにする。
  const recents = await recentMeals(8);
  for (const r of recents) {
    const t = sumItems(r.items);
    chipsEl.append(el('button', { class: 'chip again', onclick: () => logAgain(r) },
      el('b', {}, shorten(r.label)), ` ${fmt(t.kcal)}`));
  }
  if (!state.weight) {
    chipsEl.append(el('button', { class: 'chip', onclick: () => { inputEl.value = '体重 '; inputEl.focus(); } }, '体重'));
  }
  chipsEl.append(el('button', {
    class: 'chip',
    onclick: () => { inputEl.value = state.eaten.kcal > 0 ? '残りで何が食べられる？' : '今日の食事プランを立てて'; send(); },
  }, state.eaten.kcal > 0 ? '残りで何が食べられる？' : '今日のプラン'));
}

const shorten = (s, n = 14) => (s.length > n ? s.slice(0, n) + '…' : s);

async function logAgain(r) {
  const id = uid();
  await db.putMeal({
    id, day: targetDay(), at: stampFor(targetDay()),
    slot: slotNow(), items: structuredClone(r.items), source: 'again',
  });
  noteRecord(r.label, sumItems(r.items).kcal, sumItems(r.items).p);
  await refresh();
  const t = sumItems(r.items);
  logEl.append(el('div', { class: 'msg sys' },
    `${r.label} ${fmt(t.kcal)}kcal を記録（残り ${fmt(state.budget.budget - state.eaten.kcal)}）`));
  scrollDown();
  undoToast(`${shorten(r.label)} を記録しました`, async () => { await db.delMeal(id); await refresh(); });
}

let pendingSlot = null;   // 「今日」の各区分の＋から来たときだけ効く

/** 今日タブの「＋ 朝を記録」などから呼ぶ。次の1件だけこの区分にする。 */
export function reserveSlot(slot) { pendingSlot = slot; }
function takeSlot() { const s = pendingSlot; pendingSlot = null; return s; }
const slotByHour = () => { const h = new Date().getHours(); return h < 10 ? '朝' : h < 15 ? '昼' : h < 22 ? '夜' : '間食'; };
export function slotNow() { return takeSlot() || slotByHour(); }

/** 過去日へ書くときは、その日の同じ時刻にする（時刻順の並びを崩さない）。 */
function stampFor(day) {
  const now = new Date();
  if (day === currentDay()) return now.toISOString();
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds()).toISOString();
}

// ---------------------------------------------------------------- 送信

async function send() {
  const text = inputEl.value.trim();
  if (!text && !attached) return;
  if (busy) { toast('前の返事を待っています。届いてから送ってください'); return; }   // 欄も写真も触らずに返す
  const img = attached?.dataUrl || null;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  clearAttachment();
  await sendWith(text, img);
}

async function sendWith(text, img) {
  // 返事待ちの間に送られたものを黙って捨てない。文字は欄に戻す
  if (busy) {
    if (text && !inputEl.value) inputEl.value = text;
    toast('前の返事を待っています。届いてから送ってください');
    return;
  }
  if (!hasKey()) {
    logEl.append(el('div', { class: 'msg err' }, 'APIキーがまだ設定されていません。設定タブで入れてください。'));
    scrollDown();
    goTab('settings');
    return;
  }
  setBusy(true);   // 縮小と保存を待つ間に2通目が通らないよう、ここで立てる
  let thumb = null;
  try {
    const pics = [].concat(img || []);
    thumb = pics.length ? await thumbnail(pics[0]) : null;
    const shown = text || (pics.length > 1 ? `（写真${pics.length}枚）` : '（写真）');
    logEl.append(userBubble(shown, thumb));
    scrollDown();
    await db.putChat({ id: uid(), at: new Date().toISOString(), role: 'user', text: shown, thumb });
  } catch (err) {
    // ここで落ちると busy が立ったままになり、開き直すまで何も送れなくなる
    console.warn('[moppara] 発話の保存に失敗', err);
  }
  await deliver(text, img, thumb);
}

async function deliver(text, img, thumb = null) {
  const at = new Date().toISOString();
  setBusy(true);

  const label = el('span', {}, img ? ' 写真を見ています' : ' 考えています');
  const thinking = el('div', { class: 'msg ai thinking' },
    el('span', { class: 'dots', html: '<span></span><span></span><span></span>' }), label);
  logEl.append(thinking);
  scrollDown();

  try {
    const recent = await recentDays(14);
    const rowsNow = await db.allChat();
    // 直前に出した伝票がまだ確定していなければ、それを見せて「ご飯は半分」のような訂正を受けられるようにする
    const pendingRow = rowsNow.slice(-6).reverse().find((r) => r.role === 'proposal' && r.status === 'pending') || null;
    const context = contextBlock({ presets: state.presets, recent, pending: pendingRow?.meal });
    const history = rowsNow.slice(-9, -1)
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({ role: r.role, text: r.text }));

    const out = await ask({
      settings: state.settings, context, history, text, imageDataUrl: img,
      onRetry: ({ attempt, of, status, wait }) => {
        label.textContent = status === 429
          ? ` 立て込んでいます。${Math.round(wait / 1000)}秒待って${attempt + 1}回目（全${of}回）`
          : ` 向こうが混み合っています。やり直し中 ${attempt + 1}/${of}`;
        scrollDown();
      },
    });
    thinking.remove();

    const side = [];
    const wasReady = state.ready;
    const got = await applySetup(out.setup);
    if (got.length) side.push(`${got.join('・')}を登録`);
    if (out.weight) {
      await db.putWeight({ day: targetDay(), kg: out.weight.kg, fatPct: out.weight.fatPct, at: stampFor(targetDay()) });
      side.push(`体重 ${out.weight.kg}kg を記録`);
    }
    if (out.activity) {
      await db.putActivity({ id: uid(), day: targetDay(), at: stampFor(targetDay()), name: out.activity.name, kcal: out.activity.kcal, minutes: out.activity.minutes });
      side.push(`${out.activity.name} ${fmt(out.activity.kcal)}kcal を記録`);
    }
    if (side.length || out.weight || out.activity || got.length) await refresh();

    let replyEl = null;
    if (out.reply) {
      replyEl = el('div', { class: 'msg ai' }, out.reply);
      logEl.append(replyEl);
      await db.putChat({ id: uid(), at: new Date().toISOString(), role: 'assistant', text: out.reply });
    }
    if (side.length) logEl.append(el('div', { class: 'msg sys' }, side.join(' / ')));

    if (!wasReady && state.ready) {
      const t = state.targets, b = state.budget;
      // 数字の前提も一緒に出す。聞いていない活動量や、基礎代謝で止めたことを黙っていると後で食い違う
      const lv = ACTIVITY_LEVELS.find((l) => l.key === state.settings.profile.activity) || ACTIVITY_LEVELS[0];
      const realPace = r1((b.deficit * 7) / 7200);
      const msg = ['これで計算できます。', '', `1日の上限　${fmt(b.budget)} kcal`,
        `P ${t.p}g　F ${t.f}g　C ${t.c}g`, '',
        `活動量は「${lv.label}」として計算しています。`,
        b.cappedByFloor ? `目標のペースだと基礎代謝を割るので、そこで止めています（実際は週${realPace}kgほど）。` : null,
        '違うところは設定タブで直せます。', '',
        '写真か一言を送れば記録します。上の帯にいつでも残りが出ます。'].filter((x) => x != null).join(String.fromCharCode(10));
      logEl.append(el('div', { class: 'msg ai' }, msg));
      await db.putChat({ id: uid(), at: new Date().toISOString(), role: 'assistant', text: msg });
    }

    // AIが文章で「記録した」と言いながら meal を返さないことがある。文章だけでは何も起きないので、
    // 記録のつもりだった（intent=record／写真つき／返事に「記録」）のに伝票が無ければ、その場で言う。
    const claimed = /記録し/.test(out.reply || '');
    const recordedOther = out.weight || out.activity || got.length;   // 体重・運動・設定は記録できている
    if (!out.meal && !recordedOther && (out.intent === 'record' || claimed || img)) {
      logEl.append(el('div', { class: 'msg err' },
        'まだ記録していません。AIが中身（品名とカロリー）を返してこなかったためです。',
        el('div', { class: 'faint', style: 'margin-top:6px' },
          '品名を一言（例：「ザバス ミルクプロテイン 1本」）で送ると伝票が出ます。数値が分かるなら、今日タブの区分の＋から「数値で入れる」でも登録できます。')));
    }

    if (out.meal) {
      // 「＋ 夜」から来たなら、その区分を優先する（AIは時刻から推測しているだけ）
      const reserved = takeSlot();
      if (reserved) out.meal.slot = reserved;
      // 訂正なら古い伝票を下ろし、写真はそちらから引き継ぐ（訂正の発話に写真は付かない）
      // 待っている間に古い伝票が記録・取り消しされていたら、訂正ではなく新しい伝票として出す
      const latest = pendingRow ? await db.getChat(pendingRow.id) : null;
      const revising = out.revise && latest?.status === 'pending';
      // 待つ間に記録してしまっていたら、新しい1件ではなく記録済みの食事の置き換えとして出す（二重計上を防ぐ）
      const replacesMealId = out.revise && latest?.status === 'saved' ? latest.mealId : null;
      if (revising) {
        await db.putChat({ ...pendingRow, status: 'revised' });
        logEl.querySelector(`[data-row="${pendingRow.id}"]`)?.replaceWith(revisedNote());
      }
      // DOMだけに置くと開き直したとき消えて「記録済み」に見える。DBに持つ。
      const row = {
        id: uid(), at: new Date().toISOString(), role: 'proposal',
        text: '', status: 'pending', meal: out.meal, thumb: thumb || (revising || replacesMealId ? pendingRow.thumb : null), mealId: null,
        replacesMealId,
      };
      await db.putChat(row);
      logEl.append(proposeCard(row));
    }

    await db.trimChat(300);
    // 長い相談の返事は頭から読ませる。末尾まで送ると冒頭が画面の外に出る
    if (replyEl && !out.meal && replyEl.offsetHeight > logEl.clientHeight * 0.55) {
      requestAnimationFrame(() => replyEl.scrollIntoView({ block: 'start' }));
    } else scrollDown();
  } catch (err) {
    thinking.remove();
    const msg = err instanceof AIError ? err.message
      : err.name === 'TypeError' ? '通信できませんでした。電波を確認してください。'
      : err.message || '不明なエラーです。';
    const again = el('button', { class: 'btn sm', style: 'margin-top:8px' }, 'もう一度送る');
    // キーやモデルの問題は、送り直しても通らない。設定への道を出す
    const toSettings = /APIキー|モデル|残高|権限/.test(msg)
      ? el('button', { class: 'btn sm primary', style: 'margin:8px 0 0 8px', onclick: () => goTab('settings') }, '設定を開く') : null;
    const box = el('div', { class: 'msg err' }, msg, el('div', {}, again, toSettings));
    again.addEventListener('click', () => {
      if (busy) { toast('前の返事を待っています'); return; }
      box.remove(); deliver(text, img, thumb);
    });
    logEl.append(box);
    scrollDown();
  } finally {
    setBusy(false);
  }
}

function setBusy(b) { busy = b; sendBtn.disabled = b; }

function userBubble(text, thumb) {
  const n = el('div', { class: 'msg user' });
  if (thumb) n.append(el('img', { src: thumb, alt: '送った写真' }));
  if (text && !(thumb && text === '（写真）')) n.append(document.createTextNode(text));   // 写真だけなら文字は要らない
  return n;
}

// 下寄せを justify-content に頼らなくなったので、開いた直後は自分で下端へ送る。
// フォントや写真で高さが後から変わるため、数回に分けて送る。
function scrollDown() {
  const go = () => { logEl.scrollTop = logEl.scrollHeight; };
  requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
  setTimeout(go, 80);
  setTimeout(go, 320);
}

async function thumbnail(dataUrl, px = 220) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, px / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      res(cv.toDataURL('image/jpeg', 0.65));
    };
    img.onerror = () => res(null);
    img.src = dataUrl;
  });
}

// ---------------------------------------------------------------- 推定の伝票

/** row は DB のチャット行（role:'proposal'）。状態で見た目が変わる。 */
function proposeCard(row) {
  if (row.status === 'saved') return savedCard(row);
  if (row.status === 'cancelled') return el('div', { class: 'msg sys' }, '記録しませんでした');
  if (row.status === 'revised') return revisedNote();

  const meal = row.meal;
  const items = meal.items.map((i) => ({ ...i, b: { kcal: i.kcal || 1, p: i.p, f: i.f, c: i.c } }));
  const card = el('div', { class: 'propose', 'data-row': row.id });

  // 写真があれば上いっぱいに。kcalは写真の上に載せる
  const badge = el('b');
  if (row.thumb) {
    const pic = el('div', { class: 'pic' }, badge);
    pic.style.backgroundImage = `url(${row.thumb})`;
    card.append(pic);
  }

  const slot = el('select', { style: 'width:auto;padding:4px 8px;font-size:13px;border-radius:9px' },
    ...['朝', '昼', '夜', '間食'].map((s) => el('option', { value: s, selected: s === meal.slot }, s)));

  card.append(el('div', { class: 'p-head' },
    el('span', { class: 'p-title' }, row.replacesMealId ? '記録済みの分を直しますか' : '記録しますか'),
    el('span', { style: 'display:flex;gap:6px;align-items:center' }, slot,
      el('span', { class: `p-conf ${meal.confidence === 'low' ? 'low' : ''}` },
        meal.confidence === 'high' ? '確度 高' : meal.confidence === 'low' ? '確度 低' : '確度 中'))));

  // 手で直した分はDBの行へ書き戻す。書き戻さないと、続けて「味噌汁なし」と送ったとき
  // AIには直す前の伝票が渡り、±した量が元に戻る
  let persistTimer = null;
  let closed = false;   // 記録する・やめるを押したら、もう書き戻さない（確定した行を pending に戻してしまう）
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      if (closed) return;
      const cur = await db.getChat(row.id);
      if (closed || cur?.status !== 'pending') return;
      const kept = items.filter((i) => !i.removed).map(({ name, amount, kcal, p, f, c }) => ({ name, amount, kcal, p, f, c }));
      await db.putChat({ ...cur, meal: { ...cur.meal, slot: slot.value, items: kept } });
    }, 250);
  };
  slot.addEventListener('change', persist);

  const totalRow = el('div', { class: 'p-macros' });
  let drawn = false;
  const recalc = () => {
    if (drawn) persist();
    const t = sumItems(items.filter((i) => !i.removed));
    badge.textContent = `${fmt(t.kcal)} kcal`;
    totalRow.textContent = '';
    totalRow.append(el('b', {}, `${fmt(t.kcal)} kcal`), ` ／ P ${r1(t.p)}g　F ${r1(t.f)}g　C ${r1(t.c)}g`);
  };

  const scaleTo = (it, v) => {
    const k = Math.max(0, v) / (it.b.kcal || 1);
    it.kcal = Math.max(0, Math.round(v));
    it.p = Math.round(it.b.p * k * 10) / 10;
    it.f = Math.round(it.b.f * k * 10) / 10;
    it.c = Math.round(it.b.c * k * 10) / 10;
  };

  const rows = el('div', { class: 'p-body' });
  let showAll = items.length <= 7;   // 12品の定食で画面3つ分になっていた。多いときは畳む
  const drawRows = () => {
    rows.textContent = '';
    const live = items.filter((i) => !i.removed);
    for (const [idx, it] of live.entries()) {
      if (!showAll && idx >= 5) {
        rows.append(el('button', { class: 'btn ghost sm p-more', onclick: () => { showAll = true; drawRows(); } },
          `ほか${live.length - 5}品を表示`));
        break;
      }
      // 量は指で刻む。1回で元の25%（半分残したなら2回）
      const step = Math.max(10, Math.round(it.b.kcal * 0.25));
      const inp = el('input', { type: 'number', inputmode: 'numeric', value: String(it.kcal), min: '0' });
      inp.addEventListener('input', () => { scaleTo(it, Number(inp.value) || 0); recalc(); });
      const dec = el('button', { onclick: () => { scaleTo(it, it.kcal - step); inp.value = String(it.kcal); recalc(); } }, '−');
      const inc = el('button', { onclick: () => { scaleTo(it, it.kcal + step); inp.value = String(it.kcal); recalc(); } }, '＋');
      rows.append(el('div', { class: 'p-item' },
        el('div', { class: 'n' }, it.name, it.amount ? el('small', {}, it.amount) : null),
        el('div', { class: 'stp' }, dec, inp, inc),
        el('button', { class: 'm-x', 'aria-label': `${it.name}を外す`, onclick: () => { it.removed = true; drawRows(); recalc(); } }, '×')));
    }
  };
  drawRows();
  card.append(rows, totalRow);
  recalc();
  drawn = true;

  if (meal.assumptions?.length) card.append(el('div', { class: 'p-assume' }, '仮定：' + meal.assumptions.join(' / ')));
  card.append(el('div', { class: 'p-assume' }, '違っていたら「ご飯は半分」「味噌汁なし」と送れば直ります'));

  const actions = el('div', { class: 'p-actions' });
  actions.append(
    el('button', {
      class: 'btn ghost',
      onclick: async () => { closed = true; clearTimeout(persistTimer); await db.putChat({ ...row, status: 'cancelled' }); card.replaceWith(el('div', { class: 'msg sys' }, '記録しませんでした')); },
    }, 'やめる'),
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        const kept = items.filter((i) => !i.removed).map(({ name, amount, kcal, p, f, c }) => ({ name, amount, kcal, p, f, c }));
        if (!kept.length) { toast('品目が残っていません'); return; }
        closed = true; clearTimeout(persistTimer);
        // 記録済みの食事の訂正なら、新しく足さずにその食事を置き換える（日時はもとのまま）
        const prev = row.replacesMealId ? await db.getMeal(row.replacesMealId) : null;
        const mealId = prev?.id || uid();
        await db.putMeal({
          id: mealId, day: prev?.day || targetDay(), at: prev?.at || stampFor(targetDay()),
          slot: slot.value, items: kept, thumb: row.thumb || prev?.thumb || null, source: row.thumb ? 'photo' : 'text',
        });
        const saved = { ...row, status: 'saved', mealId, meal: { ...meal, slot: slot.value, items: kept } };
        await db.putChat(saved);
        noteRecord(kept.map((i) => i.name).join('・'), sumItems(kept).kcal, sumItems(kept).p);
        await refresh();
        card.replaceWith(savedCard(saved));
        if (prev) toast('直しました');
        else {
          // ほかの記録と同じく取り消せるようにする。取り消したら伝票は確認待ちに戻す
          undoToast('記録しました', async () => {
            await db.delMeal(mealId);
            const back = { ...row, status: 'pending', mealId: null };
            await db.putChat(back);
            await refresh();
            logEl.querySelector(`[data-saved="${row.id}"]`)?.replaceWith(proposeCard(back));
          });
        }
      },
    }, row.replacesMealId ? '置き換える' : '記録する'));
  card.append(actions);
  return card;
}

const revisedNote = () => el('div', { class: 'msg sys' }, '伝票を直しました（下が新しいもの）');

/** 記録済み。ここでは数字を触らせない（触れてもDBは変わらないため）。 */
function savedCard(row) {
  const t = sumItems(row.meal.items);
  const card = el('div', { class: 'propose done', 'data-saved': row.id });
  if (row.thumb) {
    const pic = el('div', { class: 'pic' }, el('b', {}, `${fmt(t.kcal)} kcal`));
    pic.style.backgroundImage = `url(${row.thumb})`;
    card.append(pic);
  }
  card.append(el('div', { class: 'p-head' },
    el('span', { class: 'p-title' }, `記録済み　${row.meal.slot}`),
    el('span', { class: 'p-conf' }, `${fmt(t.kcal)} kcal`)));
  card.append(el('div', { class: 'p-saved' },
    row.meal.items.map((i) => `${i.name}${i.amount ? `（${i.amount}）` : ''}`).join('・')));
  card.append(el('div', { class: 'p-macros' }, `P ${r1(t.p)}g　F ${r1(t.f)}g　C ${r1(t.c)}g`));
  card.append(el('div', { class: 'p-actions' },
    el('button', { class: 'btn ghost sm', onclick: () => openMealInToday(row.mealId) }, '直す'),
    el('button', { class: 'btn ghost sm', onclick: () => savePreset(row.meal.items) }, 'いつもの に登録')));
  return card;
}

async function savePreset(items) {
  const suggested = items.map((i) => i.name).join('と');
  const name = prompt('「いつもの◯◯」の◯◯にあたる名前を入れてください', suggested);
  if (!name) return;
  const existing = (await db.allPresets()).find((p) => p.name === name);
  await db.putPreset({
    id: existing?.id || uid(), name,
    items: items.map(({ name: n, amount, kcal, p, f, c }) => ({ name: n, amount, kcal, p, f, c })),
    useCount: (existing?.useCount || 0) + 1, updatedAt: new Date().toISOString(),
  });
  await refresh();
  toast('いつもの に登録しました');
}
