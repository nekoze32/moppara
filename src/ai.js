// AIプロバイダの差を吸収する層。ここを足せば別のAPIにも移れる。
// キーは端末（IndexedDB）にしか無く、送り先はそのAPIのエンドポイントだけ。

import { SYSTEM, SCHEMA_FIELDS, REQUIRED } from './prompts.js';
import { dataUrlParts } from './util.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    note: '無料枠あり（Flash系）。無料枠では入力がGoogleの製品改善に使われます。',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.8-flash',
  },
  anthropic: {
    label: 'Anthropic Claude',
    note: '無料枠なし。写真1枚あたり約0.6円。入力は学習に使われません。',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-haiku-4-5',
  },
};

// ---------------------------------------------------------------- スキーマ変換

const GEMINI_TYPE = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT' };

function toGeminiSchema(node) {
  const out = { type: GEMINI_TYPE[node.type] || 'STRING' };
  if (node.description) out.description = node.description;
  if (node.enum) out.enum = node.enum;
  if (node.type === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties || {})) out.properties[k] = toGeminiSchema(v);
    if (node.required) out.required = node.required;
    out.nullable = true;
  }
  if (node.type === 'array') out.items = toGeminiSchema(node.items);
  return out;
}

function responseSchema() {
  const props = {};
  for (const [k, v] of Object.entries(SCHEMA_FIELDS)) props[k] = toGeminiSchema(v);
  return { type: 'OBJECT', properties: props, required: REQUIRED };
}

function anthropicToolSchema() {
  return {
    type: 'object',
    properties: structuredClone(SCHEMA_FIELDS),
    required: REQUIRED,
  };
}

// ---------------------------------------------------------------- 返り値の正規化

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** モデルの返しがどう崩れていても、アプリが扱える形に均す。 */
export function coerce(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = { reply: String(o.reply || '').trim(), meal: null, weight: null, activity: null };

  const m = o.meal;
  if (m && typeof m === 'object' && Array.isArray(m.items) && m.items.length) {
    const items = m.items
      .filter((i) => i && (i.name || i.kcal))
      .map((i) => ({
        name: String(i.name || '（不明）').trim(),
        amount: String(i.amount ?? '').trim(),
        kcal: Math.max(0, Math.round(num(i.kcal))),
        p: Math.max(0, Math.round(num(i.p) * 10) / 10),
        f: Math.max(0, Math.round(num(i.f) * 10) / 10),
        c: Math.max(0, Math.round(num(i.c) * 10) / 10),
      }));
    if (items.length) {
      const slot = ['朝', '昼', '夜', '間食'].includes(m.slot) ? m.slot : guessSlot();
      out.meal = {
        slot,
        items,
        confidence: ['high', 'medium', 'low'].includes(m.confidence) ? m.confidence : 'medium',
        assumptions: Array.isArray(m.assumptions) ? m.assumptions.map(String).filter(Boolean) : [],
      };
    }
  }

  const w = o.weight;
  if (w && num(w.kg) > 20 && num(w.kg) < 300) {
    out.weight = { kg: Math.round(num(w.kg) * 10) / 10, fatPct: num(w.fatPct) > 0 ? Math.round(num(w.fatPct) * 10) / 10 : null };
  }

  const a = o.activity;
  if (a && a.name && num(a.kcal) > 0) {
    out.activity = { name: String(a.name).trim(), kcal: Math.round(num(a.kcal)), minutes: num(a.minutes) || null };
  }

  if (!out.reply) out.reply = out.meal ? '記録しました。' : '';
  return out;
}

function guessSlot(d = new Date()) {
  const h = d.getHours();
  if (h < 10) return '朝';
  if (h < 15) return '昼';
  if (h < 22) return '夜';
  return '間食';
}

// ---------------------------------------------------------------- 送信

/**
 * @param {object} p
 * @param {object} p.settings
 * @param {string} p.context   状況ブロック
 * @param {Array}  p.history   [{role:'user'|'assistant', text}]
 * @param {string} p.text      今回の発話
 * @param {string} [p.imageDataUrl]
 */
export async function ask({ settings, context, history = [], text, imageDataUrl, signal }) {
  const provider = settings.provider === 'anthropic' ? 'anthropic' : 'gemini';
  if (provider === 'anthropic') return askAnthropic({ settings, context, history, text, imageDataUrl, signal });
  return askGemini({ settings, context, history, text, imageDataUrl, signal });
}

// ---- Gemini ----
async function askGemini({ settings, context, history, text, imageDataUrl, signal }) {
  const key = settings.geminiKey?.trim();
  if (!key) throw new AIError('GeminiのAPIキーが設定されていません。設定タブで入れてください。');
  const model = (settings.geminiModel || PROVIDERS.gemini.defaultModel).replace(/^models\//, '');

  const contents = [];
  for (const h of history) {
    contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] });
  }
  const parts = [];
  const img = dataUrlParts(imageDataUrl);
  if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
  parts.push({ text: `${context}\n\n---\n【利用者の発話】\n${text || '（写真のみ）'}` });
  contents.push({ role: 'user', parts });

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: responseSchema(),
    },
  };

  const res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal,
  });

  const json = await readJson(res);
  if (!res.ok) throw new AIError(geminiError(res.status, json, model));

  const cand = json.candidates?.[0];
  if (!cand) throw new AIError('AIから応答が返りませんでした。もう一度試してください。');
  if (cand.finishReason === 'SAFETY') throw new AIError('この内容は安全フィルタで止められました。表現を変えて試してください。');
  const out = (cand.content?.parts || []).map((p) => p.text || '').join('');
  return coerce(parseLoose(out));
}

function geminiError(status, json, model) {
  const msg = json?.error?.message || '';
  if (status === 400 && /API key not valid/i.test(msg)) return 'GeminiのAPIキーが正しくありません。設定を確認してください。';
  if (status === 404) return `モデル「${model}」がこのキーでは使えません。設定タブの「使えるモデルを取得」で選び直してください。`;
  if (status === 429) return '無料枠の上限（1分あたり／1日あたりの回数）に当たりました。しばらく置いて試してください。';
  if (status === 403) return 'このAPIキーには権限がありません。Google AI Studioで作り直してください。';
  return `Geminiでエラー（${status}）${msg ? '：' + msg : ''}`;
}

// ---- Anthropic ----
async function askAnthropic({ settings, context, history, text, imageDataUrl, signal }) {
  const key = settings.anthropicKey?.trim();
  if (!key) throw new AIError('AnthropicのAPIキーが設定されていません。設定タブで入れてください。');
  const model = settings.anthropicModel || PROVIDERS.anthropic.defaultModel;

  const messages = history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text }));
  const content = [];
  const img = dataUrlParts(imageDataUrl);
  if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
  content.push({ type: 'text', text: `${context}\n\n---\n【利用者の発話】\n${text || '（写真のみ）'}` });
  messages.push({ role: 'user', content });

  const body = {
    model,
    max_tokens: 2000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
    tools: [{
      name: 'respond',
      description: '利用者への返事と、記録すべき食事・体重・運動を返す',
      input_schema: anthropicToolSchema(),
    }],
    tool_choice: { type: 'tool', name: 'respond' },
  };

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });

  const json = await readJson(res);
  if (!res.ok) throw new AIError(anthropicError(res.status, json, model));

  const block = (json.content || []).find((b) => b.type === 'tool_use');
  if (!block) {
    const t = (json.content || []).find((b) => b.type === 'text');
    if (t?.text) return coerce(parseLoose(t.text));
    throw new AIError('AIから応答が返りませんでした。もう一度試してください。');
  }
  return coerce(block.input);
}

function anthropicError(status, json, model) {
  const msg = json?.error?.message || '';
  if (status === 401) return 'AnthropicのAPIキーが正しくありません。設定を確認してください。';
  if (status === 404 || /model/i.test(msg) && status === 400) return `モデル「${model}」が使えません。設定タブの「使えるモデルを取得」で選び直してください。`;
  if (status === 429) return 'レート上限に当たりました。少し置いて試してください。';
  if (status === 400 && /credit|balance/i.test(msg)) return 'Anthropicの残高が足りません。コンソールでクレジットを追加してください。';
  return `Anthropicでエラー（${status}）${msg ? '：' + msg : ''}`;
}

// ---------------------------------------------------------------- モデル一覧

export async function listModels(settings) {
  if (settings.provider === 'anthropic') {
    const key = settings.anthropicKey?.trim();
    if (!key) throw new AIError('先にAPIキーを入れてください。');
    const res = await fetch(`${ANTHROPIC_BASE}/models?limit=50`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    const json = await readJson(res);
    if (!res.ok) throw new AIError(anthropicError(res.status, json, ''));
    return (json.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
  }
  const key = settings.geminiKey?.trim();
  if (!key) throw new AIError('先にAPIキーを入れてください。');
  const res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const json = await readJson(res);
  if (!res.ok) throw new AIError(geminiError(res.status, json, ''));
  return (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => !/embedding|aqa|imagen|veo|tts/i.test(m.id));
}

// ---------------------------------------------------------------- 雑用

export class AIError extends Error {}

async function readJson(res) {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
}

/** ```json で囲まれていたり前後に文が付いていても拾う */
function parseLoose(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { /* 続行 */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* 続行 */ } }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* 続行 */ } }
  return { reply: s.trim() };
}
