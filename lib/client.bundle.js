// 本文件由 npm run build 生成，请修改 lib/client.js 后重新构建。
// dsh-phone-mirror 浏览器端：右侧栏「手机」面板。
// 做三件事：拉宿主推来的二进制帧、用 WebCodecs 解出画面、把指针/键盘换算成控制消息回传。
/* global window, VideoDecoder, AudioDecoder, EncodedVideoChunk, EncodedAudioChunk, AudioContext */
window.__ModuleLoader__.load({
  id: 'dsh-phone-mirror',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const BASE = '/dsh-phone-mirror/api'
    const TAB_ID = 'phone-mirror'
    const TAB_KIND = 'phone-mirror'
    const KIND = { VIDEO: 1, AUDIO: 2, META: 3, IMAGE: 4 }

    /** 字母与数字的安卓键码，用于修饰键组合。 */
    const LETTER_OR_DIGIT = {
      a: 29, b: 30, c: 31, d: 32, e: 33, f: 34, g: 35, h: 36, i: 37, j: 38,
      k: 39, l: 40, m: 41, n: 42, o: 43, p: 44, q: 45, r: 46, s: 47, t: 48,
      u: 49, v: 50, w: 51, x: 52, y: 53, z: 54,
      0: 7, 1: 8, 2: 9, 3: 10, 4: 11, 5: 12, 6: 13, 7: 14, 8: 15, 9: 16
    }

    const clamp01 = (value) => Math.min(1, Math.max(0, value))

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
            // 长度异常说明流已错位，直接丢弃以免越积越多。
            this.buffer = new Uint8Array(0)
            break
          }
          if (this.buffer.length < 4 + length) break
          frames.push({
            kind: this.buffer[4],
            payload: this.buffer.subarray(5, 4 + length)
          })
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

    /** 兜底：没有 PPS 时退回 Annex-B，至少还有机会出画面。 */
    function codecFromSps(data) {
      for (let i = 0; i + 4 < data.length; i += 1) {
        const isStart = data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))
        if (!isStart) continue
        const header = data[i + 2] === 1 ? i + 3 : i + 4
        const type = data[header] & 0x1f
        if (type !== 7) continue
        const profile = data[header + 1]
        const constraints = data[header + 2]
        const level = data[header + 3]
        if (profile === undefined || level === undefined) return null
        const hex = (value) => value.toString(16).padStart(2, '0')
        return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`
      }
      return null
    }

    const buttonStyle = {
      appearance: 'none',
      border: '1px solid rgba(127,127,127,0.28)',
      background: 'rgba(127,127,127,0.10)',
      color: 'inherit',
      borderRadius: 8,
      padding: '6px 10px',
      fontSize: 12,
      lineHeight: 1.2,
      cursor: 'pointer'
    }

    const primaryStyle = { ...buttonStyle, borderColor: 'rgba(80,140,255,0.65)', background: 'rgba(80,140,255,0.18)' }

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
      const [wireless, setWireless] = useState('')

      const canvasRef = useRef(null)
      const boxRef = useRef(null)
      const typingRef = useRef(null)
      // 输入法正在组字：此时不发送，等提交后统一发。
      const composingRef = useRef(false)
      const [keyboardActive, setKeyboardActive] = useState(false)
      // 输入浮层：显示正在输入的拼音。
      const [preedit, setPreedit] = useState('')
      const abortRef = useRef(null)
      const decoderRef = useRef(null)
      // 新建/重建解码器后必须等到关键帧才能解增量帧，否则会花屏。
      const needKeyRef = useRef(true)
      // 当前生效的 avcC 指纹，用于判断 SPS/PPS 是否真的变化。
      const configKeyRef = useRef('')
      // 分辨率变化时要求后续必须等关键帧；与 needKeyRef 分开，避免互相覆盖。
      const wantKeyRef = useRef(false)
      const codecRef = useRef(null)
      const sizeRef = useRef({ width: 1080, height: 1920 })
      const pointerRef = useRef({ down: false, x: 0, y: 0, lastMove: 0 })
      const audioRef = useRef({ decoder: null, context: null, next: 0, description: null, failed: false })
      const counterRef = useRef({ received: 0, bytes: 0, at: 0 })
      // 链路与解码的存活时间戳。画面静止时设备本来就不出帧，
      // 只靠「多久没收到视频帧」判断不了死活，因此分开记录三种时刻。
      const liveRef = useRef({
        byteAt: 0, feedAt: 0, decodeAt: 0, restartAt: 0, keyAt: 0,
        keyRetries: 0, stalls: 0, stallWindowAt: 0
      })
      // 连续失败计数：链路一直连不上时不要无限重试。
      const faultRef = useRef({ failures: 0 })

      const running = meta.state === 'running'

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

      // 未连接时低频轮询设备列表；连接后靠流里的 meta 帧驱动。
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
            if (!response.ok) throw new Error(`控制指令被拒绝（${response.status}）`)
            const data = await response.json().catch(() => ({}))
            if (data && data.ok === false) throw new Error(data.error ?? '设备未接受指令')
            setControlError('')
          })
          .catch((failure) => setControlError(failure.message))
        return controlQueue.current
      }, [])

      /**
       * 让设备重建编码会话，立刻重发 SPS/PPS + 关键帧。
       * 解码跟不上、参考帧断掉、等关键帧等太久，都靠这一下发拉回同步；
       * 每次都会让设备重启编码器，所以默认限频 2.5s。
       */
      const requestKeyframe = useCallback((force = false) => {
        const now = Date.now()
        if (!force && now - liveRef.current.keyAt < 2500) return false
        liveRef.current.keyAt = now
        sendControl({ kind: 'reset' })
        return true
      }, [sendControl])

      /** 记一次重同步。15 秒窗口内反复发生说明当前画质根本解不动。 */
      const noteStall = useCallback(() => {
        const state = liveRef.current
        const now = Date.now()
        if (now - state.stallWindowAt > 15000) {
          state.stallWindowAt = now
          state.stalls = 0
        }
        state.stalls += 1
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

      const ensureDecoder = useCallback((codec, description) => {
        const canvas = canvasRef.current
        if (!canvas) return null
        if (decoderRef.current && codecRef.current === codec && decoderRef.current.state === 'configured') {
          return decoderRef.current
        }
        try { decoderRef.current?.close() } catch {}
        const context = canvas.getContext('2d', { alpha: false })
        const decoder = new VideoDecoder({
          output: (frame) => {
            liveRef.current.decodeAt = Date.now()
            const { displayWidth, displayHeight } = frame
            if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
              canvas.width = displayWidth
              canvas.height = displayHeight
              sizeRef.current = { width: displayWidth, height: displayHeight }
            }
            try { context.drawImage(frame, 0, 0, displayWidth, displayHeight) } catch {}
            frame.close()
          },
          error: (failure) => {
            // 解码器报错后状态不再可信：丢弃它，由重连拿到新的 SPS/PPS 与关键帧。
            if (decoderRef.current === decoder) {
              decoderRef.current = null
              codecRef.current = null
            }
            needKeyRef.current = true
            // 可自愈的瞬时故障：用提示色展示，避免被当成致命错误。
            setControlError(`解码器重建中：${failure.message}`)
            const now = Date.now()
            if (now - (counterRef.current.lastRestartAt ?? 0) > 1500) {
              counterRef.current.lastRestartAt = now
              restartStreamRef.current()
            }
          }
        })
        // 有 avcC 就按 AVCC 解（Chromium 稳定路径）；没有才退回 Annex-B。
        const base = description
          ? { codec, description, optimizeForLatency: true }
          : { codec, optimizeForLatency: true, avc: { format: 'annexb' } }
        try {
          decoder.configure(base)
        } catch {
          try {
            // 兜底：仍失败时让浏览器自行选择实现。
            decoder.configure({ ...base, hardwareAcceleration: 'no-preference' })
          } catch (failure) {
            // 配置失败的解码器可能已被浏览器关闭，不能继续用。
            try { decoder.close() } catch {}
            if (decoderRef.current === decoder) decoderRef.current = null
            setError(`解码器配置失败：${failure.message}`)
            return null
          }
        }
        needKeyRef.current = true
        if (decoder.state !== 'configured') {
          try { decoder.close() } catch {}
          if (decoderRef.current === decoder) decoderRef.current = null
          return null
        }
        decoderRef.current = decoder
        codecRef.current = codec
        return decoder
      }, [])

      const ensureAudio = useCallback((codec, description) => {
        const state = audioRef.current
        if (state.failed) return null
        if (state.decoder && state.decoder.state === 'configured' && !description) return state.decoder
        try { state.decoder?.close() } catch {}
        const context = state.context ?? new AudioContext()
        state.context = context
        const decoder = new AudioDecoder({
          output: (data) => {
            try {
              const channels = data.numberOfChannels
              const frames = data.numberOfFrames
              const buffer = context.createBuffer(channels, frames, data.sampleRate)
              for (let channel = 0; channel < channels; channel += 1) {
                const target = new Float32Array(frames)
                data.copyTo(target, { planeIndex: channel, format: 'f32-planar' })
                buffer.copyToChannel(target, channel)
              }
              const source = context.createBufferSource()
              source.buffer = buffer
              source.connect(context.destination)
              const now = context.currentTime
              // 落后超过 200ms 就重新对齐，避免越拖越多。
              if (state.next < now || state.next - now > 0.2) state.next = now
              source.start(state.next)
              state.next += buffer.duration
            } catch {}
            data.close()
          },
          error: () => {
            // Opus 在不支持的组合下会拒绝配置；关掉声音但不影响画面。
            audioRef.current.failed = true
          }
        })
        try {
          const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }
          if (description) config.description = description
          decoder.configure(config)
          state.decoder = decoder
          return decoder
        } catch {
          audioRef.current.failed = true
          return null
        }
      }, [])

      // startStream 定义在其后，通过 ref 供解码异常处理路径触发重连。
      const restartStreamRef = useRef(() => {})
      // 标记停止来源：主动停止不触发自动重连。
      const stoppedRef = useRef(true)
      // 会话状态镜像：设备已断开时不再空转重连。
      const sessionStateRef = useRef('idle')
      // 流的代次：用于判断某个读流循环是否已被新的循环取代。
      const streamGenRef = useRef(0)
      // 尺寸变化的去抖定时器。
      const sizeTimerRef = useRef(null)
      const attachedRef = useRef(false)
      const attachSessionRef = useRef(() => {})
      const stopStream = useCallback(() => {
        stoppedRef.current = true
        abortRef.current?.abort()
        abortRef.current = null
        try { decoderRef.current?.close() } catch {}
        decoderRef.current = null
        codecRef.current = null
        try { audioRef.current.decoder?.close() } catch {}
        audioRef.current.decoder = null
        audioRef.current.failed = false
      }, [])

      const startStream = useCallback(async () => {
        stopStream()
        stoppedRef.current = false
        const generation = (streamGenRef.current += 1)
        const controller = new AbortController()
        abortRef.current = controller
        const parser = new FrameParser()
        counterRef.current = { received: 0, bytes: 0, at: Date.now() }
        // 建流阶段也要有超时：宿主无响应时 fetch 会一直挂着，页面就停在上一帧。
        const handshake = setTimeout(() => controller.abort(), 10000)
        try {
          const response = await fetch(`${BASE}/stream`, { signal: controller.signal, cache: 'no-store' })
          clearTimeout(handshake)
          if (!response.ok || !response.body) throw new Error(`流连接失败（${response.status}）`)
          const reader = response.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            liveRef.current.byteAt = Date.now()
            faultRef.current.failures = 0
            counterRef.current.bytes += value.length
            for (const frame of parser.push(value)) {
              if (frame.kind === KIND.META) {
                let payload = {}
                try { payload = JSON.parse(new TextDecoder().decode(frame.payload)) } catch {}
                if (payload.type === 'error') setError(payload.message ?? '会话出错')
                if (payload.type === 'meta') {
                  if (payload.state) sessionStateRef.current = payload.state
                  if (payload.screen) {
                    const changed = payload.screen.width !== sizeRef.current.width ||
                      payload.screen.height !== sizeRef.current.height
                    sizeRef.current = payload.screen
                    // 分辨率变化意味着编码会话切换：丢弃整条流重连，
                    // 由宿主重发 SPS/PPS 与关键帧，避免残留参考帧造成绿屏。
                    if (changed) {
                      // 切换动画期间尺寸会连续变化，去抖后再重连一次即可。
                      if (sizeTimerRef.current) clearTimeout(sizeTimerRef.current)
                      sizeTimerRef.current = setTimeout(() => {
                        sizeTimerRef.current = null
                        try { decoderRef.current?.close() } catch {}
                        decoderRef.current = null
                        codecRef.current = null
                        configKeyRef.current = ''
                        wantKeyRef.current = true
                        restartStreamRef.current()
                      }, 400)
                    }
                  }
                  setMeta((previous) => ({ ...previous, ...payload }))
                }
                continue
              }
              if (frame.kind === KIND.IMAGE) {
                const blob = new Blob([frame.payload], { type: 'image/png' })
                const bitmap = await createImageBitmap(blob)
                const canvas = canvasRef.current
                if (canvas) {
                  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                    canvas.width = bitmap.width
                    canvas.height = bitmap.height
                    sizeRef.current = { width: bitmap.width, height: bitmap.height }
                  }
                  canvas.getContext('2d', { alpha: false })?.drawImage(bitmap, 0, 0)
                }
                bitmap.close()
                continue
              }
              if (frame.kind === KIND.VIDEO) {
                const flags = frame.payload[0]
                const pts = Number(new DataView(frame.payload.buffer, frame.payload.byteOffset + 1, 8).getBigUint64(0))
                const data = frame.payload.subarray(9)
                if (data.length === 0) continue
                counterRef.current.received += 1
                liveRef.current.feedAt = Date.now()
                if ((flags & 0x40) !== 0) {
                  // 配置包只用来建 avcC，本身不是图像数据。
                  // 关键帧前会重复发送同一份 SPS/PPS；内容未变时保持解码器不动，
                  // 以免打断参考帧链。
                  const config = parseConfig(data)
                  if (config) {
                    const fingerprint = fingerprintConfig(config, data)
                    const changed = fingerprint !== configKeyRef.current
                    configKeyRef.current = fingerprint
                    const usable = decoderRef.current?.state === 'configured' &&
                      codecRef.current === config.codec
                    if (changed || !usable) {
                      codecRef.current = config.codec
                      try { decoderRef.current?.close() } catch {}
                      decoderRef.current = null
                      ensureDecoder(config.codec, config.description)
                    }
                  }
                  continue
                }
                const decoder = decoderRef.current
                if (!decoder) continue
                // 只向处于已配置状态的解码器送帧。
                if (decoder.state !== 'configured') {
                  if (decoder.state === 'closed') decoderRef.current = null
                  continue
                }
                const isKey = (flags & 0x20) !== 0
                // 队列过深说明解码跟不上。丢掉中间帧会打断参考帧链，直接关解码器
                // 又要干等下一个关键帧（可能好几秒，画面就僵在那里），所以改成：
                // 请设备立刻重发关键帧，期间只接收关键帧，让队列先排空。
                if (decoder.decodeQueueSize > 16 && !needKeyRef.current) {
                  needKeyRef.current = true
                  noteStall()
                  requestKeyframe(true)
                }
                // 新建或刚重同步的解码器没有参考帧，只接受关键帧。
                if (needKeyRef.current || wantKeyRef.current) {
                  if (!isKey) continue
                  needKeyRef.current = false
                  wantKeyRef.current = false
                  liveRef.current.keyRetries = 0
                }
                const payload = toAvcc(data)
                if (!payload) continue
                try {
                  decoder.decode(new EncodedVideoChunk({
                    type: isKey ? 'key' : 'delta',
                    timestamp: pts,
                    data: payload
                  }))
                } catch (failure) {
                  // 解码器不可用：丢弃并重连，由宿主请求新的关键帧序列。
                  decoderRef.current = null
                  codecRef.current = null
                  counterRef.current.decodeErrors = (counterRef.current.decodeErrors ?? 0) + 1
                  const now = Date.now()
                  if (now - (counterRef.current.lastRestartAt ?? 0) > 1500) {
                    counterRef.current.lastRestartAt = now
                    setControlError(`解码器异常，正在重建画面：${failure.message}`)
                    restartStreamRef.current()
                  }
                }
                continue
              }
              if (frame.kind === KIND.AUDIO && audioOn) {
                const flags = frame.payload[0]
                const pts = Number(new DataView(frame.payload.buffer, frame.payload.byteOffset + 1, 8).getBigUint64(0))
                const data = frame.payload.subarray(9)
                if (data.length === 0) continue
                if ((flags & 0x40) !== 0) {
                  // MediaCodec 的 Opus 配置包就是 OpusHead，直接当 description 用。
                  const head = new TextDecoder('latin1').decode(data.subarray(0, 8))
                  const description = head.startsWith('OpusHead') ? data : null
                  audioRef.current.description = description
                  ensureAudio('opus', description)
                  continue
                }
                const decoder = audioRef.current.decoder
                if (!decoder) ensureAudio('opus', audioRef.current.description)
                try {
                  audioRef.current.decoder?.decode(new EncodedAudioChunk({ type: 'key', timestamp: pts, data }))
                } catch {}
              }
            }
            const now = Date.now()
            const elapsed = now - counterRef.current.at
            if (elapsed >= 1000) {
              const fps = (counterRef.current.received * 1000) / elapsed
              setStats({ fps: Math.round(fps) })
              counterRef.current = { received: 0, bytes: 0, at: now }
            }
          }
        } catch (failure) {
          // 主动停止（stopStream 会先把 stoppedRef 置位再 abort）不算失败；
          // 其余情况，包括建流超时，都要计数，避免对着死链路无限重试。
          if (!stoppedRef.current) {
            faultRef.current.failures += 1
            if (failure.name !== 'AbortError') setError(failure.message)
          }
        } finally {
          clearTimeout(handshake)
          // 流结束后如果会话还在跑，说明连接被意外中断（宿主重启、代理超时等），
          // 自动重连；否则面板会停在最后一帧，只能手动刷新。
          // 连续失败多次就不再空转，留给用户手动处理。
          const shouldRetry = !stoppedRef.current &&
            sessionStateRef.current === 'running' &&
            streamGenRef.current === generation &&
            faultRef.current.failures < 8
          if (shouldRetry) {
            setTimeout(() => {
              if (!stoppedRef.current && sessionStateRef.current === 'running' &&
                  streamGenRef.current === generation) {
                restartStreamRef.current()
              }
            }, 800)
          } else if (faultRef.current.failures >= 8) {
            setError('画面连续中断，请点「重建画面」或重新连接')
          }
        }
      }, [audioOn, ensureAudio, ensureDecoder, noteStall, requestKeyframe, stopStream])

      // 重连 = 停掉旧流（会关闭解码器）+ 重新拉流（宿主据此重发关键帧）。
      restartStreamRef.current = () => {
        stopStream()
        startStream().catch(() => {})
      }

      // 两秒内不重复重连：避免链路抖动时把解码器反复拆了重建。
      const restartThrottled = useCallback(() => {
        const now = Date.now()
        if (now - liveRef.current.restartAt < 2000) return
        liveRef.current.restartAt = now
        restartStreamRef.current()
      }, [])

      // 面板重新打开时，如果宿主还留着会话就直接接上，避免又点一次「连接」。
      attachSessionRef.current = (info) => {
        if (attachedRef.current) return
        attachedRef.current = true
        setMeta({ ...info, state: 'running' })
        startStream().catch(() => {})
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
          // 读流是长期任务，不能 await，否则 busy 永远挂着。
          startStream().catch(() => {})
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [post, serial, startStream])

      const disconnect = useCallback(async () => {
        setBusy('正在断开…')
        try {
          stopStream()
          await post('/disconnect')
          setMeta({ state: 'idle', deviceName: '', screen: null, mode: null })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
          refresh()
        }
      }, [post, refresh, stopStream])

      const connectWireless = useCallback(async () => {
        const address = wireless.trim()
        if (!address) return
        setBusy('正在连接无线设备…')
        try {
          await post('/adb/connect', { address })
          setWireless('')
          await refresh()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [post, refresh, wireless])

      // 看门狗跑在读流循环之外：链路真断了的时候 reader.read() 不会再返回，
      // 循环里的任何判断都不会被执行，画面就永远停在最后一帧。
      useEffect(() => {
        const timer = setInterval(() => {
          if (stoppedRef.current || sessionStateRef.current !== 'running') return
          const state = liveRef.current
          const now = Date.now()

          // 1) 链路存活。宿主每 2 秒发一次心跳，8 秒一个字节都没有就是断了。
          if (state.byteAt > 0 && now - state.byteAt > 8000) {
            restartThrottled()
            return
          }

          // 2) 解码器卡死：有帧送进去，却长时间没有输出。
          //    正在等关键帧时不走这条，否则每秒都会重建一次解码器和编码器。
          const feeding = state.feedAt > state.decodeAt
          if (!needKeyRef.current && feeding &&
              now - state.feedAt < 4000 && now - state.decodeAt > 4000) {
            try { decoderRef.current?.close() } catch {}
            decoderRef.current = null
            codecRef.current = null
            configKeyRef.current = ''
            needKeyRef.current = true
            noteStall()
            requestKeyframe(true)
            return
          }

          // 3) 要了关键帧却一直不来：最多再催两次，还不行就整条流重连。
          if (needKeyRef.current && now - state.keyAt > 3000) {
            state.keyRetries += 1
            if (state.keyRetries > 2) {
              state.keyRetries = 0
              restartThrottled()
            } else {
              requestKeyframe(true)
            }
            return
          }

          // 4) 15 秒里反复追不上帧，说明这个画质档位解不动：降一档重连，
          //    比不停重同步的体感好得多。
          if (state.stalls >= 3 && quality > 720) {
            const next = quality >= 1600 ? 1080 : 720
            state.stalls = 0
            setQuality(next)
            connect(next).catch(() => {})
          }
        }, 1000)
        return () => clearInterval(timer)
      }, [connect, noteStall, quality, requestKeyframe, restartThrottled])

      // 面板被卸载（切换页签）时只停止收流；会话的结束由侧栏关闭钩子负责。
      useEffect(() => () => {
        stopStream()
        attachedRef.current = false
      }, [stopStream])

      useEffect(() => {
        // 挂在外层容器上：canvas 用 object-fit:contain 撑满，事件在容器上更稳。
        const canvas = boxRef.current
        if (!canvas) return undefined
        const onPointerDown = (event) => {
          // 点击画面即接管键盘；点别处会自然失焦，不影响在对话里打字。
          setTimeout(() => { try { typingRef.current?.focus({ preventScroll: true }) } catch {} }, 0)
          try { canvas.setPointerCapture?.(event.pointerId) } catch {}
          const point = toDevice(event)
          if (!point) return
          pointerRef.current = { down: true, x: point.x, y: point.y, lastMove: 0 }
          sendControl({ kind: 'touch', action: 'down', ...point })
        }
        const onPointerMove = (event) => {
          if (!pointerRef.current.down) return
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
          if (!pointerRef.current.down) return
          const point = toDevice(event) ?? { x: pointerRef.current.x, y: pointerRef.current.y }
          pointerRef.current.down = false
          sendControl({ kind: 'touch', action: 'up', ...point })
          event.preventDefault()
        }
        const onWheel = (event) => {
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
        if (!running) return

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
      }, [running, sendControl])

      useEffect(() => {
        if (!running || !keyboardActive) return undefined
        // 捕获阶段先拿到按键，避免被页面快捷键处理掉。
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [running, keyboardActive, onKeyDown])

      const devices = (status?.devices ?? []).filter((device) => device.state === 'device')
      const unauthorized = (status?.devices ?? []).filter((device) => device.state === 'unauthorized')
      const adbReady = Boolean(status?.adb?.ok)

      const frameCaption = useMemo(() => {
        if (!running) return '未连接'
        const size = sizeRef.current
        // 「收」是到达的帧，「解」是真正解码出来的帧；两者差得多就是浏览器端跟不上。
        return `${meta.deviceName || serial} · ${size.width}×${size.height} · ${stats.fps}fps`
      }, [meta.deviceName, running, serial, stats])

      return h('div', {
        style: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8, padding: 10, fontSize: 12 }
      }, [

        h('div', { key: 'bar', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('select', {
            key: 'pick',
            value: serial,
            onChange: (event) => setSerial(event.target.value),
            disabled: running,
            style: { ...buttonStyle, flex: '1 1 140px', minWidth: 0, cursor: running ? 'default' : 'pointer' }
          }, devices.length === 0
            ? [h('option', { key: 'none', value: '' }, adbReady ? '未检测到设备' : 'adb 不可用')]
            : devices.map((device) => h('option', { key: device.serial, value: device.serial }, `${device.model || device.serial} (${device.serial})`))),
          running
            ? h('button', { key: 'dis', style: buttonStyle, onClick: disconnect }, '断开')
            : h('button', { key: 'con', style: primaryStyle, onClick: () => connect(), disabled: !serial || Boolean(busy) }, busy || '连接')
        ]),
        h('div', { key: 'frame', style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
          h('span', { key: 'cap', style: { opacity: 0.7, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, frameCaption),
          h('select', {
            key: 'quality',
            value: String(quality),
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
            style: { ...buttonStyle, padding: '4px 8px', opacity: audioOn ? 1 : 0.6 },
            onClick: () => {
              setAudioOn((value) => {
                if (value) audioRef.current.context?.suspend?.()
                else audioRef.current.context?.resume?.()
                return !value
              })
            },
            title: '声音需要 Android 11+'
          }, audioOn ? '🔊' : '🔇')
        ]),
        h('div', {
          key: 'stage',
          ref: boxRef,
          style: {
            flex: 1,
            minHeight: 120,
            background: '#000',
            borderRadius: 10,
            border: '1px solid rgba(127,127,127,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            position: 'relative',
            userSelect: 'none',
          }
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
          }),,
          h('canvas', {
            key: 'canvas',
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
          running ? null : h('div', {
            key: 'hint',
            style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, opacity: 0.75, lineHeight: 1.7 }
          }, adbReady
            ? (unauthorized.length > 0
                ? '手机上弹出过「允许 USB 调试吗？」，点允许后重试'
                : devices.length > 0
                  ? '已发现设备，点右上「连接」开始投屏'
                  : '插上手机，打开开发者选项里的「USB 调试」，然后点连接')
            : `adb 不可用：${status?.adb?.error ?? '未找到 adb'}`)
        ]),
        h('div', { key: 'recover', style: { display: 'flex', gap: 6 } }, [
          h('button', {
            key: 'rebuild',
            style: { ...buttonStyle, padding: '5px 8px', flex: 1 },
            disabled: !running,
            onClick: () => {
              // 重建画面：丢弃解码器并重连流，由宿主重发 SPS/PPS 与关键帧。
              decoderRef.current = null
              codecRef.current = null
              configKeyRef.current = ''
              needKeyRef.current = true
              restartStreamRef.current()
            }
          }, '重建画面')
        ]),
        h('div', { key: 'tools', style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, [
          ['返回', { kind: 'back' }],
          ['Home', { kind: 'key', keycode: 3 }],
          ['任务', { kind: 'key', keycode: 187 }],
          ['电源', { kind: 'power' }],
          ['旋转', { kind: 'rotate' }],
          ['通知', { kind: 'notifications' }],
          ['音量-', { kind: 'key', keycode: 25 }],
          ['音量+', { kind: 'key', keycode: 24 }],
          ['全屏', { kind: 'fullscreen' }]
        ].map(([label, message]) => h('button', {
          key: label,
          style: { ...buttonStyle, padding: '5px 8px' },
          disabled: !running && message.kind !== 'fullscreen',
          onClick: () => {
            // 侧边栏很窄，平板横屏时全屏看才是常态。
            if (message.kind === 'fullscreen') {
              const canvas = canvasRef.current
              if (canvas?.requestFullscreen) canvas.requestFullscreen().catch(() => {})
              return
            }
            sendControl(message)
          }
        }, label))),
        h('div', { key: 'wire', style: { display: 'flex', gap: 6 } }, [
          h('input', {
            key: 'addr',
            value: wireless,
            placeholder: '无线调试：192.168.1.5:5555',
            onChange: (event) => setWireless(event.target.value),
            style: {
              ...buttonStyle,
              flex: 1,
              minWidth: 0,
              cursor: 'text',
              fontFamily: 'inherit'
            }
          }),
          h('button', { key: 'wire-go', style: buttonStyle, disabled: !wireless.trim(), onClick: connectWireless }, '连接')
        ]),
        controlError.length > 0
          ? h('div', { key: 'cerr', style: { color: '#c9803a', lineHeight: 1.5, wordBreak: 'break-word' } }, `控制失败：${controlError}`)
          : null,
        error.length > 0
          ? h('div', { key: 'err', style: { color: '#e0645c', lineHeight: 1.5, wordBreak: 'break-word' } }, error)
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
