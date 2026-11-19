// iOS 设备提供方：通过本机 usbmuxd 发现 USB 与已配对无线设备，并管理 CoreDevice 投屏会话与无线配对。
import { existsSync, readdirSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { IosSession, pairIosWireless, learnedWirelessHost } from './session.js'
import { runtimeState } from './runtime.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..', '..')

const LIST_DEVICES_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0"><dict>',
  '<key>ClientVersionString</key><string>dsh-phone-mirror</string>',
  '<key>MessageType</key><string>ListDevices</string>',
  '<key>ProgName</key><string>dsh-phone-mirror</string>',
  '</dict></plist>'
].join('')

function buildUsbmuxPacket(xml) {
  const payload = Buffer.from(xml, 'utf8')
  const header = Buffer.allocUnsafe(16)
  header.writeUInt32LE(16 + payload.length, 0)
  header.writeUInt32LE(1, 4) // version 1 (plist)
  header.writeUInt32LE(8, 8) // type 8 (plist payload)
  header.writeUInt32LE(1, 12) // tag 1
  return Buffer.concat([header, payload], 16 + payload.length)
}

function parsePropertiesBlock(xml) {
  const out = []
  const propRegex = /<key>Properties<\/key>\s*<dict>([\s\S]*?)<\/dict>/g
  for (const match of xml.matchAll(propRegex)) {
    const block = match[1]
    const serial = /<key>SerialNumber<\/key>\s*<string>([^<]+)<\/string>/.exec(block)?.[1]?.trim() ?? ''
    if (!serial) continue
    const connectionType = /<key>ConnectionType<\/key>\s*<string>([^<]+)<\/string>/.exec(block)?.[1]?.trim() ?? 'USB'
    const networkAddress = /<key>NetworkAddress<\/key>\s*<data>([^<]+)<\/data>/.exec(block)?.[1]?.trim() ?? ''
    out.push({
      serial,
      connection: connectionType.toLowerCase() === 'network' ? 'wifi' : 'usb',
      networkAddress
    })
  }
  return out
}

function pmdDirs() {
  return [
    join(pluginRoot, '.tmp', 'home', '.pymobiledevice3'),
    join(homedir(), '.pymobiledevice3')
  ]
}

function candidateLockdownDirs() {
  const dirs = [...pmdDirs()]
  if (process.platform === 'win32') {
    const allUsers = process.env.ALLUSERSPROFILE || 'C:\\ProgramData'
    dirs.push(join(allUsers, 'Apple', 'Lockdown'))
  } else if (process.platform === 'darwin') {
    dirs.push('/var/db/lockdown')
  } else {
    dirs.push('/var/lib/lockdown')
  }
  return dirs
}

function hasPairingRecord(serial) {
  for (const dir of candidateLockdownDirs()) {
    try {
      if (existsSync(join(dir, `${serial}.plist`)) || existsSync(join(dir, `${serial}.plist.tmp`))) {
        return true
      }
    } catch {}
  }
  return false
}

function listRemotePairedRecords() {
  const records = []
  for (const dir of pmdDirs()) {
    try {
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        if (!file.startsWith('remote_') || !file.endsWith('.plist')) continue
        const id = file.slice('remote_'.length, -'.plist'.length)
        if (id) records.push(id)
      }
    } catch {}
  }
  return [...new Set(records)]
}

/** 通过本机 usbmuxd（Windows 27015 端口 / Unix 域套接字）读取连接的 iOS 设备。 */
export function queryUsbmuxDevices(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const endpoint = process.platform === 'win32'
      ? { host: '127.0.0.1', port: 27015 }
      : { path: '/var/run/usbmuxd' }
    const socket = netConnect(endpoint)
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      try {
        socket.write(buildUsbmuxPacket(LIST_DEVICES_PLIST))
      } catch (error) {
        finish({ ok: false, error: error.message, devices: [] })
      }
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 16) return
      const totalLength = buffer.readUInt32LE(0)
      if (buffer.length < totalLength) return
      const xml = buffer.subarray(16, totalLength).toString('utf8')
      const parsed = parsePropertiesBlock(xml)
      finish({ ok: true, error: '', devices: parsed })
    })
    socket.once('timeout', () => finish({ ok: false, error: '连接 Apple Mobile Device Service 超时', devices: [] }))
    socket.once('error', (error) => {
      const reason = error.code === 'ECONNREFUSED' || error.code === 'ENOENT'
        ? '未检测到 Apple Mobile Device Service（请安装 Apple Devices 或 iTunes）'
        : error.message
      finish({ ok: false, error: reason, devices: [] })
    })
  })
}

/** 学到的 Wi-Fi 地址上 RemotePairing 端口开着，就认为这台 iPhone 的无线可达。 */
const PROBE_PORT = 49152
const PROBE_TIMEOUT_MS = 1200
const PROBE_TTL_MS = 8000
const probeCache = new Map()

function probeHost(host) {
  return new Promise((resolve) => {
    let settled = false
    const socket = netConnect({ host, port: PROBE_PORT })
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolve(value)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function wirelessOnline(udid) {
  const cached = probeCache.get(udid)
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.online
  const host = learnedWirelessHost(udid)
  const online = host ? await probeHost(host) : false
  probeCache.set(udid, { at: Date.now(), online })
  return online
}

export function createIosProvider({ getSettings }) {
  // 手动断开的无线设备不随发现结果重新出现；「转无线」重新启用。
  const disconnectedWireless = new Set()

  async function status() {
    const mux = await queryUsbmuxDevices()
    const seen = new Set()
    const devices = []
    for (const item of mux.devices) {
      const key = `${item.serial}:${item.connection}`
      if (seen.has(key)) continue
      seen.add(key)
      const serial = item.connection === 'wifi' ? `wifi:${item.serial}` : item.serial
      if (disconnectedWireless.has(serial)) continue
      const paired = hasPairingRecord(item.serial)
      devices.push({
        serial,
        state: paired ? 'device' : 'unauthorized',
        model: item.connection === 'wifi' ? 'iPhone (Wi-Fi)' : 'iPhone',
        platform: 'ios',
        connection: item.connection,
        ...(item.connection === 'wifi' ? { online: true } : {})
      })
    }
    for (const remoteId of listRemotePairedRecords()) {
      const wirelessSerial = `wifi:${remoteId}`
      if (disconnectedWireless.has(wirelessSerial) || devices.some((device) => device.serial === wirelessSerial)) continue
      devices.push({
        serial: wirelessSerial,
        state: 'device',
        model: 'iPhone (Wi-Fi)',
        platform: 'ios',
        connection: 'wifi',
        online: await wirelessOnline(remoteId)
      })
    }
    return {
      ok: mux.ok,
      error: mux.error,
      preparing: runtimeState.preparing,
      preparingMessage: runtimeState.message,
      devices
    }
  }

  async function startSession({ serial, wire }) {
    if (disconnectedWireless.has(serial)) throw new Error('此 iPhone 的无线连接已断开，请通过 USB 点「转无线」')
    const cfg = getSettings ? getSettings() : { audio: true }
    // 优先用 USB 期间学到的地址，配置项作兜底。
    const udid = serial.startsWith('wifi:') ? serial.slice('wifi:'.length) : serial
    const target = new IosSession({
      serial,
      audio: Boolean(cfg.audio),
      host: learnedWirelessHost(udid) || cfg.iosWirelessHost,
      usbPresent: async () => {
        const result = await queryUsbmuxDevices()
        return result.ok ? result.devices.some((device) => device.serial === serial && device.connection === 'usb') : null
      }
    })
    wire?.(target, 'coredevice')
    try {
      await target.start()
      return {
        session: target,
        info: {
          state: 'running',
          platform: 'ios',
          mode: 'coredevice',
          serial,
          deviceName: target.deviceName || 'iPhone',
          screen: target.baseScreen ?? null,
          rotation: target.rotation,
          audio: Boolean(target.audioCodec),
          audioCodec: target.audioCodec ?? null,
          videoCodec: target.videoCodec ?? null,
          videoDescription: target.videoDescription ?? null,
          lastError: ''
        }
      }
    } catch (error) {
      await target.stop().catch(() => {})
      throw error
    }
  }

  async function toWireless(rawSerial) {
    const serial = String(rawSerial ?? '').trim()
    const udid = serial.startsWith('wifi:') ? serial.slice('wifi:'.length) : serial
    if (!udid) {
      return { status: 400, body: { ok: false, error: '需要 USB 连接的 iPhone 序列号' } }
    }
    const result = await pairIosWireless(udid)
    if (!result.ok) {
      return { status: 502, body: { ok: false, error: result.error } }
    }
    disconnectedWireless.delete(result.address)
    return { status: 200, body: { ok: true, address: result.address } }
  }

  async function disconnectWireless(rawAddress) {
    let address = String(rawAddress ?? '').trim()
    if (!address) {
      const current = listRemotePairedRecords()[0]
      if (current) address = `wifi:${current}`
    }
    if (!address) {
      return { status: 200, address: null, body: { ok: true, address: null, message: '没有无线连接' } }
    }
    if (!address.startsWith('wifi:')) address = `wifi:${address}`
    disconnectedWireless.add(address)
    return { status: 200, address, body: { ok: true, address, message: '已断开无线连接并从列表移除，保留配对' } }
  }

  async function canRecoverWireless(serial) {
    if (!serial?.startsWith('wifi:') || disconnectedWireless.has(serial)) return false
    const udid = serial.slice('wifi:'.length)
    if (listRemotePairedRecords().includes(udid)) return true
    const { devices } = await queryUsbmuxDevices()
    return devices.some((device) => device.serial === udid && device.connection === 'wifi')
  }

  return {
    id: 'ios',
    status,
    startSession,
    toWireless,
    disconnectWireless,
    canRecoverWireless
  }
}
