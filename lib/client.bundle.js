// 本文件由 npm run build 生成，请修改 lib/client.js 后重新构建。
// dsh-phone-mirror 浏览器端：右侧栏「手机」面板。
// 这里只做面板界面：把指针/键盘换算成控制消息回传，画面和声音由引擎负责（lib/engine.js）。
/* global window, AudioContext, AudioWorkletNode, Worker, createImageBitmap */
window.__ModuleLoader__.load({
  id: 'dsh-phone-mirror',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const BASE = '/dsh-phone-mirror/api'
    const STREAM_URL = `${BASE}/stream`
    const CONTROL_URL = `${BASE}/control`
    // AudioWorklet 和引擎 Worker 都由宿主同源提供（不复用 /api 前缀）。
    const WORKLET_URL = '/dsh-phone-mirror/audio-worklet.js'
    const WORKER_URL = '/dsh-phone-mirror/engine-worker.js'
    // 音频初始目标缓冲；欠载后由引擎加厚，稳定后回降。
    const AUDIO_TARGET_MS = 80
    const TAB_ID = 'phone-mirror'
    const TAB_KIND = 'phone-mirror'

    /** 字母与数字的安卓键码，用于修饰键组合。 */
    const LETTER_OR_DIGIT = {
      a: 29, b: 30, c: 31, d: 32, e: 33, f: 34, g: 35, h: 36, i: 37, j: 38,
      k: 39, l: 40, m: 41, n: 42, o: 43, p: 44, q: 45, r: 46, s: 47, t: 48,
      u: 49, v: 50, w: 51, x: 52, y: 53, z: 54,
      0: 7, 1: 8, 2: 9, 3: 10, 4: 11, 5: 12, 6: 13, 7: 14, 8: 15, 9: 16
    }

    const clamp01 = (value) => Math.min(1, Math.max(0, value))

    // 引擎源码在这里内联（见 scripts/build-client.mjs）。
    // 镜像引擎：拉宿主推来的二进制帧，解视频画到画布、解音频送进 worklet。
// 只依赖传入的画布和消息通道，因此可以整个放进 Worker，也能在主线程里跑。
//
// 与宿主之间的消息：
//   收 init(canvas) / open(streamUrl, controlUrl) / close / reset / mute(muted)
//      audio-port(port) / audio-denied
//   发 meta(payload) / size / stats(fps) / note / error / stall / audio-start
/* global self, createImageBitmap, VideoDecoder, AudioDecoder, EncodedVideoChunk, EncodedAudioChunk */
function createMirrorEngine({ canvas, post }) {
  const KIND = { VIDEO: 1, AUDIO: 2, META: 3, IMAGE: 4 }
  // 画面静止时设备不产生帧，仅凭视频帧无法判断链路是否存活，
  // 因此分别记录字节、送入、解码三种时刻。
  const emptyLive = () => ({
    byteAt: 0, feedAt: 0, decodeAt: 0, keyAt: 0, keyRetries: 0,
    restartAt: 0, stalls: 0, stallWindowAt: 0, failures: 0
  })
  // 音频目标缓冲：80ms 覆盖实测抖动；欠载时加厚，稳定后回降。
  const TARGET_MIN = 80
  const TARGET_MAX = 240
  const BACKLOG_FRAMES = 16
  const context = canvas.getContext('2d', { alpha: false })

  const state = {
    streamUrl: '',
    controlUrl: '',
    generation: 0,
    controller: null,
    stopped: true,
    sizeTimer: null,
    size: { width: 0, height: 0 },
    video: { decoder: null, codec: '', configKey: '', key: true, wantKey: false, pending: [], present: null },
    audio: {
      decoder: null, description: null, port: null, target: TARGET_MIN,
      muted: false, failed: false, requested: false, lastUnderrun: 0
    },
    live: emptyLive(),
    counter: { received: 0, at: 0 },
    watchdog: null,
    decay: null
  }

  /** 宿主帧格式：[u32 长度][u8 类型][载荷]，可能任意切包。 */
  class FrameParser {
    constructor() {
      this.buffer = new Uint8Array(0)
    }

    push(chunk) {
      const merged = new Uint8Array(this.buffer.length + chunk.length)
      merged.set(this.buffer, 0)
      merged.set(chunk, this.buffer.length)
      this.buffer = merged
      const frames = []
      for (;;) {
        if (this.buffer.length < 4) break
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4)
        const length = view.getUint32(0)
        if (length < 1 || length > 64 * 1024 * 1024) {
          // 长度异常表示流已错位，丢弃缓冲以免累积。
          this.buffer = new Uint8Array(0)
          break
        }
        if (this.buffer.length < 4 + length) break
        frames.push({ kind: this.buffer[4], payload: this.buffer.subarray(5, 4 + length) })
        this.buffer = this.buffer.subarray(4 + length)
      }
      return frames
    }
  }

  /** 按起始码切出 NAL 单元（去掉 00 00 01 / 00 00 00 01）。 */
  function splitNals(data) {
    const nals = []
    let start = -1
    for (let i = 0; i + 2 < data.length; i += 1) {
      const isThree = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1
      const isFour = i + 3 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1
      if (!isThree && !isFour) continue
      if (start >= 0) nals.push(data.subarray(start, i))
      start = i + (isFour ? 4 : 3)
      i += isFour ? 3 : 2
    }
    if (start >= 0 && start < data.length) nals.push(data.subarray(start))
    return nals
  }

  /** Annex-B 访问单元 → AVCC（每个 NAL 前加 4 字节大端长度）。 */
  function toAvcc(data) {
    const nals = splitNals(data)
    if (nals.length === 0) return null
    let total = 0
    for (const nal of nals) total += 4 + nal.length
    const out = new Uint8Array(total)
    let offset = 0
    for (const nal of nals) {
      out[offset] = (nal.length >>> 24) & 0xff
      out[offset + 1] = (nal.length >>> 16) & 0xff
      out[offset + 2] = (nal.length >>> 8) & 0xff
      out[offset + 3] = nal.length & 0xff
      out.set(nal, offset + 4)
      offset += 4 + nal.length
    }
    return out
  }

  /** 配置包指纹：长度 + 内容摘要，用来判断 SPS/PPS 是否真的变化。 */
  function fingerprintConfig(config, data) {
    let hash = 0
    for (let i = 0; i < data.length; i += 1) hash = ((hash << 5) - hash + data[i]) | 0
    return `${config.codec}:${data.length}:${hash}`
  }

  /** 从配置包里取 SPS/PPS，拼 avcC；codec 字符串也由 SPS 前三字节决定。 */
  function parseConfig(data) {
    const nals = splitNals(data)
    const sps = nals.find((nal) => (nal[0] & 0x1f) === 7)
    const pps = nals.find((nal) => (nal[0] & 0x1f) === 8)
    if (!sps || sps.length < 4) return null
    const hex = (value) => value.toString(16).padStart(2, '0')
    const codec = `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`
    if (!pps) return { codec, description: null }
    const description = new Uint8Array(11 + sps.length + pps.length)
    description[0] = 1 // configurationVersion
    description[1] = sps[1] // AVCProfileIndication
    description[2] = sps[2] // profile_compatibility
    description[3] = sps[3] // AVCLevelIndication
    description[4] = 0xff // 6 bits reserved + lengthSizeMinusOne = 3
    description[5] = 0xe1 // 3 bits reserved + numOfSequenceParameterSets = 1
    description[6] = (sps.length >>> 8) & 0xff
    description[7] = sps.length & 0xff
    description.set(sps, 8)
    let offset = 8 + sps.length
    description[offset] = 1 // numOfPictureParameterSets
    description[offset + 1] = (pps.length >>> 8) & 0xff
    description[offset + 2] = pps.length & 0xff
    description.set(pps, offset + 3)
    return { codec, description }
  }

  const emit = (message) => {
    try { post(message) } catch {}
  }

  function resize(width, height) {
    if (canvas.width === width && canvas.height === height) return
    canvas.width = width
    canvas.height = height
    state.size = { width, height }
    emit({ type: 'size', width, height })
  }

  /**
   * 请求设备重建编码会话并立即发送 SPS/PPS 与关键帧。
   * 解码落后、参考链断开、关键帧超时都依赖它恢复同步；
   * 每次都会重启编码器，因此默认限频 2.5s。
   */
  function requestKeyframe(force = false) {
    const now = Date.now()
    if (!force && now - state.live.keyAt < 2500) return
    state.live.keyAt = now
    if (!state.controlUrl) return
    // 控制指令只走查询串，不读请求体，避免被慢请求阻塞。
    fetch(`${state.controlUrl}?kind=reset`, { method: 'POST', cache: 'no-store' }).catch(() => {})
  }

  /** 记录一次重同步；15 秒窗口内反复出现说明当前档位超出解码能力。 */
  function noteStall() {
    const now = Date.now()
    if (now - state.live.stallWindowAt > 15000) {
      state.live.stallWindowAt = now
      state.live.stalls = 0
    }
    state.live.stalls += 1
    emit({ type: 'stall', stalls: state.live.stalls })
  }

  function dropPending() {
    const pending = state.video.pending
    while (pending.length > 0) {
      try { pending.shift().close() } catch {}
    }
  }

  /**
   * 解码输出先入队，由固定节拍逐帧绘制。adb 常把几帧攒在一起送达，
   * 收到就画会让同一簇里的中间帧来不及上屏，动画看起来一顿一顿。
   */
  function startPresenter() {
    if (state.video.present) return
    state.video.present = setInterval(() => {
      const pending = state.video.pending
      if (pending.length === 0) return
      const frame = pending.shift()
      try { context.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight) } catch {}
      try { frame.close() } catch {}
    }, 16)
  }

  function closeDecoder() {
    try { state.video.decoder?.close() } catch {}
    state.video.decoder = null
    state.video.codec = ''
    state.video.key = true
    dropPending()
  }

  function ensureDecoder(codec, description) {
    closeDecoder()
    const decoder = new VideoDecoder({
      output: (frame) => {
        state.live.decodeAt = Date.now()
        resize(frame.displayWidth, frame.displayHeight)
        const pending = state.video.pending
        pending.push(frame)
        // 只保留最近几帧，避免延迟随队列增长。
        while (pending.length > 4) {
          try { pending.shift().close() } catch {}
        }
        startPresenter()
      },
      error: (failure) => {
        // 解码器报错后状态不可信：丢弃并重连，以获取新的 SPS/PPS 与关键帧。
        if (state.video.decoder === decoder) closeDecoder()
        emit({ type: 'note', message: `解码器重建中：${failure.message}` })
        const now = Date.now()
        if (now - state.live.restartAt > 1500) {
          state.live.restartAt = now
          restart()
        }
      }
    })
    // 有 avcC 时按 AVCC 解码（Chromium 的稳定路径），否则退回 Annex-B。
    const base = description
      ? { codec, description, optimizeForLatency: true }
      : { codec, optimizeForLatency: true, avc: { format: 'annexb' } }
    try {
      decoder.configure(base)
    } catch {
      try {
        // 仍失败时交由浏览器选择实现。
        decoder.configure({ ...base, hardwareAcceleration: 'no-preference' })
      } catch (failure) {
        try { decoder.close() } catch {}
        emit({ type: 'error', message: `解码器配置失败：${failure.message}` })
        return null
      }
    }
    if (decoder.state !== 'configured') {
      try { decoder.close() } catch {}
      return null
    }
    state.video.decoder = decoder
    state.video.codec = codec
    state.video.key = true
    return decoder
  }

  /** 音频链路：Opus 解码 → 宿主侧的 AudioWorklet 环形缓冲 → 扬声器。 */
  function ensureAudioDecoder() {
    const audio = state.audio
    if (audio.decoder || audio.failed || !audio.description || !audio.port) return
    try {
      const decoder = new AudioDecoder({
        output: (data) => {
          const port = state.audio.port
          if (!port) {
            data.close()
            return
          }
          try {
            const frames = data.numberOfFrames
            const left = new Float32Array(frames)
            data.copyTo(left, { planeIndex: 0, format: 'f32-planar' })
            if (data.numberOfChannels > 1) {
              const right = new Float32Array(frames)
              data.copyTo(right, { planeIndex: 1, format: 'f32-planar' })
              port.postMessage({ type: 'pcm', left, right }, [left.buffer, right.buffer])
            } else {
              port.postMessage({ type: 'pcm', left }, [left.buffer])
            }
          } catch {}
          data.close()
        },
        error: () => {
          // 部分组合下 Opus 拒绝配置：停止音频，不影响画面。
          state.audio.failed = true
        }
      })
      decoder.configure({
        codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: audio.description
      })
      audio.decoder = decoder
    } catch {
      audio.failed = true
    }
  }

  function attachAudioPort(port) {
    state.audio.port = port
    port.onmessage = (event) => {
      if (event.data?.type !== 'underrun') return
      const audio = state.audio
      audio.lastUnderrun = Date.now()
      const next = Math.min(TARGET_MAX, audio.target + 40)
      if (next === audio.target) return
      audio.target = next
      port.postMessage({ type: 'target', ms: next })
    }
    port.postMessage({ type: 'target', ms: state.audio.target })
    ensureAudioDecoder()
  }

  function resetAudio() {
    try { state.audio.decoder?.close() } catch {}
    state.audio.decoder = null
    state.audio.port?.postMessage({ type: 'reset' })
  }

  function applyMeta(payload) {
    if (payload.type === 'error') {
      emit({ type: 'error', message: payload.message ?? '会话出错' })
      return
    }
    if (payload.type !== 'meta') return
    if (payload.screen) {
      const changed = payload.screen.width !== state.size.width || payload.screen.height !== state.size.height
      if (state.live.decodeAt === 0) {
        // 尚未解码出首帧时无法比较，直接采用宿主上报的尺寸。
        state.size = payload.screen
      } else if (changed) {
        // 分辨率变化意味着编码会话切换：丢弃整条流重连，
        // 由宿主重发 SPS/PPS 与关键帧，避免残留参考帧造成绿屏。
        // 尺寸在切换动画期间会连续变化，去抖后重连一次。
        clearTimeout(state.sizeTimer)
        state.sizeTimer = setTimeout(() => {
          state.sizeTimer = null
          closeDecoder()
          state.video.wantKey = true
          restart()
        }, 400)
      }
    }
    emit({ type: 'meta', payload })
  }

  async function drawImage(payload) {
    try {
      const bitmap = await createImageBitmap(new Blob([payload], { type: 'image/png' }))
      resize(bitmap.width, bitmap.height)
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
    } catch {}
  }

  function handleVideo(payload) {
    const flags = payload[0]
    const pts = Number(new DataView(payload.buffer, payload.byteOffset + 1, 8).getBigUint64(0))
    const data = payload.subarray(9)
    if (data.length === 0) return
    state.counter.received += 1
    state.live.feedAt = Date.now()
    if ((flags & 0x40) !== 0) {
      // 配置包只用于构建 avcC，本身不是图像数据。
      // 关键帧前会重复发送同一份 SPS/PPS；内容未变时保持解码器不变，
      // 以免打断参考帧链。
      const config = parseConfig(data)
      if (!config) return
      const fingerprint = fingerprintConfig(config, data)
      const changed = fingerprint !== state.video.configKey
      state.video.configKey = fingerprint
      const usable = state.video.decoder?.state === 'configured' && state.video.codec === config.codec
      if (changed || !usable) {
        closeDecoder()
        ensureDecoder(config.codec, config.description)
      }
      return
    }
    const decoder = state.video.decoder
    if (!decoder || decoder.state !== 'configured') {
      if (decoder?.state === 'closed') closeDecoder()
      return
    }
    const isKey = (flags & 0x20) !== 0
    // 队列过深说明解码跟不上：丢帧会断参考链，关解码器又要干等关键帧，
    // 因此请求新关键帧，期间只接收关键帧以清空队列。
    if (decoder.decodeQueueSize > BACKLOG_FRAMES && !state.video.key) {
      state.video.key = true
      noteStall()
      requestKeyframe(true)
    }
    // 新建或刚重同步的解码器没有参考帧，只接受关键帧。
    if (state.video.key || state.video.wantKey) {
      if (!isKey) return
      state.video.key = false
      state.video.wantKey = false
      state.live.keyRetries = 0
    }
    const avcc = toAvcc(data)
    if (!avcc) return
    try {
      decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: pts, data: avcc }))
    } catch (failure) {
      // 解码器不可用：丢弃并重连，由宿主请求新的关键帧序列。
      closeDecoder()
      const now = Date.now()
      if (now - state.live.restartAt > 1500) {
        state.live.restartAt = now
        emit({ type: 'note', message: `解码器异常，正在重建画面：${failure.message}` })
        restart()
      }
    }
  }

  function handleAudio(payload) {
    const flags = payload[0]
    const pts = Number(new DataView(payload.buffer, payload.byteOffset + 1, 8).getBigUint64(0))
    const data = payload.subarray(9)
    if (data.length === 0) return
    const audio = state.audio
    if ((flags & 0x40) !== 0) {
      // 配置包即 OpusHead；静音期间仍需保存，否则恢复时缺少解码器配置。
      const head = new TextDecoder('latin1').decode(data.subarray(0, 8))
      audio.description = head.startsWith('OpusHead') ? data : null
      if (audio.description && !audio.requested && !audio.failed && !audio.port) {
        audio.requested = true
        emit({ type: 'audio-start' })
      }
      ensureAudioDecoder()
      return
    }
    if (audio.muted) return
    if (!audio.decoder) ensureAudioDecoder()
    if (!audio.decoder) return
    try {
      audio.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: pts, data }))
    } catch {}
  }

  async function pump(controller, generation) {
    const parser = new FrameParser()
    state.counter = { received: 0, at: Date.now() }
    // 建流阶段同样需要超时：宿主无响应时 fetch 会一直挂起。
    const handshake = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(state.streamUrl, { signal: controller.signal, cache: 'no-store' })
      clearTimeout(handshake)
      if (!response.ok || !response.body) throw new Error(`流连接失败（${response.status}）`)
      if (generation !== state.generation) return
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        if (generation !== state.generation) return
        state.live.byteAt = Date.now()
        state.live.failures = 0
        for (const frame of parser.push(value)) {
          if (frame.kind === KIND.META) {
            let payload = {}
            try { payload = JSON.parse(new TextDecoder().decode(frame.payload)) } catch {}
            applyMeta(payload)
            continue
          }
          if (frame.kind === KIND.IMAGE) {
            await drawImage(frame.payload)
            continue
          }
          if (frame.kind === KIND.VIDEO) handleVideo(frame.payload)
          else if (frame.kind === KIND.AUDIO) handleAudio(frame.payload)
        }
        const now = Date.now()
        const elapsed = now - state.counter.at
        if (elapsed >= 1000) {
          const fps = Math.round((state.counter.received * 1000) / elapsed)
          emit({ type: 'stats', fps })
          state.counter = { received: 0, at: now }
        }
      }
    } catch (failure) {
      // 主动停止不计为失败；超时与断链计入失败次数，避免对失效链路无限重试。
      if (!state.stopped && generation === state.generation) {
        state.live.failures += 1
        if (failure.name !== 'AbortError') emit({ type: 'error', message: failure.message })
      }
    } finally {
      clearTimeout(handshake)
      // 连接意外中断时自动重连；连续失败达上限后停止，交由用户处理。
      if (!state.stopped && generation === state.generation && state.live.failures < 8) {
        setTimeout(() => {
          if (!state.stopped && generation === state.generation) restart()
        }, 800)
      } else if (state.live.failures >= 8) {
        emit({ type: 'error', message: '画面连续中断，请点「重建画面」或重新连接' })
      }
    }
  }

  /** 看门狗独立于读流循环：链路中断时 read() 不返回，循环内的检查不会执行。 */
  function tick() {
    if (state.stopped) return
    const live = state.live
    const now = Date.now()

    // 1) 8 秒收不到任何字节（含心跳）。
    if (live.byteAt > 0 && now - live.byteAt > 8000) {
      restartThrottled()
      return
    }
    if (live.byteAt === 0) return

    // 2) 有帧送入解码器却长时间无输出；等待关键帧期间跳过，
    //    否则会频繁重建解码器。
    const feeding = live.feedAt > live.decodeAt
    if (!state.video.key && feeding && now - live.feedAt < 4000 && now - live.decodeAt > 4000) {
      closeDecoder()
      noteStall()
      requestKeyframe(true)
      return
    }

    // 3) 关键帧超时：再请求两次，仍无关键帧则重连整条流。
    if (state.video.key && now - live.keyAt > 3000) {
      live.keyRetries += 1
      if (live.keyRetries > 2) {
        live.keyRetries = 0
        restartThrottled()
      } else {
        requestKeyframe(true)
      }
    }
  }

  // 两秒内不重复重连，避免链路抖动导致解码器反复重建。
  function restartThrottled() {
    const now = Date.now()
    if (now - state.live.restartAt < 2000) return
    state.live.restartAt = now
    restart()
  }

  function restart() {
    state.controller?.abort()
    closeDecoder()
    resetAudio()
    state.stopped = false
    state.generation += 1
    const generation = state.generation
    const controller = new AbortController()
    state.controller = controller
    // 重连不属于重同步，节流窗口与降档计数延续。
    state.live = {
      ...emptyLive(),
      restartAt: state.live.restartAt,
      stalls: state.live.stalls,
      stallWindowAt: state.live.stallWindowAt
    }
    pump(controller, generation).catch(() => {})
  }

  function open(message) {
    state.streamUrl = message.streamUrl
    state.controlUrl = message.controlUrl ?? ''
    if (!state.watchdog) state.watchdog = setInterval(tick, 1000)
    if (!state.decay) {
      // 稳定一段时间无欠载后，把目标缓冲降回最小值。
      state.decay = setInterval(() => {
        const audio = state.audio
        if (audio.target <= TARGET_MIN) return
        if (Date.now() - audio.lastUnderrun < 5000) return
        audio.target = Math.max(TARGET_MIN, audio.target - 20)
        audio.port?.postMessage({ type: 'target', ms: audio.target })
      }, 5000)
    }
    restart()
  }

  function close() {
    state.stopped = true
    state.generation += 1
    if (state.video.present) {
      clearInterval(state.video.present)
      state.video.present = null
    }
    state.controller?.abort()
    state.controller = null
    clearTimeout(state.sizeTimer)
    state.sizeTimer = null
    closeDecoder()
    resetAudio()
    state.live = emptyLive()
  }

  return {
    handle(message) {
      switch (message?.type) {
        case 'open':
          open(message)
          break
        case 'close':
          close()
          break
        case 'reset':
          if (!state.stopped) restart()
          break
        case 'mute':
          state.audio.muted = Boolean(message.muted)
          // 静音期间缓冲会积压，恢复播放前清空。
          if (!state.audio.muted) resetAudio()
          break
        case 'audio-port':
          attachAudioPort(message.port)
          break
        case 'audio-denied':
          state.audio.failed = true
          break
        default:
          break
      }
    }
  }
}

    // 控件尺寸和颜色跟随 DSH 主题变量；内联样式写不了 :hover，所以注入样式表。
    const STYLE_ID = 'dsh-phone-mirror-css'
    const CSS = `
.dpm-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 10px;
  font-family: var(--dsw-font-xxs-12-font-family, inherit);
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: var(--dsw-font-xxs-12-line-height, 18px);
  color: var(--dsw-alias-label-primary, inherit);
}
.dpm-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dpm-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  min-width: 0;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.28));
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: var(--dsw-font-xxs-12-line-height, 18px);
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}
.dpm-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
.dpm-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.18)); }
.dpm-btn:disabled { opacity: .4; cursor: not-allowed; }
.dpm-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4a6cf7); outline-offset: 1px; }
.dpm-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #4a6cf7);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dpm-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #3d5ce0); }
.dpm-btn--block { width: 100%; }
.dpm-btn--icon { width: 28px; padding: 0; flex: none; }
.dpm-field {
  box-sizing: border-box;
  height: 28px;
  min-width: 0;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.32));
  border-radius: var(--dsw-radius-sm, 8px);
  background-color: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: var(--dsw-font-xxs-12-line-height, 18px);
  outline: none;
}
.dpm-field:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3, rgba(127,127,127,0.4)); }
.dpm-field:focus { border-color: var(--dsw-alias-state-business-primary, #4a6cf7); }
.dpm-field:disabled { opacity: .5; cursor: default; }
.dpm-select {
  appearance: none;
  padding-right: 24px;
  cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2.5 4L5 6.5 7.5 4' fill='none' stroke='%238a8f98' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px 10px;
}
.dpm-caption {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.95));
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dpm-stage {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22));
  border-radius: var(--dsw-radius-md, 12px);
  background: #000;
  user-select: none;
}
.dpm-stage--fullscreen { position: fixed; inset: 0; z-index: 60; border: 0; border-radius: 0; }
.dpm-exit { position: absolute; top: 12px; right: 12px; z-index: 3; background: rgba(0,0,0,0.55); border-color: rgba(255,255,255,0.28); color: #fff; }
.dpm-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.8)); line-height: 1.7; text-align: center; }
.dpm-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0; }
.dpm-tools__group { display: flex; min-width: 0; }
/* 每个按钮左边留同样的 4px，组宽才严格正比于按钮数，九个按钮等宽。 */
.dpm-tools .dpm-btn { flex: 1 1 0; margin-left: 4px; padding: 0 4px; overflow: hidden; text-overflow: ellipsis; }
.dpm-tools__sep { flex: none; width: 1px; height: 16px; margin: 0 6px 0 2px; background: var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); }
.dpm-error { color: var(--dsw-alias-state-error-primary, #e0645c); line-height: 1.5; word-break: break-word; }
.dpm-warn { color: var(--dsw-alias-state-warn-label, #c9803a); line-height: 1.5; word-break: break-word; }
.dpm-note { color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.95)); line-height: 1.5; word-break: break-word; }
.dpm-pair { display: flex; flex-direction: column; gap: 6px; }
`

    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head?.appendChild(style)
      } catch {}
    }

    function SpeakerIcon({ muted = false }) {
      const shape = (d, key) => h('path', {
        key,
        d,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round'
      })
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' }
      }, [
        shape('M3 6.25h2.1L7.6 4.1v7.8L5.1 9.75H3z', 'body'),
        muted
          ? shape('M10.5 6.3l3.2 3.4M13.7 6.3l-3.2 3.4', 'mute')
          : shape('M9.6 5.9a3.1 3.1 0 0 1 0 4.2M11.3 4.2a5.6 5.6 0 0 1 0 7.6', 'wave')
      ])
    }

    // 工具按钮按功能分组，组间用竖线分隔。
    const TOOL_GROUPS = [
      {
        id: 'nav',
        items: [
          ['返回', { kind: 'back' }],
          ['Home', { kind: 'key', keycode: 3 }],
          ['任务', { kind: 'key', keycode: 187 }]
        ]
      },
      {
        id: 'volume',
        items: [
          ['音量-', { kind: 'key', keycode: 25 }],
          ['音量+', { kind: 'key', keycode: 24 }]
        ]
      },
      {
        id: 'system',
        items: [
          ['电源', { kind: 'power' }],
          ['旋转', { kind: 'rotate' }],
          ['通知', { kind: 'notifications' }]
        ]
      },
      { id: 'view', items: [['全屏', { kind: 'fullscreen' }]] }
    ]

    ensureStyles()

    function PhonePanel() {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [controlError, setControlError] = useState('')
      const [error, setError] = useState('')
      const [serial, setSerial] = useState('')
      const [meta, setMeta] = useState({ state: 'idle', deviceName: '', screen: null, mode: null })
      const [stats, setStats] = useState({ fps: 0 })
      const [audioOn, setAudioOn] = useState(true)
      const [quality, setQuality] = useState(1600)
      const [fullscreen, setFullscreen] = useState(false)
      // 配对面板：默认隐藏，点击「配对」展开。
      const [pairing, setPairing] = useState(false)
      const [pairAddress, setPairAddress] = useState('')
      const [pairCode, setPairCode] = useState('')
      const [pairNote, setPairNote] = useState('')
      const [pairConnect, setPairConnect] = useState('')
      const [notice, setNotice] = useState('')

      const canvasRef = useRef(null)
      const boxRef = useRef(null)
      const typingRef = useRef(null)
      // 输入法正在组字：此时不发送，等提交后统一发。
      const composingRef = useRef(false)
      const [keyboardActive, setKeyboardActive] = useState(false)
      // 输入浮层：显示正在输入的拼音。
      const [preedit, setPreedit] = useState('')
      // 引擎优先运行在 Worker，不可用时退回主线程。
      const engineRef = useRef(null)
      const openRef = useRef(false)
      // 画布代次：Worker 异常时重建 canvas 元素，才能重新交出控制权。
      const [epoch, setEpoch] = useState(0)
      const sizeRef = useRef({ width: 1080, height: 1920 })
      const pointerRef = useRef({ down: false, x: 0, y: 0, lastMove: 0 })
      // 音频出口在主线程创建（AudioContext 仅主线程可用），端口交给引擎。
      const audioRef = useRef({ context: null, node: null, failed: false, starting: false, attached: false })
      // 引擎最后一次上报的时间；超时视为失联，由主线程重建。
      const aliveRef = useRef(0)
      const attachedRef = useRef(false)
      const attachSessionRef = useRef(() => {})
      const connectRef = useRef(() => {})
      const qualityRef = useRef(1600)
      // 指针处理函数只注册一次，用 ref 读取最新的会话状态。
      const runningRef = useRef(false)

      const running = meta.state === 'running'
      runningRef.current = running

      const post = useCallback(async (path, body) => {
        const response = await fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {})
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error ?? `请求失败（${response.status}）`)
        return data
      }, [])

      const refresh = useCallback(async () => {
        try {
          const response = await fetch(`${BASE}/status`, { method: 'GET' })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error ?? '状态读取失败')
          setStatus(data)
          // 宿主已有会话时直接接上，避免重新打开面板后还要再点一次「连接」。
          if (data.session?.state === 'running') attachSessionRef.current(data.session)
          const list = (data.devices ?? []).filter((device) => device.state === 'device')
          if (list.length > 0) {
            setSerial((current) => (current && list.some((d) => d.serial === current) ? current : list[0].serial))
          }
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      // 未连接时低频轮询设备列表；连接后由流中的 meta 帧驱动。
      useEffect(() => {
        refresh()
        const timer = setInterval(() => {
          if (!running) refresh()
        }, 3000)
        return () => clearInterval(timer)
      }, [refresh, running])

      // 串行队列保证 down/up 顺序；参数走查询串，不依赖请求体，也不使用 keepalive。
      const controlQueue = useRef(Promise.resolve())
      const sendControl = useCallback((message) => {
        const params = new URLSearchParams()
        for (const [key, value] of Object.entries(message)) {
          if (value === undefined || value === null) continue
          params.set(key, String(value))
        }
        controlQueue.current = controlQueue.current
          .then(() => fetch(`${BASE}/control?${params.toString()}`, { method: 'POST', cache: 'no-store' }))
          .then(async (response) => {
            // 会话已结束（例如刚切到无线），该指令直接丢弃。
            if (response.status === 409) {
              setControlError('')
              return
            }
            if (!response.ok) throw new Error(`控制指令被拒绝（${response.status}）`)
            const data = await response.json().catch(() => ({}))
            if (data && data.ok === false) throw new Error(data.error ?? '设备未接受指令')
            setControlError('')
          })
          .catch((failure) => setControlError(failure.message))
        return controlQueue.current
      }, [])

      /** 画布内的归一化坐标，考虑 object-fit: contain 的留黑边。 */
      const toDevice = useCallback((event) => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const rect = canvas.getBoundingClientRect()
        const { width, height } = sizeRef.current
        const scale = Math.min(rect.width / width, rect.height / height)
        const displayWidth = width * scale
        const displayHeight = height * scale
        const offsetX = (rect.width - displayWidth) / 2
        const offsetY = (rect.height - displayHeight) / 2
        return {
          x: clamp01((event.clientX - rect.left - offsetX) / displayWidth),
          y: clamp01((event.clientY - rect.top - offsetY) / displayHeight)
        }
      }, [])

      const postEngine = useCallback((message, transfer) => {
        const engine = engineRef.current
        if (!engine) return
        try { engine.post(message, transfer) } catch {}
      }, [])

      /**
       * 音频出口：解码在引擎侧，这里创建 AudioContext 与 worklet 环形缓冲，
       * 再把端口交给引擎，PCM 由解码线程直接进入音频线程。
       */
      const ensureAudioSink = useCallback(async () => {
        const state = audioRef.current
        if (state.failed || state.starting || state.attached) return null
        state.starting = true
        try {
          const context = state.context ??
            new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
          state.context = context
          await context.audioWorklet.addModule(WORKLET_URL)
          const node = new AudioWorkletNode(context, 'dsh-pcm-sink', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { targetMs: AUDIO_TARGET_MS }
          })
          node.connect(context.destination)
          if (context.state === 'suspended') context.resume().catch(() => {})
          state.node = node
          state.attached = true
          return node.port
        } catch {
          state.failed = true
          return null
        } finally {
          state.starting = false
        }
      }, [])

      const handleEngineMessage = useCallback((message) => {
        if (!message) return
        aliveRef.current = Date.now()
        if (message.type === 'meta') {
          setMeta((previous) => ({ ...previous, ...(message.payload ?? {}) }))
          return
        }
        if (message.type === 'size') {
          sizeRef.current = { width: message.width, height: message.height }
          return
        }
        if (message.type === 'stats') {
          setStats({ fps: message.fps })
          return
        }
        if (message.type === 'note') {
          setControlError(message.message)
          return
        }
        if (message.type === 'error') {
          setError(message.message)
          return
        }
        if (message.type === 'stall') {
          // 15 秒内反复出现解码落后，说明当前档位超出解码能力，降一档重连。
          if (message.stalls >= 3 && qualityRef.current > 720) {
            const next = qualityRef.current >= 1600 ? 1080 : 720
            qualityRef.current = next
            setQuality(next)
            connectRef.current(next)
          }
          return
        }
        if (message.type === 'audio-start') {
          ensureAudioSink().then((port) => {
            if (port) postEngine({ type: 'audio-port', port }, [port])
            else postEngine({ type: 'audio-denied' })
          })
        }
      }, [ensureAudioSink, postEngine])

      // 消息经 Worker 转来，闭包可能过期，统一用 ref 取最新处理函数。
      const handleEngineRef = useRef(handleEngineMessage)
      handleEngineRef.current = handleEngineMessage

      /** 起一个 Worker 并等它就绪；超时或出错返回 null，交给主线程兜底。 */
      const spawnEngineWorker = useCallback(() => new Promise((resolve) => {
        if (typeof Worker === 'undefined') { resolve(null); return }
        let worker = null
        try { worker = new Worker(WORKER_URL) } catch { resolve(null); return }
        const timer = setTimeout(() => {
          worker.onmessage = null
          worker.terminate()
          resolve(null)
        }, 4000)
        worker.onmessage = (event) => {
          if (event.data?.type !== 'ready') return
          clearTimeout(timer)
          resolve(worker)
        }
        worker.onerror = () => {
          clearTimeout(timer)
          worker.terminate()
          resolve(null)
        }
      }), [])

      /** 建好引擎（只建一次），之后靠 open/close 开关收流。 */
      const openEngine = useCallback(async () => {
        if (!engineRef.current) {
          const canvas = canvasRef.current
          if (!canvas) return
          aliveRef.current = Date.now()
          // 优先使用 Worker，不可用时退回主线程。
          const worker = typeof canvas.transferControlToOffscreen === 'function'
            ? await spawnEngineWorker()
            : null
          if (!openRef.current) {
            worker?.terminate()
            return
          }
          if (worker) {
            const offscreen = canvas.transferControlToOffscreen()
            const engine = {
              mode: 'worker',
              worker,
              post: (message, transfer) => worker.postMessage(message, transfer ?? [])
            }
            worker.onmessage = (event) => handleEngineRef.current(event.data)
            worker.onerror = (event) => {
              engineRef.current = null
              try { worker.terminate() } catch {}
              setError(`画面引擎异常：${event.message ?? '未知错误'}`)
              // 画布控制权已交出，只能重建元素。
              setEpoch((value) => value + 1)
            }
            worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen])
            engineRef.current = engine
          } else {
            // 退回主线程，运行同一份引擎。
            const local = createMirrorEngine({
              canvas,
              post: (message) => handleEngineRef.current(message)
            })
            engineRef.current = { mode: 'main', local, post: (message) => local.handle(message) }
          }
        }
        postEngine({ type: 'open', streamUrl: STREAM_URL, controlUrl: CONTROL_URL })
      }, [postEngine, spawnEngineWorker])

      const closeEngine = useCallback(() => {
        try { engineRef.current?.post({ type: 'close' }) } catch {}
      }, [])

      const stopEngine = useCallback(() => {
        const engine = engineRef.current
        engineRef.current = null
        if (!engine) return
        try { engine.post({ type: 'close' }) } catch {}
        if (engine.worker) { try { engine.worker.terminate() } catch {} }
      }, [])

      // 会话运行时接入引擎；结束、卸载或重建时清理。
      useEffect(() => {
        if (!running) return undefined
        openRef.current = true
        openEngine().catch(() => {})
        return () => {
          openRef.current = false
          closeEngine()
        }
      }, [running, epoch, openEngine, closeEngine])

      // 宿主仍有会话时直接接入，无需再次点击「连接」。
      attachSessionRef.current = (info) => {
        if (attachedRef.current) return
        attachedRef.current = true
        setMeta({ ...info, state: 'running' })
      }

      // 一次性文本注入：输入法提交、粘贴等无法用键码表达的字符都走这里。
      // 按 1000 字切片发送，避免单条控制请求的 URL 过长。
      const sendText = useCallback((value) => {
        if (typeof value !== 'string' || value.length === 0) return
        for (let offset = 0; offset < value.length; offset += 1000) {
          sendControl({ kind: 'text', text: value.slice(offset, offset + 1000) })
        }
      }, [sendControl])

      const connect = useCallback(async (overrideSize) => {
        if (!serial) return
        setBusy('正在连接…')
        setError('')
        try {
          const result = await post('/connect', { serial, maxSize: overrideSize })
          setMeta({ ...result.session, state: 'running' })
          // 会话被替换后旧流中断，让引擎立即重连以缩短黑屏。
          postEngine({ type: 'reset' })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [post, postEngine, serial])

      // 降档需要回调 connect，经 ref 取最新闭包。
      connectRef.current = connect
      qualityRef.current = quality

      const disconnect = useCallback(async () => {
        setBusy('正在断开…')
        try {
          await post('/disconnect')
          setMeta({ state: 'idle', deviceName: '', screen: null, mode: null })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
          refresh()
        }
      }, [post, refresh])

      // 切到无线：tcpip 会重启 adbd，正在运行的会话必然中断，先结束会话，再在新地址上重连。
      const toWireless = useCallback(async () => {
        if (!serial || serial.includes(':') || busy) return
        const wasRunning = running
        setBusy('正在切到无线…')
        setError('')
        setNotice('')
        try {
          if (wasRunning) {
            await post('/disconnect')
            // 会话已停止，先置为未连接，避免切换期间的控制请求打到空会话。
            setMeta({ state: 'idle', deviceName: '', screen: null, mode: null })
          }
          const result = await post('/adb/tcpip', { serial })
          setSerial(result.address)
          if (wasRunning) {
            const info = await post('/connect', { serial: result.address, maxSize: quality })
            setMeta({ ...info.session, state: 'running' })
            postEngine({ type: 'reset' })
            setNotice(`已切到无线：${result.address}，可以拔掉数据线`)
          }
          await refresh()
        } catch (failure) {
          setError(failure.message)
          if (wasRunning) setMeta({ state: 'idle', deviceName: '', screen: null, mode: null })
          await refresh()
        } finally {
          setBusy('')
        }
      }, [busy, post, postEngine, quality, refresh, running, serial])

      // 提示显示两秒后清除。
      useEffect(() => {
        if (notice.length === 0) return undefined
        const timer = setTimeout(() => setNotice(''), 2000)
        return () => clearTimeout(timer)
      }, [notice])

      const exitFullscreen = useCallback(() => {
        setFullscreen(false)
        try {
          if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {})
        } catch {}
      }, [])

      const enterFullscreen = useCallback(() => {
        setFullscreen(true)
        // 桌面外壳对元素全屏的处理不一致：界面靠固定覆盖层铺满，系统级全屏作为增强。
        try { boxRef.current?.requestFullscreen?.()?.catch?.(() => {}) } catch {}
      }, [])

      // 全屏时 Esc 退出；浏览器自身退出全屏时同步界面状态。
      useEffect(() => {
        if (!fullscreen) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          exitFullscreen()
        }
        const onChange = () => {
          if (!document.fullscreenElement) setFullscreen(false)
        }
        window.addEventListener('keydown', onKey, true)
        document.addEventListener('fullscreenchange', onChange)
        return () => {
          window.removeEventListener('keydown', onKey, true)
          document.removeEventListener('fullscreenchange', onChange)
        }
      }, [fullscreen, exitFullscreen])

      const togglePairing = useCallback(() => {
        setPairing((value) => !value)
        setPairNote('')
        setPairConnect('')
        setError('')
      }, [])

      const closePairing = useCallback(() => {
        setPairing(false)
        setPairAddress('')
        setPairCode('')
        setPairNote('')
        setPairConnect('')
      }, [])

      const pairDevice = useCallback(async () => {
        const address = pairAddress.trim()
        const code = pairCode.trim()
        if (!address || code.length !== 6) return
        setBusy('正在配对…')
        setError('')
        setPairNote('')
        try {
          const result = await post('/adb/pair', { address, code })
          if (result.address) {
            setPairing(false)
            setPairAddress('')
            setPairCode('')
            setPairNote('')
            setPairConnect('')
            setSerial(result.address)
            await refresh()
            setNotice(`已配对并连上：${result.address}`)
          } else {
            // 配对端口与连接端口不同，mDNS 查不到时由用户补充连接地址。
            setPairCode('')
            setPairConnect('')
            setPairNote(result.error ?? '配对成功。把无线调试页面上的 IP:端口 填到下面，点连接。')
          }
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [pairAddress, pairCode, post, refresh])

      const connectPairAddress = useCallback(async () => {
        const address = pairConnect.trim()
        if (!address) return
        setBusy('正在连接…')
        setError('')
        try {
          await post('/adb/connect', { address })
          setPairing(false)
          setPairNote('')
          setPairConnect('')
          setSerial(address)
          await refresh()
          setNotice(`已连上：${address}`)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [pairConnect, post, refresh])

      // 只断开无线通道；USB 与经 USB 建立的投屏会话不受影响。
      const dropWireless = useCallback(async () => {
        const address = (status?.devices ?? []).find((device) => device.serial.includes(':'))?.serial ?? ''
        if (!address || busy) return
        setBusy('正在断开…')
        setError('')
        setNotice('')
        try {
          await post('/adb/disconnect', { address })
          if (meta.serial === address) setMeta({ state: 'idle', deviceName: '', screen: null, mode: null })
          setNotice('已断开无线连接')
          await refresh()
          const usb = (status?.devices ?? []).find((device) => device.state === 'device' && !device.serial.includes(':'))
          if (usb) setSerial(usb.serial)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [busy, meta.serial, post, refresh, status])

      // Worker 失联时不再有消息（宿主每 2 秒的心跳也无法转达），由主线程重建画布。
      useEffect(() => {
        if (!running) return undefined
        const timer = setInterval(() => {
          if (!engineRef.current) return
          if (Date.now() - aliveRef.current < 12000) return
          stopEngine()
          setEpoch((value) => value + 1)
        }, 4000)
        return () => clearInterval(timer)
      }, [running, stopEngine])

      // 面板卸载（切换页签）时停止引擎与音频；会话结束由侧栏关闭钩子负责。
      useEffect(() => () => {
        stopEngine()
        // AudioContext 不关闭会长期占用音频设备，多次切换页签将耗尽上限。
        const state = audioRef.current
        try { state.node?.disconnect() } catch {}
        try { state.context?.close?.()?.catch?.(() => {}) } catch {}
        attachedRef.current = false
      }, [stopEngine])

      useEffect(() => {
        // 挂在外层容器上：canvas 用 object-fit:contain 撑满，事件在容器上更稳。
        const canvas = boxRef.current
        if (!canvas) return undefined
        const onPointerDown = (event) => {
          if (!runningRef.current) return
          // 点击画面即接管键盘；点击别处会自然失焦，不影响在对话中输入。
          setTimeout(() => { try { typingRef.current?.focus({ preventScroll: true }) } catch {} }, 0)
          // 点击画面属于用户手势，可用于恢复音频上下文。
          try { audioRef.current.context?.resume?.()?.catch?.(() => {}) } catch {}
          try { canvas.setPointerCapture?.(event.pointerId) } catch {}
          const point = toDevice(event)
          if (!point) return
          pointerRef.current = { down: true, x: point.x, y: point.y, lastMove: 0 }
          sendControl({ kind: 'touch', action: 'down', ...point })
        }
        const onPointerMove = (event) => {
          if (!runningRef.current || !pointerRef.current.down) return
          const point = toDevice(event)
          if (!point) return
          const now = performance.now()
          if (now - pointerRef.current.lastMove < 12) return
          pointerRef.current.lastMove = now
          pointerRef.current.x = point.x
          pointerRef.current.y = point.y
          sendControl({ kind: 'touch', action: 'move', ...point })
        }
        const onPointerUp = (event) => {
          if (!runningRef.current || !pointerRef.current.down) return
          const point = toDevice(event) ?? { x: pointerRef.current.x, y: pointerRef.current.y }
          pointerRef.current.down = false
          sendControl({ kind: 'touch', action: 'up', ...point })
          event.preventDefault()
        }
        const onWheel = (event) => {
          if (!runningRef.current) return
          const point = toDevice(event)
          if (!point) return
          // scrcpy 的滚动量「向上为正」，浏览器 deltaY「向下为正」，这里取反。
          // 一个滚轮刻度在 Chrome 里约 100px，除以 100 才是「一格一次」；
          // deltaMode 为 1 表示按行计数（Firefox/Linux），换算成像素。
          const perUnit = event.deltaMode === 1 ? 16 : 1
          const clamp = (value) => Math.max(-3, Math.min(3, value))
          sendControl({
            kind: 'scroll',
            ...point,
            dx: clamp((-event.deltaX * perUnit) / 100),
            dy: clamp((-event.deltaY * perUnit) / 100)
          })
          event.preventDefault()
        }
        canvas.addEventListener('pointerdown', onPointerDown)
        canvas.addEventListener('pointermove', onPointerMove)
        canvas.addEventListener('pointerup', onPointerUp)
        canvas.addEventListener('pointercancel', onPointerUp)
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => {
          canvas.removeEventListener('pointerdown', onPointerDown)
          canvas.removeEventListener('pointermove', onPointerMove)
          canvas.removeEventListener('pointerup', onPointerUp)
          canvas.removeEventListener('pointercancel', onPointerUp)
          canvas.removeEventListener('wheel', onWheel)
        }
      }, [sendControl, toDevice])

      const onKeyDown = useCallback((event) => {
        if (!running || fullscreen) return

        // 修饰键组合优先处理：输入法激活时这些按键会被标成 229，
        // 若先做组字判断，Ctrl+A 之类的快捷键会被整条跳过。
        if (event.ctrlKey || event.altKey || event.metaKey) {
          const modifierState =
            (event.shiftKey ? 0x1 : 0) |
            (event.altKey ? 0x02 : 0) |
            (event.ctrlKey ? 0x1000 : 0) |
            (event.metaKey ? 0x10000 : 0)
          const combo = LETTER_OR_DIGIT[event.key.toLowerCase()]
          if (combo !== undefined) {
            sendControl({ kind: 'key', keycode: combo, metastate: modifierState })
            event.preventDefault()
            event.stopPropagation()
          }
          return
        }

        // 输入法组字期间不逐字发送，等 compositionend 统一提交。
        if (event.isComposing || event.keyCode === 229) return

        // Esc 用来交还键盘焦点，方便回到对话里打字；设备端返回请用工具栏「返回」。
        if (event.key === 'Escape') {
          event.target.blur()
          event.preventDefault()
          return
        }

        const special = {
          Enter: 66, NumpadEnter: 66, Backspace: 67, Delete: 112, Tab: 61,
          ' ': 62, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
          Home: 122, End: 123, PageUp: 92, PageDown: 93, Insert: 124
        }
        // 特殊键带的修饰状态（shift 选择、alt 等）。
        const metastate =
          (event.shiftKey ? 0x1 : 0) |
          (event.altKey ? 0x02 : 0) |
          (event.ctrlKey ? 0x1000 : 0) |
          (event.metaKey ? 0x10000 : 0)

        if (special[event.key] !== undefined) {
          sendControl({ kind: 'key', keycode: special[event.key], metastate })
          event.preventDefault()
          event.stopPropagation()
          return
        }

        // 非组字状态下的可打印字符直接注入，不依赖 input 事件。
        if (event.key.length === 1) {
          sendControl({ kind: 'text', text: event.key })
          event.preventDefault()
          event.stopPropagation()
        }
      }, [fullscreen, running, sendControl])

      useEffect(() => {
        if (!running || !keyboardActive) return undefined
        // 捕获阶段先拿到按键，避免被页面快捷键处理掉。
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [running, keyboardActive, onKeyDown])

      const devices = (status?.devices ?? []).filter((device) => device.state === 'device')
      // 无线通道可能处于 offline，断开按钮以序列号是否包含冒号判断。
      const wirelessDevices = (status?.devices ?? []).filter((device) => device.serial.includes(':'))
      const unauthorized = (status?.devices ?? []).filter((device) => device.state === 'unauthorized')
      const adbReady = Boolean(status?.adb?.ok)

      const frameCaption = useMemo(() => {
        if (!running) return '未连接'
        const size = sizeRef.current
        // 帧率由引擎统计；设备静止时不产生帧，个位数属正常。
        return `${meta.deviceName || serial} · ${size.width}×${size.height} · ${stats.fps}fps`
      }, [meta.deviceName, running, serial, stats])

      return h('div', { className: 'dpm-panel' }, [

        h('div', { key: 'bar', className: 'dpm-row' }, [
          h('select', {
            key: 'pick',
            className: 'dpm-field dpm-select',
            value: serial,
            onChange: (event) => setSerial(event.target.value),
            disabled: running,
            style: { flex: '1 1 auto' }
          }, devices.length === 0
            ? [h('option', { key: 'none', value: '' }, adbReady ? '未检测到设备' : 'adb 不可用')]
            : devices.map((device) => h('option', { key: device.serial, value: device.serial }, `${device.model || device.serial} (${device.serial})`))),
          running
            ? h('button', { key: 'dis', className: 'dpm-btn', onClick: disconnect }, '断开')
            : h('button', {
                key: 'con',
                className: 'dpm-btn dpm-btn--primary',
                onClick: () => connect(),
                disabled: !serial || Boolean(busy)
              }, busy || '连接')
        ]),
        h('div', { key: 'frame', className: 'dpm-row' }, [
          h('span', { key: 'cap', className: 'dpm-caption', title: frameCaption }, frameCaption),
          h('select', {
            key: 'quality',
            className: 'dpm-field dpm-select',
            value: String(quality),
            style: { flex: 'none' },
            onChange: (event) => {
              const value = Number(event.target.value)
              setQuality(value)
              // 切画质等于换编码分辨率，必须重连会话。
              if (running) connect(value)
            },
            title: '画面长边像素，卡就往下调'
          }, [
            h('option', { key: '720', value: '720' }, '流畅'),
            h('option', { key: '1080', value: '1080' }, '标准'),
            h('option', { key: '1600', value: '1600' }, '高清')
          ]),
          h('button', {
            key: 'audio',
            className: 'dpm-btn dpm-btn--icon',
            onClick: () => {
              setAudioOn((value) => {
                const next = !value
                const muted = !next
                const state = audioRef.current
                // 静音通过挂起音频上下文实现；恢复前清空积压样本。
                postEngine({ type: 'mute', muted })
                if (muted) state.context?.suspend?.()
                else state.context?.resume?.()
                return next
              })
            },
            title: meta.audio === false ? '该设备不支持音频转发' : (audioOn ? '关闭声音' : '打开声音'),
            disabled: meta.audio === false,
            'aria-label': audioOn ? '关闭声音' : '打开声音',
            'aria-pressed': audioOn
          }, h(SpeakerIcon, { muted: !audioOn }))
        ]),
        h('div', {
          key: 'stage',
          ref: boxRef,
          className: fullscreen ? 'dpm-stage dpm-stage--fullscreen' : 'dpm-stage'
        }, [

          h('textarea', {
            key: 'keyboard',
            ref: typingRef,
            'aria-hidden': true,
            onKeyDown,
            onInput: (event) => {
              // 按键与输入法提交都已各自处理，这里只兜底粘贴等来源。
              if (event.nativeEvent?.isComposing || composingRef.current) return
              const value = event.target.value
              if (value.length === 0) return
              event.target.value = ''
              sendText(value)
            },
            onCompositionStart: () => {
              composingRef.current = true
              setPreedit('')
            },
            onCompositionUpdate: (event) => setPreedit(event.data ?? ''),
            onCompositionEnd: (event) => {
              composingRef.current = false
              setPreedit('')
              const value = event.data ?? event.target.value ?? ''
              event.target.value = ''
              if (value.length > 0) sendText(value)
            },
            onFocus: () => setKeyboardActive(true),
            onBlur: () => {
              composingRef.current = false
              setKeyboardActive(false)
            },
            style: {
              position: 'absolute',
              left: '12%',
              bottom: '16%',
              width: '60%',
              height: 1,
              padding: 0,
              margin: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'transparent',
              // 不用 opacity:0：部分浏览器会因此跳过输入法候选窗。
              opacity: 1,
              resize: 'none',
              caretColor: 'transparent',
              cursor: 'default',
              zIndex: 2,
              display: running ? 'block' : 'none'
            }
          }),
          h('canvas', {
            key: `canvas-${epoch}`,
            ref: canvasRef,
            tabIndex: -1,
            onKeyDown,
            style: {
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              display: running ? 'block' : 'none',
              touchAction: 'none',
              outline: 'none'
            }
          }),
          running && preedit.length > 0 ? h('div', {
            key: 'ime',
            style: {
              position: 'absolute',
              left: '50%',
              bottom: '17%',
              transform: 'translateX(-50%)',
              maxWidth: 'calc(100% - 24px)',
              padding: '3px 12px',
              borderRadius: 6,
              background: 'rgba(236,238,241,0.96)',
              color: '#1b1d21',
              boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
              fontSize: 13,
              lineHeight: 1.4,
              letterSpacing: 1,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              pointerEvents: 'none',
              zIndex: 3
            }
          }, preedit) : null,
          fullscreen ? h('button', {
            key: 'exit-fullscreen',
            className: 'dpm-btn dpm-exit',
            onClick: exitFullscreen
          }, '退出全屏') : null,
          running ? null : h('div', {
            key: 'hint',
            className: 'dpm-hint'
          }, adbReady
            ? (unauthorized.length > 0
                ? '手机上弹出过「允许 USB 调试吗？」，点允许后重试'
                : devices.length > 0
                  ? '已发现设备，点右上「连接」开始投屏'
                  : '插上手机，打开开发者选项里的「USB 调试」，然后点连接')
            : (status?.adb?.preparing
                ? '首次运行，正在下载 adb（约 8 MB）…'
                : `adb 不可用：${status?.adb?.error ?? '未找到 adb'}。可在插件目录执行 npm run fetch:tools，或在配置里填 adbPath。`))
        ]),
        h('div', { key: 'recover', className: 'dpm-row' }, [
          h('button', {
            key: 'rebuild',
            className: 'dpm-btn dpm-btn--block',
            disabled: !running,
            onClick: () => {
              // 丢弃解码器并重连流，由宿主重发 SPS/PPS 与关键帧。
              postEngine({ type: 'reset' })
            }
          }, '重建画面')
        ]),
        // 按功能分组，组间用 1px 竖线分隔；每组按按钮数量分配宽度，
        // 使所有按钮在同一行里等宽对齐，窄面板时整组换行。
        h('div', { key: 'tools', className: 'dpm-tools' }, TOOL_GROUPS.flatMap((group, index) => [
          index === 0 ? null : h('span', { key: `${group.id}-sep`, className: 'dpm-tools__sep' }),
          h('div', {
            key: group.id,
            className: 'dpm-tools__group',
            style: { flexGrow: group.items.length, flexBasis: 0 }
          }, group.items.map(([label, message]) => h('button', {
            key: label,
            className: 'dpm-btn',
            title: label,
            disabled: !running,
            onClick: () => {
              if (message.kind === 'fullscreen') {
                enterFullscreen()
                return
              }
              sendControl(message)
            }
          }, label)))
        ])),
        h('div', { key: 'wire', className: 'dpm-row' }, [
          h('button', {
            key: 'tcpip',
            className: 'dpm-btn',
            style: { flex: '1 1 0' },
            disabled: !serial || serial.includes(':') || Boolean(busy),
            title: '把 USB 调试切到无线并自动连上',
            onClick: toWireless
          }, '转无线'),
          h('button', {
            key: 'pair',
            className: 'dpm-btn',
            style: { flex: '1 1 0' },
            disabled: Boolean(busy),
            'aria-expanded': pairing,
            onClick: togglePairing
          }, '配对'),
          h('button', {
            key: 'drop',
            className: 'dpm-btn',
            style: { flex: '1 1 0' },
            disabled: Boolean(busy) || wirelessDevices.length === 0,
            title: '断开电脑与平板之间的无线通道',
            onClick: dropWireless
          }, '断开连接')
        ]),
        pairing ? h('div', { key: 'pair', className: 'dpm-pair' }, [
          h('input', {
            key: 'addr',
            className: 'dpm-field',
            value: pairAddress,
            placeholder: '配对地址：192.168.1.5:37123',
            onChange: (event) => setPairAddress(event.target.value)
          }),
          h('div', { key: 'code', className: 'dpm-row' }, [
            h('input', {
              key: 'digits',
              className: 'dpm-field',
              value: pairCode,
              inputMode: 'numeric',
              maxLength: 6,
              placeholder: '6 位配对码',
              onChange: (event) => setPairCode(event.target.value.replace(/\D/g, '').slice(0, 6)),
              style: { flex: '1 1 auto' }
            }),
            h('button', {
              key: 'go',
              className: 'dpm-btn dpm-btn--primary',
              disabled: Boolean(busy) || !pairAddress.trim() || pairCode.length !== 6,
              onClick: pairDevice
            }, '配对'),
            h('button', {
              key: 'cancel',
              className: 'dpm-btn',
              disabled: Boolean(busy),
              onClick: closePairing
            }, '取消')
          ]),
          pairNote.length > 0 ? h('div', { key: 'note', className: 'dpm-note' }, pairNote) : null,
          pairNote.length > 0 ? h('div', { key: 'link', className: 'dpm-row' }, [
            h('input', {
              key: 'link-addr',
              className: 'dpm-field',
              value: pairConnect,
              placeholder: '连接地址：192.168.1.5:41234',
              onChange: (event) => setPairConnect(event.target.value),
              style: { flex: '1 1 auto' }
            }),
            h('button', {
              key: 'link-go',
              className: 'dpm-btn',
              disabled: Boolean(busy) || !pairConnect.trim(),
              onClick: connectPairAddress
            }, '连接')
          ]) : null
        ]) : null,
        running && busy.length > 0 ? h('div', { key: 'busy', className: 'dpm-note' }, busy) : null,
        notice.length > 0 ? h('div', { key: 'notice', className: 'dpm-note' }, notice) : null,
        controlError.length > 0
          ? h('div', { key: 'cerr', className: 'dpm-warn' }, `控制失败：${controlError}`)
          : null,
        error.length > 0
          ? h('div', { key: 'err', className: 'dpm-error' }, error)
          : null
      ])
    }

    function apply(ctx) {
      // 页签被显式关闭时结束设备会话；切换页签不触发。
      ctx.inject(['sidebarRight'], (owner) => {
        const right = owner.get('sidebarRight')
        owner.effect(() => right.registerCloseHandler(TAB_KIND, async () => {
          try {
            await fetch(`${BASE}/disconnect`, { method: 'POST', keepalive: true })
          } catch {}
        }), 'phone-mirror: close handler')
      })

      ctx.inject(['sidebarRightTabs'], (owner) => {
        const tabs = owner.get('sidebarRightTabs')
        const title = () => '手机'
        owner.effect(() => tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title,
          guide: [{ id: TAB_ID, order: 120, title }]
        }), 'phone-mirror: sidebar tab type')

        const register = owner.slots.register.bind(owner.slots)
        owner.slots.inject('sidebar.right.pane.tab', () => register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          inject: () => ({})
        }, PhonePanel))
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight']
    return module.exports
  }
})
