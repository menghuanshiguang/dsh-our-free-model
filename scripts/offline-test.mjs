/**
 * Offline behaviour with no API key, and the managed-installation gate.
 *
 * The plugin's whole premise is that there is no key to configure — the free
 * lane's pooled credential lives in `src/upstream.js` and nowhere else. So the
 * first promise to verify is the cold, disconnected one: a fresh install with
 * the gateway unreachable must still activate, still offer the fallback roster,
 * still answer its settings API, and fail a turn as a clean upstream error
 * rather than a crash — with no key material configured or required anywhere.
 *
 * The second promise is Stage M6's: when the plugin arrives through a managed
 * installation (an EAC integration pack, a Mojobox install), its own self-updater
 * and announcement channel must stand down. The pack owns the plugin's bytes;
 * an in-app updater racing the pack manager is two writers to one directory.
 * Managed mode is a settings/config flag, and these checks pin every surface it
 * closes — update routes, hot reload, feed polls — without touching the model
 * lane, which is the feature the pack installed.
 *
 * The outlet is the one place a user pastes in a secret of their own — a
 * subscription link, whose path *is* its token — so a third block pins that it
 * is held to the forward keys' standard: stored as given, absent from every
 * routine payload, served only when the settings page asks for it.
 *
 * Local network only: the "offline" gateway is a real server that was closed, so
 * every connection is refused immediately. No free-lane quota is spent.
 *
 * Run: node scripts/offline-test.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { callRoute, fakeContext, freePort, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/** A port that answers nothing, forever: the honest stand-in for "no network". */
const dead = http.createServer()
await new Promise(resolve => dead.listen(0, '127.0.0.1', resolve))
const deadBase = `http://127.0.0.1:${dead.address().port}`
await new Promise(resolve => dead.close(resolve))

process.env.OUR_FREE_MODEL_BASE = deadBase

const { apply, inject } = await import('../index.js')
const { ROUTE_MAIN } = await import('../src/adapter.js')

/** Boot one plugin generation against its own scratch home. */
async function boot({ config = {}, settings = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-offline-'))
  process.env.DSH_HOME = home
  if (Object.keys(settings).length > 0) {
    fs.mkdirSync(path.join(home, 'our-free-model'), { recursive: true })
    fs.writeFileSync(path.join(home, 'our-free-model', 'settings.json'), JSON.stringify(settings))
  }
  const routes = []
  const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'attachments'], onRegister: route => routes.push(route) })
  apply(ctx, config)
  const api = () => routes.find(route => route.kind === 'prefix')?.handler
  await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
  return { ctx, api, home }
}

function dispose(ctx) {
  for (const disposer of ctx.__disposers.reverse()) {
    try { disposer() } catch { /* a suite tearing down must not fail on teardown */ }
  }
}

const dataDir = home => path.join(home, 'our-free-model')

// ── offline, no key: the plugin must still be usable ─────────────────────────
{
  const { ctx, api, home } = await boot()
  const adapter = ctx.__captured.adapters[0]?.adapter
  check('the plugin activates with the gateway unreachable', adapter !== undefined, true)
  check('and registers the model lane', ctx.__captured.routes.includes(ROUTE_MAIN), true)

  // The harness forwards to these by name with no guard (`adapters.get(provider)
  // ?.adapter.<method>`), and `?.` cannot short-circuit because registration
  // succeeded. A method missing here is a TypeError at first use — for
  // `imageRequestPricing` that is every token measurement, which silently kills
  // auto- and manual compaction while the UI keeps no error (issue #42).
  for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    check(`the adapter answers the contract method ${method}()`, typeof adapter?.[method], 'function')
  }
  check('imageRequestPricing declares no per-image price for this free lane',
    adapter?.imageRequestPricing(ROUTE_MAIN, 'any-model-free'), undefined)

  const models = await adapter.listModels(ROUTE_MAIN)
  check('the fallback roster is advertised with no network and no key', models.length > 0, true)

  const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
  check('the settings API answers offline', summary.status, 200)
  check('and lists the same roster with an availability verdict surface',
    (summary.json.catalog ?? []).length > 0 && 'availability' in (summary.json.catalog?.[0] ?? {}), true)

  await until(() => ctx.__logs.some(line => line.includes('model listing refresh failed')), {
    what: 'the listing failure to be reported', timeoutMs: 5000,
  }).then(() => check('a dead gateway is a logged degradation, not a crash', true, true))
    .catch(() => check('a dead gateway is a logged degradation, not a crash', false, true))

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: ROUTE_MAIN, model: models[0].id, sessionId: 'offline:turn',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) chunks.push(chunk)
  const finish = chunks.find(chunk => chunk.type === 'finish')?.reason
  check('a turn ends as an upstream error, not an exception', finish?.kind, 'error')
  check('with the transport failure named', /upstream|fetch|ECONNREFUSED|request failed/i.test(finish?.failure?.message ?? ''), true)

  // The forward listener is part of the no-key promise: other local harnesses
  // get an OpenAI endpoint that needs only its own bearer, minted locally.
  const forwardPort = await freePort()
  await callRoute(api(), 'POST', '/api/our-free-model/settings', { forward: { enabled: true, host: '127.0.0.1', port: forwardPort } })
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir(home), 'settings.json'), 'utf8'))
  check('no credential field is configured or required',
    Object.keys(stored).filter(key => /\b(api_?key|secret|passw|token|authorization)\b/i.test(key) && key !== 'forwardKey'), [])
  const key = stored.forwardKey
  const listed = await fetch(`http://127.0.0.1:${forwardPort}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
  check('the forward listener serves its model list offline', listed.status, 200)
  const refused = await fetch(`http://127.0.0.1:${forwardPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: models[0].id, messages: [{ role: 'user', content: 'hi' }] }),
  }).catch(() => null)
  const body = refused === null ? null : await refused.json().catch(() => null)
  check('a forwarded turn fails cleanly against a dead gateway', [refused?.status, body?.error !== undefined], [502, true])
  const unknown = await fetch(`http://127.0.0.1:${forwardPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'no-such-model-free', messages: [{ role: 'user', content: 'hi' }] }),
  }).catch(() => null)
  check('a model the roster does not carry answers 404 model-shaped', unknown?.status, 404)
  await callRoute(api(), 'POST', '/api/our-free-model/settings', { forward: { enabled: false, host: '127.0.0.1', port: forwardPort } })

  dispose(ctx)
  fs.rmSync(home, { recursive: true, force: true })
}

// ── the outlet address is a credential, not a setting ────────────────────────
// The one secret a user of this plugin does paste in is a subscription link,
// whose path *is* its token. So it is held to the forward keys' standard and
// then some: absent from every routine payload, served only when the settings
// page itself asks for it (`GET /egress/url`), and sealed on disk rather than
// written in the clear. The seeded file below carries the pre-seal shape on
// purpose, so this block also pins the upgrade path that seals it in place.
{
  const token = 'ofm-subscription-token-0123456789abcdef'
  const address = `https://outlet.example.com/s/${token}`
  const { ctx, api, home } = await boot({ settings: { egress: { enabled: false, mode: 'subscription', url: address, mihomoPath: '' } } })
  const settingsFile = path.join(dataDir(home), 'settings.json')
  const stored = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const raw = () => fs.readFileSync(settingsFile, 'utf8')

  const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
  const egress = summary.json.settings.egress
  check('the subscription URL never rides along in a payload', 'url' in egress, false)
  check('and the whole summary carries none of the token it holds', JSON.stringify(summary.json).includes(token), false)
  check('the panel is told a URL exists, and gets the masked host only', [egress.hasUrl, egress.urlLabel], [true, 'https://outlet.example.com'])

  const revealed = await callRoute(api(), 'GET', '/api/our-free-model/egress/url')
  check("the value is served on the settings page's own ask", revealed.json.url, address)
  check('and the ask is the read that seals it', typeof stored().egress.secret?.scheme, 'string')
  check('— the token is nowhere in it', raw().includes(token), false)
  check('— and the old plaintext field is gone', stored().egress.url, undefined)

  const kept = await callRoute(api(), 'POST', '/api/our-free-model/settings', { egress: { mode: 'client', mihomoPath: '' } })
  check('a patch that carries no URL keeps the stored one', kept.status, 200)
  check('— the sealed record survives a patch that does not name it', typeof stored().egress.secret?.scheme, 'string')
  check('— still no plaintext in the file', raw().includes(token), false)
  check('— and still not in the answer', 'url' in (kept.json.settings.egress ?? {}), false)
  const stillThere = await callRoute(api(), 'GET', '/api/our-free-model/egress/url')
  check('— and the address still unseals to the same value', stillThere.json.url, address)

  const replaced = await callRoute(api(), 'POST', '/api/our-free-model/settings', { egress: { url: 'https://other.example.com/s/second-token-abcdef0123456789' } })
  check('a pasted address replaces the stored one', [replaced.status, replaced.json.settings.egress.urlLabel], [200, 'https://other.example.com'])
  check('— and the first token is gone from the file', raw().includes(token), false)
  check('— and the second is not in the clear either', raw().includes('second-token'), false)

  const cleared = await callRoute(api(), 'POST', '/api/our-free-model/settings', { egress: { enabled: false, url: '' } })
  check('clearing it is still possible, and says so in the payload', [cleared.status, cleared.json.settings.egress.hasUrl], [200, false])
  check('— and the seal is gone with it', stored().egress.secret, null)

  dispose(ctx)
  fs.rmSync(home, { recursive: true, force: true })
}

// ── a seal that will not open here is said out loud ──────────────────────────
// The record below was written for another machine (or another Windows account):
// every field is well-formed, so only the authentication check can tell. The
// plugin must report that state instead of calling the address missing, and it
// must not spawn anything while the address is unreadable.
{
  const foreign = {
    enabled: true,
    mode: 'client',
    mihomoPath: '',
    label: 'https://outlet.example.com',
    secret: {
      scheme: 'machine-aes',
      salt: Buffer.alloc(16, 1).toString('base64'),
      iv: Buffer.alloc(12, 2).toString('base64'),
      tag: Buffer.alloc(16, 3).toString('base64'),
      data: Buffer.alloc(48, 4).toString('base64'),
    },
  }
  const { ctx, api, home } = await boot({ settings: { egress: foreign } })

  const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
  const egress = summary.json.settings.egress
  check('the panel is told the address is on file but sealed shut', [egress.hasUrl, egress.secretUnreadable], [true, true])
  check('and the masked host still renders, so the user knows which one', egress.urlLabel, 'https://outlet.example.com')
  check('the address is not invented in its place', (await callRoute(api(), 'GET', '/api/our-free-model/egress/url')).json.url, '')
  check('the outlet reports why it is not running', String(egress.error).includes('cannot be decrypted'), true)
  check('and nothing was spawned for it', egress.running, false)

  dispose(ctx)
  fs.rmSync(home, { recursive: true, force: true })
}

// ── managed installation (config): the self-channel stands down ──────────────
{
  const { ctx, api, home } = await boot({ config: { distribution: 'managed' } })

  const meta = await callRoute(api(), 'GET', '/api/our-free-model/meta')
  check('the config flag puts /meta under managed distribution', meta.json.distribution, 'managed')

  const status = await callRoute(api(), 'GET', '/api/our-free-model/update/status')
  check('update status reports managed rather than availability', [status.json.managed, status.json.available], [true, false])

  const refusedCheck = await callRoute(api(), 'POST', '/api/our-free-model/update/check')
  check('a manual update check is refused', refusedCheck.status, 409)
  check('with the reason stated', /managed/i.test(refusedCheck.json?.error ?? ''), true)
  check('an update apply is refused too', (await callRoute(api(), 'POST', '/api/our-free-model/update/apply', {})).status, 409)
  check('and hot reload, which would swap bytes under the manager', (await callRoute(api(), 'POST', '/api/our-free-model/reload')).status, 409)

  const announcements = await callRoute(api(), 'GET', '/api/our-free-model/announcements')
  check('the announcement feed reports its managed stand-down', [announcements.json.items, announcements.json.unread, announcements.json.source], [[], 0, 'managed'])
  await callRoute(api(), 'POST', '/api/our-free-model/announcements/refresh')
  const after = await callRoute(api(), 'GET', '/api/our-free-model/announcements')
  check('a manual refresh stays a no-op', [after.json.items, after.json.source], [[], 'managed'])
  check('no feed fetch was attempted', ctx.__logs.filter(line => /feed|announcement/.test(line) && /fail|error/i.test(line)), [])

  const flipped = await callRoute(api(), 'POST', '/api/our-free-model/settings', { distribution: 'self' })
  const metaAfter = await callRoute(api(), 'GET', '/api/our-free-model/meta')
  check('the settings API cannot un-manage an installation', [flipped.status, metaAfter.json.distribution], [200, 'managed'])

  const stillAlive = await callRoute(api(), 'GET', '/api/our-free-model/summary')
  check('the model lane is untouched by the gate', [stillAlive.status, (stillAlive.json.catalog ?? []).length > 0], [200, true])
  check('and no feed cache was written', fs.existsSync(path.join(dataDir(home), 'feed.json')), false)

  dispose(ctx)
  fs.rmSync(home, { recursive: true, force: true })
}

// ── managed installation (settings file): same gate, installer's other door ──
{
  const { ctx, api, home } = await boot({ settings: { distribution: 'managed' } })
  const meta = await callRoute(api(), 'GET', '/api/our-free-model/meta')
  check('a pre-seeded settings file manages the plugin too', meta.json.distribution, 'managed')
  check('and closes the same update route', (await callRoute(api(), 'POST', '/api/our-free-model/update/check')).status, 409)
  dispose(ctx)
  fs.rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\noffline: no key needed offline, and managed installs self-govern' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
