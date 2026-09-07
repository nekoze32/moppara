// アプリの状態。設定と「今日の集計」をここで持ち、変わったら購読者に投げる。

import * as db from './db.js';
import { mergeSettings, dailyBudget, macroTargets, missingProfile, DEFAULT_SETTINGS } from './nutrition.js';
import { mealDay, sumMeals, ymd, addDays, r0 } from './util.js';

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((f) => f(state));

export const state = {
  settings: structuredClone(DEFAULT_SETTINGS),
  today: ymd(),
  meals: [],
  activities: [],
  weight: null,       // {day, kg, fatPct}
  latestWeight: null, // 直近の記録（今日が無ければ遡る）
  budget: null,       // dailyBudget()の結果
  targets: null,      // {p,f,c}
  eaten: { kcal: 0, p: 0, f: 0, c: 0 },
  exerciseKcal: 0,
  presets: [],
  storageError: null,
  restoredFromBackup: false,
  missing: [],   // 上限を出すのに足りない項目
  ready: false,  // 全部そろったか
};

export async function init() {
  await db.requestPersist();
  let saved = null;
  try {
    saved = await db.getKV('settings');
  } catch (e) {
    // 保存領域が開けなくてもアプリは立ち上げる。黙って空画面にしない。
    state.storageError = e.message || '保存領域を開けませんでした';
    state.settings = mergeSettings(db.readMirror());
    await refresh().catch(() => {});
    return;
  }
  // IndexedDB側が空でも、控えが残っていれば書き戻す（キーの入れ直しを防ぐ）
  if (!saved || !(saved.geminiKey || saved.anthropicKey)) {
    const backup = db.readMirror();
    if (backup && (backup.geminiKey || backup.anthropicKey)) {
      saved = { ...(saved || {}), ...backup };
      await db.setKV('settings', mergeSettings(saved));
      state.restoredFromBackup = true;
    }
  }
  state.settings = mergeSettings(saved);
  await refresh();
}

export async function saveSettings(patch) {
  state.settings = mergeSettings({ ...state.settings, ...patch });
  await db.setKV('settings', state.settings);
  db.mirrorSettings(state.settings);
  await refresh();
}

/** AIが会話から聞き取った項目だけを設定へ反映する。 */
export async function applySetup(setup) {
  if (!setup) return [];
  const s = structuredClone(state.settings);
  const got = [];
  const P = { sex: '性別', birthYear: '生まれ年', heightCm: '身長', activity: '活動量' };
  for (const k of Object.keys(P)) {
    if (setup[k] != null && setup[k] !== '') { s.profile[k] = setup[k]; got.push(P[k]); }
  }
  if (setup.goalMode) { s.goal.mode = setup.goalMode; got.push('目標'); }
  if (setup.targetWeightKg != null) { s.goal.targetWeightKg = setup.targetWeightKg; got.push('目標体重'); }
  if (setup.targetDate) { s.goal.targetDate = setup.targetDate; got.push('目標の日'); }
  if (!got.length) return [];
  await saveSettings(s);
  return got;
}

export function currentDay() {
  return mealDay(new Date(), state.settings.dayCutoffHour);
}

export async function refresh() {
  state.today = currentDay();
  try {
    state.meals = await db.mealsOf(state.today);
    state.activities = await db.activitiesOf(state.today);
    state.presets = await db.allPresets();
  } catch { state.meals = []; state.activities = []; state.presets = []; }

  const weights = await db.allWeights().catch(() => []);
  state.weight = weights.find((w) => w.day === state.today) || null;
  state.latestWeight = weights.length ? weights[weights.length - 1] : null;

  const known = state.weight?.kg ?? state.latestWeight?.kg ?? state.settings.goal.startWeightKg ?? null;
  state.missing = missingProfile(state.settings, known);
  state.ready = state.missing.length === 0;
  const kg = known ?? 70;
  state.exerciseKcal = state.activities.reduce((a, x) => a + (Number(x.kcal) || 0), 0);
  state.budget = dailyBudget(state.settings, kg, state.exerciseKcal, state.today);
  state.targets = macroTargets(state.settings, state.budget.budget, kg);
  state.eaten = sumMeals(state.meals);
  emit();
}

export function remaining() {
  const b = state.budget?.budget || 0;
  return {
    kcal: r0(b - state.eaten.kcal),
    p: r0((state.targets?.p || 0) - state.eaten.p),
    f: r0((state.targets?.f || 0) - state.eaten.f),
    c: r0((state.targets?.c || 0) - state.eaten.c),
    pct: b > 0 ? state.eaten.kcal / b : 0,
  };
}

export function weightKg() {
  return state.weight?.kg ?? state.latestWeight?.kg ?? state.settings.goal.startWeightKg ?? null;
}

export function hasKey(s = state.settings) {
  return s.provider === 'anthropic' ? !!s.anthropicKey : !!s.geminiKey;
}

// 直近n日ぶんの日別サマリ（推移タブとAIへの文脈で使う）
export async function recentDays(n = 14) {
  const meals = await db.allMeals();
  const acts = await db.allActivities();
  const weights = await db.allWeights();
  const wmap = new Map(weights.map((w) => [w.day, w]));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = addDays(state.today, -i);
    const dm = meals.filter((m) => m.day === day);
    const s = sumMeals(dm);
    out.push({
      day,
      kcal: r0(s.kcal), p: r0(s.p), f: r0(s.f), c: r0(s.c),
      exercise: r0(acts.filter((a) => a.day === day).reduce((x, a) => x + (Number(a.kcal) || 0), 0)),
      weight: wmap.get(day)?.kg ?? null,
      meals: dm.length,
    });
  }
  return out;
}
