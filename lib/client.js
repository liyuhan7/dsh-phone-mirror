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
    // 上一次使用的设备序列号。
    let preferredSerial = ''

    /** 字母与数字的安卓键码，用于修饰键组合。 */
    const LETTER_OR_DIGIT = {
      a: 29, b: 30, c: 31, d: 32, e: 33, f: 34, g: 35, h: 36, i: 37, j: 38,
      k: 39, l: 40, m: 41, n: 42, o: 43, p: 44, q: 45, r: 46, s: 47, t: 48,
      u: 49, v: 50, w: 51, x: 52, y: 53, z: 54,
      0: 7, 1: 8, 2: 9, 3: 10, 4: 11, 5: 12, 6: 13, 7: 14, 8: 15, 9: 16
    }

    const clamp01 = (value) => Math.min(1, Math.max(0, value))

    // 引擎源码在这里内联（见 scripts/build-client.mjs）。
    //#inline ./engine.js

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
      const [keyboardActive, setKeyboardActive] = useState(false)
      // 输入浮层：显示正在输入的拼音。
      const [preedit, setPreedit] = useState('')
      // 引擎优先运行在 Worker，不可用时退回主线程。
      const engineRef = useRef(null)
      const openRef = useRef(false)
      // 画布代次：Worker 异常时重建 canvas 元素。
      const [epoch, setEpoch] = useState(0)
      const sizeRef = useRef({ width: 1080, height: 1920 })
      const pointerRef = useRef({ down: false, x: 0, y: 0, lastMove: 0 })
      // 音频出口状态；AudioContext 在主线程创建。
      const audioRef = useRef({ context: null, node: null, failed: false, starting: false, attached: false })
      // 引擎最后一次上报的时间。
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
          setAutoConnecting(Boolean(data.autoConnecting))
          // 宿主已有会话时直接接入。
          if (data.session?.state === 'running') attachSessionRef.current(data.session)
          const list = (data.devices ?? []).filter((device) => device.state === 'device')
          if (list.length > 0) {
            setSerial((current) => {
              if (current && list.some((item) => item.serial === current)) return current
              if (preferredSerial && list.some((item) => item.serial === preferredSerial)) return preferredSerial
              return list[0].serial
            })
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

      // 控制指令串行发送，参数走查询串。
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
          const payload = message.payload ?? {}
          // 会话结束后允许再次接入。
          if (payload.state === 'error' || payload.state === 'idle') attachedRef.current = false
          setMeta((previous) => ({ ...previous, ...payload }))
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
        setBusy('正在连接…')
        setError('')
        try {
          const result = await post('/connect', { serial, maxSize: overrideSize })
          preferredSerial = serial
          setMeta({ ...result.session, state: 'running' })
          // 会话被替换后让引擎重连。
          postEngine({ type: 'reset' })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [post, postEngine, serial])

      // 经 ref 取最新的 connect 闭包。
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

      // 切到无线：先结束会话，再在新地址上重连。
      const toWireless = useCallback(async () => {
        if (!serial || serial.includes(':') || busy) return
        const wasRunning = running
        setBusy('正在切到无线…')
        setError('')
        setNotice('')
        try {
          if (wasRunning) {
            await post('/disconnect')
            // 会话已停止，置为未连接。
            setMeta({ state: 'idle', deviceName: '', screen: null, mode: null })
          }
          const result = await post('/adb/tcpip', { serial })
          preferredSerial = result.address
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
            preferredSerial = result.address
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
          preferredSerial = address
          setSerial(address)
          await refresh()
          setNotice(`已连上：${address}`)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [pairConnect, post, refresh])

      // 只断开无线通道。
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

      // Worker 失联时由主线程重建画布。
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
          // 点击画面时接管键盘焦点。
          setTimeout(() => { try { typingRef.current?.focus({ preventScroll: true }) } catch {} }, 0)
          // 点击画面时恢复音频上下文。
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
          }
          return
        }

        // 输入法组字期间不逐字发送，等 compositionend 统一提交。
        if (event.isComposing || event.keyCode === 229) return

        // Esc 交还键盘焦点。
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
        // 在捕获阶段处理按键。
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [running, keyboardActive, onKeyDown])

      const devices = (status?.devices ?? []).filter((device) => device.state === 'device')
      // 无线设备以序列号是否包含冒号判断。
      const wirelessDevices = (status?.devices ?? []).filter((device) => device.serial.includes(':'))
      const unauthorized = (status?.devices ?? []).filter((device) => device.state === 'unauthorized')
      const adbReady = Boolean(status?.adb?.ok)

      const frameCaption = useMemo(() => {
        if (!running) return '未连接'
        const size = sizeRef.current
        // 帧率由引擎统计。
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
              setAudioOn((value) => {
                const next = !value
                const muted = !next
                const state = audioRef.current
                // 静音通过挂起音频上下文实现。
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
              // 这里只处理粘贴等来源。
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
              // 输入框保持可见。
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
          }, autoConnecting
            ? '系统正在自动连接…'
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
      // 页签关闭时结束设备会话。
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
