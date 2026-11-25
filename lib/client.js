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

    /** iOS 直连键盘映射（与 lib/providers/ios/keymap.js 保持一致）。 */
    const IOS_HID_MOD = { SHIFT: 0xe1, ALT: 0xe2, GUI: 0xe3 }
    const IOS_KEYCODE_TO_HID = {
      29: 0x04, 30: 0x05, 31: 0x06, 32: 0x07, 33: 0x08, 34: 0x09, 35: 0x0a,
      36: 0x0b, 37: 0x0c, 38: 0x0d, 39: 0x0e, 40: 0x0f, 41: 0x10, 42: 0x11,
      43: 0x12, 44: 0x13, 45: 0x14, 46: 0x15, 47: 0x16, 48: 0x17, 49: 0x18,
      50: 0x19, 51: 0x1a, 52: 0x1b, 53: 0x1c, 54: 0x1d,
      8: 0x1e, 9: 0x1f, 10: 0x20, 11: 0x21, 12: 0x22, 13: 0x23, 14: 0x24, 15: 0x25, 16: 0x26,
      7: 0x27,
      66: 0x28, 67: 0x2a, 61: 0x2b, 62: 0x2c, 111: 0x29, 112: 0x4c, 58: 0x39,
      19: 0x52, 20: 0x51, 21: 0x50, 22: 0x4f,
      122: 0x4a, 123: 0x4d, 92: 0x4b, 93: 0x4e, 124: 0x49
    }
    const IOS_SYMBOL_TO_HID = {
      ' ': [0x2c, false], '\n': [0x28, false], '\r': [0x28, false], '\t': [0x2b, false],
      '-': [0x2d, false], '_': [0x2d, true], '=': [0x2e, false], '+': [0x2e, true],
      '[': [0x2f, false], '{': [0x2f, true], ']': [0x30, false], '}': [0x30, true],
      '\\': [0x31, false], '|': [0x31, true], ';': [0x33, false], ':': [0x33, true],
      "'": [0x34, false], '"': [0x34, true], '`': [0x35, false], '~': [0x35, true],
      ',': [0x36, false], '<': [0x36, true], '.': [0x37, false], '>': [0x37, true],
      '/': [0x38, false], '?': [0x38, true],
      '!': [0x1e, true], '@': [0x1f, true], '#': [0x20, true], '$': [0x21, true],
      '%': [0x22, true], '^': [0x23, true], '&': [0x24, true], '*': [0x25, true],
      '(': [0x26, true], ')': [0x27, true]
    }
    const iosKeycodeToHidUsages = (keycode, metastate = 0) => {
      const usage = IOS_KEYCODE_TO_HID[keycode]
      if (usage === undefined) return null
      const usages = []
      if ((metastate & 0x1) !== 0) usages.push(IOS_HID_MOD.SHIFT)
      if ((metastate & 0x02) !== 0) usages.push(IOS_HID_MOD.ALT)
      if ((metastate & 0x1000) !== 0 || (metastate & 0x10000) !== 0) usages.push(IOS_HID_MOD.GUI)
      usages.push(usage)
      return usages
    }
    const iosCharToHidUsages = (char) => {
      if (typeof char !== 'string' || char.length !== 1) return null
      const code = char.charCodeAt(0)
      if (code >= 0x61 && code <= 0x7a) return [0x04 + (code - 0x61)]
      if (code >= 0x41 && code <= 0x5a) return [IOS_HID_MOD.SHIFT, 0x04 + (code - 0x41)]
      if (code >= 0x31 && code <= 0x39) return [0x1e + (code - 0x31)]
      if (code === 0x30) return [0x27]
      const sym = IOS_SYMBOL_TO_HID[char]
      if (!sym) return null
      return sym[1] ? [IOS_HID_MOD.SHIFT, sym[0]] : [sym[0]]
    }

    const clamp01 = (value) => Math.min(1, Math.max(0, value))

    /** 按键是不是正落在别的输入框里（DSH 聊天框等）；这类按键不转发给手机。 */
    const isForeignEditable = (target) => {
      if (!target || typeof target !== 'object') return false
      if (target.isContentEditable === true) return true
      return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
    }

    // 引擎源码在这里内联（见 scripts/build-client.mjs）。
    //#inline ./engine.js

    // 控件样式表：尺寸与颜色取自 DSH 主题变量。
    const STYLE_ID = 'dsh-phone-mirror-css'
    const CSS = `
.dpm-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-sizing: border-box;
  height: calc(100% - 16px);
  min-height: 0;
  margin: 8px;
  padding: 10px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2));
  border-radius: var(--dsw-radius-lg, 16px);
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background: var(--dsw-alias-bg-layer-1, transparent);
  font-family: var(--dsw-font-family, inherit);
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: var(--dsw-font-xxs-12-line-height, 18px);
  color: var(--dsw-alias-label-primary, inherit);
}
.dpm-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dpm-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
  border-radius: var(--dsw-radius-md, 12px);
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background: var(--dsw-alias-markdown-code-block, rgba(127,127,127,0.04));
}
.dpm-subbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14));
}
.dpm-seg {
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 2px;
  height: 30px;
  padding: 2px;
  box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2));
  border-radius: var(--dsw-radius-sm, 8px);
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08));
}
.dpm-seg__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 100%;
  padding: 0 9px;
  border: 0;
  border-radius: calc(var(--dsw-radius-sm, 8px) - 2px);
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background: transparent;
  color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9));
  font-family: inherit;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition: background-color .14s ease, color .14s ease, box-shadow .14s ease;
}
.dpm-seg__btn:hover:not(:disabled):not(.dpm-seg__btn--active) {
  color: var(--dsw-alias-label-primary, inherit);
}
.dpm-seg__btn--active {
  background: var(--dsw-alias-button-elevated-fill, #fff);
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: var(--dsw-shadow-lv1, 0 1px 3px rgba(0,0,0,0.1));
}
.dpm-seg__btn:disabled {
  opacity: .55;
  cursor: not-allowed;
}
.dpm-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  min-width: 0;
  padding: 0 11px;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.24));
  border-radius: var(--dsw-radius-sm, 8px);
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  font-weight: 500;
  line-height: var(--dsw-font-xxs-12-line-height, 18px);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .14s ease, border-color .14s ease, color .14s ease, transform .08s ease;
}
.dpm-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1));
  border-color: var(--dsw-alias-border-l4, rgba(127,127,127,0.34));
}
.dpm-btn:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.16));
}
.dpm-btn:disabled {
  opacity: .42;
  cursor: not-allowed;
}
.dpm-btn:focus-visible,
.dpm-seg__btn:focus-visible,
.dpm-field:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4a6cf7);
  outline-offset: 1px;
}
.dpm-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #4a6cf7);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  box-shadow: var(--dsw-shadow-lv1, 0 1px 2px rgba(0, 0, 0, 0.1));
}
.dpm-btn--primary:hover:not(:disabled) {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-hover, #3d5ce0);
}
.dpm-btn--disconnect {
  border-color: rgba(224, 100, 92, 0.34);
  background: rgba(224, 100, 92, 0.08);
  color: var(--dsw-alias-state-error-primary, #e0645c);
}
.dpm-btn--disconnect:hover:not(:disabled) {
  border-color: rgba(224, 100, 92, 0.5);
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(224, 100, 92, 0.15));
}
.dpm-btn--compact {
  height: 26px;
  padding: 0 8px;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
}
.dpm-btn--icon {
  width: 30px;
  padding: 0;
  flex: none;
}
.dpm-btn--icon.dpm-btn--compact {
  width: 26px;
}
.dpm-btn--active {
  border-color: var(--dsw-alias-button-ghost-active-border, rgba(74, 108, 247, 0.36));
  background: var(--dsw-alias-button-ghost-active-fill, rgba(74, 108, 247, 0.1));
  color: var(--dsw-alias-label-primary, inherit);
}
.dpm-btn--active:hover:not(:disabled) {
  background: var(--dsw-alias-button-ghost-active-hover, rgba(74, 108, 247, 0.16));
}
.dpm-field {
  box-sizing: border-box;
  height: 30px;
  min-width: 0;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.26));
  border-radius: var(--dsw-radius-sm, 8px);
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background-color: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: var(--dsw-font-xxs-12-line-height, 18px);
  outline: none;
  transition: border-color .14s ease, background-color .14s ease;
}
.dpm-field:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l4, rgba(127,127,127,0.4));
}
.dpm-field:focus {
  border-color: var(--dsw-alias-state-business-primary, #4a6cf7);
}
.dpm-field:disabled {
  opacity: .52;
  cursor: default;
}
.dpm-field--compact {
  height: 26px;
  padding-left: 8px;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
}
.dpm-select {
  appearance: none;
  padding-right: 24px;
  cursor: pointer;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--dsw-alias-label-secondary, #8a8f98) 50%),
    linear-gradient(135deg, var(--dsw-alias-label-secondary, #8a8f98) 50%, transparent 50%);
  background-position: calc(100% - 13px) calc(50% + 0.5px), calc(100% - 9px) calc(50% + 0.5px);
  background-size: 4px 4px, 4px 4px;
  background-repeat: no-repeat;
}
.dpm-status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.dpm-status__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--dsw-alias-label-quaternary, rgba(127,127,127,0.45));
  transition: background-color .2s ease, box-shadow .2s ease;
}
.dpm-status__dot--live {
  background: var(--dsw-alias-state-success-primary, #18a974);
  box-shadow: 0 0 0 3px rgba(24, 169, 116, 0.16);
}
.dpm-status__dot--busy {
  background: var(--dsw-alias-state-warn-primary, #e5933a);
  box-shadow: 0 0 0 3px rgba(229, 147, 58, 0.18);
  animation: dpm-pulse 1.4s ease-in-out infinite;
}
@keyframes dpm-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.dpm-caption {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.92));
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dpm-caption--live {
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 500;
}
.dpm-caption__meta {
  color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.88));
  font-weight: 400;
}
.dpm-stream-ctrls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.dpm-stage {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  overflow: hidden;
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--dsw-radius-lg, 16px);
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background:
    radial-gradient(circle at 50% 42%, rgba(74, 108, 247, 0.12), transparent 68%),
    radial-gradient(circle at 50% 50%, #141720 0%, #08090d 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), inset 0 0 24px rgba(0, 0, 0, 0.45);
  user-select: none;
}
.dpm-stage--running {
  background: radial-gradient(circle at 50% 50%, #11131a 0%, #050608 100%);
}
.dpm-stage--fullscreen {
  position: fixed;
  inset: 0;
  z-index: 60;
  border: 0;
  border-radius: 0;
  background: #000;
}
.dpm-exit {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 3;
  height: 32px;
  padding: 0 12px;
  background: rgba(15, 17, 23, 0.68);
  backdrop-filter: blur(10px);
  border-color: rgba(255, 255, 255, 0.22);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  color: #fff;
}
.dpm-exit:hover:not(:disabled) {
  background: rgba(26, 29, 38, 0.84);
  border-color: rgba(255, 255, 255, 0.36);
}
.dpm-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  text-align: center;
}
.dpm-empty-device {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 100%;
  max-width: 224px;
  padding: 22px 18px 20px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 26px;
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.015) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 16px 36px -12px rgba(0, 0, 0, 0.55);
}
.dpm-empty-device__notch {
  width: 34px;
  height: 4px;
  margin-bottom: 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
}
.dpm-empty-device__badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background: rgba(74, 108, 247, 0.14);
  border: 0.5px solid rgba(74, 108, 247, 0.32);
  color: #7d9bff;
}
.dpm-empty-device__badge--ready {
  background: rgba(24, 169, 116, 0.15);
  border-color: rgba(24, 169, 116, 0.36);
  color: #3dd69d;
}
.dpm-empty-device__badge--warn {
  background: rgba(229, 147, 58, 0.15);
  border-color: rgba(229, 147, 58, 0.36);
  color: #f4ae5c;
}
.dpm-empty-device__text {
  color: rgba(235, 238, 245, 0.82);
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: 1.6;
}
.dpm-empty-device__bar {
  width: 46px;
  height: 3px;
  margin-top: 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
}
.dpm-dock {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
  border-radius: var(--dsw-radius-md, 12px);
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background: var(--dsw-alias-markdown-code-block, rgba(127,127,127,0.04));
}
.dpm-nav-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dpm-nav-bar .dpm-btn {
  flex: 1 1 0;
  height: 30px;
  padding: 0 8px;
}
.dpm-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.dpm-tools__group {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  gap: 4px;
}
.dpm-tools__group--volume {
  flex: 0 0 auto;
  gap: 0;
}
.dpm-tools__group--volume .dpm-btn {
  padding: 0 8px;
}
.dpm-tools__group--volume .dpm-btn:first-child {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.dpm-tools__group--volume .dpm-btn:last-child {
  margin-left: -0.5px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.dpm-tools .dpm-btn {
  flex: 1 1 0;
  height: 28px;
  padding: 0 6px;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  gap: 3px;
}
.dpm-tools__sep {
  flex: none;
  width: 1px;
  height: 14px;
  margin: 0 2px;
  background: var(--dsw-alias-border-l2, rgba(127,127,127,0.22));
}
.dpm-wire {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14));
}
.dpm-wire .dpm-btn {
  flex: 1 1 0;
  height: 28px;
  padding: 0 8px;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
}
.dpm-pair {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22));
  border-radius: var(--dsw-radius-sm, 8px);
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.03));
}
.dpm-banner {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--dsw-radius-sm, 8px);
  corner-shape: var(--dsw-corner-shape, superellipse(1.5));
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dpm-error {
  border: 0.5px solid rgba(224, 100, 92, 0.3);
  background: rgba(224, 100, 92, 0.08);
  color: var(--dsw-alias-state-error-primary, #e0645c);
}
.dpm-warn {
  border: 0.5px solid rgba(201, 128, 58, 0.3);
  background: rgba(201, 128, 58, 0.08);
  color: var(--dsw-alias-state-warn-label, #c9803a);
}
.dpm-note {
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2));
  background: var(--dsw-alias-fill-l1, rgba(127,127,127,0.06));
  color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.95));
}
`

    function ensureStyles() {
      try {
        if (typeof document === 'undefined') return
        const existing = document.getElementById(STYLE_ID)
        if (existing) {
          if (existing.textContent !== CSS) existing.textContent = CSS
          return
        }
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
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round'
      })
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', flex: 'none' }
      }, [
        shape('M3 6.25h2.1L7.6 4.1v7.8L5.1 9.75H3z', 'body'),
        muted
          ? shape('M10.5 6.3l3.2 3.4M13.7 6.3l-3.2 3.4', 'mute')
          : shape('M9.6 5.9a3.1 3.1 0 0 1 0 4.2M11.3 4.2a5.6 5.6 0 0 1 0 7.6', 'wave')
      ])
    }

    const ICON_PATHS = {
      back: ['M10 3.5L5.5 8l4.5 4.5'],
      home: ['M3.5 7.2L8 3.5l4.5 3.7v4.6a.7.7 0 0 1-.7.7H4.2a.7.7 0 0 1-.7-.7z'],
      tasks: ['M3.5 5.2h6.8v6.8H3.5z', 'M6 3.5h6.5V10'],
      'vol-down': ['M4.5 8h7'],
      'vol-up': ['M4.5 8h7', 'M8 4.5v7'],
      power: ['M8 2.8v4.8', 'M5.2 4.5a4.5 4.5 0 1 0 5.6 0'],
      rotate: ['M12.5 5.5A4.8 4.8 0 0 0 4 4.8L3.2 5.6', 'M3.2 3.2v2.4h2.4', 'M3.5 10.5A4.8 4.8 0 0 0 12 11.2l.8-.8', 'M12.8 12.8v-2.4h-2.4'],
      notifications: ['M8 3.2a3.2 3.2 0 0 1 3.2 3.2v2.4l1.1 1.4H3.7l1.1-1.4V6.4A3.2 3.2 0 0 1 8 3.2z', 'M6.8 12.2a1.3 1.3 0 0 0 2.4 0'],
      control: ['M3.5 5.5h9', 'M3.5 10.5h9', 'M6.2 4v3', 'M9.8 9v3'],
      fullscreen: ['M3.2 6V3.2H6', 'M10 3.2h2.8V6', 'M12.8 10v2.8H10', 'M6 12.8H3.2V10'],
      'exit-fullscreen': ['M6 3.2V6H3.2', 'M10 3.2V6h2.8', 'M12.8 10H10v2.8', 'M3.2 10H6v2.8'],
      rebuild: ['M12.8 8a4.8 4.8 0 1 1-1.3-3.3L12.8 6', 'M12.8 3.4V6h-2.6'],
      wifi: ['M2.8 6.4a7.5 7.5 0 0 1 10.4 0', 'M4.8 8.7a4.6 4.6 0 0 1 6.4 0', 'M6.9 11a1.6 1.6 0 0 1 2.2 0'],
      pair: ['M6.5 9.5l3-3', 'M5.4 7.2L4.2 8.4a2.3 2.3 0 0 0 3.2 3.2l1.2-1.2', 'M10.6 8.8l1.2-1.2a2.3 2.3 0 0 0-3.2-3.2L7.4 5.6'],
      unlink: ['M3.2 3.2l9.6 9.6', 'M5.2 8.6a4.6 4.6 0 0 1 1.4-1', 'M9.8 6a7.5 7.5 0 0 1 3.4 1.6'],
      phone: ['M5.2 2.5h5.6a1.2 1.2 0 0 1 1.2 1.2v8.6a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 12.3V3.7a1.2 1.2 0 0 1 1.2-1.2z', 'M7 11.4h2']
    }

    function ToolIcon({ name, size = 13 }) {
      const paths = ICON_PATHS[name]
      if (!paths) return null
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', flex: 'none' }
      }, paths.map((d, index) => h('path', {
        key: index,
        d,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round'
      })))
    }

    const iconForTool = (label, message) => {
      if (message.kind === 'back') return 'back'
      if (message.kind === 'home' || message.keycode === 3) return 'home'
      if (message.kind === 'app-switcher' || message.keycode === 187) return 'tasks'
      if (message.kind === 'volume-down' || message.keycode === 25) return 'vol-down'
      if (message.kind === 'volume-up' || message.keycode === 24) return 'vol-up'
      if (message.kind === 'power') return 'power'
      if (message.kind === 'rotate') return 'rotate'
      if (message.kind === 'notifications') return 'notifications'
      if (message.kind === 'control-center') return 'control'
      if (message.kind === 'fullscreen') return 'fullscreen'
      return null
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
      const [iosAddressOpen, setIosAddressOpen] = useState(false)
      const [iosAddress, setIosAddress] = useState('')

      const canvasRef = useRef(null)
      const boxRef = useRef(null)
      const typingRef = useRef(null)
      // 输入法组字中。
      const composingRef = useRef(false)
      // iOS：最后动过画面即接管键盘，点别处则还给 DSH。
      const armedRef = useRef(false)
      // 输入浮层：显示正在输入的拼音。
      const [preedit, setPreedit] = useState('')
      // 观察面板尺寸：画布按显示尺寸封顶，避免全分辨率提交合成。
      const viewportObserverRef = useRef(null)
      // iOS 会话的 sidecar 端口：引擎用它直连视频流，绕开宿主事件循环。
      const videoPortRef = useRef(0)
      const directVideoUrl = () => videoPortRef.current
        ? `http://127.0.0.1:${videoPortRef.current}/stream.bin`
        : ''
      // 引擎优先运行在 Worker，不可用时退回主线程。
      const engineRef = useRef(null)
      // 画布代次：Worker 异常时重建 canvas 元素。
      const [epoch, setEpoch] = useState(0)
      // 首帧到达前不显示画布：默认黑底的 300×150 画布会闪一下再被首帧盖掉。
      const [canvasReady, setCanvasReady] = useState(false)
      // 媒体管线模式：解码帧走 video 轨道，画布不再参与页面合成。
      const [videoMode, setVideoMode] = useState(false)
      const videoRef = useRef(null)
      // note 提示的自动消隐定时器。
      const noteTimerRef = useRef(0)
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

      // iOS 触摸、滚轮与键盘直连 sidecar，绕开 Node 宿主事件循环与二次转发；用 text/plain 避开 CORS 预检。
      const directIosControl = (message) => {
        const port = videoPortRef.current
        if (platformRef.current !== 'ios' || !(port > 0)) return null
        if (message.kind === 'touch') {
          const coord = (value) => Math.round(clamp01(Number(value) || 0) * 65535)
          return {
            url: `http://127.0.0.1:${port}/touch`,
            body: JSON.stringify({
              type: message.action === 'up' ? 'release' : 'contact',
              x: coord(message.x),
              y: coord(message.y)
            })
          }
        }
        if (message.kind === 'scroll') {
          return {
            url: `http://127.0.0.1:${port}/key`,
            body: JSON.stringify({
              scroll: {
                x: message.x ?? 0.5, y: message.y ?? 0.5,
                dx: message.dx ?? 0, dy: message.dy ?? 0
              }
            })
          }
        }
        if (message.kind === 'key') {
          const usages = iosKeycodeToHidUsages(Number(message.keycode), Number(message.metastate) || 0)
          if (!usages) return null
          return {
            url: `http://127.0.0.1:${port}/key`,
            body: JSON.stringify({ tap: usages })
          }
        }
        if (message.kind === 'text') {
          const taps = []
          for (const char of String(message.text ?? '')) {
            const usages = iosCharToHidUsages(char)
            if (usages) taps.push(usages)
          }
          if (taps.length === 0) return null
          return {
            url: `http://127.0.0.1:${port}/key`,
            body: JSON.stringify(taps.length === 1 ? { tap: taps[0] } : { taps })
          }
        }
        return null
      }

      // 控制指令串行发送，参数走查询串。
      const controlQueue = useRef(Promise.resolve())
      // 排队中的控制指令数：积压时丢弃高频指令，避免整条连接越拖越慢。
      const controlPending = useRef(0)
      const sendControl = useCallback((message) => {
        const params = new URLSearchParams({ tabId })
        for (const [key, value] of Object.entries(message)) {
          if (value === undefined || value === null) continue
          params.set(key, String(value))
        }
        // 指针移动是「可丢」的高频指令：队列积压时丢中间路径，终点不丢。
        // 滚轮与按下/抬起是相对增量或用户动作，丢了就是丢了，永不丢弃。
        const droppable = message.kind === 'touch' && message.action === 'move'
        if (droppable && controlPending.current > 2) return controlQueue.current
        controlPending.current += 1
        const direct = directIosControl(message)
        controlQueue.current = controlQueue.current
          .then(async () => {
            if (direct) {
              try {
                const response = await fetch(direct.url, {
                  method: 'POST',
                  headers: { 'content-type': 'text/plain' },
                  body: direct.body,
                  cache: 'no-store',
                  signal: AbortSignal.timeout(1500)
                })
                await response.text().catch(() => {})
                if (response.ok) {
                  setControlError('')
                  return
                }
              } catch {}
            }
            const response = await fetch(`${BASE}/control?${params.toString()}`, {
              method: 'POST',
              cache: 'no-store',
              signal: AbortSignal.timeout(1500)
            })
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
          .finally(() => { controlPending.current -= 1 })
        return controlQueue.current
      }, [tabId])

      /** 画布内的归一化坐标，考虑 object-fit: contain 的留黑边。 */
      const toDevice = useCallback((event, allowOutside = false) => {
        // 媒体管线模式下画布隐藏，改成量承载画面的舞台。
        const canvas = boxRef.current
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
        // 已建好的节点复用端口：回 null 会被当成 audio-denied，之后接不上音频。
        if (state.attached && state.node) return state.node.port
        if (state.failed || state.starting) return null
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

      /** 媒体管线模式：按舞台尺寸和朝向摆放 video，内容和画布一样居中留边。 */
      const layoutVideo = useCallback(() => {
        const video = videoRef.current
        const stage = boxRef.current
        const geometry = geometryRef.current
        if (!video || !stage || !geometry) return
        const box = stage.getBoundingClientRect()
        if (box.width <= 0 || box.height <= 0) return
        // geometry 是旋转后的显示尺寸；video 里是未旋转的帧，先摆正再转。
        const sideways = Math.abs(geometry.rotation % 180) === 90
        const scale = Math.min(box.width / geometry.width, box.height / geometry.height)
        const displayW = geometry.width * scale
        const displayH = geometry.height * scale
        video.style.width = `${sideways ? displayH : displayW}px`
        video.style.height = `${sideways ? displayW : displayH}px`
        video.style.transform = `translate(-50%, -50%) rotate(${geometry.rotation}deg)`
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
          if (payload.videoPort) videoPortRef.current = payload.videoPort
          setMeta((previous) => ({ ...previous, ...payload }))
          return
        }
        if (message.type === 'track') {
          const video = videoRef.current
          if (!video || !message.track) return
          video.muted = true
          video.srcObject = new MediaStream([message.track])
          setVideoMode(true)
          video.play().catch(() => {})
          return
        }
        if (message.type === 'geometry') {
          geometryRef.current = message
          sizeRef.current = { width: message.width, height: message.height }
          setCanvasReady(true)
          layoutVideo()
          return
        }
        if (message.type === 'size') {
          sizeRef.current = { width: message.width, height: message.height }
          setCanvasReady(true)
          return
        }
        if (message.type === 'stats') {
          setStats({ fps: message.fps })
          return
        }
        if (message.type === 'note') {
          setControlError(message.message)
          clearTimeout(noteTimerRef.current)
          // 提示短暂显示后自动消隐：流恢复后没有人来清它会一直挂在面板上。
          if (message.message) {
            noteTimerRef.current = setTimeout(() => setControlError(''), 5000)
          }
          return
        }
        if (message.type === 'error') {
          setError(message.message)
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
        // 宿主路由可能拒绝 Worker 脚本加载（403）。此时用 fetch 取源码
        // （页面请求带渲染进程凭据）再以 Blob 起 Worker，避免退回主线程。
        const start = (source) => {
          let blobUrl = null
          let worker = null
          try {
            if (source) blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
            worker = new Worker(blobUrl ?? WORKER_URL)
          } catch {
            if (blobUrl) URL.revokeObjectURL(blobUrl)
            resolve(null)
            return
          }
          const cleanup = () => { if (blobUrl) URL.revokeObjectURL(blobUrl) }
          const timer = setTimeout(() => {
            worker.onmessage = null
            worker.terminate()
            cleanup()
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
            cleanup()
            if (source) { resolve(null); return }
            fetch(WORKER_URL, { cache: 'no-store' })
              .then((response) => (response.ok ? response.text() : null))
              .then((text) => { if (text) start(text); else resolve(null) })
              .catch(() => resolve(null))
          }
        }
        start(null)
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
            // 画布控制权只能交出一次：拿不到就换一个画布元素重建。
            let offscreen = null
            try {
              offscreen = canvas.transferControlToOffscreen()
            } catch {
              worker.terminate()
              setEpoch((value) => value + 1)
              return
            }
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
        postEngine({
          type: 'open',
          streamUrl: `${STREAM_URL}?tabId=${encodeURIComponent(tabId)}`,
          controlUrl: `${CONTROL_URL}?tabId=${encodeURIComponent(tabId)}`,
          directVideoUrl: directVideoUrl()
        })
        postEngine({ type: 'page', visible: document.visibilityState !== 'hidden' })
        // 画布按面板显示尺寸封顶：全分辨率提交合成会拖垮合成器。
        const reportViewport = () => {
          const box = canvasRef.current?.getBoundingClientRect()
          if (!box || box.width <= 0 || box.height <= 0) return
          postEngine({
            type: 'viewport',
            width: Math.round(box.width),
            height: Math.round(box.height),
            dpr: window.devicePixelRatio || 1
          })
        }
        reportViewport()
        viewportObserverRef.current?.disconnect()
        if (typeof ResizeObserver === 'function' && canvasRef.current) {
          viewportObserverRef.current = new ResizeObserver(reportViewport)
          viewportObserverRef.current.observe(canvasRef.current)
        }
        // 浏览器缩放会改变 devicePixelRatio 但常常不改布局尺寸，单独兜一层。
        window.addEventListener('resize', reportViewport)
        return () => window.removeEventListener('resize', reportViewport)
      }, [postEngine, spawnEngineWorker, tabId])

      const closeEngine = useCallback(() => {
        // 隐藏画布：重开期间显示面板背景而不是停在上一帧/黑底上。
        setCanvasReady(false)
        try { engineRef.current?.post({ type: 'close' }) } catch {}
      }, [])

      const stopEngine = useCallback(() => {
        const engine = engineRef.current
        engineRef.current = null
        setCanvasReady(false)
        // 引擎销毁后轨道随之结束，视频元素也要摘掉，否则会停在最后一帧。
        const video = videoRef.current
        if (video?.srcObject) {
          for (const track of video.srcObject.getTracks()) { try { track.stop() } catch {} }
          video.srcObject = null
        }
        setVideoMode(false)
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

      // 媒体管线模式下按舞台尺寸摆放画面：面板大小、全屏切换都要跟着重算。
      useEffect(() => {
        if (!videoMode || !running) return undefined
        layoutVideo()
        if (typeof ResizeObserver !== 'function' || !boxRef.current) return undefined
        const observer = new ResizeObserver(() => layoutVideo())
        observer.observe(boxRef.current)
        return () => observer.disconnect()
      }, [videoMode, running, layoutVideo])

      // Worker 里没有 document，由主线程同步窗口可见性。
      useEffect(() => {
        const sync = () => {
          const visible = document.visibilityState !== 'hidden'
          if (visible) {
            // 后台节流恢复时先把存活时间戳刷新，避免看门狗误判失联重建整条 Worker。
            aliveRef.current = Date.now()
            audioRef.current.context?.resume?.().catch(() => {})
            if (videoRef.current?.srcObject && videoRef.current.paused) {
              videoRef.current.play().catch(() => {})
            }
          }
          postEngine({ type: 'page', visible })
        }
        document.addEventListener('visibilitychange', sync)
        return () => document.removeEventListener('visibilitychange', sync)
      }, [postEngine])

      // 宿主仍有会话时直接接入。
      attachSessionRef.current = (info) => {
        // 端口先更新：attach 只接一次，但端口消息可能后到。
        if (info.videoPort) videoPortRef.current = info.videoPort
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

      // 手填地址可直接连未配对过的设备：USB 序列号同样映射成 wifi:<udid>；
      // 列表里没有 iPhone 时用哨兵序列号，配对成功后会话回传真实序列号。
      const manualIosSerial = platform !== 'ios' ? undefined
        : serial
          ? (serial.startsWith('wifi:') ? serial : `wifi:${serial}`)
          : 'wifi:manual'

      const connect = useCallback(async (overrideSize, manualAddress) => {
        const targetSerial = manualAddress ? manualIosSerial : serial
        if (!targetSerial) return
        // 趁用户点击手势同步创建并唤醒 AudioContext，避免异步建流后被自动播放策略挂起。
        try {
          const audio = audioRef.current
          // 新会话允许重新尝试音频：上一次的失败不该永久禁用声音。
          audio.failed = false
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
          const result = await post('/connect', {
            platform, serial: targetSerial, maxSize: overrideSize, tabId, iosWirelessHost: manualAddress
          })
          if (tab.signal.aborted || !result.session) return
          preferredPlatform = platform
          // 手填地址首次配对后，会话序列号从哨兵换成真实 UDID。
          const finalSerial = result.session.serial || targetSerial
          preferredSerialByPlatform[platform] = finalSerial
          setSerial(finalSerial)
          if (manualAddress) setIosAddressOpen(false)
          videoPortRef.current = result.session.videoPort || 0
          setMeta({ ...result.session, state: 'running' })
          // 会话被替换后让引擎重连。
          postEngine({ type: 'reset', directVideoUrl: directVideoUrl() })
          if (manualAddress) void refresh()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }, [audioOn, manualIosSerial, platform, post, postEngine, refresh, serial, tab.signal, tabId])

      // 经 ref 取最新的 connect 闭包。
      connectRef.current = connect
      qualityRef.current = quality

      const disconnect = useCallback(async () => {
        setBusy('正在断开…')
        try {
          // 停引擎收流但保留 Worker 与画布：重连时复用，且不会在 sidecar
          // 先退出时报错。
          closeEngine()
          await post('/disconnect')
          setMeta({ state: 'idle', platform: null, deviceName: '', screen: null, mode: null })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
          refresh()
        }
      }, [closeEngine, post, refresh, tabId])

      // 切到无线：先结束会话，再在新地址上重连。
      const toWireless = useCallback(async () => {
        if (!serial || serial.includes(':') || busy) return
        const wasRunning = running
        let usbSessionReplaced = false
        setBusy(platform === 'ios' ? '正在配对并验证无线地址，请勿拔线…' : '正在切到无线…')
        setError('')
        setNotice('')
        try {
          if (wasRunning && platform !== 'ios') {
            await post('/disconnect')
            setMeta({ state: 'idle', platform: null, deviceName: '', screen: null, mode: null })
          }
          const result = await post('/adb/tcpip', { platform, serial })
          // 配对完成后只提示，等拔线再连无线会话。
          if (platform === 'ios') {
            setNotice(result.directReady
              ? '无线地址已验证：拔掉数据线后，选中 iPhone (Wi-Fi) 再点「连接」'
              : `USB 配对完成，但无线隧道未验证：${result.wirelessError || '未取得可验证的无线地址'}。请保留 USB，或用「手填地址」试连。`)
            await refresh()
            return
          }
          preferredSerialByPlatform[platform] = result.address
          setSerial(result.address)
          if (wasRunning) {
            usbSessionReplaced = wasRunning
            if (tab.signal.aborted) return
            const info = await post('/connect', { platform, serial: result.address, maxSize: quality, tabId })
            if (tab.signal.aborted || !info.session) return
            videoPortRef.current = info.session.videoPort || 0
            setMeta({ ...info.session, state: 'running' })
            postEngine({ type: 'reset', directVideoUrl: directVideoUrl() })
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
          // 同上：只停收流，保留引擎实例供重连复用。
          closeEngine()
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
          armedRef.current = true
          if (platformRef.current === 'ios' && event.button !== 0) return
          const point = toDevice(event)
          if (!point) return
          // 上一次按下如果在面板外松开（up 事件没送到画面），这里先补一个抬起，
          // 否则指针状态会一直是「按着」，之后整个画面都点不动。
          if (pointerRef.current.down) {
            sendControl({ kind: 'touch', action: 'up', x: pointerRef.current.x, y: pointerRef.current.y })
            pointerRef.current.down = false
          }
          // 点画面即接管手机键盘：按键逐键发给手机，由手机输入法组字选字。
          event.preventDefault()
          if (platformRef.current === 'ios') {
            const active = document.activeElement
            if (active && isForeignEditable(active) && typeof active.blur === 'function') active.blur()
          } else {
            setTimeout(() => { try { typingRef.current?.focus({ preventScroll: true }) } catch {} }, 0)
          }
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
        // 滚轮是相对增量：在飞请求期间到达的增量累加起来，随下一条请求一起
        // 带走而不是丢掉——丢了滚轮就基本滚不动。
        let wheelAcc = { dx: 0, dy: 0, x: 0.5, y: 0.5 }
        let wheelFlushing = false
        const flushWheel = () => {
          if (wheelFlushing || (!wheelAcc.dx && !wheelAcc.dy)) return
          // 单条请求的幅度封顶，超出部分留给下一条；桥接侧按 int8 分段发送。
          const take = (value) => Math.max(-8, Math.min(8, value))
          const dx = take(wheelAcc.dx)
          const dy = take(wheelAcc.dy)
          wheelAcc.dx -= dx
          wheelAcc.dy -= dy
          wheelFlushing = true
          sendControl({ kind: 'scroll', x: wheelAcc.x, y: wheelAcc.y, dx, dy })
            .finally(() => {
              wheelFlushing = false
              if (wheelAcc.dx || wheelAcc.dy) flushWheel()
            })
        }
        const onWheel = (event) => {
          if (!runningRef.current) return
          const point = toDevice(event)
          if (!point) return
          // scrcpy 的滚动量「向上为正」，浏览器 deltaY「向下为正」，这里取反。
          // 一个滚轮刻度在 Chrome 里约 100px，除以 100 才是「一格一次」；
          // deltaMode 为 1 表示按行计数（Firefox/Linux），换算成像素。
          const perUnit = event.deltaMode === 1 ? 16 : 1
          event.preventDefault()
          const dx = (-event.deltaX * perUnit) / 100
          const dy = (-event.deltaY * perUnit) / 100
          if (!dx && !dy) return
          // 滚动位置取最后一次事件；增量按当前朝向映射后累加。
          wheelAcc.x = point.x
          wheelAcc.y = point.y
          if (platformRef.current === 'ios') {
            const [mx, my] = ({ 90: [dy, -dx], 180: [-dx, -dy], 270: [-dy, dx] })[geometryRef.current?.rotation] ?? [dx, dy]
            wheelAcc.dx += mx
            wheelAcc.dy += my
          } else {
            wheelAcc.dx += dx
            wheelAcc.dy += dy
          }
          // 长时间发不出去时不无限积压，避免恢复后一路狂滚。
          wheelAcc.dx = Math.max(-40, Math.min(40, wheelAcc.dx))
          wheelAcc.dy = Math.max(-40, Math.min(40, wheelAcc.dy))
          if (pointerRef.current.down) return
          flushWheel()
        }
        // 点画面以外的地方（聊天框、工具栏、别的面板）把键盘还给 DSH。
        const onDocumentPointerDown = (event) => {
          if (!canvas.contains?.(event.target)) armedRef.current = false
        }
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
        document.addEventListener('pointerdown', onDocumentPointerDown, true)
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
        // 输入法组字中的按键由输入法自己处理。
        if (event.isComposing || composingRef.current || event.keyCode === 229) return
        if (ios) {
          // iOS：电脑键盘作为外接键盘逐键转发，拼音由手机输入法组字选字。
          // 只在最后动过画面时转发，且不转发到别的输入框里。
          if (!armedRef.current || isForeignEditable(event.target)) return
        } else if (event.target !== typingRef.current) {
          return
        }

        // Ctrl+空格：按手机的语言切换键处理（iOS 用 Caps Lock 切中英）。
        if (ios && event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Space') {
          sendControl({ kind: 'key', keycode: 58, metastate: 0 })
          event.preventDefault()
          event.stopPropagation()
          return
        }

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

        // Esc：iOS 转发给手机（收起输入法/取消），安卓交还键盘焦点。
        if (event.key === 'Escape') {
          if (ios) {
            sendControl({ kind: 'key', keycode: 111, metastate: 0 })
            event.preventDefault()
            event.stopPropagation()
            return
          }
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

      const activeDeviceName = useMemo(() => {
        if (meta.deviceName) return meta.deviceName
        const matched = devices.find((item) => item.serial === serial)
        if (matched?.model) return String(matched.model).replace(/_/g, ' ')
        if (serial.startsWith('wifi:')) return platform === 'ios' ? 'iPhone (Wi-Fi)' : serial
        return serial
      }, [devices, meta.deviceName, platform, serial])

      const frameCaption = useMemo(() => {
        if (!running) return autoConnecting ? '自动连接中…' : '未连接'
        const size = sizeRef.current
        // 帧率由引擎统计。
        return `${activeDeviceName} · ${size.width}×${size.height} · ${stats.fps}fps`
      }, [activeDeviceName, autoConnecting, running, stats])

      const switchPlatform = (next) => {
        if (running || next === platform) return
        platformTouched = true
        preferredPlatform = next
        platformRef.current = next
        setPlatform(next)
        setPairing(false)
        setIosAddressOpen(false)
        setError('')
        setSerial(pickSerialForPlatform(status?.devices ?? [], next, ''))
      }

      const renderToolButton = ([label, message]) => {
        const displayLabel = platform === 'ios' && message.kind === 'rotate'
          ? (Math.abs(meta.rotation ?? 0) % 180 === 90 ? '切竖屏' : '切横屏')
          : label
        const iconName = iconForTool(label, message)
        return h('button', {
          key: label,
          className: 'dpm-btn',
          title: displayLabel,
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
        }, [
          iconName ? h(ToolIcon, { key: 'icon', name: iconName, size: 12 }) : null,
          h('span', { key: 'text' }, displayLabel)
        ])
      }

      const allToolGroups = toolGroupsFor(platform)
      const navGroup = allToolGroups.find((group) => group.id === 'nav')
      const utilityGroups = allToolGroups.filter((group) => group.id !== 'nav')
      const iosOffline = !running && platform === 'ios' && devices.some((device) => device.serial === serial && device.online === false)
      const emptyBadgeTone = (!providerReady || unauthorized.length > 0)
        ? 'dpm-empty-device__badge dpm-empty-device__badge--warn'
        : (devices.length > 0 ? 'dpm-empty-device__badge dpm-empty-device__badge--ready' : 'dpm-empty-device__badge')
      const statusDotClass = running
        ? 'dpm-status__dot dpm-status__dot--live'
        : (busy || autoConnecting ? 'dpm-status__dot dpm-status__dot--busy' : 'dpm-status__dot')

      return h('div', { className: 'dpm-panel' }, [
        h('div', { key: 'header', className: 'dpm-header' }, [
          h('div', { key: 'bar', className: 'dpm-row' }, [
            h('div', {
              key: 'platform',
              className: 'dpm-seg',
              role: 'tablist',
              'aria-label': '设备平台'
            }, [
              h('button', {
                key: 'android',
                type: 'button',
                role: 'tab',
                'aria-selected': platform === 'android',
                className: platform === 'android' ? 'dpm-seg__btn dpm-seg__btn--active' : 'dpm-seg__btn',
                disabled: running,
                onClick: () => switchPlatform('android')
              }, '安卓'),
              h('button', {
                key: 'ios',
                type: 'button',
                role: 'tab',
                'aria-selected': platform === 'ios',
                className: platform === 'ios' ? 'dpm-seg__btn dpm-seg__btn--active' : 'dpm-seg__btn',
                disabled: running,
                onClick: () => switchPlatform('ios')
              }, 'iOS')
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
              : devices.map((device, index) => {
                  // 只在同型号有多台时才加序号区分，不把 UDID 这类长串丢给用户看。
                  const sameModel = devices.filter((item) => (item.model || '') === (device.model || '')).length > 1
                  // 安卓的 model 来自 adb devices -l（Pixel_7 这类下划线是空格写法）。
                  const base = (device.model ? String(device.model).replace(/_/g, ' ') : '')
                    || (platform === 'ios' ? 'iPhone' : '安卓设备')
                  const suffix = sameModel ? ` #${index + 1}` : ''
                  const state = device.online === true ? ' · 在线' : device.online === false ? ' · 离线' : ''
                  return h('option', { key: device.serial, value: device.serial }, `${base}${suffix}${state}`)
                })),
            running
              ? h('button', { key: 'dis', className: 'dpm-btn dpm-btn--disconnect', onClick: disconnect }, '断开')
              : h('button', {
                  key: 'con',
                  className: 'dpm-btn dpm-btn--primary',
                  onClick: () => connect(),
                  // 自动重开期间禁用。
                  disabled: !serial || Boolean(busy) || autoConnecting,
                  title: autoConnecting ? '系统正在自动连接，链路恢复后会自动接上' : ''
                }, busy || (autoConnecting ? '自动连接中' : '连接'))
          ]),
          h('div', { key: 'frame', className: 'dpm-subbar' }, [
            h('div', { key: 'status', className: 'dpm-status' }, [
              h('span', { key: 'dot', className: statusDotClass }),
              running
                ? h('span', { key: 'cap', className: 'dpm-caption dpm-caption--live', title: frameCaption }, [
                    h('span', { key: 'name' }, activeDeviceName),
                    h('span', { key: 'meta', className: 'dpm-caption__meta' }, ` · ${sizeRef.current.width}×${sizeRef.current.height} · ${stats.fps}fps`)
                  ])
                : h('span', { key: 'cap', className: 'dpm-caption', title: frameCaption }, frameCaption)
            ]),
            h('div', { key: 'ctrls', className: 'dpm-stream-ctrls' }, [
              h('select', {
                key: 'quality',
                className: 'dpm-field dpm-field--compact dpm-select',
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
                key: 'rebuild',
                className: 'dpm-btn dpm-btn--compact',
                disabled: !running,
                title: '画面花屏或卡住时请求新关键帧',
                onClick: () => {
                  // 丢弃解码器并重连流，由宿主重发 SPS/PPS 与关键帧。
                  postEngine({ type: 'reset' })
                }
              }, [
                h(ToolIcon, { key: 'icon', name: 'rebuild', size: 12 }),
                h('span', { key: 'text' }, '重建画面')
              ]),
              h('button', {
                key: 'audio',
                className: running && audioOn && meta.audio !== false
                  ? 'dpm-btn dpm-btn--icon dpm-btn--compact dpm-btn--active'
                  : 'dpm-btn dpm-btn--icon dpm-btn--compact',
                onClick: () => {
                  // 只切换引擎侧静音，不挂起 AudioContext：挂起后恢复并不可靠。
                  const next = !audioOn
                  postEngine({ type: 'mute', muted: !next })
                  // 恢复播放时确保上下文在运行。
                  if (next) audioRef.current.context?.resume?.()?.catch?.(() => {})
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
            ])
          ])
        ]),
        iosOffline
          ? h('div', { key: 'offline', className: 'dpm-banner dpm-note' },
              '无线地址暂时不可达。可以手填手机当前的 IP，或插线再点「转无线」。')
          : null,
        running && busy.length > 0 ? h('div', { key: 'busy', className: 'dpm-banner dpm-note' }, busy) : null,
        notice.length > 0 ? h('div', { key: 'notice', className: 'dpm-banner dpm-note' }, notice) : null,
        controlError.length > 0
          ? h('div', { key: 'cerr', className: 'dpm-banner dpm-warn' }, `控制失败：${controlError}`)
          : null,
        error.length > 0
          ? h('div', { key: 'err', className: 'dpm-banner dpm-error' }, error)
          : null,
        h('div', {
          key: 'stage',
          ref: boxRef,
          className: fullscreen
            ? 'dpm-stage dpm-stage--fullscreen'
            : (running ? 'dpm-stage dpm-stage--running' : 'dpm-stage')
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
            onBlur: () => {
              composingRef.current = false
              setPreedit('')
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
              // 这个组字框只给安卓用，不占点击区域。
              display: platform === 'ios' || !running ? 'none' : 'block'
            }
          }),
          h('video', {
            key: `video-${epoch}`,
            ref: videoRef,
            muted: true,
            autoPlay: true,
            playsInline: true,
            style: {
              position: 'absolute',
              left: '50%',
              top: '50%',
              objectFit: 'contain',
              borderRadius: 0,
              display: running && videoMode ? 'block' : 'none',
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none'
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
              display: running && canvasReady && !videoMode ? 'block' : 'none',
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
              padding: '4px 12px',
              borderRadius: 8,
              background: 'rgba(24, 27, 34, 0.88)',
              backdropFilter: 'blur(10px)',
              border: '0.5px solid rgba(255, 255, 255, 0.18)',
              color: '#f3f5f8',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
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
          }, [
            h(ToolIcon, { key: 'icon', name: 'exit-fullscreen', size: 13 }),
            h('span', { key: 'text' }, '退出全屏')
          ]) : null,
          running ? null : h('div', {
            key: 'hint',
            className: 'dpm-hint'
          }, h('div', { className: 'dpm-empty-device' }, [
            h('span', { key: 'notch', className: 'dpm-empty-device__notch' }),
            h('div', { key: 'badge', className: emptyBadgeTone },
              h(ToolIcon, { name: 'phone', size: 18 })),
            h('div', { key: 'text', className: 'dpm-empty-device__text' }, autoConnecting
              ? '系统正在自动连接…'
              : platform === 'ios'
                ? (status?.ios?.preparing
                    ? (status.ios.preparingMessage || '首次连接，正在下载 iOS 运行时…')
                    : iosReady
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
                      : `adb 不可用：${status?.adb?.error ?? '未找到 adb'}。可在插件目录执行 npm run fetch:tools，或在配置里填 adbPath。`)),
            h('span', { key: 'bar', className: 'dpm-empty-device__bar' })
          ]))
        ]),
        h('div', { key: 'dock', className: 'dpm-dock' }, [
          navGroup ? h('div', { key: 'nav', className: 'dpm-nav-bar' },
            navGroup.items.map(renderToolButton)) : null,
          h('div', { key: 'tools', className: 'dpm-tools' }, utilityGroups.flatMap((group, index) => [
            index === 0 ? null : h('span', { key: `${group.id}-sep`, className: 'dpm-tools__sep' }),
            h('div', {
              key: group.id,
              className: group.id === 'volume'
                ? 'dpm-tools__group dpm-tools__group--volume'
                : 'dpm-tools__group',
              style: group.id === 'volume' ? undefined : { flexGrow: group.items.length, flexBasis: 0 }
            }, group.items.map(renderToolButton))
          ])),
          h('div', { key: 'wire', className: 'dpm-wire' }, [
            h('button', {
              key: 'tcpip',
              className: 'dpm-btn',
              disabled: !serial || serial.includes(':') || Boolean(busy),
              title: platform === 'ios' ? '通过 USB 配置 iPhone 无线连接' : '把 USB 调试切到无线并自动连上',
              onClick: toWireless
            }, [
              h(ToolIcon, { key: 'icon', name: 'wifi', size: 12 }),
              h('span', { key: 'text' }, '转无线')
            ]),
            platform === 'android' ? h('button', {
              key: 'pair',
              className: pairing ? 'dpm-btn dpm-btn--active' : 'dpm-btn',
              disabled: Boolean(busy),
              'aria-expanded': pairing,
              onClick: togglePairing
            }, [
              h(ToolIcon, { key: 'icon', name: 'pair', size: 12 }),
              h('span', { key: 'text' }, '配对')
            ]) : h('button', {
              key: 'ios-address',
              className: iosAddressOpen ? 'dpm-btn dpm-btn--active' : 'dpm-btn',
              disabled: running || Boolean(busy) || autoConnecting,
              'aria-expanded': iosAddressOpen,
              onClick: () => setIosAddressOpen((open) => !open)
            }, [
              h(ToolIcon, { key: 'icon', name: 'pair', size: 12 }),
              h('span', { key: 'text' }, '手填地址')
            ]),
            h('button', {
              key: 'drop',
              className: 'dpm-btn',
              disabled: Boolean(busy) || !wirelessAddress,
              title: platform === 'ios' ? '停止无线投屏或取消重连，保留配对' : '断开电脑与设备之间的无线通道',
              onClick: dropWireless
            }, [
              h(ToolIcon, { key: 'icon', name: 'unlink', size: 12 }),
              h('span', { key: 'text' }, '断开连接')
            ])
          ]),
          iosAddressOpen && platform === 'ios' && !running ? h('form', {
            key: 'ios-address-form',
            className: 'dpm-pair',
            onSubmit: (event) => {
              event.preventDefault()
              if (manualIosSerial && iosAddress.trim() && !busy && !autoConnecting) {
                connect(quality, iosAddress.trim())
              }
            }
          }, [
            h('div', { key: 'address', className: 'dpm-row' }, [
              h('input', {
                key: 'ip',
                className: 'dpm-field',
                'aria-label': 'iPhone 无线 IP 地址',
                placeholder: 'iPhone 当前的 IP 地址',
                value: iosAddress,
                maxLength: 15,
                disabled: Boolean(busy),
                onChange: (event) => setIosAddress(event.target.value),
                style: { flex: '1 1 auto' }
              }),
              h('button', {
                key: 'connect',
                type: 'submit',
                className: 'dpm-btn dpm-btn--primary',
                disabled: !iosAddress.trim() || Boolean(busy) || autoConnecting
              }, '连接')
            ])
          ]) : null,
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
            pairNote.length > 0 ? h('div', { key: 'note', className: 'dpm-banner dpm-note' }, pairNote) : null,
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
          ]) : null
        ])
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
        owner.effect(() => right.registerCloseHandler(TAB_KIND, (sessionId, tab) => {
          // 只有同一侧栏里还开着手机页签，才算仍有人在用这条连接。
          const open = right.openTabs?.getSnapshot?.() ?? []
          const sameSidebar = open.filter((entry) => entry.kind === TAB_KIND && entry.sessionId === sessionId)
          if (sameSidebar.some((entry) => entry.tabId !== tab.id)) return
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
