// 設定。今日タブと同じ流儀で「いまの値＋修正」を出し、直すときだけ欄が開く。
// 入力欄を出しっぱなしにして黙って保存すると、入れた側は反映されたか分からない。

import { $, el, toast, r1, fmt } from '../util.js';
import * as db from '../db.js';
import { state, saveSettings, refresh } from '../store.js';
import { ACTIVITY_LEVELS, dailyBudget, macroTargets, activityFactor } from '../nutrition.js';
import { PROVIDERS, listModels, rankModels, testModel, AIError } from '../ai.js';

let root;
let open = null;   // いま開いている組：'ai' | 'body' | 'goal' | 'macro' | 'ops'

export function mount() { root = $('#settings-body'); }

export function render() {
  if (!root) return;
  root.textContent = '';
  root.append(groupAI(), groupBody(), groupGoal(), groupMacro(), groupOps(),
              sectionHealth(), sectionData(), sectionView());
}

/**
 * 「いまの値＋修正」と「編集中」を切り替える枠。
 * @param key   組の名前
 * @param title 見出し
 * @param lines 読むときに出す行（文字列の配列）
 * @param build 編集欄を組み立て、保存する値を返す関数を渡す
 */
function group(key, title, lines, build) {
  const box = el('div', { class: 'card' });
  box.append(el('h2', {}, title));

  if (open !== key) {
    box.append(el('div', { class: 'state' },
      el('span', { class: 's-time' }, ''),
      el('span', { class: 's-val', style: 'display:block' },
        ...lines.map((t, i) => el('div', {
          style: i ? 'font-size:12px;color:var(--ink-faint);margin-top:2px' : 'font-size:13.5px',
        }, t))),
      el('button', { class: 's-fix', onclick: () => { open = key; render(); } }, '修正')));
    return box;
  }

  const body = el('div');
  const collect = build(body);
  box.append(body);
  box.append(el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;padding-top:4px' },
    el('button', { class: 'btn sm', onclick: () => { open = null; render(); } }, 'やめる'),
    el('button', {
      class: 'btn sm primary',
      onclick: async () => {
        const patch = collect();
        if (patch === false) return;            // 入力に不備があれば閉じない
        await saveSettings(patch);
        open = null;
        render();
        toast('保存しました');
      },
    }, '保存')));
  return box;
}

// ================================================================ AI

function groupAI() {
  const s = state.settings;
  const isA = s.provider === 'anthropic';
  const key = isA ? s.anthropicKey : s.geminiKey;
  const model = isA ? s.anthropicModel : s.geminiModel;

  return group('ai', 'AI', [
    PROVIDERS[s.provider].label,
    key ? `キー ${mask(key)}　／　${model}` : 'APIキーが未設定です',
  ], (body) => {
    const prov = el('select', {},
      ...Object.entries(PROVIDERS).map(([k, v]) => el('option', { value: k, selected: s.provider === k }, v.label)));
    const keyIn = el('input', { type: 'password', value: key || '', placeholder: isA ? 'sk-ant-...' : 'AIza...', autocomplete: 'off', spellcheck: 'false' });
    const modelIn = el('input', { type: 'text', value: model || '', spellcheck: 'false' });

    const note = el('div', { class: 'hint' });
    const paint = () => {
      const p = PROVIDERS[prov.value];
      note.textContent = '';
      note.append(p.note, el('br'),
        el('a', { href: p.keyUrl, target: '_blank', rel: 'noreferrer' }, 'キーを取得する'));
      keyIn.placeholder = prov.value === 'anthropic' ? 'sk-ant-...' : 'AIza...';
    };
    prov.addEventListener('change', paint);
    paint();

    // モデル名は当てにいくと外す。実際に1回投げて通ったものを採る。
    const report = el('div', { class: 'hint', style: 'margin-top:6px' });
    const probeOf = () => {
      const p = { ...s, provider: prov.value };
      p[prov.value === 'anthropic' ? 'anthropicKey' : 'geminiKey'] = keyIn.value.trim();
      return p;
    };

    const autoBtn = el('button', { class: 'btn sm' }, '使えるモデルを自動で選ぶ');
    autoBtn.addEventListener('click', async () => {
      autoBtn.disabled = true;
      try {
        report.textContent = 'モデル一覧を取得しています…';
        const cands = rankModels(await listModels(probeOf())).slice(0, 5);
        if (!cands.length) { report.textContent = '使えるモデルがありませんでした。'; autoBtn.disabled = false; return; }
        for (const [i, id] of cands.entries()) {
          report.textContent = `${id} を試しています（${i + 1}/${cands.length}）…`;
          const r = await testModel(probeOf(), id);
          if (r.ok) {
            modelIn.value = id;
            report.textContent = `${id} が通りました。「保存」を押してください。`;
            autoBtn.disabled = false;
            return;
          }
        }
        report.textContent = `${cands.length}件とも通りませんでした。キーを確認してください。`;
      } catch (err) {
        report.textContent = err instanceof AIError ? err.message : '取得できませんでした';
      }
      autoBtn.disabled = false;
    });

    const testBtn = el('button', { class: 'btn sm' }, 'いまのモデルで試す');
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      report.textContent = `${modelIn.value} を試しています…`;
      const r = await testModel(probeOf(), modelIn.value.trim());
      report.textContent = r.ok ? `${modelIn.value} は使えます。` : r.message;
      testBtn.disabled = false;
    });

    body.append(
      field('使うAI', prov),
      el('div', { class: 'field' }, el('label', {}, 'APIキー'), keyIn, note),
      el('div', { class: 'field' }, el('label', {}, 'モデル'), modelIn,
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, autoBtn, testBtn),
        report));

    return () => {
      const p = { provider: prov.value };
      p[prov.value === 'anthropic' ? 'anthropicKey' : 'geminiKey'] = keyIn.value.trim();
      p[prov.value === 'anthropic' ? 'anthropicModel' : 'geminiModel'] = modelIn.value.trim() || PROVIDERS[prov.value].defaultModel;
      return p;
    };
  });
}

const mask = (k) => (k.length > 10 ? `${k.slice(0, 4)}••••${k.slice(-4)}` : '••••');

// ================================================================ からだ

function groupBody() {
  const p = state.settings.profile;
  const lv = ACTIVITY_LEVELS.find((l) => l.key === p.activity);
  return group('body', '体の情報', [
    [p.sex ? (p.sex === 'female' ? '女性' : '男性') : '性別 未設定',
     p.birthYear ? `${p.birthYear}年生まれ` : '生まれ年 未設定',
     p.heightCm ? `${r1(p.heightCm)}cm` : '身長 未設定'].join('　'),
    `活動量：${lv ? lv.label : '未設定'}（×${activityFactor(p.activity)}）`,
  ], (body) => {
    const sex = el('select', {},
      el('option', { value: 'male', selected: p.sex === 'male' }, '男性'),
      el('option', { value: 'female', selected: p.sex === 'female' }, '女性'));
    const year = num(p.birthYear);
    const height = num(p.heightCm, '0.1');
    const act = el('select', {}, ...ACTIVITY_LEVELS.map((l) => el('option', { value: l.key, selected: p.activity === l.key }, l.label)));
    body.append(
      el('div', { class: 'grid3' }, field('性別', sex), field('生まれ年', year), field('身長 (cm)', height)),
      el('div', { class: 'field' }, el('label', {}, '普段の活動量'), act,
        el('div', { class: 'hint' }, '運動を別に記録するなら「座位中心」に。二重に足されるのを防げます。')));
    return () => {
      const y = Number(year.value);
      if (y && (y < 1900 || y > new Date().getFullYear())) { toast('生まれ年を確認してください'); return false; }
      return { profile: { ...p, sex: sex.value, birthYear: y || null, heightCm: Number(height.value) || null, activity: act.value } };
    };
  });
}

// ================================================================ 目標

function groupGoal() {
  const g = state.settings.goal;
  const kg = state.weight?.kg ?? state.latestWeight?.kg ?? g.startWeightKg ?? 70;
  const b = dailyBudget(state.settings, kg, 0, state.today);
  const t = macroTargets(state.settings, b.budget, kg);
  const mode = { diet: '減量', maintain: '維持', bulk: '増量' }[g.mode] || '—';

  return group('goal', '目標', [
    state.ready
      ? `${mode}　${g.targetWeightKg ? `${r1(g.targetWeightKg)}kg` : ''}${g.targetDate ? `（${g.targetDate}まで）` : ''}`
      : `${mode}　まだ計算できません`,
    state.ready
      ? `1日の上限 ${fmt(b.budget)} kcal（運動ぶんを除く）　P ${t.p}g F ${t.f}g C ${t.c}g　／　ペース ${r1(b.paceKgPerWeek)}kg/週`
      : `あと ${state.missing.join('・')}`,
  ], (body) => {
    const mo = el('select', {},
      el('option', { value: 'diet', selected: g.mode === 'diet' }, '減量'),
      el('option', { value: 'maintain', selected: g.mode === 'maintain' }, '維持'),
      el('option', { value: 'bulk', selected: g.mode === 'bulk' }, '増量'));
    const start = num(g.startWeightKg, '0.1');
    const tgt = num(g.targetWeightKg, '0.1');
    const date = el('input', { type: 'date', value: g.targetDate || '' });
    const pace = num(g.manualPaceKgPerWeek, '0.1');

    // 直しながら結果が見えるように、その場で試算を出す
    const preview = el('div', { class: 'card tight', style: 'margin-top:10px' });
    const repaint = () => {
      const probe = { ...state.settings, goal: { ...g, mode: mo.value, targetWeightKg: Number(tgt.value) || null, targetDate: date.value, manualPaceKgPerWeek: Number(pace.value) || 0 } };
      const bb = dailyBudget(probe, kg, 0, state.today);
      const tt = macroTargets(probe, bb.budget, kg);
      preview.textContent = '';
      // append は null を文字列 "null" にするので、必ず絞ってから渡す
      preview.append(...[
        el('div', {}, `この設定だと 1日の上限 ${fmt(bb.budget)} kcal`, el('span', { class: 'faint' }, '（運動ぶんを除く）')),
        el('div', { class: 'faint', style: 'margin-top:3px' }, `P ${tt.p}g　F ${tt.f}g　C ${tt.c}g　／　ペース ${r1(bb.paceKgPerWeek)}kg/週`),
        bb.paceTooFast && el('div', { class: 'banner', style: 'margin:8px 0 0' }, '週1kgを超えるペースです。目標日を延ばすか目標体重を見直してください。'),
        bb.cappedByFloor && el('div', { class: 'banner', style: 'margin:8px 0 0' }, '基礎代謝を割るので、上限を安全側に引き上げています。'),
      ].filter(Boolean));
    };
    for (const n of [mo, tgt, date, pace]) n.addEventListener('change', repaint);
    repaint();

    body.append(
      field('いま何をしたいか', mo),
      el('div', { class: 'grid2' }, field('開始体重 (kg)', start), field('目標体重 (kg)', tgt)),
      el('div', { class: 'grid2' }, field('目標の日', date), field('ペース (kg/週)', pace)),
      el('div', { class: 'hint', style: 'margin-top:-6px' }, '目標の日を入れるとペースは自動計算されます。空なら右の数字を使います。'),
      preview);

    return () => ({
      goal: {
        ...g, mode: mo.value,
        startWeightKg: Number(start.value) || null,
        targetWeightKg: Number(tgt.value) || null,
        targetDate: date.value,
        manualPaceKgPerWeek: Number(pace.value) || 0,
      },
    });
  });
}

// ================================================================ PFC

function groupMacro() {
  const m = state.settings.macro;
  return group('macro', 'PFCの決め方', [
    `たんぱく質 ${r1(m.proteinGPerKg)} g/目標体重kg　／　脂質 ${Math.round(m.fatPctOfKcal * 100)}%`,
    '炭水化物は残りぜんぶ',
  ], (body) => {
    const pg = num(m.proteinGPerKg, '0.1');
    const fp = num(Math.round(m.fatPctOfKcal * 100), '1');
    body.append(
      el('div', { class: 'grid2' }, field('たんぱく質 (g/目標体重kg)', pg), field('脂質 (総カロリーの%)', fp)),
      el('div', { class: 'hint' }, '減量中の目安は たんぱく質 1.6〜2.2g/kg、脂質 20〜30%。'));
    return () => ({ macro: { proteinGPerKg: Number(pg.value) || 1.8, fatPctOfKcal: (Number(fp.value) || 25) / 100 } });
  });
}

// ================================================================ 運用

function groupOps() {
  const s = state.settings;
  return group('ops', '運用', [
    `運動を上限に足す：${s.addExerciseToBudget ? 'する' : 'しない'}　／　${s.dayCutoffHour}時までは前日扱い`,
    s.prefs?.trim() ? `好み・制限：${s.prefs.trim().slice(0, 34)}${s.prefs.trim().length > 34 ? '…' : ''}` : '好み・制限は未記入',
  ], (body) => {
    const ex = el('input', { type: 'checkbox', style: 'width:auto' });
    ex.checked = !!s.addExerciseToBudget;
    const cut = num(s.dayCutoffHour, '1');
    const prefs = el('textarea', { rows: '3', placeholder: '例：辛いものが苦手。えびアレルギー。会社の近くはサイゼとゆで太郎と松屋。' });
    prefs.value = s.prefs || '';
    body.append(
      el('label', { style: 'display:flex;gap:9px;align-items:center;margin-bottom:12px;font-size:13.5px' },
        ex, '運動で消費した分を、その日の上限に足す'),
      field('何時までを前日扱いにするか', cut),
      el('div', { class: 'field' }, el('label', {}, '好み・制限・よく行く店'), prefs,
        el('div', { class: 'hint' }, '外食の提案に使われます。')));
    return () => ({
      addExerciseToBudget: ex.checked,
      dayCutoffHour: Math.min(11, Math.max(0, Number(cut.value) || 0)),
      prefs: prefs.value,
    });
  });
}

// ================================================================ ヘルスケア

function sectionHealth() {
  const url = location.origin + location.pathname;
  const acc = el('details', { class: 'acc' });
  acc.append(el('summary', {}, 'iPhoneのヘルスケアとつなぐ'));
  acc.append(el('div', { class: 'acc-body' },
    el('div', { class: 'hint', style: 'margin-bottom:10px' },
      'Webアプリからヘルスケアは直接読めません。ショートカットから数値を渡す形にしてあります。'),
    el('ol', { style: 'padding-left:20px;margin:0 0 10px;font-size:13px;line-height:1.9' },
      el('li', {}, 'ショートカットアプリで新規ショートカットを作る'),
      el('li', {}, '「ヘルスケアサンプルを検索」→ アクティブエネルギー／今日／合計'),
      el('li', {}, '体重も取るなら、もう1つ「ヘルスケアサンプルを検索」→ 体重／最新の1件'),
      el('li', {}, '最後に「URLを開く」を置き、下のURLの数字を各変数に差し替える'),
      el('li', {}, 'オートメーションで毎日22:00に実行')),
    el('pre', {}, `${url}#health?ae=520&w=72.4`),
    el('div', { class: 'hint' }, 'ae＝アクティブエネルギー(kcal)、w＝体重(kg)。片方だけでも動きます。')));
  return acc;
}

// ================================================================ データ

function sectionData() {
  const box = el('div', { class: 'card' });
  box.append(el('h2', {}, 'データ'));
  box.append(el('div', { class: 'hint', style: 'margin:8px 0 10px' },
    '記録はこの端末の中だけにあります。ときどき書き出してください。'));

  const diag = el('div', { class: 'card tight', style: 'margin:0 0 12px' }, '確認中…');
  box.append(diag);
  (async () => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let persisted = false, supported = false;
    try {
      supported = !!navigator.storage?.persisted;
      persisted = supported ? await navigator.storage.persisted() : false;
    } catch { /* 取れない環境は未対応として扱う */ }
    diag.textContent = '';
    diag.append(
      el('div', {}, '起動元：', el('b', {}, standalone ? 'ホーム画面のアプリ' : 'ブラウザ')),
      el('div', { style: 'margin-top:3px' }, '保存の永続化：', el('b', {}, !supported ? '未対応' : persisted ? '許可されている' : 'まだ許可されていない')),
      el('div', { style: 'margin-top:3px' }, '設定の控え：', el('b', {}, db.readMirror() ? 'あり' : 'なし')),
      el('div', { class: 'hint', style: 'margin-top:7px' },
        standalone
          ? 'この状態で入れた設定は、ホーム画面のアプリ側に残ります。'
          : 'iOSはブラウザとホーム画面アプリで別々にデータを持ちます。ホーム画面に追加したうえで、アイコンから開いて設定してください。'));
  })();

  box.append(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
    el('button', { class: 'btn sm', onclick: doExport }, '書き出す (JSON)'),
    el('label', { class: 'btn sm', for: 'import-file' }, '読み込む'),
    el('button', { class: 'btn sm danger', onclick: doWipe }, '全部消す')));
  const fileIn = el('input', { type: 'file', id: 'import-file', accept: 'application/json', hidden: true });
  fileIn.addEventListener('change', doImport);
  box.append(fileIn);
  return box;
}

// ================================================================ 画面

function sectionView() {
  const box = el('div', { class: 'card' });
  box.append(el('h2', {}, '画面'));
  const sel = el('select', {},
    el('option', { value: 'auto' }, 'OSに合わせる'),
    el('option', { value: 'light' }, 'ライト'),
    el('option', { value: 'dark' }, 'ダーク'));
  sel.value = localStorage.getItem('moppara-theme') || 'auto';
  // 結果がその場で見えるので、ここは保存ボタンを置かない
  sel.addEventListener('change', () => {
    localStorage.setItem('moppara-theme', sel.value);
    applyTheme();
  });
  box.append(el('div', { style: 'padding-top:10px' }, field('テーマ', sel)));
  box.append(el('div', { class: 'faint' },
    'Moppara — もっぱら、食事管理だけ。記録はすべて端末内。AIに送るのは、写真・入力文・その日の集計だけです。'));
  return box;
}

export function applyTheme() {
  const v = localStorage.getItem('moppara-theme') || 'auto';
  if (v === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
}

// ================================================================ 小道具

function field(label, control) {
  return el('div', { class: 'field' }, el('label', {}, label), control);
}
function num(value, step = '1') {
  return el('input', { type: 'number', inputmode: 'decimal', step, value: value ?? '' });
}

async function doExport() {
  const data = await db.exportAll();
  if (data.settings) data.settings = { ...data.settings, geminiKey: '', anthropicKey: '' };
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
