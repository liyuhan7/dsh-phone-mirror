// scrcpy 控制协议（客户端 → 设备）。
// 字节布局来自 scrcpy 仓库 app/tests/test_control_msg_serialize.c：
//   INJECT_TOUCH_EVENT = 32B, INJECT_SCROLL_EVENT = 21B,
//   INJECT_KEYCODE = 14B, INJECT_TEXT = 5B + UTF-8。
// 所有多字节整数均为大端。

export const MSG = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  RESET_VIDEO: 17
}

export const ACTION = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 }

/** scrcpy 的「通用手指」指针 id。 */
export const POINTER = {
  FINGER: 0xfffffffffffffffen
}

const BUTTON_PRIMARY = 1

/** 固定宽度大端写入小工具。 */
class Writer {
  constructor(size) {
    this.buffer = Buffer.alloc(size)
    this.offset = 0
  }
  u8(value) { this.buffer.writeUInt8(value & 0xff, this.offset); this.offset += 1; return this }
  u16(value) { this.buffer.writeUInt16BE(value & 0xffff, this.offset); this.offset += 2; return this }
  u32(value) { this.buffer.writeUInt32BE(value >>> 0, this.offset); this.offset += 4; return this }
  i32(value) { this.buffer.writeInt32BE(value | 0, this.offset); this.offset += 4; return this }
  i16(value) { this.buffer.writeInt16BE(value | 0, this.offset); this.offset += 2; return this }
  u64(value) { this.buffer.writeBigUInt64BE(BigInt(value) & 0xffffffffffffffffn, this.offset); this.offset += 8; return this }
  bytes(value) { this.buffer.set(value, this.offset); this.offset += value.length; return this }
  done() { return this.buffer.subarray(0, this.offset) }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** 触控事件；x/y 为设备像素，screen 为设备真实分辨率。 */
export function touch({ action, x, y, screen, pointerId = POINTER.FINGER, pressure = 1 }) {
  const width = Math.max(1, Math.round(screen.width))
  const height = Math.max(1, Math.round(screen.height))
  return new Writer(32)
    .u8(MSG.INJECT_TOUCH_EVENT)
    .u8(action)
    .u64(pointerId)
    .i32(clamp(Math.round(x), 0, width))
    .i32(clamp(Math.round(y), 0, height))
    .u16(width)
    .u16(height)
    .u16(action === ACTION.UP ? 0 : Math.round(clamp(pressure, 0, 1) * 0xffff))
    .u32(action === ACTION.MOVE ? 0 : BUTTON_PRIMARY)
    .u32(action === ACTION.MOVE ? 0 : BUTTON_PRIMARY)
    .done()
}

/** 滚轮：scrcpy 把 [-16, 16] 的浮点压成 i16 定点。 */
export function scroll({ x, y, screen, dx = 0, dy = 0 }) {
  const width = Math.max(1, Math.round(screen.width))
  const height = Math.max(1, Math.round(screen.height))
  // 定点换算并夹到 i16 边界。
  const fix = (value) => Math.max(-32768, Math.min(32767, Math.round(clamp(value, -16, 16) * 2048)))
  return new Writer(21)
    .u8(MSG.INJECT_SCROLL_EVENT)
    .i32(clamp(Math.round(x), 0, width))
    .i32(clamp(Math.round(y), 0, height))
    .u16(width)
    .u16(height)
    .i16(fix(dx))
    .i16(fix(dy))
    .u32(0)
    .done()
}

export function keycode({ action = ACTION.DOWN, keycode: code, repeat = 0, metastate = 0 }) {
  return new Writer(14)
    .u8(MSG.INJECT_KEYCODE)
    .u8(action)
    .u32(code)
    .u32(repeat)
    .u32(metastate)
    .done()
}

/** 设置设备剪贴板并可顺带粘贴，用于非 ASCII 文本。 */
export function setClipboard({ text, sequence = 0, paste = true }) {
  const payload = Buffer.from(String(text), 'utf8').subarray(0, 256 * 1024)
  return new Writer(14 + payload.length)
    .u8(MSG.SET_CLIPBOARD)
    .u64(sequence)
    .u8(paste ? 1 : 0)
    .u32(payload.length)
    .bytes(payload)
    .done()
}

/** 文本注入，仅用于纯 ASCII。 */
export function text(value) {
  const payload = Buffer.from(String(value), 'utf8').subarray(0, 300)
  return new Writer(5 + payload.length)
    .u8(MSG.INJECT_TEXT)
    .u32(payload.length)
    .bytes(payload)
    .done()
}

export const expandNotifications = () => new Writer(1).u8(MSG.EXPAND_NOTIFICATION_PANEL).done()
export const rotateDevice = () => new Writer(1).u8(MSG.ROTATE_DEVICE).done()

/** 请求服务端重建编码会话，重发 SPS/PPS 与关键帧。 */
export const resetVideo = () => new Writer(1).u8(MSG.RESET_VIDEO).done()

/** Android keycode 常量，只保留插件实际发出的键。 */
export const KEY = {
  BACK: 4,
  POWER: 26
}
