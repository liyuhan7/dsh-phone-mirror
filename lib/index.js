// dsh-phone-mirror 宿主侧：按平台（android / ios）管理设备提供方与投屏会话，
// 并把视频/音频/元数据按统一帧格式推给侧边栏里的客户端。
import z from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { AUDIO_FLAGS, frame, KIND, metaPayload, VIDEO_FLAGS, videoPayload } from './core/frames.js'
import { isLocalSameOrigin, json, readControlMessage, readJson } from './core/http.js'
import { createAndroidProvider } from './providers/android/index.js'
import { createIosProvider } from './providers/ios/index.js'

export const name = 'dsh-phone-mirror'
export const inject = ['webServer']

export const Config = z.object({
  adbPath: z.string().default(''),
  mode: z.union([z.const('auto'), z.const('scrcpy'), z.const('screencap')]).default('auto'),
  maxSize: z.number().step(1).min(0).max(4096).default(1280),
  maxFps: z.number().step(1).min(0).max(120).default(60),
  videoBitRate: z.number().step(1).min(0).max(100_000_000).default(8_000_000),
  audio: z.boolean().default(true),
  iosWirelessHost: z.string().default(''),
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

function settings(config) {
  const defaults = {
    adbPath: '', mode: 'auto', maxSize: 1280, maxFps: 60,
    videoBitRate: 8_000_000, audio: true, screencapIntervalMs: 260, serverJar: '',
    iosWirelessHost: ''
  }
  const result = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const field = config?.[key]
    const value = typeof field?.get === 'function' ? field.get() : field
    result[key] = value ?? fallback
  }
  return result
}

const emptySessionInfo = () => ({
  platform: null,
  mode: null,
  serial: null,
  deviceName: '',
  screen: null,
  audio: false,
  state: 'idle'
})

export function apply(ctx, config) {
  const log = (message) => ctx.logger?.info?.(`dsh-phone-mirror: ${message}`)
  const warn = (message) => ctx.logger?.warn?.(`dsh-phone-mirror: ${message}`)
  const getSettings = () => settings(config)

  const android = createAndroidProvider({ getSettings, warn })
  const ios = createIosProvider({ getSettings, warn, log })
  const providers = { android, ios }

  let session = null
  let stream = null
  let streamTabId = null
  let lastAudioConfig = null
  let sessionInfo = emptySessionInfo()
  // 最后一次成功启动的参数。
  let lastRequest = null
  let recoveryTask = null
  let pendingConnect = null
  // 无线会话掉线后自动重开的时间窗口。
  const RECOVER_WINDOW_MS = 90 * 1000

  function pushMeta(extra = {}) {
    sessionInfo = { ...sessionInfo, ...extra }
    if (stream && !stream.destroyed) {
      try {
        stream.write(frame(KIND.META, metaPayload({ type: 'meta', ...sessionInfo })))
      } catch {}
    }
  }

  // 停止过程是异步的；断开后立刻连接时必须等上一次 stop 真正结束，
  // 否则新 bridge 会和还没释放设备会话的旧 bridge 抢同一个 DisplayService。
  let stopping = Promise.resolve()

  async function stopSession({ clear = false } = {}) {
    if (!session) {
      await stopping
      if (clear && !session) {
        lastAudioConfig = null
        sessionInfo = emptySessionInfo()
        pushMeta()
      }
      return
    }
    const current = session
    session = null
    lastAudioConfig = null
    stopping = current.stop().catch(() => {})
    await stopping
    sessionInfo = emptySessionInfo()
    pushMeta()
    log('会话已停止')
  }

  /** 把当前会话的事件接到流上，忽略已经取消的连接。 */
  function wire(target, mode, tabId, isCurrent) {
    const safe = (fn) => (...args) => {
      if (!isCurrent()) return
      try { fn(...args) } catch (error) {
        warn(`回调异常：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // 套接字积压时跳过非关键帧，并请求一个关键帧后恢复投递。
    const BACKLOG_LIMIT = 1_500_000
    let resyncing = false
    let keyRequestAt = 0
    const askKeyframe = () => {
      const now = Date.now()
      if (now - keyRequestAt < 1000) return
      keyRequestAt = now
      try { target.requestKeyframe?.() } catch {}
    }

    target.on('ready', safe((info) => {
      pushMeta({
        state: 'running',
        tabId,
        platform: target.platform ?? 'android',
        mode,
        serial: target.serial,
        deviceName: info.deviceName,
        screen: info.screen,
        ...(info.rotation != null ? { rotation: info.rotation } : {}),
        audio: info.audio,
        ...(info.videoCodec ? { videoCodec: info.videoCodec } : {}),
        ...(info.videoDescription ? { videoDescription: info.videoDescription } : {})
      })
    }))
    target.on('meta', safe((info) => pushMeta({
      screen: info.screen ?? sessionInfo.screen,
      ...(info.rotation != null ? { rotation: info.rotation } : {}),
      deviceName: info.deviceName ?? sessionInfo.deviceName,
      ...(info.videoCodec ? { videoCodec: info.videoCodec } : {}),
      ...(info.videoDescription ? { videoDescription: info.videoDescription } : {})
    })))
    target.on('video', safe((packet) => {
      if (!stream || stream.destroyed) return
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
      const flags =
        (packet.config ? VIDEO_FLAGS.CONFIG : 0) |
        (packet.key ? VIDEO_FLAGS.KEY : 0) |
        (packet.reset ? VIDEO_FLAGS.RESET : 0)
      stream.write(frame(KIND.VIDEO, videoPayload(flags, packet.pts, packet.data)))
    }))
    target.on('audio', safe((packet) => {
      if (packet.config) lastAudioConfig = packet
      if (!stream || stream.destroyed) return
      const flags = (packet.config ? AUDIO_FLAGS.CONFIG : 0) | (packet.pcm ? AUDIO_FLAGS.PCM : 0)
      stream.write(frame(KIND.AUDIO, videoPayload(flags, packet.pts, packet.data)))
    }))
    target.on('image', safe((packet) => {
      if (!stream || stream.destroyed) return
      stream.write(frame(KIND.IMAGE, packet.data))
    }))
    target.on('audio-codec', safe((info) => pushMeta({ audioCodec: info.codec, audio: Boolean(info.codec) })))
    target.on('error', safe((error) => {
      warn(error.message)
      pushMeta({ state: 'error', error: error.message })
      if (session === target) {
        session = null
        stopping = target.stop().catch(() => {})
      }
    }))
    target.on('close', safe(() => {
      if (session === target) pushMeta({ state: 'idle' })
    }))
  }

  /** 根据序列号或显式 platform 参数选择提供方。 */
  async function resolvePlatform(explicitPlatform, serial) {
    if (explicitPlatform === 'android' || explicitPlatform === 'ios') return explicitPlatform
    const iosStatus = await ios.status().catch(() => ({ devices: [] }))
    if (iosStatus.devices.some((device) => device.serial === serial)) return 'ios'
    return 'android'
  }

  async function startSession({ platform: rawPlatform, serial, mode, maxSize, tabId }, isCancelled) {
    await stopSession()
    const platform = await resolvePlatform(rawPlatform, serial)
    if (isCancelled()) return null
    if (stream && streamTabId !== tabId) {
      stream.end()
      stream = null
    }
    const provider = providers[platform] ?? android
    let starting = true
    try {
      const { session: target, info } = await provider.startSession({
        serial,
        mode,
        maxSize,
        wire: (candidate, candidateMode) => wire(candidate, candidateMode, tabId, () =>
          starting ? !isCancelled() : session === candidate
        )
      })
      if (isCancelled()) {
        await target.stop().catch(() => {})
        return null
      }
      session = target
      lastRequest = { platform, serial, mode, maxSize, tabId }
      sessionInfo = { ...info, tabId }
      pushMeta()
      return sessionInfo
    } finally {
      starting = false
    }
  }

  async function status() {
    const cfg = getSettings()
    const [androidStatus, iosStatus] = await Promise.all([
      android.status(),
      ios.status()
    ])
    const devices = [...androidStatus.devices, ...iosStatus.devices]
    const recoveryTarget = !session && lastRequest?.serial.includes(':')
      ? { platform: lastRequest.platform, serial: lastRequest.serial, tabId: lastRequest.tabId }
      : null
    return {
      adb: {
        ok: androidStatus.ok,
        version: androidStatus.version,
        error: androidStatus.error,
        binary: androidStatus.binary,
        preparing: androidStatus.preparing
      },
      ios: {
        ok: iosStatus.ok,
        error: iosStatus.error,
        preparing: iosStatus.preparing
      },
      providers: {
        android: androidStatus,
        ios: iosStatus
      },
      devices,
      config: { mode: cfg.mode, maxSize: cfg.maxSize, audio: cfg.audio, adbPath: cfg.adbPath },
      session: sessionInfo,
      // 宿主是否正在自动重开无线会话。
      autoConnecting: Boolean(recoveryTarget),
      recoveryTarget
    }
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
          if (pendingConnect) return json(res, 409, { ok: false, error: '已有连接正在建立' })
          const tabId = typeof body.tabId === 'string' ? body.tabId : null
          const connect = { tabId, cancelled: false }
          pendingConnect = connect
          lastRequest = null
          connect.task = (async () => {
            await recoveryTask
            if (connect.cancelled) return null
            return startSession({ platform: body.platform, serial: body.serial, mode: body.mode, maxSize, tabId },
              () => connect.cancelled)
          })()
          try {
            const info = await connect.task
            json(res, 200, { ok: true, session: info })
          } finally {
            pendingConnect = null
          }
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
        try {
          const { tabId } = await readJson(req)
          const matches = (owner) => tabId == null || owner === tabId
          const connect = pendingConnect
          if (connect && matches(connect.tabId)) connect.cancelled = true
          if (lastRequest && matches(lastRequest.tabId)) {
            lastRequest = null
            await recoveryTask
          }
          if (connect?.cancelled && matches(connect.tabId)) await connect.task.catch(() => {})
          if (matches(sessionInfo.tabId)) await stopSession({ clear: true })
          json(res, 200, { ok: true })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      }
    },
    {
      path: `${BASE}/control`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        try {
          if (!session) return json(res, 409, { ok: false, error: '没有进行中的会话' })
          const message = await readControlMessage(req)
          const handled = await session.handleControl(message)
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
          const outcome = await android.connectAddress(body.address)
          json(res, outcome.status, outcome.body)
        } catch (error) {
          json(res, 500, { ok: false, error: error.message })
        }
      }
    },
    {
      path: `${BASE}/adb/tcpip`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        try {
          const body = await readJson(req)
          const platform = await resolvePlatform(body.platform, body.serial)
          const provider = providers[platform] ?? android
          const outcome = await provider.toWireless(body.serial)
          json(res, outcome.status, outcome.body)
        } catch (error) {
          json(res, 500, { ok: false, error: error.message })
        }
      }
    },
    {
      path: `${BASE}/adb/pair`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        try {
          const body = await readJson(req)
          const outcome = await android.pair(body.address, body.code)
          json(res, outcome.status, outcome.body)
        } catch (error) {
          json(res, 500, { ok: false, error: error.message })
        }
      }
    },
    {
      path: `${BASE}/adb/disconnect`,
      handler: async (req, res) => {
        if (!isLocalSameOrigin(req)) return json(res, 403, { error: '只接受本机同源请求' })
        if (req.method !== 'POST') return json(res, 405, { error: '需要 POST' })
        try {
          const body = await readJson(req)
          const platform = await resolvePlatform(body.platform, body.address)
          const provider = providers[platform] ?? android
          const outcome = await provider.disconnectWireless(body.address)
          const address = outcome.address
          const cancelsRecovery = address && lastRequest?.platform === platform && lastRequest.serial === address
          if (cancelsRecovery) lastRequest = null
          if (address && session?.platform === platform && session.serial === address) {
            await stopSession()
          } else if (cancelsRecovery) {
            await recoveryTask
            if (!session) await stopSession({ clear: true })
          }
          json(res, outcome.status, outcome.body)
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
        const tabId = new URL(req.url, 'http://localhost').searchParams.get('tabId')
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-transform, no-store',
          'content-encoding': 'identity',
          'x-content-type-options': 'nosniff',
          connection: 'keep-alive'
        })
        if (stream && !stream.destroyed) stream.end()
        stream = res
        streamTabId = tabId
        try { req.socket?.setNoDelay?.(true) } catch {}
        res.on('error', () => { if (stream === res) stream = null })
        res.on('close', () => { if (stream === res) stream = null })
        res.write(frame(KIND.META, metaPayload({ type: 'meta', ...sessionInfo })))
        if (lastAudioConfig) {
          res.write(frame(KIND.AUDIO, videoPayload(AUDIO_FLAGS.CONFIG, lastAudioConfig.pts, lastAudioConfig.data)))
        }
        try { session?.requestKeyframe?.() } catch {}
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

  // 无线会话运行期间定期发送保活。
  ctx.effect(() => {
    const timer = setInterval(() => {
      try { session?.keepalive?.() } catch {}
    }, 10000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'phone-mirror: wireless keepalive')

  // 无线会话掉线后，按最后一次启动参数自动重开。
  let retryAt = 0
  let recoverSince = 0
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (!lastRequest || !lastRequest.serial.includes(':')) {
        recoverSince = 0
        return
      }
      if (recoveryTask || session) return
      if (recoverSince === 0) recoverSince = Date.now()
      if (Date.now() - recoverSince > RECOVER_WINDOW_MS) {
        lastRequest = null
        recoverSince = 0
        log('自动重开超过窗口，交回手动连接')
        return
      }
      if (Date.now() < retryAt) return
      const request = lastRequest
      const provider = providers[request.platform]
      recoveryTask = (async () => {
        const canRecover = await provider.canRecoverWireless(request.serial).catch(() => false)
        if (!canRecover || lastRequest !== request || session) return
        try {
          if (!await startSession(request, () => lastRequest !== request)) return
          retryAt = 0
          recoverSince = 0
          log('无线链路已恢复，会话自动重开')
        } catch (error) {
          if (lastRequest !== request) return
          retryAt = Date.now() + 5000
          warn(`自动重开会话失败：${error.message}`)
        }
      })().finally(() => { recoveryTask = null })
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

  log(`已加载（adb: ${android.binary}）`)
}
