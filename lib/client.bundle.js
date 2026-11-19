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
    // 上一次选择的平台与各平台上次选中的设备序列号（只记住选择，默认不自动连接）。
    let preferredPlatform = 'android'
    let platformTouched = false
    const preferredSerialByPlatform = { android: '', ios: '' }

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
  // OffscreenCanvas 刚转移过来、还没画过任何东西时，合成层可能先显示一块
  // 未初始化的绿色；先铺黑，保证首帧到达前是黑屏。
  try {
    context.fillStyle = '#000'
    context.fillRect(0, 0, canvas.width, canvas.height)
  } catch {}

  const state = {
    streamUrl: '',
    controlUrl: '',
    generation: 0,
    controller: null,
    stopped: true,
    pageVisible: true,
    resumeUntil: 0,
    sizeTimer: null,
    size: { width: 0, height: 0 },
    // 设备上报的顺时针旋转角（0/90/180/270），由宿主 meta 下发。
    rotation: 0,
    platform: null,
    screen: null,
    geometry: null,
    video: {
      decoder: null, codec: '', configKey: '', key: true,
      lengthPrefixed: false, externalCodec: '', externalDescription: null,
      // 黑边裁剪：crop 为 null 表示满屏，cropDirty 置位时下一帧重新探测。
      crop: null, cropDirty: true,
      pending: [], present: null
    },
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
    const separator = state.controlUrl.includes('?') ? '&' : '?'
    fetch(`${state.controlUrl}${separator}kind=reset`, { method: 'POST', cache: 'no-store' }).catch(() => {})
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

  function clearCanvas() {
    try {
      context.fillStyle = '#000'
      context.fillRect(0, 0, canvas.width, canvas.height)
    } catch {}
  }

  // 非 iOS 路径的编码器或截图可能带黑边，探测后只画有效区域。
  let probe = null

  function probeContext() {
    if (probe) return probe
    try {
      probe = new OffscreenCanvas(32, 72).getContext('2d', { willReadFrequently: true })
    } catch {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 72
        probe = canvas.getContext('2d', { willReadFrequently: true })
      } catch { probe = null }
    }
    return probe
  }

  /** 采样一帧，找出非黑内容的外接矩形；没有明显黑边时返回 null。 */
  function detectCrop(frame) {
    const ctx2 = probeContext()
    if (!ctx2) return null
    const SW = 32
    const SH = 72
    try {
      ctx2.clearRect(0, 0, SW, SH)
      ctx2.drawImage(frame, 0, 0, SW, SH)
      const { data } = ctx2.getImageData(0, 0, SW, SH)
      const black = (i) => data[i] < 20 && data[i + 1] < 20 && data[i + 2] < 20
      let minX = SW
      let minY = SH
      let maxX = -1
      let maxY = -1
      for (let y = 0; y < SH; y += 1) {
        for (let x = 0; x < SW; x += 1) {
          if (black((y * SW + x) * 4)) continue
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
      if (maxX < 0) return null
      const fw = frame.displayWidth
      const fh = frame.displayHeight
      const x = Math.floor((minX / SW) * fw)
      const y = Math.floor((minY / SH) * fh)
      const w = Math.ceil(((maxX + 1) / SW) * fw) - x
      const h = Math.ceil(((maxY + 1) / SH) * fh) - y
      // 只裁掉真正的黑边：宽或高至少要缩掉一成，否则当作满屏。
      if (w > fw * 0.92 && h > fh * 0.92) return null
      if (w < fw * 0.2 || h < fh * 0.2) return null
      return { x, y, w, h }
    } catch {
      return null
    }
  }

  // 先合成到中间画布，避免直接把 HEVC 解码纹理交给面板。
  let iosScratch = null
  let iosScratchCtx = null
  function iosScratchFor(width, height) {
    if (!iosScratch) {
      iosScratch = new OffscreenCanvas(width, height)
      iosScratchCtx = iosScratch.getContext('2d', { alpha: false })
    } else if (iosScratch.width !== width || iosScratch.height !== height) {
      iosScratch.width = width
      iosScratch.height = height
    }
    return iosScratchCtx
  }

  let iosRaf = null
  function startPresenter() {
    if (state.platform === 'ios' && typeof requestAnimationFrame === 'function') {
      if (iosRaf === null) {
        iosRaf = requestAnimationFrame(() => {
          iosRaf = null
          presentFrame()
        })
      }
    } else if (!state.video.present) {
      state.video.present = setInterval(presentFrame, 16)
    }
  }

  function presentFrame() {
    const frame = state.video.pending.shift()
    if (!frame) return
    try {
      if (state.platform === 'ios') {
        const fw = frame.displayWidth
        const fh = frame.displayHeight
        const screen = state.screen
        const nativeLandscape = screen ? screen.width > screen.height : fw > fh
        const rotation = (fw > fh) === nativeLandscape ? state.rotation : 0
        const sideways = rotation % 180 !== 0
        const sourceLandscape = fw > fh
        const baseW = screen ? (sourceLandscape === nativeLandscape ? screen.width : screen.height) : fw
        const baseH = screen ? (sourceLandscape === nativeLandscape ? screen.height : screen.width) : fh
        const next = { width: sideways ? baseH : baseW, height: sideways ? baseW : baseH, rotation }
        const prev = state.geometry
        if (!prev || prev.width !== next.width || prev.height !== next.height || prev.rotation !== rotation) {
          state.geometry = next
          resize(next.width, next.height)
          emit({ type: 'geometry', ...next })
        }
        // 尺寸跟随输出而非解码缓冲，避免编码尺寸波动时重分配画布。
        iosScratchFor(baseW, baseH).drawImage(frame, 0, 0, baseW, baseH)
        context.save()
        try {
          context.translate(next.width / 2, next.height / 2)
          context.rotate(rotation * Math.PI / 180)
          context.drawImage(iosScratch, -baseW / 2, -baseH / 2)
        } finally { context.restore() }
      } else {
        if (state.video.cropDirty) {
          state.video.crop = detectCrop(frame)
          state.video.cropDirty = false
        }
        const crop = state.video.crop
        resize(crop ? crop.w : frame.displayWidth, crop ? crop.h : frame.displayHeight)
        if (crop) {
          context.drawImage(frame, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
        } else {
          context.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight)
        }
      }
    } catch {}
    try { frame.close() } catch {}
  }

  function closeDecoder() {
    if (iosRaf !== null) {
      cancelAnimationFrame(iosRaf)
      iosRaf = null
    }
    try { state.video.decoder?.close() } catch {}
    state.video.decoder = null
    state.video.codec = ''
    state.video.key = true
    state.video.cropDirty = true
    dropPending()
  }

  function ensureDecoder(codec, description) {
    closeDecoder()
    const decoder = new VideoDecoder({
      output: (frame) => {
        state.live.decodeAt = Date.now()
        const pending = state.video.pending
        // iOS 只跳过已经解码的旧帧；编码帧仍按顺序送入解码器。
        if (state.platform === 'ios') dropPending()
        pending.push(frame)
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
    if (payload.platform) state.platform = payload.platform
    if (Number.isFinite(payload.rotation)) state.rotation = ((payload.rotation % 360) + 360) % 360
    if (payload.screen?.width > 0 && payload.screen?.height > 0) state.screen = payload.screen
    if (payload.videoCodec && payload.videoDescription) {
      try {
        const binary = self.atob(payload.videoDescription)
        const desc = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) desc[i] = binary.charCodeAt(i)
        state.video.lengthPrefixed = true
        state.video.externalCodec = payload.videoCodec
        state.video.externalDescription = desc
        const fingerprint = `${payload.videoCodec}:${payload.videoDescription}`
        const usable = state.video.decoder?.state === 'configured' && state.video.codec === payload.videoCodec
        if (fingerprint !== state.video.configKey || !usable) {
          state.video.configKey = fingerprint
          ensureDecoder(payload.videoCodec, desc)
        }
      } catch {}
    } else if (payload.platform === 'android') {
      state.video.lengthPrefixed = false
      state.video.externalCodec = ''
      state.video.externalDescription = null
    }
    if (payload.screen) {
      // 尺寸只认解码帧，避免与宿主上报值互相拉扯导致清屏。
      if (state.live.decodeAt === 0) {
        state.size = { width: payload.screen.width, height: payload.screen.height }
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
      state.video.lengthPrefixed = false
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
    const isKey = (flags & 0x20) !== 0
    const isReset = (flags & 0x10) !== 0
    if (isKey) state.video.cropDirty = true
    if (isReset && isKey && state.video.externalCodec && state.video.externalDescription) {
      ensureDecoder(state.video.externalCodec, state.video.externalDescription)
    } else if ((!state.video.decoder || state.video.decoder.state !== 'configured') && state.video.externalCodec && state.video.externalDescription) {
      ensureDecoder(state.video.externalCodec, state.video.externalDescription)
    }
    const decoder = state.video.decoder
    if (!decoder || decoder.state !== 'configured') {
      if (decoder?.state === 'closed') closeDecoder()
      return
    }
    // 队列过深时请求新关键帧，期间只接收关键帧。
    if (decoder.decodeQueueSize > BACKLOG_FRAMES && !state.video.key) {
      state.video.key = true
      noteStall()
      requestKeyframe(true)
    }
    // 新建或刚重同步的解码器没有参考帧，只接受关键帧。
    if (state.video.key) {
      if (!isKey) return
      state.video.key = false
      state.live.keyRetries = 0
    }
    const chunkData = state.video.lengthPrefixed ? data : toAvcc(data)
    if (!chunkData) return
    try {
      decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: pts, data: chunkData }))
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
    if ((flags & 0x01) !== 0) {
      // iOS 48kHz 立体声 s16le 交错 PCM 直通 AudioWorklet。
      if (!audio.requested && !audio.failed && !audio.port) {
        audio.requested = true
        emit({ type: 'audio-start' })
      }
      if (audio.muted || !audio.port) return
      const frames = Math.floor(data.byteLength / 4)
      if (frames <= 0) return
      const view = new DataView(data.buffer, data.byteOffset, frames * 4)
      const left = new Float32Array(frames)
      const right = new Float32Array(frames)
      for (let i = 0; i < frames; i += 1) {
        left[i] = view.getInt16(i * 4, true) / 32768
        right[i] = view.getInt16(i * 4 + 2, true) / 32768
      }
      try {
        audio.port.postMessage({ type: 'pcm', left, right }, [left.buffer, right.buffer])
      } catch {}
      return
    }
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
    if (state.stopped || !state.pageVisible || Date.now() < state.resumeUntil) return
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
    clearCanvas()
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
    clearInterval(state.watchdog)
    state.watchdog = null
    clearInterval(state.decay)
    state.decay = null
    clearTimeout(state.sizeTimer)
    state.sizeTimer = null
    closeDecoder()
    resetAudio()
    state.live = emptyLive()
    state.platform = null
    state.rotation = 0
    state.screen = null
    state.geometry = null
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
        case 'page': {
          const visible = message.visible !== false
          if (!visible) {
            // 遮挡期间多囤一点音频，切回来时用缓冲盖住设备/音频线程恢复的空档。
            state.audio.target = TARGET_MAX
            state.audio.port?.postMessage({ type: 'target', ms: TARGET_MAX })
          }
          if (visible && !state.pageVisible) {
            // 回到前台时解码器可能刚恢复输出，别把这段空档当成链路停滞。
            state.live.byteAt = state.live.feedAt = state.live.decodeAt = Date.now()
            state.resumeUntil = Date.now() + 2000
            // 丢掉遮挡期间积压的旧帧，直接把最新一帧画上去。
            const pending = state.video.pending
            while (pending.length > 1) {
              try { pending.shift().close() } catch {}
            }
            presentFrame()
          }
          state.pageVisible = visible
          break
        }
        default:
          break
      }
    }
  }
}

    // 控件样式表：尺寸与颜色取自 DSH 主题变量。
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
/* 每个按钮左侧留 4px，使组宽正比于按钮数。 */
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

    // iOS 的工具栏：动作名称与安卓完全分开，不借用安卓键码。
    // iOS 没有全局返回键。
    const IOS_TOOL_GROUPS = [
      {
        id: 'nav',
        items: [
          ['Home', { kind: 'home' }],
          ['任务', { kind: 'app-switcher' }]
        ]
      },
      {
        id: 'volume',
        items: [
          ['音量-', { kind: 'volume-down' }],
          ['音量+', { kind: 'volume-up' }]
        ]
      },
      {
        id: 'system',
        items: [
          ['电源', { kind: 'power' }],
          ['旋转', { kind: 'rotate' }],
          ['通知', { kind: 'notifications' }],
          ['控制', { kind: 'control-center' }]
        ]
      },
      { id: 'view', items: [['全屏', { kind: 'fullscreen' }]] }
    ]

    const toolGroupsFor = (platform) => (platform === 'ios' ? IOS_TOOL_GROUPS : TOOL_GROUPS)

    ensureStyles()

    function PhonePanel({ useTabInfo }) {
      const { tab } = useTabInfo()
      const { id: tabId, visible } = tab
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [controlError, setControlError] = useState('')
      const [error, setError] = useState('')
      const [platform, setPlatform] = useState(preferredPlatform)
      const [serial, setSerial] = useState(preferredSerialByPlatform[preferredPlatform] ?? '')
      const [meta, setMeta] = useState({ state: 'idle', platform: null, deviceName: '', screen: null, mode: null })
      const [stats, setStats] = useState({ fps: 0 })
      const [audioOn, setAudioOn] = useState(true)
      const [quality, setQuality] = useState(1600)
      const [fullscreen, setFullscreen] = useState(false)
      // 宿主是否正在自动重开无线会话。
      const [autoConnecting, setAutoConnecting] = useState(false)
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
      // 输入法组字中。
      const composingRef = useRef(false)
      // iOS：等待确认是否为组字首字符的待发送文本，{ text, timer }。
      const [keyboardActive, setKeyboardActive] = useState(false)
      // 输入浮层：显示正在输入的拼音。
      const [preedit, setPreedit] = useState('')
      // 引擎优先运行在 Worker，不可用时退回主线程。
      const engineRef = useRef(null)
      // 画布代次：Worker 异常时重建 canvas 元素。
      const [epoch, setEpoch] = useState(0)
      const sizeRef = useRef({ width: 1080, height: 1920 })
      const geometryRef = useRef(null)
      const iosToolPending = useRef(false)
      const [iosToolBusy, setIosToolBusy] = useState(false)
      const pointerRef = useRef({ down: false, x: 0, y: 0, lastMove: 0 })
      // 音频出口状态；AudioContext 在主线程创建。
      const audioRef = useRef({ context: null, node: null, failed: false, starting: false, attached: false })
      // 引擎最后一次上报的时间。
      const aliveRef = useRef(0)
      const attachedRef = useRef(false)
      const attachSessionRef = useRef(() => {})
      const connectRef = useRef(() => {})
      const qualityRef = useRef(1600)
      const platformRef = useRef(platform)
      platformRef.current = platform
      // 指针处理函数只注册一次，用 ref 读取最新的会话状态。
      const runningRef = useRef(false)

      const running = meta.state === 'running'
      runningRef.current = running && visible

      const pickSerialForPlatform = useCallback((allDevices, targetPlatform, currentSerial) => {
        const list = (allDevices ?? []).filter(
          (device) => (device.platform ?? 'android') === targetPlatform && device.state === 'device'
        )
        if (list.length === 0) return ''
        if (currentSerial && list.some((item) => item.serial === currentSerial)) return currentSerial
        const saved = preferredSerialByPlatform[targetPlatform]
        if (saved && list.some((item) => item.serial === saved)) return saved
        return list[0].serial
      }, [])

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
          setAutoConnecting(Boolean(data.autoConnecting))
          // 宿主已有会话时直接接入。
          if (data.session?.state === 'running') {
            if (data.session.platform === 'android' || data.session.platform === 'ios') {
              preferredPlatform = data.session.platform
              platformRef.current = data.session.platform
              setPlatform(data.session.platform)
            }
            attachSessionRef.current(data.session)
          }
          const allDevices = data.devices ?? []
          let activePlatform = platformRef.current
          if (!platformTouched && data.session?.state !== 'running') {
            const currentReady = allDevices.some(
              (device) => (device.platform ?? 'android') === activePlatform && device.state === 'device'
            )
            if (!currentReady) {
              const other = activePlatform === 'android' ? 'ios' : 'android'
              const otherReady = allDevices.some(
                (device) => (device.platform ?? 'android') === other && device.state === 'device'
              )
              if (otherReady) {
                activePlatform = other
                preferredPlatform = other
                platformRef.current = other
                setPlatform(other)
              }
            }
          }
          setSerial((current) => pickSerialForPlatform(allDevices, activePlatform, current))
        } catch (failure) {
          setError(failure.message)
        }
      }, [pickSerialForPlatform, tabId])

      // 隐藏期间由宿主维持会话，重新可见时再同步状态。
      useEffect(() => {
        if (!visible) return undefined
        refresh()
        const timer = setInterval(() => {
          if (!running) refresh()
        }, 3000)
        return () => clearInterval(timer)
      }, [refresh, running, visible])

      // 控制指令串行发送，参数走查询串。
      const controlQueue = useRef(Promise.resolve())
      const sendControl = useCallback((message) => {
        const params = new URLSearchParams({ tabId })
        for (const [key, value] of Object.entries(message)) {
          if (value === undefined || value === null) continue
          params.set(key, String(value))
        }
        const expires = message.kind === 'scroll' && platformRef.current === 'ios' ? performance.now() + 80 : Infinity
        controlQueue.current = controlQueue.current
          .then(() => performance.now() > expires ? null : fetch(`${BASE}/control?${params.toString()}`, { method: 'POST', cache: 'no-store' }))
          .then(async (response) => {
            if (!response) return
            // 会话已结束时丢弃该指令。
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
      }, [tabId])

      /** 画布内的归一化坐标，考虑 object-fit: contain 的留黑边。 */
      const toDevice = useCallback((event, allowOutside = false) => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const rect = canvas.getBoundingClientRect()
        const { width, height } = sizeRef.current
        const scale = Math.min(rect.width / width, rect.height / height)
        const displayWidth = width * scale
        const displayHeight = height * scale
        const offsetX = (rect.width - displayWidth) / 2
        const offsetY = (rect.height - displayHeight) / 2
        if (!(displayWidth > 0 && displayHeight > 0)) return null
        const rawX = (event.clientX - rect.left - offsetX) / displayWidth
        const rawY = (event.clientY - rect.top - offsetY) / displayHeight
        const ios = platformRef.current === 'ios'
        if (ios && !allowOutside && (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1)) return null
        const x = clamp01(rawX)
        const y = clamp01(rawY)
        switch (ios ? geometryRef.current?.rotation : 0) {
          case 90: return { x: y, y: 1 - x }
          case 180: return { x: 1 - x, y: 1 - y }
          case 270: return { x: 1 - y, y: x }
          default: return { x, y }
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
          const payload = message.payload ?? {}
          // 会话结束后允许再次接入。
          if (payload.state === 'error' || payload.state === 'idle') {
            attachedRef.current = false
            pointerRef.current.down = false
            geometryRef.current = null
            typingRef.current?.blur()
            // 断开原因只短暂提示：面板本身已显示未连接，不必常驻一条错误。
            if (payload.error) {
              setError('')
              setNotice(payload.error)
            }
          }
          setMeta((previous) => ({ ...previous, ...payload }))
          return
        }
        if (message.type === 'geometry') {
          geometryRef.current = message
          sizeRef.current = { width: message.width, height: message.height }
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
          // 解码持续落后时降一档重连。
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

      // 统一用 ref 取最新的处理函数。
      const handleEngineRef = useRef(handleEngineMessage)
      handleEngineRef.current = handleEngineMessage

      /** 启动引擎 Worker，就绪返回实例，超时或出错返回 null。 */
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

      /** 创建引擎（只建一次）。 */
      const openEngine = useCallback(async (signal) => {
        if (!engineRef.current) {
          const canvas = canvasRef.current
          if (!canvas) return
          aliveRef.current = Date.now()
          // 优先使用 Worker，不可用时退回主线程。
          const worker = typeof canvas.transferControlToOffscreen === 'function'
            ? await spawnEngineWorker()
            : null
          if (signal.aborted) {
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
              // 画布控制权已交出，重建元素。
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
        aliveRef.current = Date.now()
        postEngine({ type: 'open', streamUrl: `${STREAM_URL}?tabId=${encodeURIComponent(tabId)}`, controlUrl: `${CONTROL_URL}?tabId=${encodeURIComponent(tabId)}` })
        postEngine({ type: 'page', visible: document.visibilityState !== 'hidden' })
      }, [postEngine, spawnEngineWorker, tabId])

      const closeEngine = useCallback(() => {
        try { engineRef.current?.post({ type: 'close' }) } catch {}
      }, [])

      const stopEngine = useCallback(() => {
        const engine = engineRef.current
        engineRef.current = null
        // Worker 销毁后原来的 MessagePort 已失效，下次需新建 AudioWorkletNode。
        const audio = audioRef.current
        if (audio.node) {
          try { audio.node.disconnect() } catch {}
          audio.node = null
        }
        audio.attached = false
        if (!engine) return
        try { engine.post({ type: 'close' }) } catch {}
        if (engine.worker) { try { engine.worker.terminate() } catch {} }
      }, [])

      // 只按 DSH 页签可见性订阅画面，系统窗口失焦或被遮挡不影响传输。
      useEffect(() => {
        if (!running || !visible) return undefined
        const controller = new AbortController()
        openEngine(controller.signal).catch(() => {})
        return () => {
          controller.abort()
          closeEngine()
        }
      }, [running, visible, epoch, openEngine, closeEngine])

      // Worker 里没有 document，由主线程同步窗口可见性。
      useEffect(() => {
        const sync = () => {
          const visible = document.visibilityState !== 'hidden'
          postEngine({ type: 'page', visible })
          if (visible) audioRef.current.context?.resume?.().catch(() => {})
        }
        document.addEventListener('visibilitychange', sync)
        return () => document.removeEventListener('visibilitychange', sync)
      }, [postEngine])

      // 宿主仍有会话时直接接入。
      attachSessionRef.current = (info) => {
        if (attachedRef.current) return
        attachedRef.current = true
        // 接入时清除上一次的错误提示。
        setError('')
        setMeta({ ...info, state: 'running' })
      }

      // 一次性文本注入，按 1000 字切片发送。
      const sendText = useCallback((value) => {
        if (typeof value !== 'string' || value.length === 0) return
        for (let offset = 0; offset < value.length; offset += 1000) {
          sendControl({ kind: 'text', text: value.slice(offset, offset + 1000) })
        }
      }, [sendControl])

      const connect = useCallback(async (overrideSize) => {
        if (!serial) return
        // 趁用户点击手势同步创建并唤醒 AudioContext，避免异步建流后被自动播放策略挂起。
        try {
          const audio = audioRef.current
          if (!audio.context && typeof AudioContext !== 'undefined') {
            audio.context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
          }
          if (audio.context?.state === 'suspended' && audioOn) {
            audio.context.resume().catch(() => {})
          }
        } catch {}
        setBusy('正在连接…')
        setError('')
        try {
          const result = await post('/connect', { platform, serial, maxSize: overrideSize, tabId })
          if (tab.signal.aborted || !result.session) return
          preferredPlatform = platform
          preferredSerialByPlatform[platform] = serial
          setMeta({ ...result.session, state: 'running' })
          // 会话被替换后让引擎重连。
          postEngine({ type: 'reset' })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [audioOn, platform, post, postEngine, serial, tab.signal, tabId])

      // 经 ref 取最新的 connect 闭包。
      connectRef.current = connect
      qualityRef.current = quality

      const disconnect = useCallback(async () => {
        setBusy('正在断开…')
        try {
          await post('/disconnect')
          setMeta({ state: 'idle', platform: null, deviceName: '', screen: null, mode: null })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
          refresh()
        }
      }, [post, refresh, tabId])

      // 切到无线：先结束会话，再在新地址上重连。
      const toWireless = useCallback(async () => {
        if (!serial || serial.includes(':') || busy) return
        const wasRunning = running
        let usbSessionReplaced = false
        setBusy('正在切到无线…')
        setError('')
        setNotice('')
        try {
          if (wasRunning && platform !== 'ios') {
            await post('/disconnect')
            setMeta({ state: 'idle', platform: null, deviceName: '', screen: null, mode: null })
          }
          const result = await post('/adb/tcpip', { platform, serial })
          preferredSerialByPlatform[platform] = result.address
          setSerial(result.address)
          if (wasRunning || platform === 'ios') {
            usbSessionReplaced = wasRunning
            if (tab.signal.aborted) return
            const info = await post('/connect', { platform, serial: result.address, maxSize: quality, tabId })
            if (tab.signal.aborted || !info.session) return
            setMeta({ ...info.session, state: 'running' })
            postEngine({ type: 'reset' })
            setNotice(`已切到无线：${result.address}，可以拔掉数据线`)
          } else {
            setNotice('已配置无线连接，可以拔掉数据线后点「连接」')
          }
          await refresh()
        } catch (failure) {
          setError(failure.message)
          if (wasRunning && (platform !== 'ios' || usbSessionReplaced)) {
            setMeta({ state: 'idle', platform: null, deviceName: '', screen: null, mode: null })
          }
          if (platform === 'ios') {
            preferredSerialByPlatform.ios = serial
            setSerial(serial)
          }
          await refresh()
        } finally {
          setBusy('')
        }
      }, [busy, platform, post, postEngine, quality, refresh, running, serial, tab.signal, tabId])

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
        // 界面用固定覆盖层铺满，系统级全屏作为增强。
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
            preferredSerialByPlatform.android = result.address
            setSerial(result.address)
            await refresh()
            setNotice(`已配对并连上：${result.address}`)
          } else {
            // mDNS 查不到连接端口时由用户补充地址。
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
          preferredSerialByPlatform.android = address
          setSerial(address)
          await refresh()
          setNotice(`已连上：${address}`)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [pairConnect, post, refresh])

      const recoveryTarget = status?.recoveryTarget
      const recoveringWireless = !running && recoveryTarget?.platform === platform ? recoveryTarget.serial : ''
      const androidWireless = platform === 'android' ? (status?.devices ?? []).filter(
        (device) => (device.platform ?? 'android') === 'android' && device.serial.includes(':')
      ) : []
      const wirelessAddress = (running && meta.platform === platform && meta.serial?.includes(':') ? meta.serial : '')
        || recoveringWireless
        || (platform === 'ios'
          ? (serial.startsWith('wifi:') ? serial : '')
          : (androidWireless.some((device) => device.serial === serial) ? serial : androidWireless[0]?.serial))

      // 断开当前无线投屏或取消它的自动重连，不移除 iOS 配对。
      const dropWireless = async () => {
        if (!wirelessAddress || busy) return
        setBusy('正在断开…')
        setError('')
        setNotice('')
        try {
          await post('/adb/disconnect', { platform, address: wirelessAddress })
          if (meta.serial === wirelessAddress || recoveringWireless) {
            attachedRef.current = false
            setMeta({ state: 'idle', platform: null, deviceName: '', screen: null, mode: null })
            setAutoConnecting(false)
          }
          setNotice('已断开无线连接')
          await refresh()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }

      // 隐藏时引擎不收流，不能把它当成失联。
      useEffect(() => {
        if (!running || !visible) return undefined
        const timer = setInterval(() => {
          if (!engineRef.current) return
          if (Date.now() - aliveRef.current < 12000) return
          stopEngine()
          setEpoch((value) => value + 1)
        }, 4000)
        return () => clearInterval(timer)
      }, [running, stopEngine, visible])

      // 面板卸载时停止引擎与音频。
      useEffect(() => () => {
        stopEngine()
        // 关闭 AudioContext 与音频节点。
        const state = audioRef.current
        try { state.node?.disconnect() } catch {}
        try { state.context?.close?.()?.catch?.(() => {}) } catch {}
        attachedRef.current = false
      }, [stopEngine])

      useEffect(() => {
        // 指针事件挂在外层容器上。
        const canvas = boxRef.current
        if (!canvas) return undefined
        const onPointerDown = (event) => {
          if (!runningRef.current) return
          // 界面按钮上的按下不作为触摸事件处理。
          if (event.target?.closest?.('.dpm-btn')) return
          if (platformRef.current === 'ios' && event.button !== 0) return
          const point = toDevice(event)
          if (!point) return
          // 上一次按下如果在面板外松开（up 事件没送到画面），这里先补一个抬起，
          // 否则指针状态会一直是「按着」，之后整个画面都点不动。
          if (pointerRef.current.down) {
            sendControl({ kind: 'touch', action: 'up', x: pointerRef.current.x, y: pointerRef.current.y })
            pointerRef.current.down = false
          }
          // 点画面 = 把键盘交给隐藏输入框：电脑输入法要在一个有焦点的输入框里才组字，
          // 中文提交后由桥接「写手机剪贴板 + ⌘V」粘贴进手机；英文数字在输入法空闲时逐键直发。
          // preventDefault 会取消默认焦点转移，必须显式 focus。
          event.preventDefault()
          setTimeout(() => { try { typingRef.current?.focus({ preventScroll: true }) } catch {} }, 0)
          try { audioRef.current.context?.resume?.()?.catch?.(() => {}) } catch {}
          try { canvas.setPointerCapture?.(event.pointerId) } catch {}
          pointerRef.current = { down: true, id: event.pointerId, x: point.x, y: point.y, lastMove: 0 }
          sendControl({ kind: 'touch', action: 'down', ...point })
        }
        const onPointerMove = (event) => {
          if (!runningRef.current || !pointerRef.current.down) return
          if (platformRef.current === 'ios' && event.pointerId !== pointerRef.current.id) return
          const point = toDevice(event, true)
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
          if (platformRef.current === 'ios' && event.pointerId != null && event.pointerId !== pointerRef.current.id) return
          const point = (event.type === 'pointerup' ? toDevice(event, true) : null) ?? { x: pointerRef.current.x, y: pointerRef.current.y }
          pointerRef.current.down = false
          sendControl({ kind: 'touch', action: 'up', ...point })
          event.preventDefault()
        }
        let iosWheelPending = false
        const onWheel = (event) => {
          if (!runningRef.current) return
          const point = toDevice(event)
          if (!point) return
          // scrcpy 的滚动量「向上为正」，浏览器 deltaY「向下为正」，这里取反。
          // 一个滚轮刻度在 Chrome 里约 100px，除以 100 才是「一格一次」；
          // deltaMode 为 1 表示按行计数（Firefox/Linux），换算成像素。
          const perUnit = event.deltaMode === 1 ? 16 : 1
          const clamp = (value) => Math.max(-3, Math.min(3, value))
          event.preventDefault()
          const ios = platformRef.current === 'ios'
          const dx = clamp((-event.deltaX * perUnit) / 100)
          const dy = clamp((-event.deltaY * perUnit) / 100)
          if (!ios) {
            sendControl({ kind: 'scroll', ...point, dx, dy })
            return
          }
          if (pointerRef.current.down || iosWheelPending || (!dx && !dy)) return
          const [x, y] = ({ 90: [dy, -dx], 180: [-dx, -dy], 270: [-dy, dx] })[geometryRef.current?.rotation] ?? [dx, dy]
          iosWheelPending = true
          sendControl({ kind: 'scroll', ...point, dx: x, dy: y }).finally(() => { iosWheelPending = false })
        }
        // 点画面以外的地方（聊天框、工具栏、别的面板）就把键盘还给 DSH，
        canvas.addEventListener('pointerdown', onPointerDown)
        canvas.addEventListener('pointermove', onPointerMove)
        canvas.addEventListener('pointerup', onPointerUp)
        canvas.addEventListener('pointercancel', onPointerUp)
        canvas.addEventListener('lostpointercapture', onPointerUp)
        // 松手可能落在面板外（拖出侧栏、拖到别的窗口），画面收不到 up，
        // 所以窗口级再兜一层，保证指针状态一定复位。
        window.addEventListener('pointerup', onPointerUp)
        window.addEventListener('pointercancel', onPointerUp)
        window.addEventListener('blur', onPointerUp)
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => {
          canvas.removeEventListener('pointerdown', onPointerDown)
          canvas.removeEventListener('pointermove', onPointerMove)
          canvas.removeEventListener('pointerup', onPointerUp)
          canvas.removeEventListener('pointercancel', onPointerUp)
          canvas.removeEventListener('lostpointercapture', onPointerUp)
          window.removeEventListener('pointerup', onPointerUp)
          window.removeEventListener('pointercancel', onPointerUp)
          window.removeEventListener('blur', onPointerUp)
          canvas.removeEventListener('wheel', onWheel)
        }
      }, [sendControl, toDevice])

      const onKeyDown = useCallback((event) => {
        const ios = platformRef.current === 'ios'
        if (!running || (!ios && fullscreen)) return
        // 只认隐藏输入框里的按键：点画面后焦点就在它上面，电脑输入法才在这个框里组字。
        if (event.target !== typingRef.current) return
        // 组字中的按键交给电脑输入法，等 compositionend 统一提交（中文走这条）。
        if (event.isComposing || composingRef.current || event.keyCode === 229) return

        // 修饰键组合优先于输入法组字判断。
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
            return
          }
          // 非字母的修饰键组合落到特殊键分支：Ctrl+方向、Alt+方向等仍有作用。
        }

        // 输入法组字期间不逐字发送，等 compositionend 统一提交。
        if (event.isComposing || event.keyCode === 229) return

        // Esc 交还键盘焦点：之后的按键归 DSH。
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
          event.preventDefault()
          event.stopPropagation()
          sendControl({ kind: 'text', text: event.key })
        }
      }, [fullscreen, running, sendControl])

      useEffect(() => {
        if (!running) return undefined
        // 面板在跑就挂上捕获监听；按键是否归手机由 onKeyDown 里「焦点是不是隐藏输入框」决定。
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [onKeyDown, running])

      const platformDevices = (status?.devices ?? []).filter(
        (device) => (device.platform ?? 'android') === platform
      )
      const devices = platformDevices.filter((device) => device.state === 'device')
      const unauthorized = platformDevices.filter((device) => device.state === 'unauthorized')
      const adbReady = Boolean(status?.adb?.ok)
      const iosReady = Boolean(status?.ios?.ok)
      const providerReady = platform === 'ios' ? iosReady : adbReady

      const frameCaption = useMemo(() => {
        if (!running) return '未连接'
        const size = sizeRef.current
        // 帧率由引擎统计。
        return `${meta.deviceName || serial} · ${size.width}×${size.height} · ${stats.fps}fps`
      }, [meta.deviceName, running, serial, stats])

      return h('div', { className: 'dpm-panel' }, [

        h('div', { key: 'bar', className: 'dpm-row' }, [
          h('select', {
            key: 'platform',
            className: 'dpm-field dpm-select',
            value: platform,
            disabled: running,
            style: { flex: 'none' },
            onChange: (event) => {
              const next = event.target.value === 'ios' ? 'ios' : 'android'
              platformTouched = true
              preferredPlatform = next
              platformRef.current = next
              setPlatform(next)
              setPairing(false)
              setError('')
              setSerial(pickSerialForPlatform(status?.devices ?? [], next, ''))
            }
          }, [
            h('option', { key: 'android', value: 'android' }, '安卓'),
            h('option', { key: 'ios', value: 'ios' }, 'iOS')
          ]),
          h('select', {
            key: 'pick',
            className: 'dpm-field dpm-select',
            value: serial,
            onChange: (event) => {
              const next = event.target.value
              preferredSerialByPlatform[platform] = next
              setSerial(next)
            },
            disabled: running,
            style: { flex: '1 1 auto' }
          }, devices.length === 0
            ? [h('option', { key: 'none', value: '' }, providerReady
                ? '未检测到设备'
                : (platform === 'ios' ? '驱动未就绪' : 'adb 不可用'))]
            : devices.map((device) => h('option', { key: device.serial, value: device.serial }, `${device.model || device.serial} (${device.serial})`))),
          running
            ? h('button', { key: 'dis', className: 'dpm-btn', onClick: disconnect }, '断开')
            : h('button', {
                key: 'con',
                className: 'dpm-btn dpm-btn--primary',
                onClick: () => connect(),
                // 自动重开期间禁用。
                disabled: !serial || Boolean(busy) || autoConnecting,
                title: autoConnecting ? '系统正在自动连接，链路恢复后会自动接上' : ''
              }, busy || (autoConnecting ? '自动连接中' : '连接'))
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
              // 切画质需要重连会话。
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
              // 侧栏播放的声音：静音同时挂起音频上下文，双保险。
              const next = !audioOn
              const state = audioRef.current
              postEngine({ type: 'mute', muted: !next })
              if (!next) state.context?.suspend?.()?.catch?.(() => {})
              else state.context?.resume?.()?.catch?.(() => {})
              setAudioOn(next)
            },
            title: meta.audio === false
              ? (platform === 'ios'
                  ? '当前环境缺少 AAC-ELD 解码器，iPhone 声音无法转发'
                  : '该设备不支持音频转发')
              : (audioOn ? '关闭声音' : '打开声音'),
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
            onCompositionUpdate: (event) => {
              setPreedit(event.data ?? '')
            },
            onCompositionEnd: (event) => {
              composingRef.current = false
              setPreedit('')
              const value = event.data ?? event.target.value ?? ''
              event.target.value = ''
              if (value.length > 0) sendText(value)
            },
            onFocus: () => {
              setKeyboardActive(true)
            },
            onBlur: () => {
              composingRef.current = false
              setPreedit('')
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
              // 输入框保持可见。
              opacity: 1,
              resize: 'none',
              caretColor: 'transparent',
              cursor: 'default',
              zIndex: 2,
              // iOS 也要这个框：电脑输入法只在有焦点的输入框里组字，中文靠它提交。
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
          }, autoConnecting
            ? '系统正在自动连接…'
            : platform === 'ios'
              ? (iosReady
                  ? (unauthorized.length > 0
                      ? '请在 iPhone 上点「信任此电脑」并输入锁屏密码'
                      : devices.length > 0
                        ? (serial.startsWith('wifi:') ? 'iPhone 已配对，点右上「连接」尝试无线投屏' : '已发现 iPhone，点右上「连接」开始投屏')
                        : '插上 iPhone 并解锁，首次连接点击「信任此电脑」')
                  : (status?.ios?.error || '未检测到 Apple 驱动服务，请先安装 Apple Devices 或 iTunes'))
              : adbReady
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
        // 工具按钮按功能分组，组宽按按钮数量分配。
        h('div', { key: 'tools', className: 'dpm-tools' }, toolGroupsFor(platform).flatMap((group, index) => [
          index === 0 ? null : h('span', { key: `${group.id}-sep`, className: 'dpm-tools__sep' }),
          h('div', {
            key: group.id,
            className: 'dpm-tools__group',
            style: { flexGrow: group.items.length, flexBasis: 0 }
          }, group.items.map(([label, message]) => h('button', {
            key: label,
            className: 'dpm-btn',
            title: label,
            disabled: !running || (platform === 'ios' && iosToolBusy && ['app-switcher', 'rotate'].includes(message.kind)),
            onClick: () => {
              if (message.kind === 'fullscreen') {
                enterFullscreen()
                return
              }
              if (platform === 'ios' && ['app-switcher', 'rotate'].includes(message.kind)) {
                if (iosToolPending.current) return
                iosToolPending.current = true
                setIosToolBusy(true)
                sendControl(message).finally(() => {
                  iosToolPending.current = false
                  setIosToolBusy(false)
                })
                return
              }
              sendControl(message)
            }
          }, platform === 'ios' && message.kind === 'rotate'
            ? (Math.abs(meta.rotation ?? 0) % 180 === 90 ? '切竖屏' : '切横屏')
            : label)))
        ])),
        h('div', { key: 'wire', className: 'dpm-row' }, [
          h('button', {
            key: 'tcpip',
            className: 'dpm-btn',
            style: { flex: '1 1 0' },
            disabled: !serial || serial.includes(':') || Boolean(busy),
            title: platform === 'ios' ? '通过 USB 配置 iPhone 无线连接' : '把 USB 调试切到无线并自动连上',
            onClick: toWireless
          }, '转无线'),
          platform === 'android' ? h('button', {
            key: 'pair',
            className: 'dpm-btn',
            style: { flex: '1 1 0' },
            disabled: Boolean(busy),
            'aria-expanded': pairing,
            onClick: togglePairing
          }, '配对') : null,
          h('button', {
            key: 'drop',
            className: 'dpm-btn',
            style: { flex: '1 1 0' },
            disabled: Boolean(busy) || !wirelessAddress,
            title: platform === 'ios' ? '停止无线投屏或取消重连，保留配对' : '断开电脑与设备之间的无线通道',
            onClick: dropWireless
          }, '断开连接')
        ]),
        pairing && platform === 'android' ? h('div', { key: 'pair', className: 'dpm-pair' }, [
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
      // 各会话共用一条宿主连接：侧栏展开时手机页签跟随到新会话；最后一个页签关闭才断开。
      ctx.inject(['sidebarRight'], (owner) => {
        const right = owner.get('sidebarRight')
        let follow = false
        owner.effect(() => {
          let mounted
          const sync = () => {
            const next = right.mounted?.getSnapshot?.()
            if (!next) return
            const changed = mounted !== undefined && mounted !== next
            mounted = next
            const mine = (right.openTabs?.getSnapshot?.() ?? []).some(
              (entry) => entry.sessionId === next && entry.kind === TAB_KIND
            )
            if (mine) {
              follow = true
              return
            }
            if (changed && follow && right.isExpanded?.()) {
              try { right.openTab?.(TAB_KIND) } catch {}
            }
          }
          const dispose = right.mounted?.subscribe?.(sync)
          sync()
          return () => dispose?.()
        }, 'phone-mirror: follow tab')
        owner.effect(() => right.registerCloseHandler(TAB_KIND, (_sessionId, tab) => {
          const open = right.openTabs?.getSnapshot?.() ?? []
          if (open.some((entry) => entry.kind === TAB_KIND && entry.tabId !== tab.id)) return
          follow = false
          fetch(`${BASE}/disconnect`, { method: 'POST', keepalive: true }).catch(() => {})
        }), 'phone-mirror: close handler')
      })

      ctx.inject(['sidebarRightTabs'], (owner) => {
        const tabs = owner.get('sidebarRightTabs')
        const title = () => '手机'
        owner.effect(() => tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          keepMounted: true,
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
