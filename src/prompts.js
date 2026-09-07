// AIに渡すシステムプロンプトと、その時点の状況テキスト。

import { fmt, r0, r1, jpDate, hhmm, sumItems } from './util.js';
import { state, remaining, weightKg } from './store.js';

export const SYSTEM = `あなたは日本語で応対する食事管理のパーソナルトレーナーです。利用者は多忙な社会人で、面倒な入力を嫌います。

## あなたの仕事
1. 食べたものの記録（写真・文章のどちらでも）を、料理名・分量・カロリー・PFCに変換する
2. 体重や運動の申告を拾う
3. その日の残りカロリーとPFCを踏まえて、これから何をどれだけ食べればよいかを具体的に助言する

## 記録するときの決まり
- 写真は日本の家庭料理・外食・コンビニ商品として解釈する。器の大きさや付け合わせから分量を見積もる。
- 分量が写真や文章から確定できないときは、日本人の一般的な一人前を仮定して必ず数字を出す。「分かりません」と返さない。仮定した内容は assumptions に日本語で1行ずつ書く。
- 定食・丼・弁当は構成要素に分ける（例：ご飯150g／鶏の唐揚げ3個／味噌汁）。単品はそのまま1行。
- カロリーとPFCは日本食品標準成分表の水準で見積もる。P・F・Cのグラム数から計算したカロリー（P×4＋F×9＋C×4）が kcal とおおむね合うようにする。
- confidence は写真がはっきりして分量も読める場合 high、料理は分かるが量が曖昧なら medium、推測が大きいなら low。
- 「いつもの◯◯」のように過去の記録を指している場合は、下の【いつも食べているもの】から数値をそのまま使う。
- 時間帯から slot（朝／昼／夜／間食）を判断する。文章に指定があればそちらを優先する。

## はじめての聞き取り
【まだ聞けていないこと】が出ている間は、これを埋めるのが最優先です。食事の記録より先に聞いてください。
- **一度に聞くのは1〜2項目まで。**全部まとめて聞かない。フォームのように箇条書きで並べない。
- 聞けた項目だけ setup に入れる。聞けていない項目は入れない（推測で埋めない）。
- 年齢を言われたら birthYear に西暦で入れる。「38歳」なら今年から38を引く。
- 「デスクワーク」「運動していない」は activity を sedentary に。
- 体重を言われたら setup ではなく weight に入れる。
- 目標体重だけ言われて期限が無ければ targetDate は入れない。急かさない。
- **上限カロリーやPFCの数字を、聞き取り中に自分で言わないこと。**その時点ではまだ計算できていないので、言えば必ず外れます。数字はアプリが出します。
- 最後の項目が埋まったときは「これで計算できます」と一言だけ返す。数字は書かない。

## 相談に答えるとき
- 「今夜どこで何を食べたらいい？」「回転寿司で何皿まで？」のような相談では meal は null にして、reply に**具体的な品目と個数・グラム数**を書く。「バランスよく」「食べ過ぎに注意」のような一般論は書かない。
- 残りカロリーとPFCの中に収まる案を出す。残りが少ない日は「何を諦めるか」まで言う。
- 店名を挙げるときは日本のチェーン店など実在するものにし、代表的なメニューの実際のカロリーに触れる。
- 残りカロリーを超えてしまった日は責めない。翌日以降でどう均すかを1文で示す。

## reply の書き方
- 2〜4文。挨拶・前置き・復唱は書かない。
- 記録したときは「何をいくらで記録したか」ではなく、**その結果どうなったか**（残りいくら、PFCのどれが不足か、夜に何が食べられるか）を書く。数字は具体的に。
- 敬体（です・ます）。絵文字は使わない。`;

// 出力スキーマ（Gemini の responseSchema / Anthropic の input_schema の共通の元）
export const SCHEMA_FIELDS = {
  reply: { type: 'string', description: '利用者に見せる返事。2〜4文の日本語。' },
  meal: {
    type: 'object',
    description: '食事を記録する場合のみ。相談だけのときは null。',
    properties: {
      slot: { type: 'string', enum: ['朝', '昼', '夜', '間食'] },
      items: {
        type: 'array',
        description: '料理を構成要素ごとに分けた明細',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '料理名' },
            amount: { type: 'string', description: '分量（例: 150g、1杯、3個）' },
            kcal: { type: 'number' },
            p: { type: 'number', description: 'たんぱく質 g' },
            f: { type: 'number', description: '脂質 g' },
            c: { type: 'number', description: '炭水化物 g' },
          },
          required: ['name', 'amount', 'kcal', 'p', 'f', 'c'],
        },
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      assumptions: { type: 'array', items: { type: 'string' }, description: '分量などで仮定したこと' },
    },
    required: ['slot', 'items', 'confidence'],
  },
  weight: {
    type: 'object',
    description: '体重の申告があった場合のみ。無ければ null。',
    properties: { kg: { type: 'number' }, fatPct: { type: 'number' } },
    required: ['kg'],
  },
  setup: {
    type: 'object',
    description: '初期の聞き取りで、この発話から確定した項目だけを入れる。聞けていない項目は入れない。',
    properties: {
      sex: { type: 'string', enum: ['male', 'female'] },
      birthYear: { type: 'number', description: '生まれた西暦' },
      heightCm: { type: 'number' },
      activity: { type: 'string', enum: ['sedentary', 'light', 'moderate', 'active'] },
      goalMode: { type: 'string', enum: ['diet', 'maintain', 'bulk'] },
      targetWeightKg: { type: 'number' },
      targetDate: { type: 'string', description: 'YYYY-MM-DD' },
    },
  },
  activity: {
    type: 'object',
    description: '運動の申告があった場合のみ。無ければ null。消費カロリーは体重から見積もる。',
    properties: {
      name: { type: 'string' },
      kcal: { type: 'number' },
      minutes: { type: 'number' },
    },
    required: ['name', 'kcal'],
  },
};

export const REQUIRED = ['reply'];

/** その時点の状況。毎ターン先頭に付ける。 */
export function contextBlock({ presets = [], recent = [] } = {}) {
  const s = state.settings;
  const rem = remaining();
  const b = state.budget;
  const kg = weightKg();
  const now = new Date();
  const L = [];

  L.push(`【いまの状況】`);
  L.push(`日時: ${jpDate(state.today)} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`);

  if (!state.ready) {
    L.push(`★【まだ聞けていないこと】${state.missing.join('・')}`);
    L.push(`これが埋まるまで1日の上限は計算できません。1〜2項目ずつ会話で聞いてください。`);
    const p = s.profile;
    L.push(`聞けているもの: ${[
      p.sex ? `性別=${p.sex === 'female' ? '女性' : '男性'}` : null,
      p.birthYear ? `生まれ年=${p.birthYear}` : null,
      p.heightCm ? `身長=${p.heightCm}cm` : null,
      kg != null ? `体重=${kg}kg` : null,
      s.goal.targetWeightKg ? `目標体重=${s.goal.targetWeightKg}kg` : null,
    ].filter(Boolean).join(' / ') || 'まだ何も'}`);
    if (s.prefs?.trim()) L.push(`【好み・制限】${s.prefs.trim()}`);
    return L.join('\n');
  }

  const g = s.goal;
  if (g.mode === 'diet' && g.targetWeightKg) {
    L.push(`目標: 減量 ${g.targetWeightKg}kg${g.targetDate ? `（${g.targetDate}まで）` : ''} / 現在 ${kg ?? '未登録'}kg / 想定ペース ${r1(b?.paceKgPerWeek || 0)}kg/週`);
  } else if (g.mode === 'bulk') {
    L.push(`目標: 増量 ${g.targetWeightKg || '—'}kg / 現在 ${kg ?? '未登録'}kg`);
  } else {
    L.push(`目標: 体重維持 / 現在 ${kg ?? '未登録'}kg`);
  }

  L.push(`今日の上限: ${fmt(b?.budget)} kcal（生活消費 ${fmt(b?.base)}／運動 +${fmt(b?.exercise)}）`);
  L.push(`PFC目標: P ${state.targets?.p}g / F ${state.targets?.f}g / C ${state.targets?.c}g`);
  L.push(`ここまでの摂取: ${fmt(state.eaten.kcal)} kcal（P ${r0(state.eaten.p)}g / F ${r0(state.eaten.f)}g / C ${r0(state.eaten.c)}g）`);
  L.push(`★残り: ${fmt(rem.kcal)} kcal（P ${rem.p}g / F ${rem.f}g / C ${rem.c}g）`);

  if (state.meals.length) {
    L.push(`今日の記録:`);
    for (const m of state.meals) {
      const t = sumItems(m.items);
      L.push(`  ${hhmm(m.at)} ${m.slot} ${m.items.map((i) => `${i.name}${i.amount ? `(${i.amount})` : ''}`).join('・')} = ${fmt(t.kcal)}kcal`);
    }
  } else {
    L.push(`今日の記録: まだ無し`);
  }

  if (state.activities.length) {
    L.push(`今日の運動: ${state.activities.map((a) => `${a.name} ${fmt(a.kcal)}kcal`).join('・')}`);
  }

  if (recent.length) {
    const withData = recent.filter((d) => d.meals > 0);
    if (withData.length) {
      const avg = withData.reduce((a, d) => a + d.kcal, 0) / withData.length;
      L.push(`直近${withData.length}日の平均摂取: ${fmt(avg)} kcal`);
    }
    const ws = recent.filter((d) => d.weight != null);
    if (ws.length >= 2) {
      L.push(`体重の推移: ${ws[0].weight}kg（${jpDate(ws[0].day)}）→ ${ws[ws.length - 1].weight}kg（${jpDate(ws[ws.length - 1].day)}）`);
    }
  }

  if (presets.length) {
    L.push(`【いつも食べているもの】（「いつもの◯◯」と言われたらこの数値を使う）`);
    for (const p of presets.slice(0, 12)) {
      const t = sumItems(p.items);
      L.push(`  ${p.name}: ${fmt(t.kcal)}kcal P${r0(t.p)} F${r0(t.f)} C${r0(t.c)}`);
    }
  }

  if (s.prefs && s.prefs.trim()) {
    L.push(`【好み・制限】${s.prefs.trim()}`);
  }

  return L.join('\n');
}
