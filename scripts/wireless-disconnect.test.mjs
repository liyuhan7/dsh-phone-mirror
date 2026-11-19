import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import * as http from '../lib/core/http.js'

const entry = new URL('../lib/index.js', import.meta.url)
const source = readFileSync(entry, 'utf8').replace(/\r\n/g, '\n').replace(/^import .*\n/gm, '').replace(/^export /gm, '')
const serial = 'wifi:active-phone'

function fixture() {
  const routes = new Map()
  const targets = []
  let tick
  let nextStart = null
  let nextProbe = null
  const provider = {
    status: async () => ({ devices: [{ serial: 'wifi:other-phone' }, { serial }] }),
    canRecoverWireless: async () => await nextProbe ?? true,
    disconnectWireless: async (address) => ({ address, status: 200, body: { ok: true } }),
    async startSession({ wire, serial: targetSerial, tabId }) {
      const target = Object.assign(new EventEmitter(), {
        platform: 'ios', serial: targetSerial, stopped: false,
        async stop() { this.stopped = true; this.emit('close') }
      })
      targets.push(target)
      wire(target, 'coredevice')
      await nextStart
      target.emit('ready', {})
      return { session: target, info: { platform: 'ios', serial: targetSerial, state: 'running', tabId } }
    }
  }
  const schema = new Proxy(() => schema, { get: () => schema })
  const apply = runInNewContext(`${source.replaceAll('import.meta.url', 'entry')}\napply`, {
    ...http, entry, URL, readFileSync, z: schema,
    createAndroidProvider: () => ({ status: async () => ({ devices: [] }) }),
    createIosProvider: () => provider,
    setInterval(callback, delay) { if (delay === 4000) tick = callback; return 1 }
  })
  apply({ effect: (callback) => callback(), webServer: {
    register: ({ path, handler }) => routes.set(path, handler)
  } }, {})
  async function call(path, body) {
    const request = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), {
      method: body ? 'POST' : 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' }
    })
    let status, result
    await routes.get(`/dsh-phone-mirror/api${path}`)(request, {
      writeHead(code) { status = code }, end(value) { result = JSON.parse(value) }
    })
    assert.equal(status, 200, JSON.stringify(result))
    return result
  }
  return { call, targets, tick, holdNextStart: (promise) => { nextStart = promise }, holdNextProbe: (promise) => { nextProbe = promise } }
}

const flush = () => new Promise(setImmediate)

test('bottom disconnect hides the selected iPhone from both wireless discovery sources', async () => {
  const providerEntry = new URL('../lib/providers/ios/index.js', import.meta.url)
  const providerSource = readFileSync(providerEntry, 'utf8').replace(/\r\n/g, '\n').replace(/^import .*\n/gm, '').replace(/^export /gm, '')
  const udid = 'active-phone'
  const records = [`${udid}.plist`, `remote_${udid}.plist`, 'remote_other-phone.plist']
  let pairSucceeded = false
  const createProvider = runInNewContext(`${providerSource.replaceAll('import.meta.url', 'entry')}\ncreateIosProvider`, {
    entry: providerEntry, dirname, join, fileURLToPath, Buffer, process, homedir: () => '.',
    existsSync: () => true, readdirSync: () => records,
    pairIosWireless: async (id) => ({ ok: pairSucceeded, address: `wifi:${id}` }),
    netConnect() {
      const socket = new EventEmitter()
      socket.setTimeout = socket.destroy = () => {}
      const xml = Buffer.from(['USB', 'Network'].map((kind) =>
        `<key>Properties</key><dict><key>SerialNumber</key><string>${udid}</string><key>ConnectionType</key><string>${kind}</string></dict>`
      ).join(''))
      const header = Buffer.alloc(16)
      header.writeUInt32LE(16 + xml.length)
      queueMicrotask(() => socket.emit('data', Buffer.concat([header, xml])))
      return socket
    }
  })
  const provider = createProvider({})
  const listed = async () => Array.from((await provider.status()).devices, (device) => device.serial)
  assert.deepEqual(await listed(), [udid, serial, 'wifi:other-phone'])
  await provider.disconnectWireless(serial)
  assert.deepEqual(await listed(), [udid, 'wifi:other-phone'])
  assert.equal(await provider.canRecoverWireless(serial), false)
  await assert.rejects(provider.startSession({ serial }), /无线连接已断开/)
  assert.equal((await provider.toWireless(udid)).status, 502)
  assert.deepEqual(await listed(), [udid, 'wifi:other-phone'])
  pairSucceeded = true
  assert.equal((await provider.toWireless(udid)).status, 200)
  assert.deepEqual(await listed(), [udid, serial, 'wifi:other-phone'])
  assert.equal(await provider.canRecoverWireless(serial), true)
})

test('disconnect stops the named wireless session but preserves pairing and USB', async () => {
  const { call, targets } = fixture()
  await call('/connect', { platform: 'ios', serial })
  await call('/adb/disconnect', { platform: 'ios', address: 'wifi:other-phone' })
  assert.equal(targets[0].stopped, false)
  await call('/adb/disconnect', { platform: 'ios', address: serial })
  assert.equal(targets[0].stopped, true)
  let state = await call('/status')
  assert.equal(state.session.state, 'idle')
  assert.equal(state.autoConnecting, false)
  assert.ok(state.devices.some((device) => device.serial === serial))
  await call('/connect', { platform: 'ios', serial: 'usb-phone' })
  await call('/adb/disconnect', { platform: 'ios', address: serial })
  state = await call('/status')
  assert.equal(state.session.serial, 'usb-phone')
  assert.equal(targets[1].stopped, false)
})

test('closing a tab only stops the session that tab owns', async () => {
  const { call, targets } = fixture()
  await call('/connect', { platform: 'ios', serial, tabId: 'tab-a' })
  assert.equal((await call('/status')).session.tabId, 'tab-a')
  await call('/disconnect', { tabId: 'tab-b' })
  assert.equal(targets[0].stopped, false)
  await call('/disconnect', { tabId: 'tab-a' })
  assert.equal(targets[0].stopped, true)
  assert.equal((await call('/status')).session.state, 'idle')
})

for (const when of ['probe', 'startup']) {
  test(`disconnect cancels wireless recovery during ${when}`, async () => {
    const { call, targets, tick, holdNextStart, holdNextProbe } = fixture()
    await call('/connect', { platform: 'ios', serial })
    targets[0].emit('error', { message: 'test link lost' })
    assert.equal((await call('/status')).recoveryTarget.serial, serial)
    let resolve
    const promise = new Promise((done) => { resolve = done })
    if (when === 'probe') holdNextProbe(promise)
    else holdNextStart(promise)
    tick()
    await flush()
    assert.equal(targets.length, when === 'probe' ? 1 : 2)
    const disconnect = call('/adb/disconnect', { platform: 'ios', address: serial })
    await flush()
    assert.equal((await call('/status')).autoConnecting, false)
    resolve(true)
    await disconnect
    const state = await call('/status')
    assert.equal(state.session.state, 'idle')
    assert.equal(state.autoConnecting, false)
    assert.equal(targets.length, when === 'probe' ? 1 : 2)
    assert.ok(targets.every((target) => target.stopped))
  })
}
