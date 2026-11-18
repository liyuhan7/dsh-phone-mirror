// iOS 设备提供方：通过本机 usbmuxd 发现 USB 与已配对无线设备，并承载 iOS 投屏会话入口。
import { existsSync, readdirSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..')

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

function candidateLockdownDirs() {
  const dirs = [
    join(pluginRoot, '.tmp', 'home', '.pymobiledevice3'),
    join(homedir(), '.pymobiledevice3')
  ]
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
  for (const dir of [
    join(pluginRoot, '.tmp', 'home', '.pymobiledevice3'),
    join(homedir(), '.pymobiledevice3')
  ]) {
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

export function createIosProvider() {
  async function status() {
    const mux = await queryUsbmuxDevices()
    const seen = new Set()
    const devices = []
    for (const item of mux.devices) {
      const key = `${item.serial}:${item.connection}`
      if (seen.has(key)) continue
      seen.add(key)
      const paired = hasPairingRecord(item.serial)
      devices.push({
        serial: item.serial,
        state: paired ? 'device' : 'unauthorized',
        model: item.connection === 'wifi' ? 'iPhone (Wi-Fi)' : 'iPhone',
        platform: 'ios',
        connection: item.connection
      })
    }
    for (const remoteId of listRemotePairedRecords()) {
      if (devices.some((device) => device.serial === remoteId && device.connection === 'wifi')) continue
      devices.push({
        serial: `wifi:${remoteId}`,
        state: 'device',
        model: 'iPhone (Wi-Fi)',
        platform: 'ios',
        connection: 'wifi'
      })
    }
    return {
      ok: mux.ok,
      error: mux.error,
      preparing: false,
      devices
    }
  }

  async function startSession() {
    throw new Error('iOS 投屏会话尚未就绪')
  }

  async function canRecoverWireless() {
    return false
  }

  return {
    id: 'ios',
    status,
    startSession,
    canRecoverWireless
  }
}
