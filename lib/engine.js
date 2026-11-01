// 镜像引擎：拉宿主推来的二进制帧，解视频画到画布、解音频送进 worklet。
// 只依赖传入的画布和消息通道，可运行在 Worker 或主线程。
//
// 与宿主之间的消息：
//   收 init(canvas) / open(streamUrl, controlUrl) / close / reset / mute(muted)
//      audio-port(port) / audio-denied
//   发 meta(payload) / size / stats(fps) / note / error / stall / audio-start
/* global self, createImageBitmap, VideoDecoder, AudioDecoder, EncodedVideoChunk, EncodedAudioChunk */
function createMirrorEngine({ canvas, post }) {
  const KIND = { VIDEO: 1, AUDIO: 2, META: 3, IMAGE: 4 }
  // 分别记录字节、送入、解码三种时刻。
  const emptyLive = () => ({
    byteAt: 0, feedAt: 0, decodeAt: 0, keyAt: 0, keyRetries: 0,
    restartAt: 0, stalls: 0, stallWindowAt: 0, failures: 0
  })
  // 音频目标缓冲（毫秒），欠载时加厚，稳定后回降。
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
          // 长度异常时丢弃缓冲。
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

  /** 配置包指纹：长度 + 内容摘要。 */
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

  /** 请求服务端重建编码会话，限频 2.5 秒。 */
  function requestKeyframe(force = false) {
    const now = Date.now()
    if (!force && now - state.live.keyAt < 2500) return
    state.live.keyAt = now
    if (!state.controlUrl) return
    // 控制指令走查询串。
    fetch(`${state.controlUrl}?kind=reset`, { method: 'POST', cache: 'no-store' }).catch(() => {})
  }

  /** 记录一次重同步。 */
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

  /** 解码输出先入队，由固定节拍逐帧绘制。 */
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
        // 只保留最近几帧。
        while (pending.length > 4) {
          try { pending.shift().close() } catch {}
        }
        startPresenter()
      },
      error: (failure) => {
        // 解码器报错后丢弃并重连。
        if (state.video.decoder === decoder) closeDecoder()
        emit({ type: 'note', message: `解码器重建中：${failure.message}` })
        const now = Date.now()
        if (now - state.live.restartAt > 1500) {
          state.live.restartAt = now
          restart()
        }
      }
    })
    // 有 avcC 时按 AVCC 解码，否则按 Annex-B。
    const base = description
      ? { codec, description, optimizeForLatency: true }
      : { codec, optimizeForLatency: true, avc: { format: 'annexb' } }
    try {
      decoder.configure(base)
    } catch {
      try {
        // 失败时使用浏览器默认配置。
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
          // Opus 配置失败时停止音频。
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
        // 首帧前采用宿主上报的尺寸。
        state.size = payload.screen
      } else if (changed) {
        // 分辨率变化时去抖后重连整条流。
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
      // 配置包用于构建 avcC；内容未变时保持解码器不变。
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
    // 队列过深时请求新关键帧，期间只接收关键帧。
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
      // 解码器不可用时丢弃并重连。
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
      // 保存 OpusHead 配置包。
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
    // 建流阶段设置超时。
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
      // 主动停止不计入失败次数。
      if (!state.stopped && generation === state.generation) {
        state.live.failures += 1
        if (failure.name !== 'AbortError') emit({ type: 'error', message: failure.message })
      }
    } finally {
      clearTimeout(handshake)
      // 连接中断时自动重连，连续失败达上限后停止。
      if (!state.stopped && generation === state.generation && state.live.failures < 8) {
        setTimeout(() => {
          if (!state.stopped && generation === state.generation) restart()
        }, 800)
      } else if (state.live.failures >= 8) {
        emit({ type: 'error', message: '画面连续中断，请点「重建画面」或重新连接' })
      }
    }
  }

  /** 看门狗：独立于读流循环检查链路状态。 */
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

    // 2) 有帧送入解码器却长时间无输出。
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

  // 两秒内不重复重连。
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
    // 重连不重置节流窗口与降档计数。
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
          // 恢复播放前清空积压样本。
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
