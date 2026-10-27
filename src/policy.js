// Policy = numeric strategy parameters (searched with an evolution strategy) +
// choice preferences (updated from run outcomes, bandit style).
'use strict';

const fs = require('fs');
const path = require('path');

const POLICY_FILE = path.join(__dirname, '..', 'policy', 'policy.json');

// [default, min, max, initial search step]
const PARAM_SPACE = {
  // when to call the boss (stage time in seconds; the final swarm starts at 600)
  bossTime1: [270, 150, 560, 60],
  bossTime2: [300, 150, 560, 60],
  bossTime3: [330, 150, 560, 60],
  // last stage after the final boss: seconds to keep scoring next to the portal,
  // and the HP fraction at which to step in and lock the win
  finalStay: [300, 0, 1500, 120],
  exitHp: [0.45, 0.15, 0.9, 0.1],
  finalRadius: [10, 4, 30, 4],
  targetPatience: [25, 8, 80, 8],
  // movement / survival
  goalW: [1.4, 0.3, 4, 0.4],
  dangerW: [1.6, 0.3, 5, 0.4],
  dangerR: [2.2, 0.8, 6, 0.5],
  bossFear: [3, 0.5, 8, 0.8],
  bossDist: [9, 4, 18, 2],
  shotW: [1.2, 0, 4, 0.4],
  hazardW: [6, 0, 15, 1.5],
  lowHp: [0.35, 0.1, 0.7, 0.08],
  dashHp: [0.5, 0, 1, 0.15],
  xpW: [0.6, 0, 2, 0.3],
  xpRadius: [14, 4, 30, 4],
  xpEarly: [2.5, 1, 6, 0.8],
  earlyLevel: [6, 1, 20, 3],
  earlyRadius: [45, 15, 150, 20],
  fearEarly: [2, 0.5, 5, 0.5],
  goalEarly: [0.6, 0.1, 2, 0.2],
  crowdW: [0.6, 0, 3, 0.3],
  ultCrowd: [20, 5, 60, 8],
  // value of each map object (utility = value / (1 + distance / distScale))
  distScale: [40, 10, 120, 15],
  v_freechest: [10, 0, 20, 2],
  v_chest: [6, 0, 15, 2],
  v_altar0: [4, 0, 12, 2],
  v_altar1: [5, 0, 12, 2],
  v_altar2: [5, 0, 12, 2],
  v_altar3: [7, 0, 15, 2],
  v_challenge: [2, 0, 10, 2],
  v_greed: [1, 0, 8, 1.5],
  v_cursed: [0.5, 0, 8, 1.5],
  v_cursedchest: [2, 0, 8, 1.5],
  v_magnet: [2, 0, 8, 1.5],
  v_berry: [3, 0, 10, 1.5],
  v_rock: [0.8, 0, 5, 0.8],
  v_snorlax: [2.5, 0, 8, 1.5],
  v_cage: [1.5, 0, 8, 1.5],
  v_shop: [2, 0, 10, 2],
  v_ditto: [2, 0, 8, 1.5],
  v_nest: [1, 0, 6, 1],
  v_rhydon: [0, 0, 6, 1],
  altar2Level: [8, 1, 30, 4],
  altar3Level: [14, 1, 40, 5],
  challengeLevel: [10, 1, 40, 5],
  goldReserve: [0, 0, 300, 50],
  shopGold: [250, 50, 1500, 150],
  choiceNoise: [0.3, 0, 1.5, 0.15],
};

const DEFAULT_WEIGHTS = {
  kind: { newMove: 1.5, upMove: 1.0, newVit: 0.8, upVit: 0.6 },
  rarity: 0.8,
  moveLevel: 0.3,
  key: {},
  stat: {
    damage: 1.0, attackSpeed: 1.0, maxHp: 0.7, moveSpeed: 0.6, critChance: 0.7, area: 0.6,
    xpGain: 0.5, regen: 0.5, armor: 0.6, luck: 0.3, duration: 0.4, statusChance: 0.3,
  },
  item: {},
};

function defaults() {
  const params = {}, sigma = {};
  for (const [k, [d, , , s]] of Object.entries(PARAM_SPACE)) { params[k] = d; sigma[k] = s; }
  return {
    version: 1, generation: 0, episodes: 0,
    params, sigma, weights: JSON.parse(JSON.stringify(DEFAULT_WEIGHTS)),
    baseline: null, best: null, history: [],
  };
}

function load(file = POLICY_FILE) {
  const base = defaults();
  if (!fs.existsSync(file)) return base;
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  // new parameters added later get their defaults
  p.params = { ...base.params, ...p.params };
  p.sigma = { ...base.sigma, ...p.sigma };
  p.weights = { ...base.weights, ...p.weights };
  return p;
}

function save(p, file = POLICY_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(p, null, 1));
}

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clampParam = (k, v) => {
  const [, lo, hi] = PARAM_SPACE[k];
  return Math.min(hi, Math.max(lo, v));
};

// Antithetic pair of perturbations around the current mean.
function samplePair(policy) {
  const eps = {}, a = {}, b = {};
  for (const k of Object.keys(PARAM_SPACE)) {
    eps[k] = gauss();
    a[k] = clampParam(k, policy.params[k] + policy.sigma[k] * eps[k]);
    b[k] = clampParam(k, policy.params[k] - policy.sigma[k] * eps[k]);
  }
  return { eps, a, b };
}

// Scores span 100s to 100,000s (late stages add a lot of damage points), so the
// learning signal works on log score.
const fitness = (score) => Math.log1p(Math.max(0, score || 0));

// Evolution-strategy step from evaluated pairs: [{eps, scoreA, scoreB}].
function esUpdate(policy, pairs, lr = 0.6) {
  if (!pairs.length) return;
  const diffs = pairs.map((p) => fitness(p.scoreA) - fitness(p.scoreB));
  const scale = Math.max(1, Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length));
  for (const k of Object.keys(PARAM_SPACE)) {
    let g = 0;
    for (let i = 0; i < pairs.length; i++) g += (diffs[i] / scale) * pairs[i].eps[k];
    g /= pairs.length;
    policy.params[k] = clampParam(k, policy.params[k] + lr * policy.sigma[k] * g);
    policy.sigma[k] = Math.max(PARAM_SPACE[k][3] * 0.25, policy.sigma[k] * 0.98);
  }
}

// Choice preferences: every pick in a run is nudged by how that run did against
// the running baseline score.
function creditChoices(policy, result, lr = 0.15) {
  const f = fitness(result.score);
  const base = policy.baseline ?? f;
  const adv = Math.max(-1.5, Math.min(1.5, f - base));
  const W = policy.weights;
  const seen = new Set();
  for (const pk of result.picks || []) {
    const id = pk.t + ':' + pk.k;
    if (seen.has(id)) continue; // count each option once per run
    seen.add(id);
    if (pk.t === 'lv') W.key[pk.k] = (W.key[pk.k] ?? 0) + lr * adv;
    else if (pk.t === 'st') W.stat[pk.k] = (W.stat[pk.k] ?? 0) + lr * adv;
    else if (pk.t === 'it') W.item[pk.k] = (W.item[pk.k] ?? 0) + lr * adv;
  }
  policy.baseline = base + 0.1 * (f - base);
}

// Weights as sent to the agent: adds the mean preference used for unseen options.
function weightsForPlay(policy) {
  const W = policy.weights;
  const mean = (o) => { const v = Object.values(o); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
  return { ...W, itemMean: mean(W.item), keyMean: mean(W.key) };
}

module.exports = { weightsForPlay, fitness, POLICY_FILE, PARAM_SPACE, defaults, load, save, samplePair, esUpdate, creditChoices };
