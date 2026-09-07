// 初回のようこそ画面。ここで聞くのはAPIキーだけ。
// 身長・体重・目標はチャットが会話で聞く（設定フォームを最初に見せない）。

import { $, el, toast } from '../util.js';
import { state, saveSettings } from '../store.js';
import { PROVIDERS } from '../ai.js';

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
      el('div', { class: 'w-card-p' }, key === 'gemini' ? '0円 / 1日1,500回まで' : '写真1枚 約0.6円'));
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
    el('br'),
    el('a', { href: p.keyUrl, target: '_blank', rel: 'noreferrer' }, 'キーを取得する（別のタブが開きます）'));
}

async function start() {
  const key = $('#w-key').value.trim();
  if (!key) { toast('APIキーを貼り付けてください'); $('#w-key').focus(); return; }
  const patch = { provider: picked };
  patch[picked === 'anthropic' ? 'anthropicKey' : 'geminiKey'] = key;
  patch[picked === 'anthropic' ? 'anthropicModel' : 'geminiModel'] =
    state.settings[picked === 'anthropic' ? 'anthropicModel' : 'geminiModel'] || PROVIDERS[picked].defaultModel;
  await saveSettings(patch);
  $('#w-key').value = '';
  goTab('chat');
}
