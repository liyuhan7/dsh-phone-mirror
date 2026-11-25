// 安卓直连会话代理：在独立 worker_threads 线程里托管 ScrcpySession 与本机 HTTP 端口，
// 宿主只维护生命周期与元数据，音视频流与高频控制由浏览器直接访问独立端口。
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'

const WORKER_URL = new URL('./direct-worker.js', import.meta.url)

export class AndroidDirectSession extends EventEmitter {
  constructor({ adb, serial, maxSize, maxFps, videoBitRate, audio, serverPath, version }) {
    super()
    this.adb = adb
    this.serial = serial
    this.maxSize = maxSize
    this.maxFps = maxFps
    this.videoBitRate = videoBitRate
    this.wantAudio = audio
    this.serverPath = serverPath
    this.version = version
    this.platform = 'android'
    this.mode = 'scrcpy'
    this.state = 'idle'
    this.deviceName = ''
    this.screen = null
    this.audioCodec = null
    this.videoCodec = null
    this.httpPort = 0
    this.worker = null
    this.$nextControlId = 1
    this.$controlWaiters = new Map()
  }

  async start() {
    this.state = 'starting'
    const worker = new Worker(WORKER_URL, {
      workerData: {
        adbBinary: this.adb.binary,
        serial: this.serial,
        maxSize: this.maxSize,
        maxFps: this.maxFps,
        videoBitRate: this.videoBitRate,
        audio: this.wantAudio,
        serverPath: this.serverPath,
        version: this.version
      }
    })
    this.worker = worker

    const readyInfo = await new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }

      worker.on('message', (message) => {
        if (!message || typeof message !== 'object') return
        if (message.type === 'ready') {
          finish(resolve, message.info)
          return
        }
        if (message.type === 'start-error') {
          finish(reject, new Error(message.message || 'scrcpy 启动失败'))
          return
        }
        if (message.type === 'control-reply') {
          const waiter = this.$controlWaiters.get(message.id)
          if (waiter) {
            this.$controlWaiters.delete(message.id)
            waiter(Boolean(message.ok))
          }
          return
        }
        if (message.type === 'meta') {
          if (message.info?.screen) this.screen = message.info.screen
          if (message.info?.deviceName) this.deviceName = message.info.deviceName
          this.emit('meta', message.info)
          return
        }
        if (message.type === 'audio-codec') {
          this.audioCodec = message.info?.codec ?? null
          this.emit('audio-codec', message.info)
          return
        }
        if (message.type === 'error') {
          if (this.state === 'running') {
            this.state = 'failed'
            this.emit('error', { message: message.message || 'scrcpy 会话异常' })
          }
          return
        }
        if (message.type === 'close') {
          if (this.state === 'running' || this.state === 'failed') {
            this.state = 'stopped'
            this.emit('close')
          }
        }
      })

      worker.once('error', (error) => {
        if (!settled) {
          finish(reject, error)
        } else if (this.state === 'running') {
          this.state = 'failed'
          this.emit('error', { message: `安卓直连线程异常：${error.message}` })
          this.emit('close')
        }
      })

      worker.once('exit', (code) => {
        for (const waiter of this.$controlWaiters.values()) waiter(false)
        this.$controlWaiters.clear()
        if (this.worker === worker) this.worker = null
        if (!settled) {
          finish(reject, new Error(`安卓直连线程退出（code ${code}）`))
        } else if (this.state === 'running') {
          this.state = 'failed'
          this.emit('error', { message: `安卓直连线程意外退出（code ${code}）` })
          this.emit('close')
        }
      })
    })

    this.deviceName = readyInfo.deviceName || this.serial
    this.screen = readyInfo.screen ?? null
    this.audioCodec = readyInfo.audioCodec ?? null
    this.videoCodec = readyInfo.videoCodec ?? null
    this.httpPort = readyInfo.videoPort || 0
    this.state = 'running'
    this.emit('ready', {
      deviceName: this.deviceName,
      screen: this.screen,
      audio: Boolean(this.audioCodec),
      videoPort: this.httpPort
    })
  }

  handleControl(message) {
    if (!this.worker || this.state !== 'running') return Promise.resolve(false)
    const id = this.$nextControlId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.$controlWaiters.delete(id)
        resolve(false)
      }, 1500)
      this.$controlWaiters.set(id, (ok) => {
        clearTimeout(timer)
        resolve(ok)
      })
      try {
        this.worker.postMessage({ type: 'control', id, payload: message })
      } catch {
        clearTimeout(timer)
        this.$controlWaiters.delete(id)
        resolve(false)
      }
    })
  }

  requestKeyframe() {
    try { this.worker?.postMessage({ type: 'reset' }) } catch {}
  }

  keepalive() {
    if (String(this.serial ?? '').includes(':')) {
      this.adb.shell(this.serial, 'input keyevent 224', 5000).catch(() => {})
    }
  }

  async stop() {
    if (this.state === 'stopped' || this.state === 'stopping') return
    this.state = 'stopping'
    const worker = this.worker
    this.worker = null
    for (const waiter of this.$controlWaiters.values()) waiter(false)
    this.$controlWaiters.clear()
    if (worker) {
      await new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(finish, 2500)
        worker.once('exit', finish)
        worker.on('message', (msg) => {
          if (msg?.type === 'stopped') finish()
        })
        try { worker.postMessage({ type: 'stop' }) } catch { finish() }
      })
      await worker.terminate().catch(() => {})
    }
    this.httpPort = 0
    this.state = 'stopped'
    this.emit('close')
  }
}
