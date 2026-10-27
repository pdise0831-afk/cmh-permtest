#!/usr/bin/env node
// Learning loop. Each generation evaluates antithetic pairs of strategy parameters
// (mean + sigma*eps, mean - sigma*eps) on full runs, then:
//   - moves the parameter mean toward the better side (evolution strategy)
//   - nudges the preference of every level-up / blessing / item picked by how the
//     run scored against the running baseline
// Progress is saved to policy/policy.json after every generation, so training can be
// stopped and resumed at any time.
//   node src/train.js [--generations 10] [--pairs 2] [--workers 2] [--species 4] [--biome forest]
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openGameRetry, playEpisode } = require('./harness');
const policy = require('./policy');

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2), v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
    o[k] = v;
  }
  return o;
}

const RUN_LOG = path.join(__dirname, '..', 'runs', 'train.jsonl');

async function main() {
  const o = args();
  const generations = Number(o.generations || 10);
  const pairs = Number(o.pairs || 2);
  const workers = Math.max(1, Number(o.workers || 2));
  const game = { species: Number(o.species || 4), biome: o.biome || 'forest', tier: Number(o.tier || 0) };
  fs.mkdirSync(path.dirname(RUN_LOG), { recursive: true });

  const browser = await launch();
  const pages = [];
  for (let i = 0; i < workers; i++) pages.push((await openGameRetry(browser)).page);

  // the game page slowly accumulates memory over many runs: give each worker a fresh
  // tab every few episodes instead of waiting for it to crash
  const RECYCLE_EVERY = 6;
  const used = pages.map(() => 0);
  const recycle = async (w) => {
    try { await pages[w].context().close(); } catch {}
    pages[w] = (await openGameRetry(browser)).page;
    used[w] = 0;
  };

  const pol = policy.load();
  for (let g = 0; g < generations; g++) {
    const samples = [];
    for (let i = 0; i < pairs; i++) {
      const s = policy.samplePair(pol);
      // both sides of a pair play the same map so the comparison is about the policy
      const seed = Math.floor(Math.random() * 2 ** 31);
      samples.push({ s, side: 'a', params: s.a, seed }, { s, side: 'b', params: s.b, seed });
    }
    // simple work queue over the worker pages
    const queue = samples.slice();
    const results = new Map();
    await Promise.all(pages.map(async (_, w) => {
      while (queue.length) {
        const job = queue.shift();
        if (used[w]++ >= RECYCLE_EVERY) await recycle(w);
        let res;
        try {
          res = await playEpisode(pages[w], { ...game, seed: job.seed, params: job.params, weights: policy.weightsForPlay(pol) });
        } catch (e) {
          res = { score: 0, err: String(e) };
          await recycle(w); // a crashed tab is replaced so the worker keeps going
        }
        results.set(job, res);
        console.log(`gen ${pol.generation} w${w} ${job.side}: score=${res.score} stage=${res.stage} bosses=${res.bosses} ` +
          `victory=${res.victory} kills=${res.kills} time=${res.time}s lv=${res.level} wall=${res.wall}s${res.err ? ' err=' + res.err.slice(0, 120) : ''}`);
        fs.appendFileSync(RUN_LOG, JSON.stringify({
          at: new Date().toISOString(), gen: pol.generation, side: job.side, params: job.params, ...res,
        }) + '\n');
      }
    }));

    const evaluated = [];
    for (let i = 0; i < samples.length; i += 2) {
      const ra = results.get(samples[i]), rb = results.get(samples[i + 1]);
      if (ra.err && !ra.picks || rb.err && !rb.picks) continue; // broken episode: no gradient
      evaluated.push({ eps: samples[i].s.eps, scoreA: ra.score, scoreB: rb.score });
    }
    const all = [...results.values()].filter((r) => r.picks);
    for (const r of all) policy.creditChoices(pol, r);
    policy.esUpdate(pol, evaluated);

    const scores = all.map((r) => r.score);
    const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
    const top = all.reduce((b, r) => (!b || r.score > b.score ? r : b), null);
    pol.generation++;
    pol.episodes += all.length;
    pol.history.push({ gen: pol.generation, mean: Math.round(mean), max: top?.score ?? 0, n: all.length });
    if (top && (!pol.best || top.score > pol.best.score)) {
      pol.best = { score: top.score, stage: top.stage, victory: top.victory, gen: pol.generation };
    }
    policy.save(pol);
    console.log(`== generation ${pol.generation}: mean ${Math.round(mean)}, best ${top?.score}, all-time best ${pol.best?.score}`);
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
