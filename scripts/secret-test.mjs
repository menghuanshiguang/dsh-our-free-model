/**
 * The credential seal (`src/secret.js`).
 *
 * The egress outlet stores a subscription link or proxy URL, and the path of a
 * subscription link *is* its token — so the settings file must not hold it in
 * the clear. This suite pins the four properties the rest of the plugin relies
 * on: a round trip returns the same bytes, the record it writes carries no
 * plaintext, a record that was tampered with (or written for another machine)
 * fails closed rather than throwing, and an absent value stays absent.
 *
 * Everything here is offline and touches no network.
 *
 * Run: node scripts/secret-test.mjs
 */
import assert from 'node:assert/strict'

import { openSecret, sealSecret, secretBackend } from '../src/secret.js'

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name} — ${error.message}`)
  }
}

// ── what the platform reaches for ────────────────────────────────────────────
await check('the backend is named, not implied', () => {
  assert.equal(secretBackend(), process.platform === 'win32' ? 'windows-dpapi' : 'machine-aes')
})

// ── an absent secret stays absent ────────────────────────────────────────────
await check('nothing to seal is not an empty seal', async () => {
  assert.equal(await sealSecret(''), null)
  assert.equal(await sealSecret(undefined), null)
  assert.equal(await sealSecret(null), null)
})

// ── the round trip ───────────────────────────────────────────────────────────
const address = 'https://outlet.example.com/s/ofm-subscription-token-0123456789abcdef'
await check('a subscription link comes back unchanged', async () => {
  const record = await sealSecret(address)
  assert.equal(await openSecret(record), address)
})

await check('the record is one of the two known shapes', async () => {
  const record = await sealSecret(address)
  assert.ok(['windows-dpapi', 'machine-aes'].includes(record.scheme), `unexpected scheme ${record.scheme}`)
  if (record.scheme === 'windows-dpapi') assert.equal(typeof record.blob, 'string')
  else for (const key of ['salt', 'iv', 'tag', 'data']) assert.equal(typeof record[key], 'string', `machine-aes is missing ${key}`)
})

await check('a password with characters outside the console code page survives', async () => {
  const awkward = '口令-🔐-\u0000-not-a-truncation:•'
  assert.equal(await openSecret(await sealSecret(awkward)), awkward)
})

await check('the same plaintext seals to different bytes each time', async () => {
  const first = await sealSecret(address)
  const second = await sealSecret(address)
  assert.notDeepEqual(first, second)
  assert.equal(await openSecret(first), address)
  assert.equal(await openSecret(second), address)
})

// ── the record that lands in settings.json ───────────────────────────────────
await check('the stored record carries no plaintext', async () => {
  const record = await sealSecret(address)
  assert.equal(JSON.stringify(record).includes('ofm-subscription-token'), false)
  assert.equal(JSON.stringify(record).includes('outlet.example.com'), false)
})

// ── failure paths fail closed, and never throw ───────────────────────────────
await check('a record that is not an object reads as absent', async () => {
  for (const value of [null, undefined, '', 'blob', 7, []]) {
    assert.equal(await openSecret(value), undefined)
  }
})

await check('an unknown scheme reads as absent', async () => {
  assert.equal(await openSecret({ scheme: 'rot13', blob: 'x' }), undefined)
})

await check('a flipped byte fails the authentication check', async () => {
  const record = await sealSecret(address)
  if (record.scheme === 'windows-dpapi') {
    const bytes = Buffer.from(record.blob, 'base64')
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    assert.equal(await openSecret({ ...record, blob: bytes.toString('base64') }), undefined)
  } else {
    const bytes = Buffer.from(record.data, 'base64')
    bytes[0] ^= 0xff
    assert.equal(await openSecret({ ...record, data: bytes.toString('base64') }), undefined)
  }
})

await check('a truncated payload fails closed', async () => {
  const record = await sealSecret(address)
  if (record.scheme === 'windows-dpapi') {
    assert.equal(await openSecret({ ...record, blob: record.blob.slice(0, 8) }), undefined)
  } else {
    assert.equal(await openSecret({ ...record, tag: record.tag.slice(0, 4) }), undefined)
  }
})

await check('a record from another machine fails closed, not loudly', async () => {
  // A machine-aes record is the one that can be forged by hand here; the
  // DPAPI path's equivalent is the flipped byte above. Both must answer
  // "undefined" — the caller asks the user to paste the address again.
  const foreign = {
    scheme: 'machine-aes',
    salt: Buffer.alloc(16, 1).toString('base64'),
    iv: Buffer.alloc(12, 2).toString('base64'),
    tag: Buffer.alloc(16, 3).toString('base64'),
    data: Buffer.alloc(32, 4).toString('base64'),
  }
  assert.equal(await openSecret(foreign), undefined)
})

await check('a machine-aes record with malformed lengths fails closed', async () => {
  assert.equal(await openSecret({ scheme: 'machine-aes', salt: 'AA==', iv: 'AA==', tag: 'AA==', data: 'AA==' }), undefined)
})

console.log(`\nsecret-test: ${failures === 0 ? 'OK' : `${failures} check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1
