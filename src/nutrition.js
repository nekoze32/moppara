// 目標カロリーとPFCの計算。式は全部ここに置いて、画面側は数字を受け取るだけにする。

import { r0, r1, clamp, daysBetween, ymd } from './util.js';

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
  if (!goal.targetWeightKg || !goal.targetDate) return Number(goal.manualPaceKgPerWeek) || 0;
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
 */
export function dailyBudget(settings, weightKg, exerciseKcal = 0, today = ymd()) {
  const base = tdee(settings, weightKg);
  const pace = requiredPace(settings.goal, weightKg, today); // kg/週（正=減量）
  const rawDeficit = (pace * KCAL_PER_KG) / 7;
  // 下限：基礎代謝、かつ絶対最小（男1500/女1200 kcal）を割らない
  const bm = bmr(settings.profile, weightKg);
  const floor = Math.max(bm, settings.profile.sex === 'female' ? 1200 : 1500);
  const wanted = base - rawDeficit;
  const capped = Math.max(floor, wanted);
  const budget = capped + (settings.addExerciseToBudget ? Number(exerciseKcal) || 0 : 0);
  return {
    base: r0(base),
    bmr: r0(bm),
    paceKgPerWeek: r1(pace),
    deficit: r0(base - capped),
    exercise: r0(exerciseKcal),
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
