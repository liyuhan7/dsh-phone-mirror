// 安卓直连 Worker：在独立 Node 线程（独立事件循环）里运行 ScrcpySession 与本机 HTTP 端口，
// 向浏览器引擎直推音视频帧并直接接收控制指令，完全绕开 DSH 主宿主事件循环。
import { createServer } from 'node:http'
import { parentPort, workerData } from 'node:worker_threads'
import { Adb } from '../../adb.js'
import { AUDIO_FLAGS, frame, KIND, metaPayload, VIDEO_FLAGS, videoPayload } from '../../core/frames.js'
import * as control from '../../protocol.js'
import { ScrcpySession } from '../../session.js'
import { createScrcpyController } from './control.js'

const BACKLOG_LIMIT = 1_500_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || Boolean(address?.startsWith('::ffff:127.'))
}

function allowedLoopbackOrigin(origin) {
  if (origin === undefined) return { ok: true, header: '' }
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, header: '' }
    const host = parsed.hostname.toLowerCase()
    if (!LOOPBACK_HOSTS.has(host)) return { ok: false, header: '' }
    return { ok: true, header: origin }
  } catch {
    return { ok: false, header: '' }
  }
}

function corsHeaders(originHeader) {
  return originHeader
    ? { 'access-control-allow-origin': originHeader, vary: 'Origin' }
    : {}
}

function sendJson(res, status, data, originHeader = '') {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...corsHeaders(originHeader)
  })
  res.end(JSON.stringify(data))
}

async function readBody(req, limit = 64 * 1024) {
  let text = ''
  for await (const chunk of req) {
    text += chunk.toString('utf8')
    if (text.length > limit) throw new Error('请求体过大')
  }
  return text
}

/**
 * 将一条 ScrcpySession 封装为本机回环 HTTP 直连服务：
 *   GET  /frames.bin —— 统一二进制帧流（META / VIDEO / AUDIO）
 *   POST /control    —— 触控、滚轮、按键、文本等控制指令
 *   POST /reset      —— 请求编码器发送关键帧
 */
export function createDirectBridge({ session, onEvent }) {
  const dispatchControl = createScrcpyController()
  const subscribers = new Set()
  let lastVideoConfig = null
  let lastAudioConfig = null
  let lastScreen = null
  let keyRequestAt = 0
  let httpServer = null
  let httpPort = 0
  let stopped = false

  function requestKeyframeThrottled(force = false) {
    const now = Date.now()
    if (!force && now - keyRequestAt < 1000) return
    keyRequestAt = now
    try { session.send(control.resetVideo()) } catch {}
  }

  function writeMetaFrame(res) {
    const payload = {
      type: 'meta',
      platform: 'android',
      deviceName: session.deviceName || '',
      screen: lastScreen ?? session.screen ?? session.deviceScreen ?? null,
      audio: Boolean(session.audioCodec),
      ...(session.audioCodec ? { audioCodec: session.audioCodec } : {})
    }
    try { res.write(frame(KIND.META, metaPayload(payload))) } catch {}
  }

  function broadcast(bytes, { kind, config = false, key = false }) {
    for (const sub of subscribers) {
      const { res } = sub
      if (res.destroyed || res.writableEnded) {
        subscribers.delete(sub)
        continue
      }
      if (kind === KIND.VIDEO && !config) {
        if (sub.resyncing) {
          if (!key) continue
          sub.resyncing = false
        } else if (res.writableLength > BACKLOG_LIMIT) {
          sub.resyncing = true
          requestKeyframeThrottled()
          continue
        }
      } else if (kind === KIND.AUDIO && !config && res.writableLength > BACKLOG_LIMIT) {
        continue
      }
      try {
        res.write(bytes)
      } catch {
        subscribers.delete(sub)
      }
    }
  }

  function handleRequest(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      return sendJson(res, 403, { error: '只接受本机回环请求' })
    }
    const originCheck = allowedLoopbackOrigin(req.headers.origin)
    if (!originCheck.ok) {
      return sendJson(res, 403, { error: '只接受本机来源请求' })
    }
    try { req.socket?.setNoDelay?.(true) } catch {}

    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders(originCheck.header),
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type'
      })
      res.end()
      return
    }

    if (req.method === 'GET' && pathname === '/frames.bin') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-transform, no-store',
        'content-encoding': 'identity',
        'x-content-type-options': 'nosniff',
        connection: 'keep-alive',
        ...corsHeaders(originCheck.header)
      })
      const sub = { res, resyncing: false }
      subscribers.add(sub)
      const cleanup = () => { subscribers.delete(sub) }
      res.once('close', cleanup)
      res.once('error', cleanup)
      writeMetaFrame(res)
      if (lastVideoConfig) {
        try {
          res.write(frame(KIND.VIDEO, videoPayload(VIDEO_FLAGS.CONFIG, lastVideoConfig.pts, lastVideoConfig.data)))
        } catch {}
      }
      if (lastAudioConfig) {
        try {
          res.write(frame(KIND.AUDIO, videoPayload(AUDIO_FLAGS.CONFIG, lastAudioConfig.pts, lastAudioConfig.data)))
        } catch {}
      }
      requestKeyframeThrottled(true)
      return
    }

    if (req.method === 'POST' && pathname === '/reset') {
      requestKeyframeThrottled(true)
      return sendJson(res, 200, { ok: true }, originCheck.header)
    }

    if (req.method === 'POST' && pathname === '/control') {
      readBody(req)
        .then((raw) => {
          const message = raw.length > 0 ? JSON.parse(raw) : {}
          const handled = dispatchControl(session, message)
          sendJson(res, 200, { ok: Boolean(handled) }, originCheck.header)
        })
        .catch((error) => {
          sendJson(res, 400, { ok: false, error: error.message }, originCheck.header)
        })
      return
    }

    sendJson(res, 404, { error: '未找到接口' }, originCheck.header)
  }

  session.on('meta', (info) => {
    if (info.screen) lastScreen = info.screen
    const payload = {
      type: 'meta',
      platform: 'android',
      screen: info.screen ?? lastScreen,
      deviceName: info.deviceName ?? session.deviceName
    }
    broadcast(frame(KIND.META, metaPayload(payload)), { kind: KIND.META })
    onEvent?.({ type: 'meta', info })
  })

  session.on('audio-codec', (info) => {
    onEvent?.({ type: 'audio-codec', info })
  })

  session.on('video', (packet) => {
    if (packet.config) lastVideoConfig = packet
    if (subscribers.size === 0) return
    const flags =
      (packet.config ? VIDEO_FLAGS.CONFIG : 0) |
      (packet.key ? VIDEO_FLAGS.KEY : 0) |
      (packet.reset ? VIDEO_FLAGS.RESET : 0)
    broadcast(frame(KIND.VIDEO, videoPayload(flags, packet.pts, packet.data)), {
      kind: KIND.VIDEO,
      config: Boolean(packet.config),
      key: Boolean(packet.key)
    })
  })

  session.on('audio', (packet) => {
    if (packet.config) lastAudioConfig = packet
    if (subscribers.size === 0) return
    const flags = (packet.config ? AUDIO_FLAGS.CONFIG : 0) | (packet.pcm ? AUDIO_FLAGS.PCM : 0)
    broadcast(frame(KIND.AUDIO, videoPayload(flags, packet.pts, packet.data)), {
      kind: KIND.AUDIO,
      config: Boolean(packet.config)
    })
  })

  session.on('error', (error) => {
    onEvent?.({ type: 'error', message: error?.message ?? String(error) })
  })

  session.on('close', () => {
    closeHttp()
    onEvent?.({ type: 'close' })
  })

  function closeHttp() {
    for (const sub of subscribers) {
      try { sub.res.end() } catch {}
    }
    subscribers.clear()
    if (httpServer) {
      const server = httpServer
      httpServer = null
      try { server.close() } catch {}
      try { server.closeAllConnections?.() } catch {}
    }
  }

  async function start() {
    httpServer = createServer(handleRequest)
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(0, '127.0.0.1', () => {
        httpPort = httpServer.address().port
        resolve()
      })
    })
    try {
      await session.start()
      return {
        deviceName: session.deviceName || '',
        screen: session.screen ?? session.deviceScreen ?? null,
        audio: Boolean(session.audioCodec),
        audioCodec: session.audioCodec ?? null,
        videoCodec: session.videoCodec ?? null,
        videoPort: httpPort
      }
    } catch (error) {
      closeHttp()
      await session.stop().catch(() => {})
      throw error
    }
  }

  async function stop() {
    if (stopped) return
    stopped = true
    closeHttp()
    await session.stop().catch(() => {})
  }

  return {
    get port() { return httpPort },
    start,
    stop,
    control: (message) => dispatchControl(session, message),
    requestKeyframe: () => requestKeyframeThrottled(true)
  }
}

// 作为 worker_threads 启动时的入口。
if (parentPort && workerData?.serial) {
  const adb = new Adb(workerData.adbBinary)
  const session = new ScrcpySession({
    adb,
    serial: workerData.serial,
    maxSize: workerData.maxSize,
    maxFps: workerData.maxFps,
    videoBitRate: workerData.videoBitRate,
    audio: workerData.audio,
    serverPath: workerData.serverPath,
    version: workerData.version
  })
  const bridge = createDirectBridge({
    session,
    onEvent: (event) => {
      try { parentPort.postMessage(event) } catch {}
    }
  })

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    await bridge.stop().catch(() => {})
    try { parentPort.postMessage({ type: 'stopped' }) } catch {}
    process.exit(0)
  }

  parentPort.on('message', (message) => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'control') {
      const ok = bridge.control(message.payload)
      if (message.id !== undefined) {
        try { parentPort.postMessage({ type: 'control-reply', id: message.id, ok: Boolean(ok) }) } catch {}
      }
      return
    }
    if (message.type === 'reset') {
      bridge.requestKeyframe()
      return
    }
    if (message.type === 'stop') {
      void shutdown()
    }
  })
  parentPort.on('close', () => { void shutdown() })

  bridge.start()
    .then((info) => {
      parentPort.postMessage({ type: 'ready', info })
    })
    .catch((error) => {
      try {
        parentPort.postMessage({ type: 'start-error', message: error?.message ?? String(error) })
      } catch {}
      process.exit(1)
    })
}
