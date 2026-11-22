import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isIPv4 } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import * as http from '../lib/core/http.js'

const entry = new URL('../lib/index.js', import.meta.url)
const source = readFileSync(entry, 'utf8').replace(/\r\n/g, '\n').replace(/^import .*\n/gm, '').replace(/^export /gm, '')
const serial = 'wifi:active-phone'

function fixture(iosProvider) {
  const routes = new Map()
  const targets = []
  let tick
  let nextStart = null
  let nextProbe = null
  const provider = {
    status: async () => ({ devices: [{ serial: 'wifi:other-phone' }, { serial }] }),
    canRecoverWireless: async () => await nextProbe ?? true,
    disconnectWireless: async (address) => ({ address, status: 200, body: { ok: true } }),
    async startSession({ wire, serial: targetSerial, tabId, iosWirelessHost }) {
      const target = Object.assign(new EventEmitter(), {
        platform: 'ios', serial: targetSerial, iosWirelessHost, stopped: false,
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
    ...http, entry, URL, readFileSync, isIPv4, z: schema,
    createAndroidProvider: () => ({ status: async () => ({ devices: [] }) }),
    createIosProvider: () => iosProvider ?? provider,
    // 拔线监听用：测试里没有真实 usbmux，当作「USB 一直在」。
    queryUsbmuxDevices: async () => ({ ok: true, devices: [] }),
    clearInterval() {},
    setInterval(callback, delay) { if (delay === 4000) tick = callback; return 1 }
  })
  apply({ effect: (callback) => callback(), webServer: {
    register: ({ path, handler }) => routes.set(path, handler)
  } }, {})
  async function call(path, body, expectedStatus = 200) {
    const request = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), {
      method: body ? 'POST' : 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' }
    })
    let status, result
    await routes.get(`/dsh-phone-mirror/api${path}`)(request, {
      writeHead(code) { status = code }, end(value) { result = JSON.parse(value) }
    })
    assert.equal(status, expectedStatus, JSON.stringify(result))
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
  let learnedHost = ''
  let verified = false
  const createProvider = runInNewContext(`${providerSource.replaceAll('import.meta.url', 'entry')}\ncreateIosProvider`, {
    entry: providerEntry, dirname, join, fileURLToPath, Buffer, process, homedir: () => '.',
    existsSync: () => true, readdirSync: () => records,
    runtimeState: { preparing: false, message: '' },
    pairIosWireless: async (id) => ({ ok: pairSucceeded, address: `wifi:${id}`, wirelessHost: learnedHost, directReady: verified }),
    // 在线/离线探测用：测试里没有学到的地址，直接当离线，不去连真实端口。
    learnedWirelessHost: () => '',
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
  const paired = await provider.toWireless(udid)
  assert.equal(paired.status, 200)
  assert.equal(paired.body.directReady, false)
  learnedHost = '192.0.2.1'
  assert.equal((await provider.toWireless(udid)).body.directReady, false)
  verified = true
  assert.equal((await provider.toWireless(udid)).body.directReady, true)
  assert.deepEqual(await listed(), [udid, serial, 'wifi:other-phone'])
  assert.equal(await provider.canRecoverWireless(serial), true)
})

test('manual iOS wireless address overrides the learned address for connection and status', async () => {
  const providerEntry = new URL('../lib/providers/ios/index.js', import.meta.url)
  const providerSource = readFileSync(providerEntry, 'utf8').replace(/\r\n/g, '\n').replace(/^import .*\n/gm, '').replace(/^export /gm, '')
  const probed = []
  const started = []
  const saved = []
  let failStart = false
  let configured = ' 192.0.2.2:49153 '
  const createProvider = runInNewContext(`${providerSource.replaceAll('import.meta.url', 'entry')}\ncreateIosProvider`, {
    entry: providerEntry, dirname, join, fileURLToPath, Buffer, process, homedir: () => '.',
    existsSync: () => true, readdirSync: () => ['remote_active-phone.plist'],
    runtimeState: { preparing: false, message: '' },
    learnedWirelessHost: () => '192.0.2.1',
    saveLearnedWirelessHost: (...args) => saved.push(args),
    IosSession: class {
      constructor({ host, serial, explicitHost }) {
        started.push([host, explicitHost])
        // 与真实会话一致：从 wifi: 序列号推导 udid，供连接成功后落盘地址用。
        this.udid = serial.startsWith('wifi:') ? serial.slice(5) : serial
        this.serial = serial
      }
      async start() { if (failStart) throw new Error('verification failed') }
      async stop() {}
    },
    netConnect(options) {
      const socket = new EventEmitter()
      socket.setTimeout = socket.destroy = () => {}
      if (options.host && options.port !== 27015) {
        probed.push([options.host, options.port])
        queueMicrotask(() => socket.emit(options.host === '192.0.2.2' ? 'connect' : 'timeout'))
      } else {
        queueMicrotask(() => socket.emit('timeout'))
      }
      return socket
    }
  })
  const provider = createProvider({ getSettings: () => ({ iosWirelessHost: configured }) })
  assert.equal((await provider.status()).devices[0].online, true)
  await provider.startSession({ serial })
  configured = '  '
  assert.equal((await provider.status()).devices[0].online, false)
  await provider.startSession({ serial })
  assert.deepEqual(probed, [['192.0.2.2', 49153], ['192.0.2.1', 49152]])
  configured = '192.0.2.2:49153'
  await provider.startSession({ serial, iosWirelessHost: '192.0.2.3' })
  assert.deepEqual(started, [['192.0.2.2:49153', true], ['192.0.2.1', false], ['192.0.2.3', true]])
  assert.deepEqual(saved, [['active-phone', '192.0.2.3']])
  failStart = true
  await assert.rejects(provider.startSession({ serial, iosWirelessHost: '192.0.2.4' }), /verification failed/)
  assert.deepEqual(saved, [['active-phone', '192.0.2.3']])
})

test('manual iOS IPv4 is validated and retained for wireless recovery', async () => {
  const { call, targets, tick } = fixture()
  const request = { platform: 'ios', serial, iosWirelessHost: ' 192.0.2.3 ' }
  await call('/connect', { ...request, iosWirelessHost: '192.0.2.3:49152' }, 400)
  await call('/connect', { ...request, serial: 'usb-phone' }, 400)
  assert.equal(targets.length, 0)
  await call('/connect', request)
  targets[0].emit('error', { message: 'test link lost' })
  tick()
  await flush()
  assert.deepEqual(targets.map((target) => target.iosWirelessHost), ['192.0.2.3', '192.0.2.3'])
})

test('manual iOS connection stays listed and can reconnect after the top disconnect', async () => {
  const providerEntry = new URL('../lib/providers/ios/index.js', import.meta.url)
  const providerSource = readFileSync(providerEntry, 'utf8').replace(/\r\n/g, '\n').replace(/^import .*\n/gm, '').replace(/^export /gm, '')
  const udid = serial.slice(5)
  const records = []
  const hosts = new Map()
  const started = []
  const createProvider = runInNewContext(`${providerSource.replaceAll('import.meta.url', 'entry')}\ncreateIosProvider`, {
    entry: providerEntry, dirname, join, fileURLToPath, Buffer, process, homedir: () => '.',
    existsSync: (path) => !path.endsWith('.plist') && !path.endsWith('.plist.tmp'),
    readdirSync: () => records,
    runtimeState: { preparing: false, message: '' },
    learnedWirelessHost: (id) => hosts.get(id),
    saveLearnedWirelessHost: (id, host) => hosts.set(id, host),
    IosSession: class extends EventEmitter {
      constructor({ serial: requested, host }) {
        super()
        this.serial = requested
        this.host = host
      }
      async start() {
        started.push([this.serial, this.host])
        if (this.serial === 'wifi:manual') records.push(`remote_${udid}.plist`)
        this.serial = serial
        this.udid = udid
      }
      async stop() {}
    },
    netConnect(options) {
      const socket = new EventEmitter()
      socket.setTimeout = socket.destroy = () => {}
      const xml = Buffer.from(`<key>Properties</key><dict><key>SerialNumber</key><string>${udid}</string><key>ConnectionType</key><string>Network</string></dict>`)
      const header = Buffer.alloc(16)
      header.writeUInt32LE(16 + xml.length)
      queueMicrotask(() => options.host === '192.0.2.9'
        ? socket.emit('connect') : socket.emit('data', Buffer.concat([header, xml])))
      return socket
    }
  })
  const { call, tick } = fixture(createProvider({}))
  const request = { platform: 'ios', serial: 'wifi:manual', iosWirelessHost: '192.0.2.9' }
  assert.equal((await call('/connect', request)).session.serial, serial)
  assert.equal((await call('/status')).devices.find((device) => device.serial === serial).state, 'device')
  await call('/disconnect', {})
  const stopped = await call('/status')
  assert.equal(stopped.session.state, 'idle')
  assert.equal(stopped.autoConnecting, false)
  assert.equal(stopped.devices.find((device) => device.serial === serial).state, 'device')
  tick()
  await flush()
  assert.equal(started.length, 1)
  assert.equal((await call('/connect', { platform: 'ios', serial })).session.serial, serial)
  assert.deepEqual(started, [['wifi:manual', '192.0.2.9'], [serial, '192.0.2.9']])
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
