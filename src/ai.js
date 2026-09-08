// AIプロバイダの差を吸収する層。ここを足せば別のAPIにも移れる。
// キーは端末（IndexedDB）にしか無く、送り先はそのAPIのエンドポイントだけ。

import { SYSTEM, SCHEMA_FIELDS, REQUIRED } from './prompts.js';
import { dataUrlParts } from './util.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

// 一時的な失敗（混雑・瞬断）は自動で数回やり直す。ここが無いと503がそのまま利用者に出る。
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, opts, { tries = 3, onRetry } = {}) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok || !RETRYABLE.has(res.status) || i === tries) return res;
      // 1日あたりの枠切れは待っても戻らない。やり直すだけ枠を減らす。
      if (res.status === 429) {
        const peek = await res.clone().json().catch(() => null);
        const ids = JSON.stringify(peek?.error?.details || '');
        if (/PerDay/i.test(ids) || /"quotaValue"\s*:\s*"0"/.test(ids)) return res;
      }
      const ra = Number(res.headers.get('retry-after'));
      const wait = Math.min(8000, ra > 0 ? ra * 1000 : i * 1800 + Math.random() * 600);
      onRetry?.({ attempt: i, of: tries, status: res.status, wait });
      await sleep(wait);
    } catch (e) {
      if (e.name === 'AbortError') throw e;   // 利用者が中断したときはやり直さない
      lastErr = e;
      if (i === tries) throw e;
      const wait = i * 1500;
      onRetry?.({ attempt: i, of: tries, status: 0, wait });
      await sleep(wait);
    }
  }
  throw lastErr;
}

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
  const out = { reply: String(o.reply || '').trim(), meal: null, weight: null, activity: null, setup: null };

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

  const st = o.setup;
  if (st && typeof st === 'object') {
    const out2 = {};
    if (st.sex === 'male' || st.sex === 'female') out2.sex = st.sex;
    if (num(st.birthYear) > 1900 && num(st.birthYear) < new Date().getFullYear()) out2.birthYear = Math.round(num(st.birthYear));
    if (num(st.heightCm) > 80 && num(st.heightCm) < 250) out2.heightCm = Math.round(num(st.heightCm) * 10) / 10;
    if (['sedentary', 'light', 'moderate', 'active'].includes(st.activity)) out2.activity = st.activity;
    if (['diet', 'maintain', 'bulk'].includes(st.goalMode)) out2.goalMode = st.goalMode;
    if (num(st.targetWeightKg) > 20 && num(st.targetWeightKg) < 300) out2.targetWeightKg = Math.round(num(st.targetWeightKg) * 10) / 10;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(st.targetDate || ''))) out2.targetDate = st.targetDate;
    if (Object.keys(out2).length) out.setup = out2;
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
export async function ask({ settings, context, history = [], text, imageDataUrl, signal, onRetry }) {
  const provider = settings.provider === 'anthropic' ? 'anthropic' : 'gemini';
  const p = { settings, context, history, text, imageDataUrl, signal, onRetry };
  return provider === 'anthropic' ? askAnthropic(p) : askGemini(p);
}

// ---- Gemini ----
async function askGemini({ settings, context, history, text, imageDataUrl, signal, onRetry }) {
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

  const res = await fetchRetry(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal,
  }, { onRetry });

  const json = await readJson(res);
  if (!res.ok) throw new AIError(geminiError(res.status, json, model));

  const cand = json.candidates?.[0];
  if (!cand) throw new AIError('AIから応答が返りませんでした。もう一度試してください。');
  if (cand.finishReason === 'SAFETY') throw new AIError('この内容は安全フィルタで止められました。表現を変えて試してください。');
  const out = (cand.content?.parts || []).map((p) => p.text || '').join('');
  return coerce(parseLoose(out));
}

/** 429の本文から「どの枠に、いくつの上限で当たったか」を取り出す。 */
function quotaDetail(json) {
  const vio = (json?.error?.details || [])
    .flatMap((d) => d.violations || [])
    .filter((v) => v.quotaId || v.quotaMetric);
  if (!vio.length) return null;
  return vio.map((v) => {
    const id = v.quotaId || v.quotaMetric || '';
    const limit = v.quotaValue != null ? `上限 ${v.quotaValue}` : '';
    const m = v.quotaDimensions?.model ? `／モデル ${v.quotaDimensions.model}` : '';
    const per = /PerDay/i.test(id) ? '1日あたり' : /PerMinute/i.test(id) ? '1分あたり' : '';
    return [per, limit, m].filter(Boolean).join(' ') || id;
  }).join('　');
}

function geminiError(status, json, model) {
  const msg = json?.error?.message || '';
  if (status === 400 && /API key not valid/i.test(msg)) return 'GeminiのAPIキーが正しくありません。設定を確認してください。';
  if (status === 404) return `モデル「${model}」がこのキーでは使えません。設定タブの「使えるモデルを取得」で選び直してください。`;
  if (status === 429) {
    // どの枠かはAPIが教えてくれる。自分の推測に置き換えない。
    const d = quotaDetail(json);
    if (d && /上限 0/.test(d)) {
      return `このキーではモデル「${model}」の枠が 0 です（${d}）。設定の「使えるモデルを自動で選ぶ」を押してください。`;
    }
    const small = /limit:\s*([0-9]+)/.exec(msg);
    if (small && Number(small[1]) <= 100) {
      return `モデル「${model}」の無料枠は ${small[1]} 回しかありません（有料モデルの試用ぶん）。`
        + `設定の「使えるモデルを自動で選ぶ」を押すと、無料枠の大きいモデルに切り替えます。`;
    }
    return `回数の上限に当たりました${d ? `：${d}` : ''}。${msg ? `
${msg}` : ''}`;
  }
  if (status === 403) return 'このAPIキーには権限がありません。Google AI Studioで作り直してください。';
  if (status === 503) return `Google側が混み合っています（503）。3回やり直しても駄目でした。数分置くか、設定の「使えるモデルを取得」で別のFlashモデルに変えてみてください。`;
  if (status >= 500) return `Google側の一時的な不具合です（${status}）。少し置いてもう一度どうぞ。`;
  return `Geminiでエラー（${status}）${msg ? '：' + msg : ''}`;
}

// ---- Anthropic ----
async function askAnthropic({ settings, context, history, text, imageDataUrl, signal, onRetry }) {
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

  const res = await fetchRetry(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  }, { onRetry });

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
  if (status === 429) return `レート上限に当たりました。${msg ? `
${msg}` : '少し置いて試してください。'}`;
  if (status === 400 && /credit|balance/i.test(msg)) return 'Anthropicの残高が足りません。コンソールでクレジットを追加してください。';
  if (status === 529) return 'Anthropic側が混み合っています（529）。3回やり直しても駄目でした。少し置いてもう一度どうぞ。';
  if (status >= 500) return `Anthropic側の一時的な不具合です（${status}）。少し置いてもう一度どうぞ。`;
  return `Anthropicでエラー（${status}）${msg ? '：' + msg : ''}`;
}

/**
 * そのキーでそのモデルが本当に通るかを、最小の1回で確かめる。
 * モデル名を当てにいくと外すので、推測せず投げて確かめる。
 */
export async function testModel(settings, modelId) {
  const probe = { ...settings, [settings.provider === 'anthropic' ? 'anthropicModel' : 'geminiModel']: modelId };
  try {
    await ask({ settings: probe, context: '（疎通確認）', history: [], text: 'ok と一言だけ返してください' });
    return { ok: true, model: modelId };
  } catch (e) {
    return { ok: false, model: modelId, message: e.message || String(e) };
  }
}

/** 一覧から食事の写真を扱えそうなものを、通しやすい順に並べる。 */
export function rankModels(models) {
  const bad = /embedding|imagen|veo|tts|audio|live|native|image-gen/i;
  return models
    .map((m) => (typeof m === 'string' ? m : m.id))
    .filter((id) => !bad.test(id))
    .sort((a, b) => score(b) - score(a));
}
function score(id) {
  let n = 0;
  if (/flash/i.test(id)) n += 10;          // 無料枠の対象はFlash系
  if (/lite/i.test(id)) n += 3;            // Liteは枠が大きいことが多い
  if (/pro/i.test(id)) n -= 5;             // Proは有料寄り
  if (/preview|exp|experimental/i.test(id)) n -= 4;
  const v = /(\d+(?:\.\d+)?)/.exec(id);
  if (v) n += Math.min(3, Number(v[1]) / 2); // 新しめを少しだけ優先
  return n;
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
