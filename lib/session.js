// 两条投屏实现：
//   1. ScrcpySession —— 推 scrcpy-server，走 H.264 硬编码 + 控制 socket，60fps 主线；
//   2. ScreencapSession —— 只用 adb 反复截屏，作为旧设备/失败时的兜底（约 3~6fps）。
// 两者对上层暴露同一组事件，index.js 不需要区分。
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/** scrcpy-server 的版本号必须与 jar 完全一致，否则服务端拒绝启动。 */
export const SCRCPY_VERSION = '5.0.1'

export const BUNDLED_SERVER = join(pluginRoot, 'tools', 'scrcpy-server.jar')

/** 在 127.0.0.1 上申请一个空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 从 socket 上按需读取定长字节，内部自己攒缓冲。 */
class SocketReader {
  constructor(socket) {
    this.socket = socket
    this.chunks = []
    this.length = 0
    this.$need = null
    this.closed = false
    socket.on('data', (chunk) => {
      this.chunks.push(chunk)
      this.length += chunk.length
      this.$pump()
    })
    socket.on('close', () => {
      this.closed = true
      this.$pump()
    })
    socket.on('error', () => {
      this.closed = true
      this.$pump()
    })
  }

  $take(n) {
    const merged = Buffer.concat(this.chunks, this.length)
    const head = merged.subarray(0, n)
    const rest = merged.subarray(n)
    this.chunks = rest.length > 0 ? [rest] : []
    this.length = rest.length
    return head
  }

  $pump() {
    const pending = this.$need
    if (!pending) return
    if (this.length >= pending.size) {
      this.$need = null
      pending.resolve(this.$take(pending.size))
      return
    }
    if (this.closed) {
      this.$need = null
      pending.reject(new Error('设备连接已断开'))
      return
    }
    // 半包，继续等下一批数据。
  }

  /** 读满 size 字节；不足时挂起。 */
  read(size) {
    return new Promise((resolve, reject) => {
      if (this.$need) {
        // 只允许一个挂起的读取，并发读会把前一个吞掉。
        reject(new Error('同一连接上出现并发读取'))
        return
      }
      if (this.length >= size) {
        resolve(this.$take(size))
        return
      }
      this.$need = { size, resolve, reject }
      this.$pump()
    })
  }
}

/**
 * scrcpy 主线会话。
 * 生命周期：start() → ready → (video/audio 事件) → stop()
 */
export class ScrcpySession extends EventEmitter {
  constructor({ adb, serial, maxSize, maxFps, videoBitRate, audio, serverPath, version }) {
    super()
    this.adb = adb
    this.serial = serial
    this.maxSize = maxSize
    this.maxFps = maxFps
    this.videoBitRate = videoBitRate
    this.wantAudio = audio
    this.serverPath = serverPath ?? BUNDLED_SERVER
    this.version = version ?? SCRCPY_VERSION
    this.scid = Math.floor(Math.random() * 0x7fffffff)
    this.sockets = { video: null, audio: null, control: null }
    this.server = null
    this.port = null
    this.child = null
    this.state = 'idle'
    this.screen = null
    this.deviceName = ''
    this.audioCodec = null
    this.videoCodec = null
    this.pending = []
    // 服务端 stderr：超时时只有它能说明真正原因。
    this.serverOutput = ''
    // 启动失败时用它立刻拒绝连接收集，避免干等超时。
    this.pendingReject = null
    this.waiters = []
  }

  async start() {
    if (!existsSync(this.serverPath)) {
      throw new Error(`缺少 scrcpy-server.jar：${this.serverPath}`)
    }
    this.state = 'starting'
    const remote = `/data/local/tmp/dsh-phone-mirror-${this.version}.jar`
    this.remoteJar = remote
    // 服务端把 socket 名定义为 scrcpy_%08x（DesktopConnection.getSocketName），
    // 必须按 8 位零填充的十六进制命名，否则设备连过来是 Connection refused。
    this.socketName = `scrcpy_${this.scid.toString(16).padStart(8, '0')}`

    await this.adb.pushJar(this.serial, this.serverPath, remote)

    this.port = await freePort()
    this.server = createServer((socket) => this.$accept(socket))
    this.server.on('error', (error) => this.emit('error', { message: `本地端口监听失败：${error.message}` }))
    await new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', resolve))

    await this.adb.reverseAdd(this.serial, `localabstract:${this.socketName}`, `tcp:${this.port}`)

    const options = [
      `com.genymobile.scrcpy.Server ${this.version}`,
      `scid=${this.scid.toString(16)}`,
      'log_level=warn',
      'tunnel_forward=false',
      `audio=${this.wantAudio ? 'true' : 'false'}`,
      'control=true',
      'video_codec=h264',
      'send_device_meta=true',
      'send_frame_meta=true',
      'send_stream_meta=true',
      'cleanup=true',
      'power_on=true',
      'stay_awake=true'
    ]
    if (this.maxSize > 0) options.push(`max_size=${this.maxSize}`)
    if (this.maxFps > 0) options.push(`max_fps=${this.maxFps}`)
    if (this.videoBitRate > 0) options.push(`video_bit_rate=${this.videoBitRate}`)

    const command = `CLASSPATH=${remote} app_process / ${options.join(' ')}`
    this.emit('log', { message: `启动 server: ${command}` })
    this.child = spawn(this.adb.binary, ['-s', this.serial, 'shell', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // 服务端 stderr 是唯一的失败线索（例如 Android 版本过低）。
    this.child.stdout.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim()
      if (message.length === 0) return
      this.serverOutput = (this.serverOutput + ' [out] ' + message).slice(-2000)
      this.emit('log', { message })
    })
    this.child.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim()
      if (message.length > 0) this.emit('log', { message })
    })
    this.child.on('exit', (code) => {
      // 端口还没连上就退出，说明服务端起不来，立刻把原因带回调用方。
      if (this.pendingReject) {
        const detail = String(this.serverOutput ?? '').trim()
        const reject = this.pendingReject
        this.pendingReject = null
        reject(new Error(`scrcpy-server 启动即退出（code ${code}）：${detail.slice(0, 400)}`))
      }
      if (this.state !== 'stopping' && this.state !== 'stopped') {
        this.state = 'failed'
        this.emit('error', { message: `scrcpy-server 退出（code ${code}）` })
        this.emit('close')
      }
    })

    // 三条连接按 video → audio → control 的顺序到达。
    const wanted = this.wantAudio ? 3 : 2
    const accepted = await this.$collect(wanted, 12000)
    this.sockets.video = accepted[0]
    if (this.wantAudio) {
      this.sockets.audio = accepted[1]
      this.sockets.control = accepted[2]
    } else {
      this.sockets.control = accepted[1]
    }

    await this.$readVideoHeader()
    if (this.sockets.audio) {
      // 先读完编码 id 再收包：两条读取并发会把包头读歪。
      await this.$readAudioHeader().catch((error) => {
        this.emit('log', { message: `读取音频头失败：${error.message}` })
      })
      if (this.audioCodec) this.$pumpAudio()
    }
    this.$pumpVideo()
    this.$watchControl()

    this.state = 'running'
    this.emit('ready', { deviceName: this.deviceName, screen: this.screen, audio: Boolean(this.sockets.audio) })
  }

  $accept(socket) {
    socket.setNoDelay(true)
    const waiter = this.waiters.shift()
    if (waiter) waiter(socket)
    else this.pending.push(socket)
  }

  /** 取到 n 条连接，超时则视为服务端启动失败。 */
  $collect(count, timeoutMs) {
    return new Promise((resolve, reject) => {
      this.pendingReject = reject
      const collected = this.pending.splice(0, count)
      if (collected.length === count) {
        resolve(collected)
        return
      }
      const timer = setTimeout(() => {
        // 这个回调跑在 await 之外：抛异常就是未捕获异常，会直接结束宿主进程。
        try {
          this.waiters = []
          const detail = String(this.serverOutput ?? '').trim()
          const reason = detail.length > 0
            ? `等待设备连接超时，服务端报错：${detail.slice(0, 400)}`
            : '等待设备连接超时：服务端没有连回来（服务端无输出）'
          reject(new Error(reason))
        } catch (failure) {
          reject(failure instanceof Error ? failure : new Error(String(failure)))
        }
      }, timeoutMs)
      const grab = (socket) => {
        collected.push(socket)
        if (collected.length === count) {
          clearTimeout(timer)
          this.waiters = []
          resolve(collected)
          return
        }
        this.waiters.push(grab)
      }
      this.waiters.push(grab)
    })
  }

  async $readVideoHeader() {
    const reader = new SocketReader(this.sockets.video)
    this.videoReader = reader
    // 第一条 socket 先发 64 字节设备名：UTF-8、\0 填充、没有长度前缀。
    const nameField = await reader.read(64)
    const nameEnd = nameField.indexOf(0)
    this.deviceName = nameField.subarray(0, nameEnd === -1 ? 64 : nameEnd).toString('utf8')

    const codec = await reader.read(4)
    this.videoCodec = codec.toString('latin1')
    if (this.videoCodec !== 'h264') {
      throw new Error(`暂不支持 ${this.videoCodec} 视频编码，请改用 h264`)
    }
    const { size } = await this.adb.screenSize(this.serial).then((value) => ({ size: value }))
    this.deviceScreen = size ?? null
  }

  async $readAudioHeader() {
    const reader = new SocketReader(this.sockets.audio)
    this.audioReader = reader
    // 音频 socket 只有 4 字节编码 id，没有设备名。
    const codec = await reader.read(4)
    this.audioCodec = codec.toString('latin1')
    this.emit('audio-codec', { codec: this.audioCodec })
  }

  async $pumpVideo() {
    const reader = this.videoReader
    try {
      for (;;) {
        const header = await reader.read(12)
        if ((header[0] & 0x80) !== 0) {
          // session packet：分辨率变化（旋转、折叠、分屏）。
          const width = header.readUInt32BE(4)
          const height = header.readUInt32BE(8)
          this.screen = { width, height }
          this.emit('meta', { screen: this.screen, deviceName: this.deviceName })
          continue
        }
        const flags = header[0]
        const pts = header.readBigUInt64BE(0) & ((1n << 61n) - 1n)
        const size = header.readUInt32BE(8)
        const data = await reader.read(size)
        this.emit('video', {
          data,
          pts: Number(pts),
          config: (flags & 0x40) !== 0,
          key: (flags & 0x20) !== 0
        })
      }
    } catch (error) {
      if (this.state === 'running') this.emit('error', { message: `视频流中断：${error.message}` })
    }
  }

  async $pumpAudio() {
    const reader = this.audioReader
    try {
      for (;;) {
        const header = await reader.read(12)
        const flags = header[0]
        const pts = header.readBigUInt64BE(0) & ((1n << 61n) - 1n)
        const size = header.readUInt32BE(8)
        const data = await reader.read(size)
        this.emit('audio', { data, pts: Number(pts), config: (flags & 0x40) !== 0 })
      }
    } catch {
      // 音频掉了不影响画面，静默降级。
      this.emit('audio-codec', { codec: null })
    }
  }

  $watchControl() {
    // 控制 socket 是双向的：设备会通过它回传剪贴板等消息，先读掉避免缓冲膨胀。
    this.sockets.control.on('data', () => {})
    this.sockets.control.on('error', () => {})
  }

  send(buffer) {
    const socket = this.sockets.control
    if (!socket || socket.destroyed) return false
    socket.write(buffer)
    return true
  }

  async stop() {
    if (this.state === 'stopped' || this.state === 'stopping') return
    this.state = 'stopping'
    for (const socket of Object.values(this.sockets)) {
      try { socket?.destroy() } catch {}
    }
    try { this.child?.kill() } catch {}
    await this.adb.reverseRemove(this.serial, `localabstract:${this.socketName}`).catch(() => {})
    await new Promise((resolve) => {
      if (!this.server) { resolve(); return }
      this.server.close(() => resolve())
      setTimeout(resolve, 500)
    })
    this.state = 'stopped'
    this.emit('close')
  }
}

/**
 * 兜底会话：只用 adb 截屏 + input 注入。
 * 没有 H.264、没有音频，但几乎在所有设备和 Android 版本上都能出画面。
 */
export class ScreencapSession extends EventEmitter {
  constructor({ adb, serial, intervalMs = 260 }) {
    super()
    this.adb = adb
    this.serial = serial
    this.intervalMs = intervalMs
    this.state = 'idle'
    this.timer = null
    this.busy = false
    this.screen = null
    this.drag = null
  }

  async start() {
    this.state = 'starting'
    const screen = await this.adb.screenSize(this.serial)
    if (!screen) throw new Error('读取不到屏幕分辨率，设备可能未授权')
    this.screen = screen
    const first = await this.$grab()
    if (!first) throw new Error('截屏失败：请确认已允许 USB 调试授权')
    this.state = 'running'
    this.emit('ready', { deviceName: this.serial, screen: this.screen, audio: false })
    this.emit('image', { data: first })
    this.$loop()
  }

  $loop() {
    this.timer = setTimeout(async () => {
      if (this.state !== 'running') return
      const data = await this.$grab()
      if (data) this.emit('image', { data })
      this.$loop()
    }, this.intervalMs)
  }

  async $grab() {
    if (this.busy) return null
    this.busy = true
    try {
      const { ok, data } = await this.adb.execOut(this.serial, ['screencap', '-p'], 12000)
      if (!ok || data.length === 0) return null
      return data
    } finally {
      this.busy = false
    }
  }

  /** 归一化坐标 → 设备像素。 */
  $point(x, y) {
    const width = this.screen?.width ?? 1080
    const height = this.screen?.height ?? 1920
    return [Math.round(x * width), Math.round(y * height)]
  }

  async send(message) {
    switch (message.kind) {
      case 'touch': {
        const [px, py] = this.$point(message.x, message.y)
        if (message.action === 'down') {
          this.drag = { x: px, y: py, at: Date.now() }
          return true
        }
        if (message.action === 'up') {
          const start = this.drag ?? { x: px, y: py, at: Date.now() }
          const duration = Math.min(1500, Date.now() - start.at)
          const moved = Math.abs(start.x - px) + Math.abs(start.y - py) > 12
          if (moved || duration > 250) {
            await this.adb.shell(this.serial, `input swipe ${start.x} ${start.y} ${px} ${py} ${Math.max(60, duration)}`)
          } else {
            await this.adb.shell(this.serial, `input tap ${px} ${py}`)
          }
          this.drag = null
          return true
        }
        return true
      }
      case 'scroll': {
        const [px, py] = this.$point(message.x, message.y)
        // 客户端已按 scrcpy 约定取反，降级模式要还原成「正数=向上滑」。
        const distance = Math.round(Math.max(-400, Math.min(400, -(message.dy ?? 0) * 240)))
        if (distance !== 0) {
          await this.adb.shell(this.serial, `input swipe ${px} ${py} ${px} ${py - distance} 220`)
        }
        return true
      }
      case 'key':
        await this.adb.shell(this.serial, `input keyevent ${message.keycode}`)
        return true
      case 'text':
        // input text 不接受空格与特殊字符，需要转义。
        await this.adb.shell(this.serial, `input text ${String(message.text).replace(/([^\w])/g, '\\$1')}`)
        return true
      case 'back':
        await this.adb.shell(this.serial, 'input keyevent 4')
        return true
      case 'power':
        await this.adb.shell(this.serial, 'input keyevent 26')
        return true
      default:
        return false
    }
  }

  async stop() {
    this.state = 'stopped'
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.emit('close')
  }
}

