// 設定。AIプロバイダ、からだ、目標、PFC方針、ヘルスケア連携、データの出し入れ。

import { $, el, toast, r1, fmt } from '../util.js';
import * as db from '../db.js';
import { state, saveSettings, refresh } from '../store.js';
import { ACTIVITY_LEVELS, dailyBudget, macroTargets } from '../nutrition.js';
import { PROVIDERS, listModels, AIError } from '../ai.js';

let root;
export function mount() { root = $('#settings-body'); }

const set = async (path, value) => {
  const s = structuredClone(state.settings);
  const keys = path.split('.');
  let o = s;
  while (keys.length > 1) o = o[keys.shift()];
  o[keys[0]] = value;
  await saveSettings(s);
};

export function render() {
  if (!root) return;
  const s = state.settings;
  root.textContent = '';

  // ================= AI =================
  const ai = el('div', { class: 'card' });
  ai.append(el('h2', {}, 'AI'));

  const provSel = el('select', {},
    ...Object.entries(PROVIDERS).map(([k, v]) => el('option', { value: k, selected: s.provider === k }, v.label)));
  provSel.addEventListener('change', async () => { await set('provider', provSel.value); render(); });
  ai.append(el('div', { class: 'field' }, el('label', {}, '使うAI'), provSel,
    el('div', { class: 'hint' }, PROVIDERS[s.provider].note)));

  const isA = s.provider === 'anthropic';
  const keyField = isA ? 'anthropicKey' : 'geminiKey';
  const modelField = isA ? 'anthropicModel' : 'geminiModel';

  const keyIn = el('input', { type: 'password', value: s[keyField] || '', placeholder: isA ? 'sk-ant-...' : 'AIza...', autocomplete: 'off', spellcheck: 'false' });
  keyIn.addEventListener('change', async () => { await set(keyField, keyIn.value.trim()); toast('キーを保存しました'); render(); });
  ai.append(el('div', { class: 'field' },
    el('label', {}, 'APIキー'),
    keyIn,
    el('div', { class: 'hint' },
      'この端末の中だけに保存され、送信先は', isA ? ' api.anthropic.com ' : ' generativelanguage.googleapis.com ', 'だけです。',
      el('br'),
      el('a', { href: PROVIDERS[s.provider].keyUrl, target: '_blank', rel: 'noreferrer' }, 'キーを取得する'))));

  const modelIn = el('input', { type: 'text', value: s[modelField] || '', spellcheck: 'false' });
  modelIn.addEventListener('change', async () => { await set(modelField, modelIn.value.trim()); toast('モデルを保存しました'); });
  const modelBox = el('div', { class: 'field' },
    el('label', {}, 'モデル'), modelIn,
    el('div', { class: 'hint' }, isA
      ? 'claude-haiku-4-5 が最安。精度を上げるなら claude-sonnet-5。'
      : 'Flash系は無料枠の対象。Pro系は有料です。'));
  const fetchBtn = el('button', { class: 'btn sm', style: 'margin-top:-4px' }, '使えるモデルを取得');
  fetchBtn.addEventListener('click', async () => {
    fetchBtn.disabled = true; fetchBtn.textContent = '取得中…';
    try {
      const models = await listModels(state.settings);
      const sel = el('select', {}, ...models.map((m) => el('option', { value: m.id, selected: m.id === s[modelField] }, `${m.id}`)));
      sel.addEventListener('change', async () => { modelIn.value = sel.value; await set(modelField, sel.value); toast('モデルを保存しました'); });
      fetchBtn.replaceWith(sel);
    } catch (err) {
      toast(err instanceof AIError ? err.message : '取得できませんでした');
      fetchBtn.disabled = false; fetchBtn.textContent = '使えるモデルを取得';
    }
  });
  modelBox.append(fetchBtn);
  ai.append(modelBox);
  root.append(ai);

  // ================= からだ =================
  const body = el('div', { class: 'card' });
  body.append(el('h2', {}, 'からだ'));
  const sexSel = el('select', {},
    el('option', { value: 'male', selected: s.profile.sex === 'male' }, '男性'),
    el('option', { value: 'female', selected: s.profile.sex === 'female' }, '女性'));
  sexSel.addEventListener('change', () => set('profile.sex', sexSel.value).then(render));
  const yearIn = numInput(s.profile.birthYear, (v) => set('profile.birthYear', v).then(render));
  const hIn = numInput(s.profile.heightCm, (v) => set('profile.heightCm', v).then(render), '0.1');
  body.append(el('div', { class: 'grid3' },
    field('性別', sexSel), field('生まれ年', yearIn), field('身長 (cm)', hIn)));
  const actSel = el('select', {}, ...ACTIVITY_LEVELS.map((l) => el('option', { value: l.key, selected: s.profile.activity === l.key }, l.label)));
  actSel.addEventListener('change', () => set('profile.activity', actSel.value).then(render));
  body.append(el('div', { class: 'field' }, el('label', {}, '普段の活動量'), actSel,
    el('div', { class: 'hint' }, '運動を別に記録するなら「座位中心」にしてください。二重に足されるのを防げます。')));
  root.append(body);

  // ================= 目標 =================
  const goal = el('div', { class: 'card' });
  goal.append(el('h2', {}, '目標'));
  const modeSel = el('select', {},
    el('option', { value: 'diet', selected: s.goal.mode === 'diet' }, '減量'),
    el('option', { value: 'maintain', selected: s.goal.mode === 'maintain' }, '維持'),
    el('option', { value: 'bulk', selected: s.goal.mode === 'bulk' }, '増量'));
  modeSel.addEventListener('change', () => set('goal.mode', modeSel.value).then(render));
  goal.append(el('div', { class: 'field' }, el('label', {}, 'いま何をしたいか'), modeSel));

  const startIn = numInput(s.goal.startWeightKg, (v) => set('goal.startWeightKg', v).then(render), '0.1');
  const tgtIn = numInput(s.goal.targetWeightKg, (v) => set('goal.targetWeightKg', v).then(render), '0.1');
  goal.append(el('div', { class: 'grid2' },
    field('開始体重 (kg)', startIn), field('目標体重 (kg)', tgtIn)));

  const dateIn = el('input', { type: 'date', value: s.goal.targetDate || '' });
  dateIn.addEventListener('change', () => set('goal.targetDate', dateIn.value).then(render));
  const paceIn = numInput(s.goal.manualPaceKgPerWeek, (v) => set('goal.manualPaceKgPerWeek', v).then(render), '0.1');
  goal.append(el('div', { class: 'grid2' },
    field('目標の日', dateIn),
    field('ペース (kg/週)', paceIn)));
  goal.append(el('div', { class: 'hint', style: 'margin-top:-4px' },
    '目標の日を入れるとペースは自動計算されます。空なら右の数字を使います。'));

  // その場のプレビュー
  const kg = state.weight?.kg ?? state.latestWeight?.kg ?? s.goal.startWeightKg ?? 70;
  const b = dailyBudget(s, kg, 0, state.today);
  const t = macroTargets(s, b.budget, kg);
  goal.append(el('div', { class: 'card tight', style: 'margin:12px 0 0;background:var(--surface2)' },
    el('div', {}, `1日の上限 ${fmt(b.budget)} kcal　（基礎代謝 ${fmt(b.bmr)}／生活消費 ${fmt(b.base)}／赤字 ${fmt(b.deficit)}）`),
    el('div', { class: 'faint', style: 'margin-top:4px' },
      `P ${t.p}g　F ${t.f}g　C ${t.c}g　/　想定ペース ${r1(b.paceKgPerWeek)}kg/週`)));
  root.append(goal);

  // ================= PFC方針 =================
  const macro = el('div', { class: 'card' });
  macro.append(el('h2', {}, 'PFCの決め方'));
  const pIn = numInput(s.macro.proteinGPerKg, (v) => set('macro.proteinGPerKg', v).then(render), '0.1');
  const fIn = numInput(Math.round(s.macro.fatPctOfKcal * 100), (v) => set('macro.fatPctOfKcal', v / 100).then(render), '1');
  macro.append(el('div', { class: 'grid2' },
    field('たんぱく質 (g/目標体重kg)', pIn),
    field('脂質 (総カロリーの%)', fIn)));
  macro.append(el('div', { class: 'hint' }, '炭水化物は残りぜんぶです。減量中の目安は たんぱく質 1.6〜2.2g/kg、脂質 20〜30%。'));
  root.append(macro);

  // ================= 運用 =================
  const ops = el('div', { class: 'card' });
  ops.append(el('h2', {}, '運用'));
  const exCk = el('input', { type: 'checkbox', style: 'width:auto' });
  exCk.checked = !!s.addExerciseToBudget;
  exCk.addEventListener('change', () => set('addExerciseToBudget', exCk.checked).then(render));
  ops.append(el('label', { style: 'display:flex;gap:9px;align-items:center;margin-bottom:12px;font-size:13.5px' },
    exCk, '運動で消費した分を、その日の上限に足す'));

  const cutIn = numInput(s.dayCutoffHour, (v) => set('dayCutoffHour', v).then(render), '1');
  ops.append(field('何時までを前日扱いにするか', cutIn));
  ops.append(el('div', { class: 'hint', style: 'margin-top:-6px' }, `${s.dayCutoffHour}時より前の食事は前の日に付きます。`));

  const prefsIn = el('textarea', { rows: '3', placeholder: '例：辛いものが苦手。えびアレルギー。会社の近くはサイゼとゆで太郎と松屋。' }, s.prefs || '');
  prefsIn.value = s.prefs || '';
  prefsIn.addEventListener('change', () => set('prefs', prefsIn.value).then(() => toast('保存しました')));
  ops.append(el('div', { class: 'field' }, el('label', {}, '好み・制限・よく行く店'), prefsIn,
    el('div', { class: 'hint' }, '外食の提案に使われます。')));
  root.append(ops);

  // ================= ヘルスケア連携 =================
  const hc = el('details', { class: 'acc' });
  hc.append(el('summary', {}, 'iPhoneのヘルスケアとつなぐ'));
  const url = location.origin + location.pathname;
  hc.append(el('div', { class: 'acc-body' },
    el('div', { class: 'hint', style: 'margin-bottom:10px' },
      'Webアプリからヘルスケアは直接読めません。iPhoneの「ショートカット」から数値を渡す形にしてあります。1日1回の自動化にしておけば手は動きません。'),
    el('ol', { style: 'padding-left:20px;margin:0 0 10px;font-size:13px;line-height:1.9' },
      el('li', {}, 'ショートカットアプリで新規ショートカットを作る'),
      el('li', {}, '「ヘルスケアサンプルを検索」→ 種類：アクティブエネルギー、期間：今日、まとめる：合計'),
      el('li', {}, '同じく体重も取るなら「ヘルスケアサンプルを検索」→ 体重、最新の1件'),
      el('li', {}, '最後に「URLを開く」を置いて、下のURLの数字の部分を各変数に差し替える'),
      el('li', {}, 'オートメーションで「毎日 22:00」に実行するよう設定する')),
    el('pre', {}, `${url}#health?ae=520&w=72.4`),
    el('div', { class: 'hint' }, 'ae＝アクティブエネルギー(kcal)、w＝体重(kg)。どちらか片方だけでも動きます。開くとこのアプリが受け取って記録します。')));
  root.append(hc);

  // ================= データ =================
  const data = el('div', { class: 'card' });
  data.append(el('h2', {}, 'データ'));
  data.append(el('div', { class: 'hint', style: 'margin-bottom:10px' },
    '記録はこの端末の中だけにあります。ときどき書き出してください。'));

  // 「キーが消える」の原因を切り分けるための現況表示
  const diag = el('div', { class: 'card tight', style: 'margin:0 0 12px;background:var(--surface2)' }, '確認中…');
  data.append(diag);
  (async () => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let persisted = false, supported = false;
    try {
      supported = !!navigator.storage?.persisted;
      persisted = supported ? await navigator.storage.persisted() : false;
    } catch { /* 取れない環境は未対応として扱う */ }
    const hasBackup = !!db.readMirror();
    diag.textContent = '';
    diag.append(
      el('div', {}, '起動元：', el('b', {}, standalone ? 'ホーム画面のアプリ' : 'ブラウザ')),
      el('div', { style: 'margin-top:3px' }, '保存の永続化：', el('b', {}, !supported ? '未対応' : persisted ? '許可されている' : 'まだ許可されていない')),
      el('div', { style: 'margin-top:3px' }, '設定の控え：', el('b', {}, hasBackup ? 'あり' : 'なし')),
      el('div', { class: 'hint', style: 'margin-top:7px' },
        standalone
          ? 'この状態で入れた設定は、ホーム画面のアプリ側に残ります。'
          : 'iOSはブラウザとホーム画面アプリで別々にデータを持ちます。ホーム画面に追加したうえで、アイコンから開いて設定してください。'));
  })();
  data.append(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
    el('button', { class: 'btn sm', onclick: doExport }, '書き出す (JSON)'),
    el('label', { class: 'btn sm', for: 'import-file' }, '読み込む'),
    el('button', { class: 'btn sm danger', onclick: doWipe }, '全部消す')));
  const fileIn = el('input', { type: 'file', id: 'import-file', accept: 'application/json', hidden: true });
  fileIn.addEventListener('change', doImport);
  data.append(fileIn);
  root.append(data);

  // ================= 画面 =================
  const view = el('div', { class: 'card' });
  view.append(el('h2', {}, '画面'));
  const themeSel = el('select', {},
    el('option', { value: 'auto' }, 'OSに合わせる'),
    el('option', { value: 'light' }, 'ライト'),
    el('option', { value: 'dark' }, 'ダーク'));
  themeSel.value = localStorage.getItem('moppara-theme') || 'auto';
  themeSel.addEventListener('change', () => {
    localStorage.setItem('moppara-theme', themeSel.value);
    applyTheme();
  });
  view.append(field('テーマ', themeSel));
  view.append(el('div', { class: 'faint', style: 'margin-top:8px' }, 'Moppara — もっぱら、食事管理だけ。記録はすべて端末内。AIに送るのは、写真・入力文・その日の集計だけです。'));
  root.append(view);
}

export function applyTheme() {
  const v = localStorage.getItem('moppara-theme') || 'auto';
  if (v === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
}

function field(label, control) {
  return el('div', { class: 'field' }, el('label', {}, label), control);
}
function numInput(value, onChange, step = '1') {
  const n = el('input', { type: 'number', inputmode: 'decimal', step, value: value ?? '' });
  n.addEventListener('change', () => onChange(n.value === '' ? null : Number(n.value)));
  return n;
}

async function doExport() {
  const data = await db.exportAll();
  if (data.settings) { data.settings = { ...data.settings, geminiKey: '', anthropicKey: '' }; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `moppara-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  toast('書き出しました（APIキーは含みません）');
}

async function doImport(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const replace = confirm('いまのデータを置き換えますか。\n［OK］置き換える　／　［キャンセル］今のデータに足す');
    await db.importAll(data, { replace });
    await refresh();
    render();
    toast('読み込みました');
  } catch (err) {
    toast(err.message || '読み込めませんでした');
  }
}

async function doWipe() {
  if (!confirm('記録・設定を全部消します。戻せません。よろしいですか')) return;
  if (!confirm('本当に消しますか')) return;
  await db.wipeAll();
  location.reload();
}
