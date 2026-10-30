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
          if (data.session?.state === 'running') {
            setMeta((previous) => (previous.state === 'running' ? previous : { ...data.session }))
          }
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
        const controller = new AbortController()
        abortRef.current = controller
        const parser = new FrameParser()
        counterRef.current = { received: 0, bytes: 0, at: Date.now() }
        try {
          const response = await fetch(`${BASE}/stream`, { signal: controller.signal, cache: 'no-store' })
          if (!response.ok || !response.body) throw new Error(`流连接失败（${response.status}）`)
          const reader = response.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            counterRef.current.bytes += value.length
            for (const frame of parser.push(value)) {
              if (frame.kind === KIND.META) {
                let payload = {}
                try { payload = JSON.parse(new TextDecoder().decode(frame.payload)) } catch {}
                if (payload.type === 'error') setError(payload.message ?? '会话出错')
                if (payload.type === 'meta') {
                  if (payload.screen) {
                    const changed = payload.screen.width !== sizeRef.current.width ||
                      payload.screen.height !== sizeRef.current.height
                    sizeRef.current = payload.screen
                    // 分辨率变化使旧参考帧失效，等待关键帧后重建。
                    if (changed) {
                      try { decoderRef.current?.close() } catch {}
                      decoderRef.current = null
                      codecRef.current = null
                      wantKeyRef.current = true
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
                counterRef.current.lastFrameAt = Date.now()
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
                // 新建的解码器尚无参考帧，只接受关键帧。
                if (needKeyRef.current || wantKeyRef.current) {
                  if (!isKey) continue
                  needKeyRef.current = false
                  wantKeyRef.current = false
                }
                // 解码排队过深时丢非关键帧，避免延迟累积。
                if (!isKey && decoder.decodeQueueSize > 6) {
                  continue
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
              // 长时间收不到新帧时主动重连一次。
              const lastFrameAt = counterRef.current.lastFrameAt ?? 0
              if (lastFrameAt > 0 && now - lastFrameAt > 5000 &&
                  now - (counterRef.current.lastWatchdogAt ?? 0) > 3000) {
                counterRef.current.lastWatchdogAt = now
                restartStreamRef.current()
                continue
              }
              const fps = (counterRef.current.received * 1000) / elapsed
              setStats({ fps: Math.round(fps) })
              counterRef.current = { received: 0, bytes: 0, at: now }
            }
          }
        } catch (failure) {
          if (failure.name !== 'AbortError') setError(failure.message)
        } finally {
          // 流结束后如果会话还在跑，说明连接被意外中断（宿主重启、代理超时等），
          // 自动重连；否则面板会停在最后一帧，只能手动刷新。
          if (!stoppedRef.current) {
            setTimeout(() => {
              if (!stoppedRef.current) restartStreamRef.current()
            }, 800)
          }
        }
      }, [audioOn, ensureAudio, ensureDecoder, stopStream])

      // 重连 = 停掉旧流（会关闭解码器）+ 重新拉流（宿主据此重发关键帧）。
      restartStreamRef.current = () => {
        stopStream()
        startStream().catch(() => {})
      }

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

      // 面板卸载或切走时必须断流，否则后端会一直推。
      useEffect(() => () => stopStream(), [stopStream])

      useEffect(() => {
        // 挂在外层容器上：canvas 用 object-fit:contain 撑满，事件在容器上更稳。
        const canvas = boxRef.current
        if (!canvas) return undefined
        const onPointerDown = (event) => {
          try { canvas.setPointerCapture?.(event.pointerId) } catch {}
          const point = toDevice(event)
          if (!point) return
          pointerRef.current = { down: true, x: point.x, y: point.y, lastMove: 0 }
          sendControl({ kind: 'touch', action: 'down', ...point })
          event.preventDefault()
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
        const special = {
          Enter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 111,
          ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22
        }
        if (special[event.key] !== undefined) {
          sendControl({ kind: 'key', keycode: special[event.key] })
          event.preventDefault()
          return
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return
        if (event.key.length === 1) {
          sendControl({ kind: 'text', text: event.key })
          event.preventDefault()
        }
      }, [running, sendControl])

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
        style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8, padding: 10, fontSize: 12 }
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
            position: 'relative'
          }
        }, [
          h('canvas', {
            key: 'canvas',
            ref: canvasRef,
            tabIndex: 0,
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
    exports.inject = ['slots', 'sidebarRightTabs']
    return module.exports
  }
})
