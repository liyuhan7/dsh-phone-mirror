// 镜像引擎：拉宿主推来的二进制帧，解视频画到画布、解音频送进 worklet。
// 只依赖传入的画布和消息通道，可运行在 Worker 或主线程。
//
// 与宿主之间的消息：
//   收 init(canvas) / open(streamUrl, controlUrl) / close / reset / mute(muted)
//      audio-port(port) / audio-denied
//   发 meta(payload) / size / stats(fps) / note / error / audio-start
/* global self, createImageBitmap, VideoDecoder, AudioDecoder, EncodedVideoChunk, EncodedAudioChunk */
function createMirrorEngine({ canvas, post }) {
  const KIND = { VIDEO: 1, AUDIO: 2, META: 3, IMAGE: 4 }
  // 分别记录字节、送入、解码三种时刻。
  const emptyLive = () => ({
    byteAt: 0, feedAt: 0, decodeAt: 0, keyAt: 0, keyRetries: 0,
    restartAt: 0, failures: 0
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
    directVideoUrl: '',
    generation: 0,
    controller: null,
    stopped: true,
    pageVisible: true,
    resumeUntil: 0,
    size: { width: 0, height: 0 },
    // 设备上报的顺时针旋转角（0/90/180/270）：优先取流内朝向包。
    rotation: 0,
    // 是否已从视频流收到过朝向（收到后 meta 的旧值不再覆盖）。
    streamRotation: false,
    // 朝向变化后的保持期：期间不清队列、不呈现新帧（画面停在上一帧），
    // 避免旧朝向的内容被按新角度画出来闪一帧侧躺画面。
    rotationHoldUntil: 0,
    platform: null,
    screen: null,
    geometry: null,
    // 面板显示尺寸（CSS 像素 + DPR）：画布 backing 按它封顶。
    viewport: { width: 0, height: 0, dpr: 1 },
    renderScale: 1,
    video: {
      decoder: null, codec: '', configKey: '', key: true,
      lengthPrefixed: false, externalCodec: '', externalDescription: null,
      // 黑边裁剪：crop 为 null 表示满屏，cropDirty 置位时下一帧重新探测。
      crop: null, cropDirty: true,
      // 直连视频是否已发过故障提示：恢复后用它清掉面板上的提示。
      directNote: false,
      // 媒体管线写入端：非空时解码帧走 video 轨道，不再经过画布合成。
      writer: null,
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

  const emit = (message, transfer) => {
    try { post(message, transfer) } catch {}
  }

  function resize(width, height) {
    // 画布 backing 按实际显示尺寸封顶：面板只有几百像素宽，按设备全分辨率
    // 提交合成会每帧上传十几 MB 纹理，和界面渲染抢合成器。
    const viewport = state.viewport
    const dpr = viewport.dpr || 1
    const limitW = viewport.width > 0 ? viewport.width * dpr : width
    const limitH = viewport.height > 0 ? viewport.height * dpr : height
    const scale = Math.min(1, limitW / width, limitH / height)
    // 量化到 16px 步进：拖动侧边栏时不会每一像素都重分配画布。
    const snap = (value) => Math.max(1, Math.round(value / 16) * 16)
    const backingW = snap(width * scale)
    const backingH = snap(height * scale)
    state.renderScale = scale
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW
      canvas.height = backingH
    }
    state.size = { width, height }
    emit({ type: 'size', width, height })
  }

  /**
   * iOS 解码帧送进媒体管线，由 Chromium 的视频合成线程上屏。
   * 页面画布要和聊天区抢同一个合成器，主会话繁忙时会整段卡住。
   */
  function ensureVideoTrack() {
    if (state.video.writer || state.platform !== 'ios') return
    if (typeof VideoTrackGenerator !== 'function') return
    try {
      const generator = new VideoTrackGenerator()
      state.video.writer = generator.writable.getWriter()
      // 轨道转移给主线程后 Worker 这边就失效了，只保留写入端。
      emit({ type: 'track', track: generator.track }, [generator.track])
    } catch {
      state.video.writer = null
    }
  }

  /** 由解码帧尺寸推出画面几何：画布与媒体管线共用同一套朝向规则。 */
  function geometryFor(fw, fh) {
    const screen = state.screen
    const nativeLandscape = screen ? screen.width > screen.height : fw > fh
    const rotation = (fw > fh) === nativeLandscape ? state.rotation : 0
    const sideways = rotation % 180 !== 0
    const sourceLandscape = fw > fh
    const baseW = screen ? (sourceLandscape === nativeLandscape ? screen.width : screen.height) : fw
    const baseH = screen ? (sourceLandscape === nativeLandscape ? screen.height : screen.width) : fh
    return { width: sideways ? baseH : baseW, height: sideways ? baseW : baseH, rotation, baseW, baseH }
  }

  /** 媒体管线不画布：几何随解码帧尺寸变化上报，供主线程摆放 video。 */
  function syncVideoGeometry(fw, fh) {
    if (!state.video.writer || !(fw > 0) || !(fh > 0)) return
    const next = geometryFor(fw, fh)
    const prev = state.geometry
    if (prev && prev.width === next.width && prev.height === next.height && prev.rotation === next.rotation) return
    state.geometry = next
    emit({ type: 'geometry', width: next.width, height: next.height, rotation: next.rotation })
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

  function dropPending() {
    const pending = state.video.pending
    while (pending.length > 0) {
      try { pending.shift().close() } catch {}
    }
  }

  function clearCanvas() {
    try {
      // 先复位变换矩阵：遗留的缩放会把黑底画成左上角一小块。
      context.setTransform(1, 0, 0, 1, 0, 0)
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

  // Worker 的 rAF 与页面主线程的渲染节拍绑定：聊天区流式渲染占住主线程时
  // rAF 停摆、呈现队列溢出丢帧（fps 不掉但画面顿）。Worker 里改用定时器排
  // 空，与主线程彻底解耦；主线程回退路径仍用 rAF 对齐 vsync。
  let iosPresentCancel = null
  function schedulePresent() {
    if (iosPresentCancel) return
    const present = () => {
      iosPresentCancel = null
      if (Date.now() < state.rotationHoldUntil) {
        schedulePresent()
        return
      }
      presentFrame()
      // 队列里还有帧就继续排下去，避免要等下一条解码输出才推进。
      if (state.video.pending.length > 0) schedulePresent()
    }
    if (typeof Window !== 'undefined' && typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(present)
      iosPresentCancel = () => cancelAnimationFrame(id)
    } else {
      const id = setTimeout(present, 0)
      iosPresentCancel = () => clearTimeout(id)
    }
  }

  function startPresenter() {
    if (state.platform !== 'ios') {
      if (!state.video.present) state.video.present = setInterval(presentFrame, 16)
      return
    }
    schedulePresent()
  }

  function presentFrame() {
    const frame = state.video.pending.shift()
    if (!frame) return
    if (Date.now() < state.rotationHoldUntil) {
      try { frame.close() } catch {}
      return
    }
    try {
      if (state.platform === 'ios') {
        const next = geometryFor(frame.displayWidth, frame.displayHeight)
        const prev = state.geometry
        if (!prev || prev.width !== next.width || prev.height !== next.height || prev.rotation !== next.rotation) {
          state.geometry = next
          resize(next.width, next.height)
          emit({ type: 'geometry', width: next.width, height: next.height, rotation: next.rotation })
        }
        // 绘制坐标是设备像素，画布 backing 可能更小：按比例缩放一次。
        context.setTransform(state.renderScale, 0, 0, state.renderScale, 0, 0)
        // 尺寸跟随输出而非解码缓冲，避免编码尺寸波动时重分配画布。
        if (next.rotation === 0) {
          // 无旋转时直接合成，省掉一次全分辨率中转绘制。
          context.drawImage(frame, 0, 0, next.baseW, next.baseH)
        } else {
          iosScratchFor(next.baseW, next.baseH).drawImage(frame, 0, 0, next.baseW, next.baseH)
          context.save()
          try {
            context.translate(next.width / 2, next.height / 2)
            context.rotate(next.rotation * Math.PI / 180)
            context.drawImage(iosScratch, -next.baseW / 2, -next.baseH / 2)
          } finally { context.restore() }
        }
      } else {
        if (state.video.cropDirty) {
          state.video.crop = detectCrop(frame)
          state.video.cropDirty = false
        }
        const crop = state.video.crop
        resize(crop ? crop.w : frame.displayWidth, crop ? crop.h : frame.displayHeight)
        context.setTransform(state.renderScale, 0, 0, state.renderScale, 0, 0)
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
    if (iosPresentCancel) {
      iosPresentCancel()
      iosPresentCancel = null
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
    ensureVideoTrack()
    const decoder = new VideoDecoder({
      output: (frame) => {
        state.live.decodeAt = Date.now()
        const writer = state.video.writer
        if (writer) {
          syncVideoGeometry(frame.displayWidth, frame.displayHeight)
          // 媒体管线按自己的节拍取帧：跟不上就丢这一帧，不让解码输出排队。
          if (writer.desiredSize !== null && writer.desiredSize <= 0) {
            try { frame.close() } catch {}
            return
          }
          writer.write(frame).catch(() => { try { frame.close() } catch {} })
          return
        }
        const pending = state.video.pending
        // 两端统一排队呈现：短时卡顿由队列吸收，超过 4 帧才丢最旧的，避免延迟无限增长。
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
        error: (failure) => {
          // 音频解码出错：本会话内停止音频，并说明原因。
          state.audio.failed = true
          emit({ type: 'note', message: `音频解码失败：${failure?.message ?? '未知错误'}` })
        }
      })
      decoder.configure({
        codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: audio.description
      })
      audio.decoder = decoder
    } catch (failure) {
      audio.failed = true
      emit({ type: 'note', message: `音频解码不可用：${failure?.message ?? '未知错误'}` })
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
    // 直连视频地址以宿主 meta 的端口为准：宿主已不再中转视频，
    // 客户端漏传时在这里补上，其余字段照常处理完再重连。
    let healDirect = false
    if (state.platform === 'ios' && payload.videoPort && !state.directVideoUrl) {
      state.directVideoUrl = `http://127.0.0.1:${payload.videoPort}/stream.bin`
      healDirect = true
    }
    // 宿主 meta 里的朝向是会话启动时的快照，视频不再经宿主转发后它不会更新；
    // 一旦收到过流内的朝向包，就以流为准，避免重连时被旧值覆盖回去。
    if (Number.isFinite(payload.rotation) && !state.streamRotation) {
      const degrees = ((payload.rotation % 360) + 360) % 360
      if (degrees !== state.rotation && state.live.decodeAt > 0) {
        state.rotationHoldUntil = Date.now() + 220
      }
      state.rotation = degrees
    }
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
    // 补齐直连地址后重连，让视频泵按新地址重新订阅。
    if (healDirect && !state.stopped) restart()
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

  // iOS sidecar 直连视频流：宿主事件循环同时承担 DSH 主对话的流式解析，
  // 视频经宿主中转会被成片推迟（fps 掉到 30-40）。Worker 直接订阅本机
  // sidecar 的 /stream.bin，音频与元数据仍走宿主流（音频有缓冲垫不受影响）。

  // 订阅前向 sidecar 的 /codec 读取当前朝向与屏幕尺寸：/codec 按请求时
  // 的设备状态生成，是重开后恢复朝向的唯一可靠来源。
  async function seedDirectState(parentSignal) {
    if (!state.directVideoUrl.endsWith('/stream.bin')) return
    const controller = new AbortController()
    const abort = () => controller.abort()
    parentSignal?.addEventListener?.('abort', abort)
    const timer = setTimeout(abort, 2000)
    try {
      const response = await fetch(`${state.directVideoUrl.slice(0, -'/stream.bin'.length)}/codec`, {
        cache: 'no-store',
        signal: controller.signal
      })
      if (!response.ok) return
      const info = await response.json()
      if (!info || typeof info !== 'object') return
      const rotation = Number(info.display?.rotation)
      if (Number.isFinite(rotation)) {
        state.rotation = ((rotation % 360) + 360) % 360
        state.streamRotation = true
      }
      if (info.display?.width > 0 && info.display?.height > 0) {
        state.screen = { width: info.display.width, height: info.display.height }
      }
    } catch {} finally {
      clearTimeout(timer)
      parentSignal?.removeEventListener?.('abort', abort)
    }
  }

  async function pumpDirectVideo(controller, generation) {
    // PTS 跨重连保持单调递增，重连后订阅从 sidecar 缓存关键帧重新引导。
    let pts = 0
    let directFaulted = false
    while (generation === state.generation) {
      try {
        // 订阅前先补种当前朝向与屏幕尺寸（引擎重开后二者已被清零，
        // 宿主 meta 只有启动快照，流内朝向包只在变化时广播）。
        await seedDirectState(controller.signal)
        const response = await fetch(state.directVideoUrl, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || !response.body) throw new Error(`直连流失败（${response.status}）`)
        if (generation !== state.generation) return
        const reader = response.body.getReader()
        let buffer = new Uint8Array(0)
        // 首个数据块到达即视为直连已恢复：清掉之前的故障提示。
        let recovered = false
        // 新订阅先收缓存关键帧（type=0），广播循环按住增量帧等 PLI 触发的
        // 新鲜关键帧（type=2）；从它开始解码，避免吃到缺参考帧的增量。
        let bootstrapped = false
        let waitingForKey = true
        const head = new Uint8Array(9)
        const view = new DataView(head.buffer)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (generation !== state.generation) return
          if (!value) continue
          state.live.byteAt = Date.now()
          state.live.failures = 0
          if (!recovered) {
            recovered = true
            if (state.video.directNote) {
              state.video.directNote = false
              emit({ type: 'note', message: '' })
            }
          }
          // fetch 已剥掉 HTTP chunked 编码，读到的是 [u32 大端长度][type][AU]
          // 连续流；u32 长度包含 type 字节，与宿主 LengthPrefixedParser 同语义。
          const merged = buffer.length ? concatBytes(buffer, value) : value
          let offset = 0
          while (merged.length - offset >= 4) {
            const size = (merged[offset] << 24) | (merged[offset + 1] << 16) | (merged[offset + 2] << 8) | merged[offset + 3]
            // 尺寸越界视为流损坏，丢弃缓冲等待新数据。
            if (size < 1 || size > 8 * 1024 * 1024) { offset = -1; break }
            if (merged.length - offset < 4 + size) break
            const packet = merged.subarray(offset + 4, offset + 4 + size)
            offset += 4 + size
            const type = packet[0]
            // type 3 是编码参数 JSON，type 4 是朝向变化 JSON：都不送解码器。
            if (type === 3 || type === 4) {
              try {
                const info = JSON.parse(new TextDecoder().decode(packet.subarray(1)))
                const rotation = type === 4 ? info.rotation : info.display?.rotation
                if (Number.isFinite(rotation)) {
                  const degrees = ((rotation % 360) + 360) % 360
                  if (degrees !== state.rotation && state.live.decodeAt > 0) {
                    state.rotationHoldUntil = Date.now() + 220
                  }
                  state.rotation = degrees
                  state.streamRotation = true
                }
                if (type === 3 && info.display?.width > 0 && info.display?.height > 0) {
                  state.screen = { width: info.display.width, height: info.display.height }
                }
              } catch {}
              continue
            }
            if (!bootstrapped) {
              if (type !== 2) continue
              bootstrapped = true
            }
            const isKey = type !== 1
            const wasWaiting = waitingForKey
            if (wasWaiting && !isKey) continue
            waitingForKey = false
            pts += 16667
            head[0] = (isKey ? 0x20 : 0) | (type === 2 || wasWaiting ? 0x10 : 0)
            view.setBigUint64(1, BigInt(pts))
            handleVideo(concatBytes(head, packet.subarray(1)))
          }
          buffer = offset > 0 ? merged.subarray(offset) : (offset === 0 ? merged : new Uint8Array(0))
        }
      } catch (failure) {
        if (failure?.name === 'AbortError') return
        // 断开过程里 sidecar 先被杀掉，这条连接会以 network error 失败；
        // 已经在停或换代时不算故障，不打扰用户。
        if (state.stopped || generation !== state.generation) return
        // 直连失败不再静默：面板提示一次原因（端口不通、CORS 等）。
        if (!directFaulted) {
          directFaulted = true
          state.video.directNote = true
          emit({ type: 'note', message: `视频直连失败：${failure?.message ?? '未知错误'}` })
        }
      }
      // 连接结束：sidecar 可能重启了流，稍等后重新订阅。
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  function concatBytes(left, right) {
    const out = new Uint8Array(left.length + right.length)
    out.set(left)
    out.set(right, left.length)
    return out
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
      if (state.directVideoUrl) pumpDirectVideo(controller, generation).catch(() => {})
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
    // 重连不重置节流窗口。
    state.live = {
      ...emptyLive(),
      restartAt: state.live.restartAt
    }
    pump(controller, generation).catch(() => {})
  }

  function open(message) {
    clearCanvas()
    state.streamUrl = message.streamUrl
    state.controlUrl = message.controlUrl ?? ''
    state.directVideoUrl = message.directVideoUrl || ''
    // 新会话重新协商音频：上一次会话的失败/请求状态不能残留，
    // 否则本次会话永远不会重建音频解码器。
    state.audio.failed = false
    state.audio.requested = false
    state.audio.description = null
    state.streamRotation = false
    state.rotationHoldUntil = 0
    state.video.directNote = false
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
    closeDecoder()
    resetAudio()
    state.audio.failed = false
    state.audio.requested = false
    state.audio.description = null
    state.live = emptyLive()
    state.platform = null
    state.rotation = 0
    state.rotationHoldUntil = 0
    state.streamRotation = false
    state.video.directNote = false
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
          if (message.directVideoUrl !== undefined) state.directVideoUrl = message.directVideoUrl || ''
          if (!state.stopped) restart()
          break
        case 'mute':
          state.audio.muted = Boolean(message.muted)
          // 无论静音还是恢复都清空积压：静音后立刻安静，恢复时不播旧样本。
          resetAudio()
          break
        case 'audio-port':
          attachAudioPort(message.port)
          break
        case 'audio-denied':
          state.audio.failed = true
          break
        case 'viewport': {
          const vp = state.viewport
          const width = Number(message.width) || 0
          const height = Number(message.height) || 0
          const dpr = Number(message.dpr) || 1
          if (vp.width === width && vp.height === height && vp.dpr === dpr) break
          state.viewport = { width, height, dpr }
          // 显示尺寸变化后按新上限重算 backing，下一帧生效。
          if (state.geometry) resize(state.geometry.width, state.geometry.height)
          break
        }
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
