// dsh-phone-mirror 宿主侧：管理 adb、开/关投屏会话，并把视频流按自定义帧格式
// 推给侧边栏里的客户端。
//
// 帧格式（同一流里视频/音频/元数据混排）：
//   [u32 长度][u8 类型][载荷]
//   1 = 视频  : [u8 标志(0x40 配置包 / 0x20 关键帧)][u64 大端 PTS][Annex-B 数据]
//   2 = 音频  : 同上
//   3 = 元数据: UTF-8 JSON
//   4 = 图像  : PNG（兜底模式的截图）
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { createSocket as udpConnect } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { Adb, BUNDLED_ADB, ensurePlatformTools, hasAdbOnPath, resolveAdb } from './adb.js'
import { BUNDLED_SERVER, ScrcpySession, ScreencapSession, SCRCPY_VERSION } from './session.js'
import * as control from './protocol.js'

export const name = 'dsh-phone-mirror'
export const inject = ['webServer']

export const Config = z.object({
  adbPath: z.string().default(''),
  mode: z.union([z.const('auto'), z.const('scrcpy'), z.const('screencap')]).default('auto'),
  maxSize: z.number().step(1).min(0).max(4096).default(1280),
  maxFps: z.number().step(1).min(0).max(120).default(60),
  videoBitRate: z.number().step(1).min(0).max(100_000_000).default(8_000_000),
  audio: z.boolean().default(true),
  screencapIntervalMs: z.number().step(1).min(80).max(5000).default(260),
  serverJar: z.string().default('')
})

const BASE = '/dsh-phone-mirror/api'
// AudioWorklet 由宿主同源下发。
const WORKLET_PATH = '/dsh-phone-mirror/audio-worklet.js'
const WORKLET_SOURCE = readFileSync(new URL('./audio-worklet.js', import.meta.url), 'utf8')
// 引擎 Worker 同样由宿主同源下发，内容为引擎核心与启动代码的拼接。
const ENGINE_PATH = '/dsh-phone-mirror/engine-worker.js'
const ENGINE_SOURCE = [
  readFileSync(new URL('./engine.js', import.meta.url), 'utf8'),
  readFileSync(new URL('./engine-worker.js', import.meta.url), 'utf8')
].join('\n')
const KIND = { VIDEO: 1, AUDIO: 2, META: 3, IMAGE: 4 }

function settings(config) {
  const defaults = {
    adbPath: '', mode: 'auto', maxSize: 1280, maxFps: 60,
    videoBitRate: 8_000_000, audio: true, screencapIntervalMs: 260, serverJar: ''
  }
  const result = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const field = config?.[key]
    const value = typeof field?.get === 'function' ? field.get() : field
    result[key] = value ?? fallback
  }
  return result
}

function json(res, status, data) {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(JSON.stringify(data))
}

/** 只接受本机同源请求。 */
function isLocalSameOrigin(req) {
  const address = req.socket?.remoteAddress
  const loopback = address === '::1' || address === '127.0.0.1' || address?.startsWith('::ffff:127.')
  if (!loopback) return false
  // 转发链中出现非回环地址时视为远端代理。
  const forwardedRaw = `${req.headers.forwarded ?? ''},${req.headers['x-forwarded-for'] ?? ''}`
  const hops = forwardedRaw
    .split(/[,\s;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const normalizeHop = (raw) => raw
    .replace(/^for=/i, '')
    .replace(/["'\[\]]/g, '')
  const isLoopbackHop = (raw) => {
    const value = normalizeHop(raw)
    const withoutPort = value.replace(/:\d+$/, '')
    return value === '::1' || withoutPort === '::1' ||
      /^127\./.test(value) || /^127\./.test(withoutPort) ||
      /^::ffff:127\./.test(value) || /^::ffff:127\./.test(withoutPort)
  }
  const remoteHop = hops.find((entry) => !isLoopbackHop(entry))
  if (remoteHop !== undefined) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function frame(kind, payload) {
  const header = Buffer.allocUnsafe(5)
  header.writeUInt32BE(payload.length + 1, 0)
  header.writeUInt8(kind, 4)
  return Buffer.concat([header, payload], header.length + payload.length)
}

function videoPayload(flags, pts, data) {
  const head = Buffer.allocUnsafe(9)
  head.writeUInt8(flags, 0)
  head.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(pts))), 1)
  return Buffer.concat([head, data], head.length + data.length)
}

const metaPayload = (value) => Buffer.from(JSON.stringify(value), 'utf8')

const CONTROL_NUMBERS = new Set(['x', 'y', 'dx', 'dy', 'keycode', 'repeat', 'metastate'])
const CONTROL_BOOLEANS = new Set(['on'])

/** 解析控制指令：优先读查询参数，为空时回退到 JSON body。 */
async function readControlMessage(req) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const message = {}
  for (const [key, value] of url.searchParams) {
    if (CONTROL_NUMBERS.has(key)) {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`参数 ${key} 不是数字`)
      message[key] = parsed
    } else if (CONTROL_BOOLEANS.has(key)) {
      message[key] = value !== 'false' && value !== '0'
    } else {
      message[key] = value
    }
  }
  if (Object.keys(message).length > 0) {
    if (typeof message.kind !== 'string' || message.kind.length === 0) throw new Error('缺少 kind')
    return message
  }
  const body = await Promise.race([
    readJson(req),
    new Promise((_, reject) => setTimeout(() => reject(new Error('读取控制请求体超时')), 1500))
  ])
  if (typeof body?.kind !== 'string' || body.kind.length === 0) throw new Error('缺少 kind')
  return body
}

async function readJson(req, limit = 64 * 1024) {
  let body = ''
  for await (const part of req) {
    body += part.toString('utf8')
    if (body.length > limit) throw new Error('请求体过大')
  }
  if (body.length === 0) return {}
  return JSON.parse(body)
}

export function apply(ctx, config) {
  const configuredAdb = settings(config).adbPath
  let adb = new Adb(resolveAdb(configuredAdb))
  let adbPreparing = false
  // 未配置 adb 且系统里没有时，后台下载 platform-tools。
  if (!configuredAdb && !existsSync(BUNDLED_ADB) && !hasAdbOnPath()) {
    adbPreparing = true
    ensurePlatformTools()
      .then((binary) => { adb = new Adb(binary) })
      .catch((error) => warn(`准备 adb 失败：${error.message}`))
      .finally(() => { adbPreparing = false })
  }
  let session = null
  let stream = null
  // 拿不到音频的设备，下次直接跳过带音频的尝试。
  const audioUnsupported = new Set()
  let lastAudioConfig = null
  let sessionInfo = { mode: null, serial: null, deviceName: '', screen: null, audio: false, state: 'idle' }
  // 最后一次成功启动的参数。
  let lastRequest = null
  // 无线会话掉线后自动重开的时间窗口。
  const RECOVER_WINDOW_MS = 30 * 1000

  const log = (message) => ctx.logger?.info?.(`dsh-phone-mirror: ${message}`)
  const warn = (message) => ctx.logger?.warn?.(`dsh-phone-mirror: ${message}`)

  // 事件回调统一包一层异常捕获。
  const safe = (fn) => (...args) => {
    try {
      fn(...args)
    } catch (error) {
      warn(`回调异常：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function pushMeta(extra = {}) {
    sessionInfo = { ...sessionInfo, ...extra }
    if (stream && !stream.destroyed) {
      try {
        stream.write(frame(KIND.META, metaPayload({ type: 'meta', ...sessionInfo })))
      } catch {}
    }
  }

  async function stopSession() {
    if (!session) return
    const current = session
    session = null
    lastAudioConfig = null
    try { await current.stop() } catch {}
    sessionInfo = { mode: null, serial: null, deviceName: '', screen: null, audio: false, state: 'idle' }
    log('会话已停止')
  }

  /** 把会话事件接到当前流上，回调统一经过 safe()。 */
  function wire(target, mode) {
    // 套接字积压时跳过非关键帧，并请求一个关键帧后恢复投递。
    const BACKLOG_LIMIT = 1_500_000
    let resyncing = false
    let keyRequestAt = 0
    const askKeyframe = () => {
      const now = Date.now()
      if (now - keyRequestAt < 1000) return
      keyRequestAt = now
      try { target.send(control.resetVideo()) } catch {}
    }

    target.on('ready', safe((info) => {
      pushMeta({
        state: 'running', mode, serial: target.serial,
        deviceName: info.deviceName, screen: info.screen, audio: info.audio
      })
    }))
    target.on('meta', safe((info) => pushMeta({ screen: info.screen, deviceName: info.deviceName })))
    target.on('video', safe((packet) => {
      if (!stream || stream.destroyed) return
      // 配置包始终投递。
      if (!packet.config) {
        if (resyncing) {
          if (!packet.key) return
          resyncing = false
        } else if (stream.writableLength > BACKLOG_LIMIT) {
          resyncing = true
          askKeyframe()
          return
        }
      }
      const flags = (packet.config ? 0x40 : 0) | (packet.key ? 0x20 : 0)
      stream.write(frame(KIND.VIDEO, videoPayload(flags, packet.pts, packet.data)))
    }))
    target.on('audio', safe((packet) => {
      // 记下 OpusHead，供后接入的浏览器补发。
      if (packet.config) lastAudioConfig = packet
      if (!stream || stream.destroyed) return
      stream.write(frame(KIND.AUDIO, videoPayload(packet.config ? 0x40 : 0, packet.pts, packet.data)))
    }))
    target.on('image', safe((packet) => {
      if (!stream || stream.destroyed) return
      stream.write(frame(KIND.IMAGE, packet.data))
    }))
    target.on('audio-codec', safe((info) => pushMeta({ audioCodec: info.codec, audio: Boolean(info.codec) })))
    target.on('error', safe((error) => {
      warn(error.message)
      pushMeta({ state: 'error', error: error.message })
      // 释放会话资源并清除引用。
      if (session === target) {
        session = null
        Promise.resolve(target.stop()).catch(() => {})
      }
    }))
    target.on('close', safe(() => {
      if (session === target) pushMeta({ state: 'idle' })
    }))
  }

  /** 设备未就绪时的提示文案。 */
  function deviceUnreadyReason(serial, state) {
    if (state === 'authorizing' || state === 'unauthorized') {
      return '平板在等调试授权：解锁平板，点「允许」后再试一次'
    }
    if (state === 'offline') return `设备 ${serial} 处于离线状态：重新插拔数据线，或再点一次「转无线」`
    if (state === '') return `找不到设备 ${serial}：确认数据线和无线连接是否还在`
    return `设备 ${serial} 状态异常（${state}）：重新插拔数据线，或再点一次「转无线」`
  }

  /** 先带音频试 scrcpy，失败退不带音频，再失败降级截图。 */
  async function startSession({ serial, mode, maxSize }) {
    await stopSession()
    // 无线设备先点亮屏幕。
    if (serial.includes(':')) await adb.shell(serial, 'input keyevent 224', 5000).catch(() => {})
    // 等设备进入 device 状态。
    const state = await waitForDevice(serial, 8000)
    if (state !== 'device') throw new Error(deviceUnreadyReason(serial, state))
    // 清理上一次会话残留的 reverse 转发。
    await clearReverse(serial)
    const cfg = settings(config)
    const resolvedMode = mode ?? cfg.mode
    const jar = cfg.serverJar.length > 0 ? cfg.serverJar : BUNDLED_SERVER
    const resolvedSize = maxSize ?? cfg.maxSize
    const wantAudio = cfg.audio && !audioUnsupported.has(serial)

    const build = (useScrcpy, audio) => useScrcpy
      ? new ScrcpySession({
          adb,
          serial,
          maxSize: resolvedSize,
          maxFps: cfg.maxFps,
          videoBitRate: cfg.videoBitRate,
          audio,
          serverPath: jar,
          version: SCRCPY_VERSION
        })
      : new ScreencapSession({ adb, serial, intervalMs: cfg.screencapIntervalMs })

    const scrcpy = (audio) => ({ mode: 'scrcpy', audio })
    const screencap = { mode: 'screencap', audio: false }
    let plan
    if (resolvedMode === 'screencap') plan = [screencap]
    else if (resolvedMode === 'scrcpy') plan = wantAudio ? [scrcpy(true), scrcpy(false)] : [scrcpy(false)]
    else plan = wantAudio
      ? [scrcpy(true), scrcpy(false), scrcpy(false), screencap]
      : [scrcpy(false), scrcpy(false), screencap]

    let lastFailure = ''
    for (const attempt of plan) {
      const target = build(attempt.mode === 'scrcpy', attempt.audio)
      wire(target, attempt.mode)
      try {
        await target.start()
        session = target
        lastRequest = { serial, mode, maxSize }
        sessionInfo = {
          state: 'running',
          mode: attempt.mode,
          serial,
          deviceName: target.deviceName || serial,
          screen: target.screen ?? null,
          audio: Boolean(target.audioCodec),
          audioCodec: target.audioCodec ?? null,
          lastError: lastFailure
        }
        return sessionInfo
      } catch (error) {
        // 仅音频相关失败写入黑名单。
        if (attempt.audio && /audio|AudioRecord|opus|codec|音频/i.test(error.message)) {
          audioUnsupported.add(serial)
        }
        lastFailure = attempt.mode === 'scrcpy'
          ? `scrcpy 启动失败：${error.message}`
          : `截屏模式失败：${error.message}`
        warn(lastFailure)
        await target.stop().catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 600))
      }
    }
    throw new Error(lastFailure || '启动失败')
  }

  async function status() {
    const cfg = settings(config)
    let version = ''
    let error = ''
    try {
      version = await adb.version()
    } catch (failure) {
      error = failure.message
    }
    let devices = []
    if (version) {
      try {
        devices = await adb.devices()
      } catch (failure) {
        error = failure.message
      }
    }
    return {
      adb: { ok: Boolean(version), version, error, binary: adb.binary, preparing: adbPreparing },
      devices,
      config: { mode: cfg.mode, maxSize: cfg.maxSize, audio: cfg.audio, adbPath: cfg.adbPath },
      session: sessionInfo,
      // 宿主是否正在自动重开无线会话。
      autoConnecting: Boolean(lastRequest && !session && lastRequest.serial.includes(':'))
    }
  }

  /** 发送一次完整按键（DOWN + 延迟后的 UP）。 */
  /** 修饰位到安卓修饰键码：shift 0x1、alt 0x02、ctrl 0x1000、meta 0x10000。 */
  const MODIFIER_KEYS = [
    [0x1000, 113], // KEYCODE_CTRL_LEFT
    [0x02, 57],    // KEYCODE_ALT_LEFT
    [0x1, 59],     // KEYCODE_SHIFT_LEFT
    [0x10000, 117] // KEYCODE_META_LEFT
  ]

  function pressKey(target, code, metastate = 0) {
    if (!Number.isFinite(code)) return false
    const modifiers = MODIFIER_KEYS.filter(([bit]) => (metastate & bit) !== 0)
    // 先按下修饰键。
    for (const [, keycode] of modifiers) {
      target.send(control.keycode({ action: control.ACTION.DOWN, keycode, metastate }))
    }
    const down = target.send(control.keycode({
      action: control.ACTION.DOWN,
      keycode: code,
      metastate
    }))
    setTimeout(() => {
      try {
        target.send(control.keycode({ action: control.ACTION.UP, keycode: code, metastate }))
        for (const [, keycode] of modifiers.reverse()) {
          target.send(control.keycode({ action: control.ACTION.UP, keycode, metastate: 0 }))
        }
      } catch {}
    }, 30)
    return down
  }

  /** 按 UTF-8 字节数把文本切成不超过 300 字节的片段。 */
  function splitText(text, limit = 300) {
    const chunks = []
    let current = ''
    let bytes = 0
    for (const char of text) {
      const size = Buffer.byteLength(char, 'utf8')
      if (bytes + size > limit && current.length > 0) {
        chunks.push(current)
        current = ''
        bytes = 0
      }
      current += char
      bytes += size
    }
    if (current.length > 0) chunks.push(current)
    return chunks
  }

  /** 发送文本：纯 ASCII 走按键注入，含非 ASCII 时走剪贴板 + 粘贴。 */
  let clipboardSequence = 0
  function sendText(target, value) {
    const text = String(value ?? '')
    if (text.length === 0) return false
    const chunks = splitText(text)
    chunks.forEach((chunk, index) => {
      const send = () => {
        try {
          if (/^[\x20-\x7e\n\r\t]*$/.test(chunk)) {
            target.send(control.text(chunk))
            return
          }
          clipboardSequence += 1
          target.send(control.setClipboard({ text: chunk, sequence: clipboardSequence, paste: true }))
        } catch {}
      }
      if (index === 0) send()
      else setTimeout(send, index * 40)
    })
    return true
  }

  /** 把归一化坐标换算成设备像素后发送触控事件。 */
  async function handleControl(target, message) {
    const screen = target.screen ?? target.deviceScreen ?? { width: 1080, height: 1920 }
    if (target instanceof ScrcpySession) {
      switch (message.kind) {
        case 'touch':
          return target.send(control.touch({
            action: message.action === 'down' ? control.ACTION.DOWN
              : message.action === 'up' ? control.ACTION.UP
                : control.ACTION.MOVE,
            x: message.x * screen.width,
            y: message.y * screen.height,
            screen
          }))
        case 'scroll':
          return target.send(control.scroll({
            x: (message.x ?? 0.5) * screen.width,
            y: (message.y ?? 0.5) * screen.height,
            screen,
            dx: message.dx ?? 0,
            dy: message.dy ?? 0
          }))
        case 'key':
          return pressKey(target, message.keycode, message.metastate ?? 0)
        case 'text':
          return sendText(target, message.text)
        case 'back':
          // 返回使用 BACK 键码。
          return pressKey(target, control.KEY.BACK)
        case 'power':
          // 电源键使用 POWER 键码。
          return pressKey(target, control.KEY.POWER)
        case 'rotate':
          return target.send(control.rotateDevice())

        // 请求关键帧。
        case 'reset':
          return target.send(control.resetVideo())

        case 'notifications':
          return target.send(control.expandNotifications())
        default:
          return false
      }
    }
    return target.send(message)
  }

  const HOST_PORT = /^[A-Za-z0-9._-]+:\d{1,5}$/
  const DEVICE_SERIAL = /^[A-Za-z0-9._-]+$/
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 读设备的 WLAN 地址与掩码长度，需在 tcpip 之前调用。 */
  async function deviceAddress(serial) {
    const { ok, stdout } = await adb.shell(serial, 'ip -4 addr', 8000)
    if (!ok) return null
    for (const match of stdout.matchAll(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/g)) {
      const ip = match[1]
      if (ip.startsWith('127.') || ip.startsWith('169.254.')) continue
      return { ip, prefix: Number(match[2]) }
    }
    return null
  }

  /**
   * 反复尝试 adb connect，直到设备进入 device 状态或超时。
   * timeoutMs 为总时长，attemptMs 为单次 adb connect 的超时。
   */
  async function connectWithRetry(address, timeoutMs = 20000, attemptMs = 10000) {
    let output = ''
    let state = ''
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await adb.run(['connect', address], { timeout: attemptMs })
      output = `${result.stdout}${result.stderr}`.trim()
      if (!/cannot|failed to connect|refused/i.test(output) && /connected to/i.test(output)) {
        const list = await adb.devices()
        state = list.find((device) => device.serial === address)?.state ?? ''
        if (state === 'device') return { ok: true, output, state }
        // 清掉 offline 条目后重试。
        if (state === 'offline') await adb.run(['disconnect', address], { timeout: 5000 }).catch(() => {})
        if (state === 'authorizing' || state === 'unauthorized') {
          await sleep(1000)
          continue
        }
      }
      await sleep(500)
    }
    return { ok: false, output, state }
  }

  /** 本机出口地址的掩码长度，从网络接口信息里取。 */
  function localPrefixFor(address) {
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list ?? []) {
        if (info.address !== address || !info.cidr) continue
        const prefix = Number(info.cidr.split('/')[1])
        if (Number.isFinite(prefix)) return prefix
      }
    }
    return null
  }

  /** 两个地址是否落在同一个子网。 */
  function sameSubnet(a, aPrefix, b, bPrefix) {
    if (!Number.isFinite(aPrefix) || !Number.isFinite(bPrefix)) return false
    const toInt = (ip) => ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0)
    const mask = (prefix) => (prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)
    return ((toInt(a) & mask(aPrefix)) >>> 0) === ((toInt(b) & mask(bPrefix)) >>> 0)
  }

  /** 到达目标地址所用的本机出口 IP。 */
  function localAddressFor(host) {
    return new Promise((resolve) => {
      const socket = udpConnect('udp4')
      const done = (value) => {
        try { socket.close() } catch {}
        resolve(value)
      }
      try {
        socket.connect(5555, host, () => {
          try { done(socket.address().address) } catch { done('') }
        })
      } catch { done('') }
      socket.once('error', () => done(''))
    })
  }

  /** 探测平板端口：open 可连，refused 可达但未监听，timeout 网络不通。 */
  function probeTcp(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const socket = netConnect({ host, port })
      const finish = (result) => {
        try { socket.destroy() } catch {}
        resolve(result)
      }
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => finish('open'))
      socket.once('timeout', () => finish('timeout'))
      socket.once('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'refused' : 'error'))
    })
  }

  /** 探测端口直到就绪：800ms 超时、400ms 间隔，open/refused 即返回。 */
  async function waitForPort(host, port, deadline) {
    let reachable = 'timeout'
    while (Date.now() < deadline) {
      reachable = await probeTcp(host, port, 800)
      if (reachable === 'open' || reachable === 'refused') return reachable
      await sleep(400)
    }
    return reachable
  }

  /** 等设备进入 device 状态，返回最后一次看到的状态。 */
  async function waitForDevice(serial, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const list = await adb.devices().catch(() => [])
      const state = list.find((device) => device.serial === serial)?.state ?? ''
      if (state === 'device' || state === '' || Date.now() >= deadline) return state
      await sleep(400)
    }
  }

  /** 清掉设备上残留的 scrcpy reverse 转发。 */
  async function clearReverse(serial) {
    for (const entry of await adb.reverseList(serial)) {
      if (!entry.local.startsWith('localabstract:scrcpy_')) continue
      await adb.reverseRemove(serial, entry.local)
    }
  }

  /** 用 mDNS 查找同一台设备的连接端口，查不到返回空串。 */
  async function mdnsConnectAddress(host) {
    const { ok, stdout } = await adb.run(['mdns', 'services'], { timeout: 8000 })
    if (!ok) return ''
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('_adb-tls-connect._tcp')) continue
      const match = /(\d+\.\d+\.\d+\.\d+):(\d{1,5})/.exec(line)
      if (match && match[1] === host) return `${match[1]}:${match[2]}`
    }
    return ''
  }

  /** 连不上时按 adb 的输出区分原因：拒绝、超时、等待授权。 */
  function connectFailure(connected, address) {
    if (connected.state === 'authorizing' || connected.state === 'unauthorized') {
      return '平板弹出了「允许 USB 调试吗？」，点允许后再试一次'
    }
    const output = connected.output ?? ''
    if (/10061|refused|积极拒绝/i.test(output)) {
      return '平板没有监听调试端口：确认「USB 调试」仍开着，再点一次「转无线」'
    }
    if (connected.state === 'offline') {
      return '平板锁屏时确认不了调试授权：解锁平板，再点一次「转无线」'
    }
    if (/10060|10065|timed out|没有正确答复|超时/i.test(output)) {
      return `连不上 ${address}：平板和电脑要在同一局域网内，校园网和访客网络常隔离设备`
    }
    return output || `连不上 ${address}`
  }

  const routes = [
    {
      path: `${BASE}/status`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: '需要 GET' })
        try {
          json(res, 200, await status())
        } catch (error) {
          json(res, 500, { error: error.message })
        }
      }
    },
    {
      path: `${BASE}/connect`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        try {
          const body = await readJson(req)
          if (typeof body.serial !== 'string' || body.serial.length === 0) {
            return json(res, 400, { error: '缺少设备序列号' })
          }
          const maxSize = Number.isFinite(body.maxSize)
            ? Math.min(2048, Math.max(240, Math.floor(body.maxSize)))
            : undefined
          const info = await startSession({ serial: body.serial, mode: body.mode, maxSize })
          json(res, 200, { ok: true, session: info })
        } catch (error) {
          json(res, 500, { ok: false, error: error.message })
        }
      }
    },
    {
      path: `${BASE}/disconnect`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        // 用户主动断开，清除自动重开记录。
        lastRequest = null
        await stopSession()
        json(res, 200, { ok: true })
      }
    },
    {
      path: `${BASE}/control`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        try {
          const message = await readControlMessage(req)
          if (!session) return json(res, 409, { ok: false, error: '没有进行中的会话' })
          const handled = await handleControl(session, message)
          return json(res, 200, { ok: Boolean(handled) })
        } catch (error) {
          return json(res, 400, { ok: false, error: error.message })
        }
      }
    },
    {
      path: `${BASE}/adb/connect`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        try {
          const body = await readJson(req)
          const address = String(body.address ?? '').trim()
          // 只接受 host:port 形式的地址。
          if (!/^[A-Za-z0-9._-]+:\d{1,5}$/.test(address)) {
            return json(res, 400, { error: '地址格式应为 192.168.1.5:5555' })
          }
          const result = await adb.run(['connect', address], { timeout: 15000 })
          const output = `${result.stdout}${result.stderr}`.trim()
          if (!result.ok || /cannot connect|failed to connect/i.test(output)) {
            return json(res, 502, { ok: false, error: output || 'adb connect 失败' })
          }
          json(res, 200, { ok: true, message: output })
        } catch (error) {
          json(res, 500, { ok: false, error: error.message })
        }
      }
    },
    {
      // 将当前 USB 设备切换到 TCP 调试并建立连接。
      path: `${BASE}/adb/tcpip`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        try {
          const body = await readJson(req)
          const serial = String(body.serial ?? '').trim()
          if (!DEVICE_SERIAL.test(serial)) {
            return json(res, 400, { ok: false, error: '需要 USB 设备的序列号' })
          }
          // 先点亮屏幕并解锁。
          await adb.shell(serial, 'input keyevent 224', 5000).catch(() => {})
          await adb.shell(serial, 'wm dismiss-keyguard', 5000).catch(() => {})
          const device = await deviceAddress(serial)
          if (!device) {
            return json(res, 409, { ok: false, error: '读不到设备的 WLAN 地址，确认平板已连上 Wi-Fi' })
          }
          const { ip } = device
          // 断开旧的无线连接，确保 adb connect 重建连接。
          await adb.run(['disconnect', `${ip}:5555`], { timeout: 5000 }).catch(() => {})
          // 通过 USB 预推 scrcpy server，供无线会话复用。
          const jar = settings(config).serverJar.length > 0 ? settings(config).serverJar : BUNDLED_SERVER
          const remoteJar = `/data/local/tmp/dsh-phone-mirror-${SCRCPY_VERSION}.jar`
          await adb.pushJar(serial, jar, remoteJar).catch((error) => warn(`预推 scrcpy server 失败：${error.message}`))
          const tcp = await adb.run(['-s', serial, 'tcpip', '5555'], { timeout: 20000 })
          if (!tcp.ok) {
            const output = `${tcp.stdout}${tcp.stderr}`.trim()
            return json(res, 502, { ok: false, error: output || 'adb tcpip 失败' })
          }
          const address = `${ip}:5555`
          // 等端口就绪（800ms 超时、400ms 间隔，窗口 20 秒）后再连接。
          const deadline = Date.now() + 20000
          const reachable = await waitForPort(ip, 5555, deadline)
          if (reachable === 'timeout' || reachable === 'error') {
            const local = await localAddressFor(ip)
            // 清除可能残留的 offline 条目。
            await adb.run(['disconnect', address], { timeout: 5000 }).catch(() => {})
            // 切回 USB 调试模式。
            await adb.run(['-s', serial, 'usb'], { timeout: 10000 }).catch(() => {})
            const localPrefix = local ? localPrefixFor(local) : null
            const from = local
              ? `（本机出口 ${local}${localPrefix != null ? `/${localPrefix}` : ''}）`
              : ''
            const same = sameSubnet(ip, device.prefix, local, localPrefix)
            const reason = same
              ? '同一网段内连不上，通常是网络隔离或防火墙（校园网、访客网络常见），换一个网络再试'
              : '两台设备不在同一网段，确认连的是同一个 Wi-Fi'
            return json(res, 502, {
              ok: false,
              error: `电脑连不到平板 ${ip}/${device.prefix}${from}：${reason}`
            })
          }
          // 单次 connect 上限 4 秒，剩余时间用于重试。
          const remaining = Math.max(4000, deadline - Date.now())
          const connected = await connectWithRetry(address, remaining, 4000)
          if (!connected.ok) {
            // 清除可能残留的 offline 条目。
            await adb.run(['disconnect', address], { timeout: 5000 }).catch(() => {})
            return json(res, 502, { ok: false, error: connectFailure(connected, address) })
          }
          json(res, 200, { ok: true, address })
        } catch (error) {
          json(res, 500, { ok: false, error: error.message })
        }
      }
    },
    {
      // 配对成功后用 mDNS 查找连接端口，找不到时返回 address: null。
      path: `${BASE}/adb/pair`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        try {
          const body = await readJson(req)
          const address = String(body.address ?? '').trim()
          const code = String(body.code ?? '').trim()
          if (!HOST_PORT.test(address)) {
            return json(res, 400, { ok: false, error: '配对地址格式应为 192.168.1.5:37123' })
          }
          if (!/^\d{6}$/.test(code)) {
            return json(res, 400, { ok: false, error: '配对码是 6 位数字' })
          }
          const result = await adb.run(['pair', address, code], { timeout: 35000 })
          const output = `${result.stdout}${result.stderr}`.trim()
          if (!/Successfully paired/i.test(output)) {
            return json(res, 502, { ok: false, error: output || 'adb pair 失败' })
          }
          const host = address.slice(0, address.lastIndexOf(':'))
          const connectAddress = await mdnsConnectAddress(host)
          if (!connectAddress) {
            return json(res, 200, { ok: true, paired: true, address: null, message: output })
          }
          const connected = await connectWithRetry(connectAddress)
          if (!connected.ok) {
            return json(res, 200, {
              ok: true,
              paired: true,
              address: null,
              error: `配对成功，${connectFailure(connected, connectAddress)}`
            })
          }
          json(res, 200, { ok: true, paired: true, address: connectAddress, message: output })
        } catch (error) {
          json(res, 500, { ok: false, error: error.message })
        }
      }
    },
    {
      // 只断开无线通道，保留 USB 连接。
      path: `${BASE}/adb/disconnect`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        try {
          const body = await readJson(req)
          let address = String(body.address ?? '').trim()
          if (!address) {
            const list = await adb.devices()
            address = list.find((device) => device.serial.includes(':'))?.serial ?? ''
          }
          if (!address) return json(res, 200, { ok: true, address: null, message: '没有无线连接' })
          if (!HOST_PORT.test(address)) {
            return json(res, 400, { ok: false, error: '地址格式应为 192.168.1.5:5555' })
          }
          // 会话使用该通道时先结束会话。
          if (session && sessionInfo?.serial === address) {
            lastRequest = null
            await stopSession()
          }
          const result = await adb.run(['disconnect', address], { timeout: 10000 })
          json(res, 200, {
            ok: true,
            address,
            message: `${result.stdout}${result.stderr}`.trim()
          })
        } catch (error) {
          json(res, 500, { ok: false, error: error.message })
        }
      }
    },
    {
      path: `${BASE}/stream`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'GET') return json(res, 405, { error: '需要 GET' })
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          // 关闭压缩，保证视频帧逐帧到达。
          'cache-control': 'no-transform, no-store',
          'content-encoding': 'identity',
          'x-content-type-options': 'nosniff',
          connection: 'keep-alive'
        })
        if (stream && !stream.destroyed) stream.end()
        stream = res
        // 关闭 Nagle。
        try { req.socket?.setNoDelay?.(true) } catch {}
        // 处理浏览器断线触发的 error 事件。
        res.on('error', () => { if (stream === res) stream = null })
        res.on('close', () => { if (stream === res) stream = null })
        res.write(frame(KIND.META, metaPayload({ type: 'meta', ...sessionInfo })))
        // 补发 OpusHead。
        if (lastAudioConfig) {
          res.write(frame(KIND.AUDIO, videoPayload(0x40, lastAudioConfig.pts, lastAudioConfig.data)))
        }
        // 请求关键帧。
        if (session instanceof ScrcpySession) {
          try { session.send(control.resetVideo()) } catch {}
        }
      }
    },
    {
      path: WORKLET_PATH,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'GET') return json(res, 405, { error: '需要 GET' })
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        })
        res.end(WORKLET_SOURCE)
      }
    },
    {
      path: ENGINE_PATH,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'GET') return json(res, 405, { error: '需要 GET' })
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        })
        res.end(ENGINE_SOURCE)
      }
    }
  ]

  // 每 2 秒发送一个 meta 帧作为保活。
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (session && stream && !stream.destroyed) pushMeta({})
    }, 2000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'phone-mirror: heartbeat')

  // 无线会话运行期间每 10 秒点亮一次屏幕。
  ctx.effect(() => {
    const timer = setInterval(() => {
      const target = session
      if (!(target instanceof ScrcpySession)) return
      if (!String(target.serial ?? '').includes(':')) return
      adb.shell(target.serial, 'input keyevent 224', 5000).catch(() => {})
    }, 10000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'phone-mirror: wireless keepalive')

  // 无线会话掉线后，按最后一次启动参数自动重开。
  let recovering = false
  let retryAt = 0
  // 自动重开的计时起点。
  let recoverSince = 0
  ctx.effect(() => {
    const timer = setInterval(async () => {
      if (!lastRequest || !lastRequest.serial.includes(':')) {
        recoverSince = 0
        return
      }
      if (recovering || session) return
      if (recoverSince === 0) recoverSince = Date.now()
      if (Date.now() - recoverSince > RECOVER_WINDOW_MS) {
        lastRequest = null
        recoverSince = 0
        log('自动重开超过窗口，交回手动连接')
        return
      }
      if (Date.now() < retryAt) return
      const list = await adb.devices().catch(() => [])
      if (!list.some((device) => device.serial === lastRequest.serial && device.state === 'device')) return
      recovering = true
      try {
        await startSession(lastRequest)
        retryAt = 0
        recoverSince = 0
        log('无线链路已恢复，会话自动重开')
      } catch (error) {
        // 失败后退避 15 秒。
        retryAt = Date.now() + 15000
        warn(`自动重开会话失败：${error.message}`)
      } finally {
        recovering = false
      }
    }, 4000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'phone-mirror: wireless recovery')

  ctx.effect(() => {
    const disposers = routes.map((route) =>
      ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler })
    )
    return () => {
      for (const dispose of disposers) {
        try { dispose?.() } catch {}
      }
      stopSession().catch(() => {})
      lastRequest = null
      if (stream && !stream.destroyed) stream.end()
    }
  }, 'phone-mirror: routes')

  log(`已加载（adb: ${adb.binary}）`)
}

