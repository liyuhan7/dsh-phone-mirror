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
import { Adb, resolveAdb } from './adb.js'
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
  audio: z.boolean().default(false),
  screencapIntervalMs: z.number().step(1).min(80).max(5000).default(260),
  serverJar: z.string().default('')
})

const BASE = '/dsh-phone-mirror/api'
const KIND = { VIDEO: 1, AUDIO: 2, META: 3, IMAGE: 4 }

function settings(config) {
  const defaults = {
    adbPath: '', mode: 'auto', maxSize: 1280, maxFps: 60,
    videoBitRate: 8_000_000, audio: false, screencapIntervalMs: 260, serverJar: ''
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

/** 只接受本机同源请求，避免局域网里的其他页面随便控制手机。 */
function isLocalSameOrigin(req) {
  const address = req.socket?.remoteAddress
  const loopback = address === '::1' || address === '127.0.0.1' || address?.startsWith('::ffff:127.')
  if (!loopback) return false
  // 桌面版外壳会做本机代理并加 x-forwarded-for，这属于正常链路；
  // 只有转发链里出现非回环地址时，才说明真的经过了远端代理。
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

const CONTROL_NUMBERS = new Set(['x', 'y', 'dx', 'dy', 'keycode', 'repeat'])
const CONTROL_BOOLEANS = new Set(['on'])

/**
 * 解析控制指令。控制消息体积小、频率高，用查询参数直接传：
 * 处理路径不触碰请求体，因此不会被慢速或未完成的 body 阻塞。
 * 查询参数为空时兼容 JSON body，读取带超时保护。
 */
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
  const adb = new Adb(resolveAdb(settings(config).adbPath))
  let session = null
  let stream = null
  let lastError = ''
  let sessionInfo = { mode: null, serial: null, deviceName: '', screen: null, audio: false, state: 'idle' }

  const log = (message) => ctx.logger?.info?.(`dsh-phone-mirror: ${message}`)
  const warn = (message) => ctx.logger?.warn?.(`dsh-phone-mirror: ${message}`)

  // 事件回调跑在 await 之外：任何异常都会变成未捕获异常并结束宿主进程。
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
    try { await current.stop() } catch {}
    sessionInfo = { mode: null, serial: null, deviceName: '', screen: null, audio: false, state: 'idle' }
    log('会话已停止')
  }

  /** 把会话事件接到当前流上。所有回调都过 safe()，插件不允许拖垮宿主。 */
  function wire(target, mode) {
    target.on('ready', safe((info) => {
      pushMeta({
        state: 'running', mode, serial: target.serial,
        deviceName: info.deviceName, screen: info.screen, audio: info.audio
      })
    }))
    target.on('meta', safe((info) => pushMeta({ screen: info.screen, deviceName: info.deviceName })))
    target.on('video', safe((packet) => {
      if (!stream || stream.destroyed) return
      // 慢客户端只丢非关键帧，避免缓冲区无限增长。
      if (stream.writableLength > 8 * 1024 * 1024 && !packet.key) return
      const flags = (packet.config ? 0x40 : 0) | (packet.key ? 0x20 : 0)
      stream.write(frame(KIND.VIDEO, videoPayload(flags, packet.pts, packet.data)))
    }))
    target.on('audio', safe((packet) => {
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
    }))
    target.on('close', safe(() => {
      if (session === target) pushMeta({ state: 'idle' })
    }))
  }

  /**
   * 建立会话。auto 模式先尝试 scrcpy（编码器偶发占用时重试一次），
   * 仍失败则降级到截屏模式。
   */
  async function startSession({ serial, mode, maxSize }) {
    await stopSession()
    const cfg = settings(config)
    const resolvedMode = mode ?? cfg.mode
    const jar = cfg.serverJar.length > 0 ? cfg.serverJar : BUNDLED_SERVER
    const resolvedSize = maxSize ?? cfg.maxSize

    const build = (useScrcpy) => useScrcpy
      ? new ScrcpySession({
          adb,
          serial,
          maxSize: resolvedSize,
          maxFps: cfg.maxFps,
          videoBitRate: cfg.videoBitRate,
          audio: cfg.audio,
          serverPath: jar,
          version: SCRCPY_VERSION
        })
      : new ScreencapSession({ adb, serial, intervalMs: cfg.screencapIntervalMs })

    const plan = resolvedMode === 'auto' ? ['scrcpy', 'scrcpy', 'screencap'] : [resolvedMode]

    let lastFailure = ''
    for (const attempt of plan) {
      const target = build(attempt === 'scrcpy')
      wire(target, attempt)
      try {
        await target.start()
        session = target
        sessionInfo = {
          state: 'running',
          mode: attempt,
          serial,
          deviceName: target.deviceName || serial,
          screen: target.screen ?? null,
          audio: Boolean(target.audioCodec),
          lastError: lastFailure
        }
        return sessionInfo
      } catch (error) {
        lastFailure = attempt === 'scrcpy'
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
      adb: { ok: Boolean(version), version, error, binary: adb.binary },
      devices,
      config: { mode: cfg.mode, maxSize: cfg.maxSize, audio: cfg.audio, adbPath: cfg.adbPath },
      session: sessionInfo
    }
  }

  /**
   * 发送一次完整按键。安卓需要成对的 DOWN/UP 才算一次按键，
   * UP 稍作延迟，避免过快的序列被系统组件丢弃。
   */
  function pressKey(target, code) {
    if (!Number.isFinite(code)) return false
    const down = target.send(control.keycode({ action: control.ACTION.DOWN, keycode: code }))
    setTimeout(() => {
      try { target.send(control.keycode({ action: control.ACTION.UP, keycode: code })) } catch {}
    }, 30)
    return down
  }

  /** 服务端已经知道设备分辨率，客户端只发归一化坐标。 */
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
          return pressKey(target, message.keycode)
        case 'text':
          return target.send(control.text(message.text ?? ''))
        case 'back':
          // 返回走 BACK 键码；BACK_OR_SCREEN_ON 主要用于点亮屏幕，语义不同。
          return pressKey(target, control.KEY.BACK)
        case 'power':
          // 用 POWER 键码而不是 SET_DISPLAY_POWER：后者只负责点亮屏幕。
          return pressKey(target, control.KEY.POWER)
        case 'rotate':
          return target.send(control.rotateDevice())

        case 'notifications':
          return target.send(control.expandNotifications())
        default:
          return false
      }
    }
    return target.send(message)
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
          // 只允许 host:port，避免把任意参数塞进 adb 命令行。
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
      path: `${BASE}/stream`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'GET') return json(res, 405, { error: '需要 GET' })
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          // 视频帧必须逐帧到达：宿主的 gzip 中间件会攒块再吐，60fps 会被压成
          // 一秒几次的突发。no-transform 让压缩中间件跳过这条响应。
          'cache-control': 'no-transform, no-store',
          'content-encoding': 'identity',
          'x-content-type-options': 'nosniff',
          connection: 'keep-alive'
        })
        if (stream && !stream.destroyed) stream.end()
        stream = res
        // 浏览器断线会触发 error 事件；未处理的 error 会直接结束宿主进程。
        res.on('error', () => { if (stream === res) stream = null })
        res.on('close', () => { if (stream === res) stream = null })
        res.write(frame(KIND.META, metaPayload({ type: 'meta', ...sessionInfo })))
        // 新接入的浏览器错过了启动时的关键帧，主动要一发，否则要等下次屏幕变化。
        if (session instanceof ScrcpySession) {
          try { session.send(control.resetVideo()) } catch {}
        }
      }
    }
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) =>
      ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler })
    )
    return () => {
      for (const dispose of disposers) {
        try { dispose?.() } catch {}
      }
      stopSession().catch(() => {})
      if (stream && !stream.destroyed) stream.end()
    }
  }, 'phone-mirror: routes')

  log(`已加载（adb: ${adb.binary}）`)
}

export { SCRCPY_VERSION }
