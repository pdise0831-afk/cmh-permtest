// In-page PokéBonk agent. Injected with addInitScript, so it runs inside the game page.
// It reads the live game objects (window.__pbApp) and plays only through the same
// inputs a player has: a virtual analog stick, virtual keys (E, Space, Shift, R) and
// picking options in the choice windows (level-up, altar blessings, items, shop).
(function () {
  'use strict';
  if (window.PBBot) return;

  const DT = 1 / 60;
  const THINK_EVERY = 6; // decisions at 10 Hz of game time
  const SCORE_STAGE = 1500, SCORE_BOSS = 800, SCORE_WIN = 6000;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hyp = Math.hypot;

  // Same formula the client uses for the run score (standard mode).
  function scoreOf(r) {
    return Math.round(
      Math.round(r.kills * 2 + r.time * 3 + r.damage / 200 + (r.stage - 1) * SCORE_STAGE +
        r.bosses * SCORE_BOSS + (r.victory ? SCORE_WIN : 0)) * (1 + (r.tier || 0) * 0.5));
  }

  class Agent {
    constructor(app, P, W) {
      this.app = app;
      this.P = P; // numeric strategy parameters (tuned by evolution strategy)
      this.W = W; // choice preferences (tuned from run outcomes)
      this.picks = []; // every choice made, for credit assignment
      this.events = [];
      this.pending = null; // open choice window waiting for a decision
      this.target = null;
      this.mode = 'farm';
      this.retarget = 0;
      this.stuck = { x: 0, z: 0, t: 0, escapeT: 0, dir: 0 };
      this.pulse = new Set();
      this.lastStage = 0;
      this.ultT = 0;
      this.portalTries = 0;
      this.skip = new Map(); // interactable -> game time until which it is ignored
      this.stageLog = [];
      this.targetSince = 0; // game time when the current target was chosen
      this.clearedAt = -1; // stage time when the final boss went down
      this.hazards = []; // telegraphed boss attacks: {line|circle, until (game time)}
      this.hookedBoss = null;
      this.jumpT = 0;
    }

    get run() { return this.app.run; }

    log(msg) { this.events.push(`[${this.run.stage}:${this.run.stageTime.toFixed(0)}] ${msg}`); }

    // ---------- perception ----------
    enemiesNear(radius) {
      const r = this.run, E = r.enemies, p = r.player.pos, out = [];
      const bi = r.boss.alive ? r.boss.bossIndex : -1;
      for (let i = 0; i < E.n; i++) {
        if (!E.alive[i] || E.dying[i] > 0) continue;
        const dx = E.x[i] - p.x, dz = E.z[i] - p.z, d = hyp(dx, dz);
        if (d > radius) continue;
        out.push({ i, dx, dz, d, rad: E.radius[i] || 0.6, boss: i === bi, dmg: E.dmg[i] });
      }
      return out;
    }

    hostileShots(radius) {
      const r = this.run, S = r.projectiles, p = r.player.pos, out = [];
      if (!S) return out;
      for (let i = 0; i < S.n; i++) {
        if (!S.alive[i] || !(S.flags[i] & 1)) continue;
        const dx = S.x[i] - p.x, dz = S.z[i] - p.z;
        if (hyp(dx, dz) > radius) continue;
        out.push({ dx, dz, vx: S.vx[i], vz: S.vz[i], rad: S.rad[i] || 0.5 });
      }
      return out;
    }

    pickupsNear(radius) {
      const r = this.run, K = r.pickups, p = r.player.pos;
      let xp = { x: 0, z: 0, w: 0 }, special = null, sd = 1e9, heal = null, hd = 1e9;
      for (let i = 0; i < K.n; i++) {
        if (!K.alive[i] || K.attract[i]) continue;
        const dx = K.x[i] - p.x, dz = K.z[i] - p.z, d = hyp(dx, dz);
        if (d > radius) continue;
        const k = K.kind[i];
        if (k <= 1) { const w = 1 / (1 + d); xp.x += dx * w; xp.z += dz * w; xp.w += w; }
        else if (k === 2) { if (d < hd) { hd = d; heal = { dx, dz, d }; } }
        else if (d < sd) { sd = d; special = { dx, dz, d, k }; }
      }
      return { xp, special, heal };
    }

    // Boss attacks are telegraphed and aimed at where the player is when they are cast.
    // Wrapping the boss' attack methods records each danger zone and when it resolves.
    // Every telegraphed area attack in the game draws its warning through
    // vfx.telegraph (circles) or vfx.beams.spawn (lines): record those as danger zones.
    hookTelegraphs() {
      const r = this.run, V = r.vfx;
      if (!V || V.__pbHooked) return;
      V.__pbHooked = true;
      const self = this;
      const tele = V.telegraph.bind(V);
      V.telegraph = (x, y, z, rad, col, dur) => {
        try {
          const p = r.player.pos;
          if (rad <= 14 && hyp(x - p.x, z - p.z) < 40) self.hazards.push({ k: 'circle', x, z, r: rad, until: r.time + (dur || 1) + 0.2 });
        } catch {}
        return tele(x, y, z, rad, col, dur);
      };
      if (V.beams?.spawn) {
        const beam = V.beams.spawn.bind(V.beams);
        V.beams.spawn = (x1, y1, z1, x2, y2, z2, w, col, dur, ...rest) => {
          try {
            if (r.boss.alive && typeof dur === 'number') self.hazards.push({ k: 'line', x1, z1, x2, z2, w: (w || 1.5) * 0.5 + 0.8, until: r.time + dur + 0.8 });
          } catch {}
          return beam(x1, y1, z1, x2, y2, z2, w, col, dur, ...rest);
        };
      }
    }

    hookBoss() {
      const r = this.run, B = r.boss;
      if (!B || this.hookedBoss === B) return;
      this.hookedBoss = B;
      const self = this, E = r.enemies, pl = r.player;
      const add = (h, delay, linger = 0.25) => self.hazards.push({ ...h, until: r.time + delay + linger });
      const wrap = (name, before) => {
        const orig = B[name];
        if (typeof orig !== 'function') return;
        B[name] = function (...a) { try { before.apply(this, a); } catch {} return orig.apply(this, a); };
      };
      wrap('lineStrike', (x1, z1, x2, z2, w, delay) => add({ k: 'line', x1, z1, x2, z2, w }, delay));
      wrap('charge', (e) => {
        const dx = pl.pos.x - E.x[e], dz = pl.pos.z - E.z[e], d = hyp(dx, dz) || 1;
        add({ k: 'line', x1: E.x[e], z1: E.z[e], x2: E.x[e] + (dx / d) * 22, z2: E.z[e] + (dz / d) * 22, w: 2.2 + E.radius[e] }, 0.75 * (B.tk || 1), 0.8);
      });
      wrap('sigCross', (e) => {
        // the cross slash is followed by a dash at the old player position
        const x = pl.pos.x, z = pl.pos.z, dx = x - E.x[e], dz = z - E.z[e], d = hyp(dx, dz) || 1;
        add({ k: 'line', x1: E.x[e], z1: E.z[e], x2: x + (dx / d) * 5, z2: z + (dz / d) * 5, w: 1.5 + E.radius[e] }, 1.2 * (B.tk || 1), 0.8);
      });
      wrap('sigLeap', () => add({ k: 'circle', x: pl.pos.x, z: pl.pos.z, r: 5.5 }, 1.07 * (B.tk || 1)));
      wrap('slams', () => add({ k: 'circle', x: pl.pos.x + pl.vel.x * 0.8, z: pl.pos.z + pl.vel.z * 0.8, r: 4.2 }, 1.1 * (B.tk || 1) + (B.enraged ? 0.9 : 0)));
      wrap('hostileGround', () => add({ k: 'circle', x: pl.pos.x, z: pl.pos.z, r: 3.9 }, B.tk || 1));
      wrap('meteor', () => add({ k: 'circle', x: pl.pos.x, z: pl.pos.z, r: 4 }, 1.1 * (B.tk || 1) + 1.5));
    }

    // danger of standing at (x, z) at game time t
    hazardAt(x, z, t) {
      let s = 0;
      for (const h of this.hazards) {
        if (h.until < t - 0.3) continue;
        if (h.k === 'circle') {
          const d = hyp(x - h.x, z - h.z);
          if (d < h.r + 1) s += 1 - Math.max(0, d - h.r);
        } else {
          const hx = h.x2 - h.x1, hz = h.z2 - h.z1, L2 = hx * hx + hz * hz || 1;
          const u = clamp(((x - h.x1) * hx + (z - h.z1) * hz) / L2, 0, 1);
          const d = hyp(h.x1 + hx * u - x, h.z1 + hz * u - z);
          if (d < h.w + 1.2) s += 1 - Math.max(0, d - h.w) / 1.2;
        }
      }
      const B = this.run.boss;
      for (const p of B.pools || []) {
        if (p.x == null) continue;
        const d = hyp(x - p.x, z - p.z);
        if (d < p.r + 0.8) s += 0.6;
      }
      return s;
    }

    // shockwave rings can only be jumped over
    jumpWaves() {
      const r = this.run, p = r.player.pos, B = r.boss;
      if (this.jumpT > 0) { this.jumpT -= THINK_EVERY * DT; return; }
      for (const w of B.waves || []) {
        if (w.hit || w.x == null) continue;
        const gap = hyp(p.x - w.x, p.z - w.z) - w.r; // ring expands 13 u/s
        if (gap > 0 && gap / 13 < 0.32) { this.press('Space'); this.jumpT = 0.4; return; }
      }
    }

    // ---------- high level decisions ----------
    bossTimeFor(stage) {
      const P = this.P;
      return [P.bossTime1, P.bossTime2, P.bossTime3, P.bossTime3][clamp(stage, 1, 4) - 1];
    }

    interactValue(it) {
      const r = this.run, P = this.P, pl = r.player;
      const lvl = pl.level, hpFrac = pl.hp / Math.max(1, pl.maxHp);
      switch (it.kind) {
        case 'freechest': return P.v_freechest;
        case 'chest':
          if (it.data?.gift) return P.v_freechest;
          return r.gold >= r.interactables.chestCost() + P.goldReserve ? P.v_chest : 0;
        case 'altar': {
          if (it.data?.sealed) return 0;
          const t = it.data?.tier ?? 0;
          if (t === 2 && lvl < P.altar2Level) return 0;
          if (t === 3 && lvl < P.altar3Level) return 0;
          if (it.data?.comet) return P.v_altar2;
          return [P.v_altar0, P.v_altar1, P.v_altar2, P.v_altar3, P.v_altar1][t] ?? 0;
        }
        case 'challenge': return lvl >= P.challengeLevel ? P.v_challenge : 0;
        case 'greed': return P.v_greed;
        case 'cursed': return P.v_cursed;
        case 'cursedchest': return P.v_cursedchest;
        case 'magnet': return P.v_magnet;
        case 'berry': return hpFrac < 0.8 ? P.v_berry * (1 - hpFrac) * (hpFrac < P.lowHp ? 5 : 2) : 0;
        case 'rock': return P.v_rock;
        case 'snorlax': return P.v_snorlax;
        case 'cage': return r.gold >= r.interactables.cageCost() + P.goldReserve ? P.v_cage : 0;
        case 'meowth': return r.gold >= P.shopGold ? P.v_shop : 0;
        case 'ditto': return pl.items.size ? P.v_ditto : 0;
        case 'nest': return r.egg ? 0 : P.v_nest;
        case 'rhydon': return r.bossSpawned ? 0 : P.v_rhydon;
        default: return 0;
      }
    }

    pickTarget() {
      const r = this.run, p = r.player.pos, P = this.P;
      const I = r.interactables;
      const timeLeft = this.bossTimeFor(r.stage) - r.stageTime;
      const speed = 6.3 * (r.player.stats.moveSpeed || 1);
      let best = null, bestU = 0;
      for (const it of I.list) {
        if (it.used && it.kind !== 'meowth') continue;
        if ((this.skip.get(it) ?? -1) > r.time) continue;
        const v = this.interactValue(it);
        if (v <= 0) continue;
        const d = hyp(it.x - p.x, it.z - p.z);
        if (!r.terrain.inBounds(it.x, it.z, 1)) continue;
        if (r.player.level < P.earlyLevel && d > P.earlyRadius) continue;
        // keep enough time to walk to the boss altar after this stop
        const bossAlt = this.bossAltar();
        if (bossAlt && timeLeft < 120) {
          const back = hyp(bossAlt.x - it.x, bossAlt.z - it.z);
          if ((d + back) / speed > timeLeft) continue;
        }
        const u = v / (1 + d / P.distScale);
        if (u > bestU) { bestU = u; best = it; }
      }
      return best;
    }

    bossAltar() {
      const L = this.run.interactables.list;
      return L.find((e) => e.kind === 'boss' && !e.used) || L.find((e) => e.kind === 'shrine' && !e.used) || null;
    }

    portal() {
      return this.run.interactables.list.find((e) => e.kind === 'portal') || null;
    }

    isFinalStage() {
      const r = this.run;
      return r.stage >= 4 || (r.stage >= 3 && !r.biome.sanctuary);
    }

    setTarget(t) {
      if (t !== this.target) { this.target = t; this.targetSince = this.run.time; }
    }

    decide() {
      const r = this.run, p = r.player.pos, P = this.P;
      if (r.stage !== this.lastStage) {
        if (this.lastStage) this.stageLog.push({ stage: this.lastStage, t: r.time });
        this.lastStage = r.stage; this.target = null; this.portalTries = 0; this.skip.clear(); this.clearedAt = -1;
        this.log('stage start');
      }
      // a target we cannot reach (cliff, water, blocked) is dropped for a while
      const tg = this.target;
      // charging an altar takes a while: the clock only runs while we are outside it
      if (tg && tg.kind === 'altar' && hyp(tg.x - p.x, tg.z - p.z) < tg.r) this.targetSince = r.time;
      if (tg && tg.kind !== 'portal' && tg.kind !== 'boss' && tg.kind !== 'shrine' && r.time - this.targetSince > P.targetPatience) {
        this.skip.set(tg, r.time + 90); this.target = null; this.log('gave up on ' + tg.kind);
      }
      if (r.stageCleared) {
        // boss down: grab the reward balls around it, then take the portal
        const loot = r.interactables.list.filter((e) => !e.used &&
          (e.kind === 'freechest' || e.kind === 'cursedchest' && P.v_cursedchest > 0 || (e.kind === 'chest' && e.data?.gift)) &&
          (this.skip.get(e) ?? -1) <= r.time && hyp(e.x - p.x, e.z - p.z) < 60);
        loot.sort((a, b) => hyp(a.x - p.x, a.z - p.z) - hyp(b.x - p.x, b.z - p.z));
        if (loot.length) { this.setTarget(loot[0]); this.mode = 'loot'; return; }
        const portal = this.portal();
        if (this.clearedAt < 0) this.clearedAt = r.stageTime;
        // Last stage: the run ends at the portal. Every extra second near it still
        // scores (time, kills, damage on an ever-tougher swarm), so hold position next
        // to it and step in before the swarm gets dangerous.
        const hpFrac = r.player.hp / Math.max(1, r.player.maxHp);
        if (this.isFinalStage() && portal && r.stageTime - this.clearedAt < P.finalStay && hpFrac > P.exitHp) {
          this.mode = 'hold'; this.target = portal;
          return;
        }
        this.mode = 'portal'; this.target = portal;
        return;
      }
      if (r.bossSpawned && r.boss.alive) { this.mode = 'boss'; this.target = null; return; }
      if (r.bossSpawned && !r.boss.alive && !r.stageCleared) { this.mode = 'farm'; }
      const due = r.stageTime >= this.bossTimeFor(r.stage) || r.director?.finalSwarm;
      if (due && !r.bossSpawned) {
        this.mode = 'callBoss';
        this.setTarget(this.bossAltar());
        return;
      }
      this.mode = 'farm';
      if (this.target && (this.target.used && this.target.kind !== 'meowth' || this.interactValue(this.target) <= 0)) this.target = null;
      if (--this.retarget <= 0 || !this.target) { this.setTarget(this.pickTarget()); this.retarget = 10; }
    }

    // ---------- low level control ----------
    steer(goal, goalW) {
      const r = this.run, p = r.player.pos, P = this.P, T = r.terrain;
      const foes = this.enemiesNear(18), shots = this.hostileShots(10);
      const pk = this.pickupsNear(P.xpRadius);
      const hpFrac = r.player.hp / Math.max(1, r.player.maxHp);
      let best = null, bestS = -1e9;
      const look = 2.5;
      const N = 16;
      const LOOKS = [[1.2, 1], [3, 0.6], [6, 0.35]];
      const cands = [];
      const low = hpFrac < P.lowHp;
      // early levels come from gems: weigh them up until the build has some power
      const xpW = P.xpW * (r.player.level < P.earlyLevel ? P.xpEarly : 1);
      for (let k = 0; k <= N; k++) {
        let dx = 0, dz = 0;
        if (k < N) { const a = (k / N) * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); }
        const qx = p.x + dx * look, qz = p.z + dz * look;
        let s = 0;
        if (goal) s += goalW * (low ? 0.25 : 1) * (dx * goal.x + dz * goal.z);
        if (pk.xp.w > 0 && !low) {
          const m = hyp(pk.xp.x, pk.xp.z) || 1; s += xpW * (dx * pk.xp.x + dz * pk.xp.z) / m;
        }
        if (pk.special) s += 0.8 * (dx * pk.special.dx + dz * pk.special.dz) / (pk.special.d || 1);
        if (pk.heal && hpFrac < 0.7) s += (low ? 3 : 1.5) * (dx * pk.heal.dx + dz * pk.heal.dz) / (pk.heal.d || 1);
        const fear = P.dangerW * (low ? 2 : 1);
        let crowd = 0;
        for (const e of foes) {
          // a hit that takes a big bite of current HP is scarier
          const w = (e.boss ? P.bossFear : 1) * clamp(0.6 + (6 * e.dmg) / (r.player.hp + 10), 0.6, 4);
          for (const [L, lw] of LOOKS) {
            const gap = hyp(e.dx - dx * L, e.dz - dz * L) - e.rad - 0.6;
            s -= fear * w * lw * Math.exp(-gap / P.dangerR);
          }
          // enemies inside a 60° cone ahead within 12 units: running into the horde
          if (k < N && e.d < 12 && (e.dx * dx + e.dz * dz) > 0.5 * e.d) crowd++;
        }
        s -= P.crowdW * Math.sqrt(crowd) * (low ? 2 : 1);
        for (const b of shots) {
          // project the shot 0.4 s ahead, penalize being near its path
          for (const t of [0, 0.2, 0.4]) {
            const ex = b.dx + b.vx * t - dx * look * (t / 0.4 + 0.2), ez = b.dz + b.vz * t - dz * look * (t / 0.4 + 0.2);
            const gap = hyp(ex, ez) - b.rad - 0.5;
            s -= P.shotW * Math.exp(-gap / 1.2);
          }
        }
        let hz = 0;
        if (this.hazards.length || r.boss.pools?.length) {
          const sp = 6.3 * (r.player.stats.moveSpeed || 1);
          for (const tt of [0.25, 0.55, 0.9]) {
            hz += this.hazardAt(p.x + dx * sp * tt, p.z + dz * sp * tt, r.time + tt) * (tt === 0.9 ? 1 : 0.6);
          }
          s -= P.hazardW * hz;
        }
        if (k < N) {
          if (!T.inBounds(qx, qz, 4)) s -= 6;
          if (T.hitProp && T.hitProp(qx, p.y + 0.5, qz, 0.7)) s -= 2.5;
          const wl = T.waterAt ? T.waterAt(qx, qz) : -99;
          if (T.height(qx, qz) < wl - 0.55 && !r.player.types?.includes('water')) s -= 1.5;
        } else s -= 0.3; // standing still is rarely right
        cands.push({ x: dx, z: dz, s, hz });
      }
      // dodging a telegraphed hit comes first: only directions within a small margin
      // of the safest one are allowed, the rest of the scoring picks among those
      const minHz = Math.min(...cands.map((c) => c.hz));
      for (const c of cands) {
        if (c.hz > minHz + 0.15) continue;
        if (c.s > bestS) { bestS = c.s; best = c; }
      }
      return { dir: best, foes, hpFrac };
    }

    setStick(dx, dz) {
      const inp = this.app.input, u = this.run.camYaw;
      const s = Math.sin(u), c = Math.cos(u);
      inp.stickY = clamp(-s * dx - c * dz, -1, 1);
      inp.stickX = clamp(c * dx - s * dz, -1, 1);
    }

    press(code) { this.app.input.touchKey(code, true); this.pulse.add(code); }

    releasePulses() {
      for (const c of this.pulse) this.app.input.touchKey(c, false);
      this.pulse.clear();
    }

    control() {
      const r = this.run;
      if (this.pending) { this.resolvePending(); return; }
      if (r.state !== 'play') { this.setStick(0, 0); return; }
      this.decide();
      const p = r.player.pos, P = this.P;
      this.hookBoss();
      this.hookTelegraphs();
      if (this.hazards.length) this.hazards = this.hazards.filter((h) => h.until > r.time);
      if (r.boss.alive) this.jumpWaves();

      // pokéball on a weakened alpha / free ally: same E key, always worth it
      if (r.capture?.canThrow?.() || (r.allies?.canThrow?.() && !r.interactables.nearest)) this.press('KeyE');

      let goal = null, goalW = P.goalW;
      const tgt = this.target;
      if (this.mode === 'boss') {
        const E = r.enemies, bi = r.boss.bossIndex;
        const bx = E.x[bi] - p.x, bz = E.z[bi] - p.z, d = hyp(bx, bz) || 1;
        // orbit: tangential plus radial correction toward the preferred distance
        const radial = clamp((d - P.bossDist) / 4, -1, 1);
        goal = { x: (bx / d) * radial - (bz / d) * 0.8, z: (bz / d) * radial + (bx / d) * 0.8 };
        const m = hyp(goal.x, goal.z) || 1; goal.x /= m; goal.z /= m;
      } else if (this.mode === 'hold' && tgt) {
        // circle the portal, drifting back in when too far out
        const dx = tgt.x - p.x, dz = tgt.z - p.z, d = hyp(dx, dz) || 1;
        const radial = clamp((d - P.finalRadius) / 4, -1, 1);
        goal = { x: (dx / d) * radial - (dz / d) * 0.8, z: (dz / d) * radial + (dx / d) * 0.8 };
        const m = hyp(goal.x, goal.z) || 1; goal.x /= m; goal.z /= m;
      } else if (tgt) {
        const dx = tgt.x - p.x, dz = tgt.z - p.z, d = hyp(dx, dz) || 1;
        goal = { x: dx / d, z: dz / d };
        const near = r.interactables.nearest === tgt;
        if (tgt.kind === 'altar') {
          // stand inside the circle until it is charged
          if (d < tgt.r * 0.75) { goal = null; goalW = 0; }
        } else if (near) {
          if (tgt.kind === 'portal') this.portalTries++;
          this.press('KeyE');
          if (tgt.kind !== 'portal' && tgt.kind !== 'meowth') this.skip.set(tgt, r.time + 3);
          if (tgt.kind === 'meowth') this.skip.set(tgt, r.time + 60);
          if (tgt.kind === 'boss' || tgt.kind === 'shrine') this.log('boss called');
        }
        // close to the target and nothing in reach: commit harder so we actually arrive
        if (goal && d < 8 && !this.enemiesNear(3).length) goalW *= 2;
      } else {
        // roam: sweep a wide circle so the horde follows and XP keeps dropping
        const a = r.time * 0.05;
        const rx = Math.cos(a) * 60 - p.x, rz = Math.sin(a) * 60 - p.z, d = hyp(rx, rz) || 1;
        goal = { x: rx / d, z: rz / d }; goalW *= 0.6;
      }

      const { dir, foes, hpFrac } = this.steer(goal, goalW);
      let mx = dir.x, mz = dir.z;

      // stuck detection: no progress for 2 s while trying to move → jump + sidestep
      const st = this.stuck;
      st.t += THINK_EVERY * DT;
      if (st.escapeT > 0) {
        st.escapeT -= THINK_EVERY * DT;
        mx = Math.cos(st.dir); mz = Math.sin(st.dir);
      } else if (st.t > 1) {
        const moved = hyp(p.x - st.x, p.z - st.z);
        if (moved < 1.2) {
          // wedged (props, slope, crowd): jump and break out away from the nearest enemies
          let ax = 0, az = 0;
          for (const e of foes) if (e.d < 6) { ax -= e.dx / (e.d + 0.5); az -= e.dz / (e.d + 0.5); }
          const base = ax || az ? Math.atan2(az, ax) : Math.atan2(mz, mx) + Math.PI / 2;
          st.escapeT = 0.8; st.dir = base + (Math.random() - 0.5) * 1.6;
          this.press('Space');
        }
        st.t = 0; st.x = p.x; st.z = p.z;
      }
      this.setStick(mx, mz);

      // emergency slide when boxed in at low HP
      const close = foes.filter((e) => e.d < e.rad + 1.6).length;
      if (hpFrac < P.dashHp && close >= 2) this.press('ShiftLeft');
      // ultimate on the boss or on a big crowd
      this.ultT -= THINK_EVERY * DT;
      if (this.ultT <= 0 && r.ult?.ready && (this.mode === 'boss' || foes.length >= P.ultCrowd)) {
        this.press('KeyR'); this.ultT = 2;
      }
    }

    // ---------- choice windows ----------
    noise() { return (Math.random() - 0.5) * 2 * this.P.choiceNoise; }

    scoreLevelUp(o) {
      const W = this.W;
      let s = (W.kind[o.kind] ?? 0) + W.rarity * (o.rarity || 0) + (W.key[o.key] ?? W.keyMean ?? 0);
      if (o.kind === 'upMove') {
        const mv = this.run.player.moves[o.slot];
        if (mv) s += W.moveLevel * (1 - mv.level / Math.max(1, this.run.player.capOf(mv)));
      }
      return s + this.noise();
    }

    scoreBlessing(o) {
      const W = this.W;
      let s = W.rarity * (o.rarity || 0);
      for (const m of o.mods || []) s += W.stat[m.stat] ?? 0;
      return s + this.noise();
    }

    // options never tried yet get the average preference, not zero, so they are not
    // pushed aside forever by options that happened to be tried early
    itemScore(key) { return (this.W.item[key] ?? this.W.itemMean ?? 0) + this.noise(); }

    argmax(arr, f) {
      let bi = 0, bs = -1e9;
      arr.forEach((x, i) => { const s = f(x); if (s > bs) { bs = s; bi = i; } });
      return arr[bi];
    }

    resolvePending() {
      const pd = this.pending; this.pending = null;
      const r = this.run;
      try {
        switch (pd.type) {
          case 'levelup': {
            const o = this.argmax(pd.offers, (x) => this.scoreLevelUp(x));
            this.picks.push({ t: 'lv', k: o.key, kind: o.kind });
            pd.cb(o);
            break;
          }
          case 'blessing': {
            const o = this.argmax(pd.offers, (x) => this.scoreBlessing(x));
            for (const m of o.mods || []) this.picks.push({ t: 'st', k: m.stat });
            pd.cb(o);
            break;
          }
          case 'item':
            this.picks.push({ t: 'it', k: pd.key });
            pd.cb(true);
            break;
          case 'itemChoice': {
            const k = this.argmax(pd.keys, (x) => this.itemScore(x));
            this.picks.push({ t: 'it', k });
            pd.cb(k);
            break;
          }
          case 'shop': {
            const stock = (r.shop?.stock || []).filter((s) => !s.sold).sort((a, b) => this.itemScore(b.key) - this.itemScore(a.key));
            for (const s of stock) {
              if (r.gold - s.price < this.P.goldReserve) continue;
              if (r.buyShopItem(s)) { this.picks.push({ t: 'it', k: s.key }); this.log('bought ' + s.key); }
            }
            pd.done();
            break;
          }
          case 'ditto': {
            const keys = [...r.player.items.keys()];
            const k = keys.length ? this.argmax(keys, (x) => this.itemScore(x)) : null;
            if (k) this.picks.push({ t: 'it', k });
            pd.cb(k);
            break;
          }
          case 'branch': pd.cb(pd.options[0]); break;
          default: pd.cb && pd.cb(null); pd.done && pd.done();
        }
      } catch (e) {
        this.log('choice error ' + pd.type + ': ' + e.message);
      }
    }

    installHud(hud) {
      const self = this;
      const later = (o) => { self.pending = o; };
      hud.showLevelUp = (run, offers, cb) => later({ type: 'levelup', offers, cb: (o) => cb(o) });
      hud.showBlessing = (run, title, offers, cb) => later({ type: 'blessing', offers, cb });
      hud.showItem = (run, key, cb) => later({ type: 'item', key, cb });
      hud.showItemChoice = (run, keys, cb) => later({ type: 'itemChoice', keys, cb });
      hud.showShop = (run, done) => later({ type: 'shop', done });
      hud.showDitto = (run, cb) => later({ type: 'ditto', cb });
      hud.showBranch = (run, options, cb) => later({ type: 'branch', options, cb });
      hud.showTrade = (run, info, cb) => later({ type: 'skip', cb });
      hud.showSlots = (run, api, done) => later({ type: 'skip', done });
      hud.showForget = (run, done) => later({ type: 'skip', done });
      hud.showPact = (run, offers, cb) => later({ type: 'skip', cb: () => cb(offers?.[0]) });
      // no modal DOM is ever shown, tell the run the window exists while we decide
      const hasModal = hud.hasModal.bind(hud);
      hud.hasModal = () => !!self.pending || hasModal();
    }

    // one compact line per game second, for debugging strategy problems
    trace(buf) {
      const r = this.run, p = r.player.pos, E = r.enemies, b = r.boss;
      const o = {
        t: +r.stageTime.toFixed(0), m: this.mode, tg: this.target?.kind, hp: Math.round(r.player.hp),
        mhp: Math.round(r.player.maxHp), lv: r.player.level, en: E.count, pos: [Math.round(p.x), Math.round(p.z)],
      };
      if (this.hurtLog?.length) { o.hurt = this.hurtLog.splice(0); }
      if (b.alive) {
        const i = b.bossIndex;
        Object.assign(o, { bhp: Math.round(E.hp[i]), bmax: Math.round(E.maxHp[i]), bd: +hyp(E.x[i] - p.x, E.z[i] - p.z).toFixed(1), bmv: b.moveName });
      }
      buf.push(o);
      if (buf.length > 4000) buf.shift();
    }

    result(reason) {
      const r = this.run;
      const res = r.result(!!r.victory);
      const score = scoreOf(res);
      return {
        score, reason, victory: !!r.victory, stage: r.stage, bosses: r.stats.bosses,
        kills: r.stats.kills, time: Math.round(r.time), level: r.player.level, endHow: r.endHow,
        stagesCleared: r.stats.stagesCleared, gold: r.gold, items: [...r.player.items.entries()],
        moves: r.player.moves.filter(Boolean).map((m) => [m.def.key ?? m.def.id, m.level]),
        picks: this.picks, events: this.events.slice(-60), stageLog: this.stageLog,
      };
    }
  }

  // ---------- episode driver ----------
  const S = { agent: null, done: true, res: null, steps: 0, err: null, wall0: 0 };

  async function startEpisode(cfg) {
    const app = window.__pbApp;
    Object.assign(S, { agent: null, done: false, res: null, steps: 0, err: null, wall0: performance.now(), traceBuf: [] });
    const ok = await app.startRun({
      species: cfg.species ?? 4, biome: cfg.biome ?? 'forest', tier: cfg.tier ?? 0, boosts: [], mode: 'standard',
    });
    if (!ok) { S.done = true; S.err = 'startRun failed'; return; }
    const run = app.run;
    const agent = (S.agent = new Agent(app, cfg.params, cfg.weights));
    if (cfg.trace) {
      // record what hits the player (amount, kind, attacker species, elite/boss flags)
      agent.hurtLog = [];
      const pl = run.player, hurt = pl.hurt.bind(pl);
      pl.hurt = (...a) => {
        const hp0 = pl.hp, ok = hurt(...a);
        if (pl.hp < hp0) {
          const i = a[2], E = run.enemies;
          agent.hurtLog.push([Math.round(hp0 - pl.hp), a[1], i >= 0 ? E.species[i] : a[8]?.species ?? a[8]?.kind ?? '', i >= 0 ? E.flags[i] : 0]);
        }
        return ok;
      };
    }
    agent.installHud(app.hud);
    const maxT = cfg.maxGameSec ?? 3600;
    const finish = (reason) => {
      if (S.done) return;
      try { S.res = agent.result(reason); } catch (e) { S.err = String(e); }
      S.done = true;
    };
    S.abort = (why) => {
      try { if (run.state !== 'over') { run.endHow = 'quit'; run.finish(false, true); } } catch {}
      finish(why);
    };
    // Fast-forward never shows the page, and the HUD/DOM work is what leaks memory and
    // costs most of the time there, so it is switched off (choice windows stay hooked).
    const stubs = cfg.stub ?? (cfg.turbo !== false ? ['ui', 'audio'] : []);
    for (const s of stubs) {
      const obj = s === 'audio' ? run.audio : s === 'vfx' ? run.vfx : s === 'ui' ? run.ui : null;
      if (!obj) continue;
      let proto = obj;
      const names = new Set();
      while (proto && proto !== Object.prototype) {
        for (const n of Object.getOwnPropertyNames(proto)) if (typeof obj[n] === 'function' && n !== 'constructor') names.add(n);
        proto = Object.getPrototypeOf(proto);
      }
      const keep = new Set(['hasModal', 'hideModal', 'showLevelUp', 'showBlessing', 'showItem', 'showItemChoice', 'showShop', 'showDitto', 'showBranch', 'showTrade', 'showSlots', 'showForget', 'showPact', 'fade']);
      for (const n of names) if (!(s === 'ui' && keep.has(n))) obj[n] = () => undefined;
    }
    if (cfg.turbo !== false) {
      app.halted = true;
      run.renderWorld = () => {};
      const tick = () => {
        if (S.done) return;
        // zone intros/fades finish on the game's own frame loop: hand control back
        // to it for those and resume fast-forward afterwards
        if (run.state === 'transition') { app.halted = false; setTimeout(tick, 50); return; }
        app.halted = true;
        try {
          for (let k = 0; k < 120; k++) {
            if (run.state === 'over') { finish(run.victory ? 'victory' : 'over'); return; }
            if (run.state === 'transition') break;
            if (run.time > maxT) { S.abort('max-time'); return; }
            if (S.steps % THINK_EVERY === 0) agent.control();
            if (cfg.trace && S.steps % 60 === 0) agent.trace(S.traceBuf);
            run.update(DT);
            agent.releasePulses();
            app.input.endFrame();
            S.steps++;
          }
        } catch (e) {
          S.err = String(e && e.stack || e);
          S.abort('error');
          return;
        }
        setTimeout(tick, 0);
      };
      tick();
    } else {
      // real-time: the game's own loop drives frames, we act before each update
      const orig = run.update.bind(run);
      run.update = (e) => {
        if (!S.done && S.steps++ % 6 === 0) agent.control();
        orig(e);
        agent.releasePulses();
        if (run.state === 'over') finish(run.victory ? 'victory' : 'over');
      };
    }
  }

  window.PBBot = {
    startEpisode: (cfg) => { startEpisode(cfg).catch((e) => { S.err = String(e); S.done = true; }); },
    status() {
      const r = window.__pbApp?.run, a = S.agent;
      return {
        done: S.done, err: S.err, steps: S.steps,
        wall: Math.round((performance.now() - S.wall0) / 1000),
        state: r?.state, stage: r?.stage, t: r ? Math.round(r.time) : 0, st: r ? Math.round(r.stageTime) : 0,
        hp: r ? Math.round(r.player.hp) : 0, lvl: r?.player.level, kills: r?.stats.kills, gold: r ? Math.round(r.gold) : 0,
        mode: a?.mode, target: a?.target?.kind,
      };
    },
    result: () => ({ ...(S.res || {}), err: S.err }),
    trace: () => S.traceBuf || [],
    abort: (why) => S.abort && S.abort(why),
    scoreOf,
  };
})();
