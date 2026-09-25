// 目標カロリーとPFCの計算。式は全部ここに置いて、画面側は数字を受け取るだけにする。

import { r0, r1, clamp, daysBetween, ymd, addDays } from './util.js';

export const ACTIVITY_LEVELS = [
  { key: 'sedentary', factor: 1.2,   label: '座位中心（運動は別に記録）' },
  { key: 'light',     factor: 1.375, label: '軽い（週1〜3回の運動）' },
  { key: 'moderate',  factor: 1.55,  label: '中くらい（週3〜5回）' },
  { key: 'active',    factor: 1.725, label: '高い（週6〜7回）' },
];

export const DEFAULT_SETTINGS = {
  provider: 'gemini',
  geminiKey: '',
  anthropicKey: '',
  geminiModel: 'gemini-3.8-flash',
  anthropicModel: 'claude-haiku-4-5',
  profile: { sex: null, birthYear: null, heightCm: null, activity: 'sedentary' },
  goal: {
    mode: 'diet',            // diet | maintain | bulk
    startWeightKg: null,
    targetWeightKg: null,
    targetDate: '',
    manualPaceKgPerWeek: 0.5, // 目標日を入れない場合のペース
    useAdaptive: false,       // 実測の消費カロリーを上限の元にする（確かさが中以上のときだけ）
  },
  macro: {
    proteinGPerKg: 1.8,      // 目標体重あたり
    fatPctOfKcal: 0.25,
  },
  addExerciseToBudget: true, // 運動で消費した分を上限に足す
  dayCutoffHour: 4,          // 深夜◯時までは前日扱い
  prefs: '',                 // 好み・苦手・アレルギー・よく行く店
  onboarded: false,
};

export function mergeSettings(saved) {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (!saved) return s;
  for (const k of Object.keys(s)) {
    if (saved[k] == null) continue;
    if (typeof s[k] === 'object' && !Array.isArray(s[k])) Object.assign(s[k], saved[k]);
    else s[k] = saved[k];
  }
  return s;
}

export function ageOf(birthYear, at = new Date()) {
  return clamp(at.getFullYear() - Number(birthYear || 1990), 10, 100);
}

/** 上限カロリーを出すのに足りない項目。空なら計算できる。 */
export function missingProfile(settings, weightKg) {
  const m = [];
  if (!settings.profile.sex) m.push('性別');
  if (!settings.profile.birthYear) m.push('生まれ年');
  if (!settings.profile.heightCm) m.push('身長');
  if (weightKg == null) m.push('いまの体重');
  if (settings.goal.mode !== 'maintain' && !settings.goal.targetWeightKg) m.push('目標体重');
  return m;
}

// Mifflin-St Jeor
export function bmr({ sex, heightCm, birthYear }, weightKg) {
  const w = Number(weightKg) || 0;
  const h = Number(heightCm) || 0;
  const a = ageOf(birthYear);
  const base = 10 * w + 6.25 * h - 5 * a;
  return Math.max(800, base + (sex === 'female' ? -161 : 5));
}

export function activityFactor(key) {
  return (ACTIVITY_LEVELS.find((l) => l.key === key) || ACTIVITY_LEVELS[0]).factor;
}

// 生活だけの消費（運動を別記録する前提なら sedentary を選んでおく）
export function tdee(settings, weightKg) {
  return bmr(settings.profile, weightKg) * activityFactor(settings.profile.activity);
}

// 目標日まで何kg／週で落とす必要があるか
export function requiredPace(goal, currentKg, today = ymd()) {
  if (goal.mode === 'maintain') return 0;
  if (!goal.targetWeightKg || !goal.targetDate) {
    const p = Math.abs(Number(goal.manualPaceKgPerWeek) || 0);
    return goal.mode === 'bulk' ? -p : p;   // 増量なのに赤字にしていた
  }
  const days = daysBetween(today, goal.targetDate);
  if (days <= 0) return 0;
  const diff = Number(currentKg) - Number(goal.targetWeightKg); // 正なら減量
  return (diff / days) * 7;
}

const KCAL_PER_KG = 7200;

/**
 * その日の予算。
 * budget = 生活消費 - 目標赤字 (+ 運動消費)
 * 安全のため、基礎代謝の1.05倍を下回らないところで止める。
 * expenditure（estimateExpenditure の結果）を渡し、設定で使うことにしていれば、
 * 式の生活消費の代わりに実測の消費を元にする。確かさが低いうちは式のまま。
 */
export function dailyBudget(settings, weightKg, exerciseKcal = 0, today = ymd(), expenditure = null) {
  const formula = tdee(settings, weightKg);
  // usable は store が決める（中以上になったら、式に戻る理由が出るまで使い続ける。境目で上限が跳ねないため）
  const adaptive = !!(settings.goal.useAdaptive && expenditure?.kcal && (expenditure.usable ?? expenditure.confidence !== 'low'));
  const base = adaptive ? expenditure.kcal : formula;
  const pace = requiredPace(settings.goal, weightKg, today); // kg/週（正=減量）
  const rawDeficit = (pace * KCAL_PER_KG) / 7;
  // 下限：基礎代謝、かつ絶対最小（男1500/女1200 kcal）を割らない
  const bm = bmr(settings.profile, weightKg);
  const floor = Math.max(bm, settings.profile.sex === 'female' ? 1200 : 1500);
  const wanted = base - rawDeficit;
  const capped = Math.max(floor, wanted);
  // 実測の消費には、ふだんの運動がもう入っている。その日の運動まで足すと二重になる。
  const addEx = settings.addExerciseToBudget && !adaptive;
  const exAdded = addEx ? Number(exerciseKcal) || 0 : 0;
  const budget = capped + exAdded;
  return {
    base: r0(base),
    formulaBase: r0(formula),
    adaptive,
    bmr: r0(bm),
    paceKgPerWeek: r1(pace),
    deficit: r0(base - capped),
    exercise: r0(exerciseKcal),
    exerciseAdded: r0(exAdded),
    budget: r0(budget),
    // 目標日までに間に合わないペースを要求されていないか
    paceTooFast: pace > 1.0,
    cappedByFloor: wanted < floor - 1,
  };
}

// PFC。P固定 → F割合 → 残りをC。
export function macroTargets(settings, budgetKcal, weightKg) {
  const anchorKg = Number(settings.goal.targetWeightKg) || Number(weightKg) || 60;
  const p = Math.max(40, (Number(settings.macro.proteinGPerKg) || 1.8) * anchorKg);
  const f = Math.max(25, ((Number(settings.macro.fatPctOfKcal) || 0.25) * budgetKcal) / 9);
  const c = Math.max(0, (budgetKcal - p * 4 - f * 9) / 4);
  return { p: r0(p), f: r0(f), c: r0(c) };
}

// 体重の移動平均（日々の増減に振り回されないため）
export function movingAverage(rows, window = 7) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const from = Math.max(0, i - window + 1);
    const slice = rows.slice(from, i + 1);
    const avg = slice.reduce((a, r) => a + r.kg, 0) / slice.length;
    out.push({ ...rows[i], avg: r1(avg) });
  }
  return out;
}

// ---------------------------------------------------------------- 実測の消費カロリー
// 式のTDEEは人によって±20%ずれる。食べた量と体重の動きが揃えば、
// 「食べた − 体重の増減ぶん」で本人の実際の消費が逆算できる（MacroFactorと同じ考え方）。

const XP_WINDOW = 28;     // 直近何日を見るか
const XP_MIN_DAYS = 14;   // 食事の記録がこれだけ無いと平均が当てにならない
const XP_MIN_WEIGH = 6;   // 体重の回数
const XP_MIN_SPAN = 10;   // 体重の最初と最後が何日ひらいているか（短いと水分の上下を傾きと取り違える）

function gatherXp(days, { floorKcal = 0, today = null, window = XP_WINDOW } = {}) {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  // 今日はまだ食べ終わっていないので摂取には入れない。体重は今朝の分まで使う（昨日食べた結果なので）
  const rows = sorted.filter((d) => !today || d.day < today).slice(-window);
  const logged = rows.filter((d) => d.meals > 0);
  // 記録が極端に少ない日は「食べなかった」より「書き忘れた」のほうがずっと多い
  // 1食だけ書き忘れた日は、ふだんの日の65%を切ることが多い。中央値を基準にそれも外す
  const ks = logged.map((d) => d.kcal).sort((a, b) => a - b);
  const median = ks.length ? ks[Math.floor(ks.length / 2)] : 0;
  const cut = Math.max(floorKcal, median * 0.65);
  const used = logged.filter((d) => d.kcal >= cut);
  // 体重は摂取を数えた期間（最初の記録日〜最後の記録日の翌朝）に揃える。
  // 揃えないと、記録していない前半の体重の動きまで摂取の平均で説明しようとしてずれる
  const from = used.length ? used[0].day : null;
  const to = used.length ? addDays(used[used.length - 1].day, 1) : null;
  const w = sorted.filter((d) => d.weight != null && from && d.day >= from && d.day <= to);
  const t0 = w.length ? w[0].day : null;
  const weigh = w.map((d) => ({ t: daysBetween(t0, d.day), kg: Number(d.weight) }));
  const spanDays = weigh.length ? weigh[weigh.length - 1].t : 0;
  // 記録の抜け。抜けた日は「平均並みに食べた」扱いになるが、実際は食べ過ぎを書かなかった日が多い
  const period = from ? daysBetween(from, rows[rows.length - 1].day) + 1 : 0;
  const coverage = period ? used.length / period : 0;
  return { used, excluded: logged.length - used.length, weigh, spanDays, coverage };
}

/** 実測に足りないもの。0なら足りている。 */
export function expenditureNeeds(days, opts = {}) {
  const g = gatherXp(days, opts);
  return {
    loggedDays: g.used.length,
    excluded: g.excluded,
    weighIns: g.weigh.length,
    spanDays: g.spanDays,
    days: Math.max(0, XP_MIN_DAYS - g.used.length),
    weights: Math.max(0, XP_MIN_WEIGH - g.weigh.length),
    span: Math.max(0, XP_MIN_SPAN - g.spanDays),
  };
}

/**
 * 実測の消費カロリー。days は recentDays() の形 [{day, kcal, meals, weight}]。
 * 1. 記録のある日の平均摂取（floorKcal 未満の日は書き忘れとみなして外す）
 * 2. 体重を前後3日の平均でならし、その点に直線を当てて傾き(kg/日)を出す
 * 3. 消費 = 平均摂取 − 傾き × 7200
 * 足りなければ null。
 */
export function estimateExpenditure(days, opts = {}) {
  const g = gatherXp(days, opts);
  const n = g.used.length, m = g.weigh.length;
  if (n < XP_MIN_DAYS || m < XP_MIN_WEIGH || g.spanDays < XP_MIN_SPAN) return null;

  const intake = g.used.reduce((a, d) => a + d.kcal, 0) / n;

  // 前後3日の平均。点の位置も窓の中の平均日にするので、端で窓が欠けても傾きが寝ない。
  const pts = g.weigh.map((p) => {
    const win = g.weigh.filter((q) => Math.abs(q.t - p.t) <= 3);
    return {
      t: win.reduce((a, q) => a + q.t, 0) / win.length,
      kg: win.reduce((a, q) => a + q.kg, 0) / win.length,
    };
  });
  const mt = pts.reduce((a, p) => a + p.t, 0) / m;
  const mk = pts.reduce((a, p) => a + p.kg, 0) / m;
  let sxy = 0, sxx = 0;
  for (const p of pts) { sxy += (p.t - mt) * (p.kg - mk); sxx += (p.t - mt) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0;   // kg/日（負なら減っている）

  const raw = intake - slope * KCAL_PER_KG;
  const kcal = clamp(raw, 1000, 5000);

  let confidence = 'low';
  if (n >= 24 && m >= 18 && g.spanDays >= 21 && g.coverage >= 0.9) confidence = 'high';
  else if (n >= 18 && m >= 10 && g.spanDays >= 14 && g.coverage >= 0.8) confidence = 'medium';
  const clamped = kcal !== raw;
  if (clamped) confidence = 'low';   // 範囲の外に出たなら、どこかの記録がおかしい

  return {
    kcal: r0(kcal),
    confidence,
    intake: r0(intake),
    loggedDays: n,
    excluded: g.excluded,
    weighIns: m,
    spanDays: g.spanDays,
    slopeKgPerWeek: Math.round(slope * 7 * 100) / 100,
    coverage: Math.round(g.coverage * 100) / 100,
    clamped,
  };
}
