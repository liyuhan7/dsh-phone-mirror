// iOS 键盘映射：把前端键码与可打印 ASCII 字符转换为 USB HID Keyboard Usage ID（Page 0x07）。

export const HID_MOD = {
  CTRL: 0xe0,
  SHIFT: 0xe1,
  ALT: 0xe2,
  GUI: 0xe3 // iOS Command (⌘)
}

// 安卓 KeyEvent 键码 → USB HID Usage ID
const KEYCODE_TO_HID = {
  // a-z (29..54 -> 0x04..0x1d)
  29: 0x04, 30: 0x05, 31: 0x06, 32: 0x07, 33: 0x08, 34: 0x09, 35: 0x0a,
  36: 0x0b, 37: 0x0c, 38: 0x0d, 39: 0x0e, 40: 0x0f, 41: 0x10, 42: 0x11,
  43: 0x12, 44: 0x13, 45: 0x14, 46: 0x15, 47: 0x16, 48: 0x17, 49: 0x18,
  50: 0x19, 51: 0x1a, 52: 0x1b, 53: 0x1c, 54: 0x1d,
  // 1-9 (8..16 -> 0x1e..0x26), 0 (7 -> 0x27)
  8: 0x1e, 9: 0x1f, 10: 0x20, 11: 0x21, 12: 0x22, 13: 0x23, 14: 0x24, 15: 0x25, 16: 0x26,
  7: 0x27,
  // 特殊键
  66: 0x28,  // Enter
  67: 0x2a,  // Backspace
  61: 0x2b,  // Tab
  62: 0x2c,  // Space
  111: 0x29, // Escape
  112: 0x4c, // Delete
  58: 0x39,  // 语言切换键（CapsLock 用法码，由 Ctrl+空格 触发）
  19: 0x52,  // ArrowUp
  20: 0x51,  // ArrowDown
  21: 0x50,  // ArrowLeft
  22: 0x4f,  // ArrowRight
  122: 0x4a, // Home
  123: 0x4d, // End
  92: 0x4b,  // PageUp
  93: 0x4e,  // PageDown
  124: 0x49  // Insert
}

// ASCII 标点与符号 → [usage, needsShift]
const SYMBOL_TO_HID = {
  ' ': [0x2c, false],
  '\n': [0x28, false],
  '\r': [0x28, false],
  '\t': [0x2b, false],
  '-': [0x2d, false], '_': [0x2d, true],
  '=': [0x2e, false], '+': [0x2e, true],
  '[': [0x2f, false], '{': [0x2f, true],
  ']': [0x30, false], '}': [0x30, true],
  '\\': [0x31, false], '|': [0x31, true],
  ';': [0x33, false], ':': [0x33, true],
  "'": [0x34, false], '"': [0x34, true],
  '`': [0x35, false], '~': [0x35, true],
  ',': [0x36, false], '<': [0x36, true],
  '.': [0x37, false], '>': [0x37, true],
  '/': [0x38, false], '?': [0x38, true],
  '!': [0x1e, true],
  '@': [0x1f, true],
  '#': [0x20, true],
  '$': [0x21, true],
  '%': [0x22, true],
  '^': [0x23, true],
  '&': [0x24, true],
  '*': [0x25, true],
  '(': [0x26, true],
  ')': [0x27, true]
}

/** 将前端 keycode + metastate 转为 HID usages 数组；Windows 的 Ctrl 映射为 iOS 的 ⌘（GUI）。 */
export function keycodeToHidUsages(keycode, metastate = 0) {
  const usage = KEYCODE_TO_HID[keycode]
  if (usage === undefined) return null
  const usages = []
  if ((metastate & 0x1) !== 0) usages.push(HID_MOD.SHIFT)
  if ((metastate & 0x02) !== 0) usages.push(HID_MOD.ALT)
  if ((metastate & 0x1000) !== 0 || (metastate & 0x10000) !== 0) usages.push(HID_MOD.GUI)
  usages.push(usage)
  return usages
}

/** 将单个可打印 ASCII 字符转为 HID usages 数组；非 ASCII 返回 null。 */
export function charToHidUsages(char) {
  if (typeof char !== 'string' || char.length !== 1) return null
  const code = char.charCodeAt(0)
  if (code >= 0x61 && code <= 0x7a) {
    return [0x04 + (code - 0x61)]
  }
  if (code >= 0x41 && code <= 0x5a) {
    return [HID_MOD.SHIFT, 0x04 + (code - 0x41)]
  }
  if (code >= 0x31 && code <= 0x39) {
    return [0x1e + (code - 0x31)]
  }
  if (code === 0x30) {
    return [0x27]
  }
  const sym = SYMBOL_TO_HID[char]
  if (!sym) return null
  return sym[1] ? [HID_MOD.SHIFT, sym[0]] : [sym[0]]
}
