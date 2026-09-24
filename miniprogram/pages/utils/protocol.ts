// pages/utils/protocol.ts

// 帧头帧尾常量
export const HEAD = [0xAA, 0x55];
export const TAIL = [0x0D, 0x0A];

// 命令码定义
export enum CmdCode {
  HEARTBEAT     = 0x01, // 心跳
  STATUS_REQ    = 0x02, // 状态请求
  ERROR_REPORT  = 0x03, // 错误码上报（接收）
  LEG_RESET     = 0x10, // 四足复位
  REBOOT        = 0x11, // 机器重启
  JOYSTICK      = 0x20, // 摇杆坐标
  HEADING       = 0x21, // 滑杆角度
  
  ACTION        = 0x30, // 统一动作指令（12个按键合并）
  EXPRESSION    = 0x31, // 表情切换指令（新增）
  BATTERY       = 0x40, // 电量上报（接收）
  STATUS_REPORT = 0x41, // 状态上报（接收）
}

// 12个按键对应的指令值 (Data[0])
// 顺序：从左到右，从上到下
export enum ActionValue {
  STAND       = 0x01, // 站立
  LIE_BACK    = 0x02, // 后躺
  SIT_DOWN    = 0x03, // 坐下
  LIE_FORWARD = 0x04, // 前趴
  SHAKE_HEAD  = 0x05, // 摇头
  WAG_TAIL    = 0x06, // 摇尾
  WAVE        = 0x07, // 招手
  MARK        = 0x08, // 标记
  CRAWL       = 0x09, // 爬行
  PUSH_UP     = 0x0A, // 俯卧撑
  SWAY        = 0x0B, // 摇摆
  ROCK        = 0x0C, // 摇滚
}

// 表情值定义（对应4种表情）
export enum ExpressionType {
  HAPPY   = 0x00, // 开心
  CRY     = 0x01, // 哭泣
  DAZE    = 0x02, // 发呆
  ANGRY   = 0x03, // 生气
}
// 协议帧打包函数
export function packFrame(cmd: CmdCode, data: Uint8Array = new Uint8Array(0)): ArrayBuffer {
  const len = data.length;
  // head(2) + cmd(1) + len(1) + data + checksum(1) + tail(2)
  const totalLen = 2 + 1 + 1 + len + 1 + 2;
  const buffer = new ArrayBuffer(totalLen);
  const view = new DataView(buffer);

  let offset = 0;
  // 1. 帧头
  view.setUint8(offset++, HEAD[0]);
  view.setUint8(offset++, HEAD[1]);
  // 2. 命令码
  view.setUint8(offset++, cmd);
  // 3. 数据长度
  view.setUint8(offset++, len);
  // 4. 数据域
  for (let i = 0; i < len; i++) {
    view.setUint8(offset++, data[i]);
  }
  // 5. 校验和 (简单累加校验)
  let checksum = 0;
  for (let i = 0; i < offset; i++) {
    checksum += view.getUint8(i);
  }
  view.setUint8(offset++, checksum & 0xFF);
  // 6. 帧尾
  view.setUint8(offset++, TAIL[0]);
  view.setUint8(offset++, TAIL[1]);

  return buffer;
}

// ArrayBuffer 转 Hex 字符串（调试用）
export function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}