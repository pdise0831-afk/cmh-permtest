#!/usr/bin/env node
// Summarizes training progress: per-generation scores from policy/policy.json and,
// when runs/train.jsonl exists, clear rates over the most recent runs.
//   node src/report.js [--last 40]
'use strict';

const fs = require('fs');
const path = require('path');
const policy = require('./policy');

const last = Number((process.argv.indexOf('--last') > -1 && process.argv[process.argv.indexOf('--last') + 1]) || 40);
const pol = policy.load();
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

console.log(`generations ${pol.generation}, episodes ${pol.episodes}, best ${pol.best?.score ?? '-'} (gen ${pol.best?.gen ?? '-'})`);
for (const h of pol.history.slice(-15)) console.log(`  gen ${String(h.gen).padStart(3)}  mean ${String(h.mean).padStart(9)}  max ${String(h.max).padStart(9)}`);

const log = path.join(__dirname, '..', 'runs', 'train.jsonl');
if (fs.existsSync(log)) {
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.picks).slice(-last);
  const wins = rows.filter((r) => r.victory).length;
  const byStage = {};
  for (const r of rows) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
  console.log(`\nlast ${rows.length} runs: victory ${wins} (${Math.round((100 * wins) / Math.max(1, rows.length))}%), ` +
    `median score ${median(rows.map((r) => r.score))}, median bosses ${median(rows.map((r) => r.bosses))}`);
  console.log('  final stage reached:', Object.entries(byStage).map(([s, n]) => `stage ${s}: ${n}`).join(', '));
}

const P = pol.params;
console.log('\nkey parameters:');
for (const k of ['bossTime1', 'bossTime2', 'bossTime3', 'finalStay', 'exitHp', 'bossDist', 'dangerW', 'hazardW', 'altar2Level', 'altar3Level']) {
  console.log(`  ${k.padEnd(12)} ${(+P[k]).toFixed(2)}`);
}
const top = (o, n = 6) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
console.log('\npreferred blessing stats:', top(pol.weights.stat));
console.log('preferred items:', top(pol.weights.item));
console.log('preferred level-up picks:', top(pol.weights.key));
