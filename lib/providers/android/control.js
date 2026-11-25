// 安卓 scrcpy 控制消息分发：把前端归一化指针/滚轮/按键/文本转换成 scrcpy 控制协议字节。
import * as control from '../../protocol.js'

/** 修饰位到安卓修饰键码：shift 0x1、alt 0x02、ctrl 0x1000、meta 0x10000。 */
const MODIFIER_KEYS = [
  [0x1000, 113], // KEYCODE_CTRL_LEFT
  [0x02, 57],    // KEYCODE_ALT_LEFT
  [0x1, 59],     // KEYCODE_SHIFT_LEFT
  [0x10000, 117] // KEYCODE_META_LEFT
]

/** 按 UTF-8 字节数把文本切成不超过 300 字节的片段。 */
function splitText(text, limit = 300) {
  const chunks = []
  let current = ''
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > limit && current.length > 0) {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += char
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** 创建一条 scrcpy 控制分发器（独立维护剪贴板粘贴序号）。 */
export function createScrcpyController() {
  let clipboardSequence = 0

  function pressKey(target, code, metastate = 0) {
    if (!Number.isFinite(code)) return false
    const modifiers = MODIFIER_KEYS.filter(([bit]) => (metastate & bit) !== 0)
    for (const [, keycode] of modifiers) {
      target.send(control.keycode({ action: control.ACTION.DOWN, keycode, metastate }))
    }
    const down = target.send(control.keycode({
      action: control.ACTION.DOWN,
      keycode: code,
      metastate
    }))
    setTimeout(() => {
      try {
        target.send(control.keycode({ action: control.ACTION.UP, keycode: code, metastate }))
        for (const [, keycode] of modifiers.reverse()) {
          target.send(control.keycode({ action: control.ACTION.UP, keycode, metastate: 0 }))
        }
      } catch {}
    }, 30)
    return down
  }

  function sendText(target, value) {
    const text = String(value ?? '')
    if (text.length === 0) return false
    const chunks = splitText(text)
    chunks.forEach((chunk, index) => {
      const send = () => {
        try {
          if (/^[\x20-\x7e\n\r\t]*$/.test(chunk)) {
            target.send(control.text(chunk))
            return
          }
          clipboardSequence += 1
          target.send(control.setClipboard({ text: chunk, sequence: clipboardSequence, paste: true }))
        } catch {}
      }
      if (index === 0) send()
      else setTimeout(send, index * 40)
    })
    return true
  }

  return function dispatch(target, message) {
    if (!target || !message || typeof message !== 'object') return false
    const screen = target.screen ?? target.deviceScreen ?? { width: 1080, height: 1920 }
    switch (message.kind) {
      case 'touch':
        return target.send(control.touch({
          action: message.action === 'down' ? control.ACTION.DOWN
            : message.action === 'up' ? control.ACTION.UP
              : control.ACTION.MOVE,
          x: Number(message.x) * screen.width,
          y: Number(message.y) * screen.height,
          screen
        }))
      case 'scroll':
        return target.send(control.scroll({
          x: (message.x ?? 0.5) * screen.width,
          y: (message.y ?? 0.5) * screen.height,
          screen,
          dx: message.dx ?? 0,
          dy: message.dy ?? 0
        }))
      case 'key':
        return pressKey(target, Number(message.keycode), Number(message.metastate) || 0)
      case 'text':
        return sendText(target, message.text)
      case 'back':
        return pressKey(target, control.KEY.BACK)
      case 'power':
        return pressKey(target, control.KEY.POWER)
      case 'rotate':
        return target.send(control.rotateDevice())
      case 'reset':
        return target.send(control.resetVideo())
      case 'notifications':
        return target.send(control.expandNotifications())
      default:
        return false
    }
  }
}
