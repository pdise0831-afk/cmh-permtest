#!/usr/bin/env node
// Play runs with the current learned policy (no learning).
//   node src/play.js [--runs N] [--species 4] [--biome forest] [--watch] [--realtime]
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openGame, playEpisode } = require('./harness');
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

async function main() {
  const o = args();
  const pol = policy.load();
  const params = { ...pol.params, choiceNoise: 0 };
  const browser = await launch({ headed: !!o.watch });
  const { page } = await openGame(browser, o.watch ? { width: 1280, height: 720 } : {});
  const runs = Number(o.runs || 1);
  const out = [];
  for (let i = 0; i < runs; i++) {
    const res = await playEpisode(page, {
      params, weights: policy.weightsForPlay(pol),
      species: Number(o.species || 4), biome: o.biome || 'forest', tier: Number(o.tier || 0),
      turbo: !(o.watch || o.realtime),
    }, {
      onProgress: (s) => process.stdout.write(
        `\r stage ${s.stage} t=${s.t}s hp=${s.hp} lv=${s.lvl} kills=${s.kills} gold=${s.gold} ${s.mode}->${s.target ?? '-'}      `),
    });
    console.log(`\nrun ${i + 1}: score=${res.score} stage=${res.stage} bosses=${res.bosses} victory=${res.victory} ` +
      `kills=${res.kills} time=${res.time}s level=${res.level} ${res.err ? 'err=' + res.err : ''}`);
    out.push(res);
  }
  const dir = path.join(__dirname, '..', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'play.jsonl'), out.map((r) => JSON.stringify({ at: new Date().toISOString(), ...r })).join('\n') + '\n');
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
