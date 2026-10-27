// Browser harness: loads the real PokéBonk client in headless Chromium, answers its
// API calls locally (runs never reach api.pokebonk.com or its leaderboards), exposes
// the game's App object and injects the in-page agent.
'use strict';

const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const { execSync } = require('child_process');
    const root = execSync('npm root -g').toString().trim();
    return require(path.join(root, 'playwright'));
  }
}

const GAME_URL = 'https://pokebonk.com/?lang=ko';
const AGENT_SRC = fs.readFileSync(path.join(__dirname, 'agent.js'), 'utf8');

// Minimal stand-in for the game's backend. Anything not listed answers `{}`.
function mockApi(method, pathname, state) {
  if (pathname === '/status') return { maintenance: { on: false }, events: [] };
  if (pathname === '/auth/guest' || pathname === '/auth/me') {
    return { id: 'local-bot', name: 'Bot', guest: true, token: 'local' };
  }
  if (pathname === '/profile') return { profile: { name: 'Bot' }, now: Date.now() };
  if (pathname === '/runs' && method === 'POST') {
    // the map seed comes from here: training pins it so compared policies see the same map
    const seed = state.seed ?? Math.floor(Math.random() * 2 ** 31);
    state.seed = null;
    return { id: 'local-' + Date.now(), seed, ranked: false };
  }
  return {};
}

// The hook is a regex on the minified bundle, so it survives renamed identifiers.
// It stores the App instance (the object that owns `run`, `hud`, `input`) on window.
const HOOK_RE = /([\w$]+)\(this,`starting`,!1\)/;

async function launch({ headed = false } = {}) {
  const { chromium } = loadPlaywright();
  return chromium.launch({
    headless: !headed,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
}

async function openGame(browser, { width = 400, height = 240, log = () => {} } = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const ctx = await browser.newContext({
    viewport: { width, height },
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });
  await ctx.route(/static\.cloudflareinsights\.com|challenges\.cloudflare\.com/, (r) => r.abort());
  let hooked = false;
  const state = { seed: null };
  await ctx.route(/pokebonk\.com\/assets\/main-[^/]*\.js(\?.*)?$/, async (route) => {
    const resp = await route.fetch();
    let src = await resp.text();
    if (HOOK_RE.test(src)) {
      src = src.replace(HOOK_RE, '(window.__pbApp=this,$1(this,`starting`,!1))');
      hooked = true;
    }
    await route.fulfill({ response: resp, body: src });
  });
  await ctx.route('https://api.pokebonk.com/**', async (route) => {
    const req = route.request();
    const body = mockApi(req.method(), new URL(req.url()).pathname, state);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await ctx.addInitScript({ content: AGENT_SRC });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('pageerror: ' + e.message));
  await page.goto(GAME_URL, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__pbApp, null, { timeout: 120000 });
  if (!hooked) throw new Error('could not hook the game bundle (client changed?)');
  // Guest login screen: the button text depends on lang=ko.
  await page.waitForTimeout(3000);
  const guest = page.getByText('손님으로 플레이!');
  if (await guest.count()) await guest.first().click();
  await page.waitForFunction(() => window.__pbApp.meta?.profile, null, { timeout: 60000 });
  page.__pbState = state;
  return { ctx, page };
}

async function openGameRetry(browser, opts = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await openGame(browser, opts);
    } catch (e) {
      if (i >= tries) throw e;
      (opts.log || console.error)(`openGame failed (${e.message.split('\n')[0]}), retrying`);
    }
  }
}

// Plays one full run. `cfg` = { params, weights, species, biome, tier, turbo, maxGameSec }.
async function playEpisode(page, cfg, { wallTimeoutMs = 45 * 60 * 1000, onProgress } = {}) {
  if (page.__pbState) page.__pbState.seed = cfg.seed ?? null;
  await page.evaluate((c) => window.PBBot.startEpisode(c), cfg);
  const t0 = Date.now();
  for (;;) {
    await page.waitForTimeout(5000);
    const st = await page.evaluate(() => window.PBBot.status());
    if (onProgress) onProgress(st);
    if (st.done) return { ...(await page.evaluate(() => window.PBBot.result())), wall: Math.round((Date.now() - t0) / 1000) };
    if (Date.now() - t0 > wallTimeoutMs) {
      await page.evaluate(() => window.PBBot.abort('wall-timeout'));
      return page.evaluate(() => window.PBBot.result());
    }
  }
}

module.exports = { launch, openGame, openGameRetry, playEpisode };
