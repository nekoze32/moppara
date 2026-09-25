// 初回のようこそ画面。ここで聞くのはAPIキーだけ。
// 身長・体重・目標はチャットが会話で聞く（設定フォームを最初に見せない）。

import { $, el, toast } from '../util.js';
import { state, saveSettings } from '../store.js';
import { PROVIDERS, listModels, rankModels, testModel } from '../ai.js';

let goTab = () => {};
let picked = 'gemini';

export function mount({ navigate }) {
  goTab = navigate;
  $('#w-start').addEventListener('click', start);
  $('#w-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  render();
}

export function render() {
  const choice = $('#w-choice');
  if (!choice) return;
  choice.textContent = '';
  for (const [key, p] of Object.entries(PROVIDERS)) {
    const card = el('button', {
      class: `w-card ${key === picked ? 'on' : ''}`,
      onclick: () => { picked = key; render(); },
    },
      el('div', { class: 'w-card-t' }, key === 'gemini' ? '無料ではじめる' : '精度で選ぶ'),
      el('div', { class: 'w-card-n' }, p.label),
      el('div', { class: 'w-card-p' }, key === 'gemini' ? '0円（モデルごとに回数上限あり）' : '写真1枚 約0.6円'));
    choice.append(card);
  }
  const p = PROVIDERS[picked];
  $('#w-key').placeholder = picked === 'anthropic' ? 'sk-ant-... を貼り付け' : 'AIza... を貼り付け';
  const hint = $('#w-hint');
  hint.textContent = '';
  hint.append(
    picked === 'gemini'
      ? '無料枠では、送った内容がGoogleの製品改善に使われます。気になる場合はAnthropicを選んでください。'
      : 'クレジットの購入が必要です。送った内容は学習に使われません。',
    el('a', { class: 'btn sm w-keylink', href: p.keyUrl, target: '_blank', rel: 'noreferrer' }, 'キーを取りに行く（別のタブ）'),
    keySteps(picked));
}

/** 「APIキー」が何か分からない人が最初の壁で止まっていた。手順を畳んで置く */
function keySteps(provider) {
  const steps = provider === 'gemini'
    ? ['上のボタンで Google AI Studio を開き、Googleアカウントでログイン', '「APIキーを作成」を押す（クレジットカードは要りません）', '出てきた AIza… で始まる文字列をコピーして、上の欄に貼る']
    : ['上のボタンで Anthropic Console を開き、アカウントを作る', 'Billing でクレジットを買う（5ドルで数か月もちます）', '「Create Key」で出た sk-ant-… をコピーして、上の欄に貼る'];
  return el('details', { class: 'w-steps' },
    el('summary', {}, 'キーの取り方（3ステップ・2分ほど）'),
    el('ol', {}, ...steps.map((t) => el('li', {}, t))),
    el('div', { class: 'faint' }, 'APIキーは、このアプリがAIを呼ぶための合言葉です。この端末の中にだけ保存します。'));
}

async function start() {
  const key = $('#w-key').value.trim();
  if (!key) { toast('APIキーを貼り付けてください'); $('#w-key').focus(); return; }
  const btn = $('#w-start');
  const modelField = picked === 'anthropic' ? 'anthropicModel' : 'geminiModel';
  const patch = { provider: picked };
  patch[picked === 'anthropic' ? 'anthropicKey' : 'geminiKey'] = key;
  patch[modelField] = state.settings[modelField] || PROVIDERS[picked].defaultModel;

  // モデルは決め打ちにしない。既定が有料モデルだと初回から上限に当たる。
  btn.disabled = true;
  btn.textContent = '使えるモデルを探しています…';
  try {
    const probe = { ...state.settings, ...patch };
    const cands = rankModels(await listModels(probe)).slice(0, 5);
    for (const id of cands) {
      const r = await testModel({ ...probe, [modelField]: id }, id);
      if (r.ok) { patch[modelField] = id; break; }
    }
  } catch { /* 取れなくても先へ進む。設定タブでやり直せる */ }
  btn.disabled = false;
  btn.textContent = 'はじめる';

  await saveSettings(patch);
  $('#w-key').value = '';
  goTab('chat');
}
