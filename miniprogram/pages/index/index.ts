// index.ts
// pages/index/index.ts
import { CmdCode, ActionValue, packFrame, bufferToHex } from '../utils/protocol';

// 定义 Page Data 的类型
interface PageData {
  connected: boolean;
  deviceName: string;
  deviceId: string;
  serviceId: string;
  writeCharId: string;
  notifyCharId: string;
  batteryLevel: number | null;
  heartbeatTimer: number | null;
  errorCode: number | null;
  deviceStatus: string;

  // 摇杆状态
  joystickX: number;
  joystickY: number;
  isTouching: boolean;
  handleLeft: number;
  handleTop: number;

  // 滑杆状态
  headingValue: number;
  // 表情控制
  expressionIndex: number;
  expressionList: ExpressionItem[];
  expressionIcon: string;
  expressionName: string;
  expressionColor: string;
}

// 定义表情项的类型
interface ExpressionItem {
  name: string;
  icon: string;
  color: string;
}

Page({
  data: {
    connected: false,
    deviceName: '',
    deviceId: '',
    serviceId: '',
    writeCharId: '',
    notifyCharId: '',
    batteryLevel: null,
    heartbeatTimer: null,
    errorCode: null,
    deviceStatus: '未连接',

    // 摇杆
    joystickX: 0,
    joystickY: 0,
    isTouching: false,
    handleLeft: 50,
    handleTop: 50,

    // 滑杆
    headingValue: 0,
    // 表情相关数据
    expressionIndex: 0,
    expressionList: [
      { name: '开心', icon: '😊', color: '#FFD700' },
      { name: '哭泣', icon: '😭', color: '#4169E1' },
      { name: '发呆', icon: '😶', color: '#D3D3D3' },
      { name: '生气', icon: '😡', color: '#FF4500' }
    ] as ExpressionItem[],
    expressionIcon: '😊',
    expressionName: '开心',
    expressionColor: '#FFD700'
  } as PageData,

  // ========== 生命周期 ==========

  onLoad() {
    this.listenAdapterState();
    this.listenConnectionState();
  },

  onUnload() {
    this.disconnect();
  },

  // ========== 蓝牙适配器状态监听 ==========

  listenAdapterState() {
    wx.onBluetoothAdapterStateChange((res) => {
      console.log('蓝牙适配器状态变化:', res);
      if (!res.available) {
        this.setData({ connected: false, deviceStatus: '蓝牙已关闭' });
        wx.showToast({ title: '蓝牙已关闭', icon: 'none' });
      }
    });
  },

  // ========== 连接状态监听 ==========

  listenConnectionState() {
    wx.onBLEConnectionStateChange((res) => {
      console.log('连接状态变化:', res);
      if (!res.connected) {
        this.setData({
          connected: false,
          deviceStatus: '已断开',
          batteryLevel: null,
        });
        if (this.data.heartbeatTimer) {
          clearInterval(this.data.heartbeatTimer);
          this.setData({ heartbeatTimer: null });
        }
      }
    });
  },

    // ========== 根据电量返回 CSS class ==========

  getBatteryClass(level: number | null): string {
    if (level === null) return '';
    if (level > 50) return 'battery-high';
    if (level > 20) return 'battery-medium';
    return 'battery-low';
  },
  // ========== 连接设备流程 ==========

  async onConnect() {
    try {
      await wx.openBluetoothAdapter({ mode: 'central' });
    } catch (err) {
      wx.showToast({ title: '请开启蓝牙权限', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '搜索中...' });

    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success: () => {
        wx.onBluetoothDeviceFound((res) => {
          // 根据实际设备名修改过滤条件
          const device = res.devices.find(d =>
            (d.localName&&d.localName.includes('Dog')) || 
            (d.name&&d.name.includes('Dog')) 
          );
          if (device) {
            wx.stopBluetoothDevicesDiscovery();
            wx.hideLoading();
            this.createConnection(device.deviceId, device.localName || device.name || '未知设备');
          }
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '搜索失败', icon: 'none' });
      }
    });
  },

  async createConnection(deviceId: string, name: string) {
    try {
      await wx.createBLEConnection({ deviceId, timeout: 8000 });
      this.setData({ connected: true, deviceId, deviceName: name, deviceStatus: '连接中...' });
      await this.discoverServices(deviceId);
    } catch (err) {
      console.error('连接失败', err);
      wx.showToast({ title: '连接失败', icon: 'none' });
    }
  },

  async discoverServices(deviceId: string) {
    try {
      const { services } = await wx.getBLEDeviceServices({ deviceId });
      console.log('发现服务:', services);

      // 根据你的实际服务UUID修改匹配条件
      const service = services.find(s =>
        s.uuid.includes('FFE0') || s.uuid.includes('FFF0')
      );

      if (service) {
        this.setData({ serviceId: service.uuid });
        await this.discoverCharacteristics(deviceId, service.uuid);
      } else {
        wx.showToast({ title: '未找到服务', icon: 'none' });
      }
    } catch (err) {
      console.error('获取服务失败', err);
    }
  },

  async discoverCharacteristics(deviceId: string, serviceId: string) {
    try {
      const { characteristics } = await wx.getBLEDeviceCharacteristics({ deviceId, serviceId });
      console.log('发现特征值:', characteristics);

      for (const char of characteristics) {
        //使用 as any 绕过 TS 类型检查
        const hasWriteNoResponse = 'writeNoResponse' in char.properties && (char.properties as any).writeNoResponse;
        if (char.properties.write || hasWriteNoResponse) {
          this.setData({ writeCharId: char.uuid });
          console.log('写入特征:', char.uuid);
        }
        if (char.properties.notify || char.properties.indicate) {
          this.setData({ notifyCharId: char.uuid });
          console.log('通知特征:', char.uuid);
          await this.enableNotify(deviceId, serviceId, char.uuid);
        }
      }

      // 连接成功，启动心跳
      this.setData({ deviceStatus: '已连接' });
      this.startHeartbeat();
    } catch (err) {
      console.error('获取特征值失败', err);
    }
  },

  // ========== 开启 Notify 监听 ==========

  async enableNotify(deviceId: string, serviceId: string, charId: string) {
    try {
      await wx.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId,
        characteristicId: charId,
        state: true,
      });

      // 安卓端开启 Notify 后建议延迟一下再开始通信
      await new Promise(resolve => setTimeout(resolve, 200));

      wx.onBLECharacteristicValueChange((res) => {
        console.log('收到设备数据:', bufferToHex(res.value));
        this.parseResponse(res.value);
      });

      console.log('Notify 开启成功');
    } catch (err) {
      console.error('开启 Notify 失败', err);
    }
  },

  // ========== 解析设备回复 ==========

  parseResponse(buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    const len = buffer.byteLength;

    if (len < 7) return; // 最小帧长度: head(2)+cmd(1)+len(1)+data(0)+checksum(1)+tail(2)

    // 验证帧头
    if (view.getUint8(0) !== 0xAA || view.getUint8(1) !== 0x55) return;
    // 验证帧尾
    if (view.getUint8(len - 2) !== 0x0D || view.getUint8(len - 1) !== 0x0A) return;

    const cmd = view.getUint8(2);
    const dataLen = view.getUint8(3);

    // 简单校验和验证
    let checksum = 0;
    for (let i = 0; i < len - 3; i++) {
      checksum += view.getUint8(i);
    }
    if ((checksum & 0xFF) !== view.getUint8(len - 3)) {
      console.warn('校验和错误');
      return;
    }

    // 根据命令码解析
    switch (cmd) {
      case CmdCode.BATTERY:
        if (dataLen >= 1) {
          const battery = view.getUint8(4);
          this.setData({ batteryLevel: battery });
        }
        break;

      case CmdCode.ERROR_REPORT:
        if (dataLen >= 1) {
          const errorCode = view.getUint8(4);
          this.setData({ errorCode });
          wx.showToast({ title: `设备错误: 0x${errorCode.toString(16).toUpperCase()}`, icon: 'none' });
        }
        break;

      case CmdCode.STATUS_REPORT:
        if (dataLen >= 1) {
          const status = view.getUint8(4);
          this.setData({ deviceStatus: this.getStatusText(status) });
        }
        break;

      case CmdCode.HEARTBEAT:
        // 心跳回复，可在此重置心跳超时计数器
        break;

      default:
        console.log('未知命令码:', cmd.toString(16));
        break;
    }
  },

  getStatusText(status: number): string {
    const statusMap: Record<number, string> = {
      0: '空闲',
      1: '运动中',
      2: '充电中',
      3: '故障',
    };
    return statusMap[status] || `未知(${status})`;
  },

  // ========== 发送通用指令 ==========

  sendCmd(cmd: CmdCode, data: Uint8Array = new Uint8Array(0)) {
    const { deviceId, serviceId, writeCharId } = this.data;
    if (!deviceId || !serviceId || !writeCharId) {
      console.warn('蓝牙未连接，无法发送指令');
      return;
    }

    const buffer = packFrame(cmd, data);
    const sys = wx.getSystemInfoSync();
    const writeType = sys.platform === 'android' ? 'writeNoResponse' : 'write';

    wx.writeBLECharacteristicValue({
      deviceId,
      serviceId,
      characteristicId: writeCharId,
      value: buffer,
      writeType,
      success: () => {
        console.log(`发送成功 [CMD=0x${cmd.toString(16).toUpperCase()}]`, bufferToHex(buffer));
      },
      fail: (err) => {
        console.error('发送失败', err);
      }
    });
  },

  // ========== 心跳 (每2秒) ==========

  startHeartbeat() {
    const timer = setInterval(() => {
      if (this.data.connected) {
        this.sendCmd(CmdCode.HEARTBEAT);
      }
    }, 2000) as unknown as number;
    this.setData({ heartbeatTimer: timer });
  },

  // ========== 动作按键处理 (12键合并为一个功能码) ==========

  onActionTap(e: any) {
    const action = e.currentTarget.dataset.action;
    let actionVal = 0;

    switch (action) {
      case 'stand':       actionVal = ActionValue.STAND; break;
      case 'lie-back':    actionVal = ActionValue.LIE_BACK; break;
      case 'sit-down':    actionVal = ActionValue.SIT_DOWN; break;
      case 'lie-forward': actionVal = ActionValue.LIE_FORWARD; break;
      case 'shake-head':  actionVal = ActionValue.SHAKE_HEAD; break;
      case 'wag-tail':    actionVal = ActionValue.WAG_TAIL; break;
      case 'wave':        actionVal = ActionValue.WAVE; break;
      case 'mark':        actionVal = ActionValue.MARK; break;
      case 'crawl':       actionVal = ActionValue.CRAWL; break;
      case 'push-up':     actionVal = ActionValue.PUSH_UP; break;
      case 'sway':        actionVal = ActionValue.SWAY; break;
      case 'rock':        actionVal = ActionValue.ROCK; break;
    }

    if (actionVal > 0) {
      this.sendCmd(CmdCode.ACTION, new Uint8Array([actionVal]));
    }
  },

   // 切换表情
   onSwitchExpression(): void {
    const newIndex = (this.data.expressionIndex + 1) % this.data.expressionList.length;
    const current = this.data.expressionList[newIndex];
    this.setData({
      expressionIndex: newIndex,
      expressionIcon: current.icon,
      expressionName: current.name,
      expressionColor: current.color
    });
    // 通过蓝牙发送表情指令
    this.sendCmd(CmdCode.EXPRESSION, new Uint8Array([newIndex]));
  },
  // ========== 四足复位 ==========

  onLegReset() {
    this.sendCmd(CmdCode.LEG_RESET);
  },

  // ========== 机器重启 ==========

  onReboot() {
    wx.showModal({
      title: '确认重启',
      content: '确定要重启机器狗吗？',
      success: (res) => {
        if (res.confirm) {
          this.sendCmd(CmdCode.REBOOT);
        }
      }
    });
  },

  // ========== 状态请求 ==========

  requestStatus() {
    this.sendCmd(CmdCode.STATUS_REQ);
  },

  // ========== 摇杆发送坐标 ==========

  onJoystickTouchStart(e: any) {
    this.setData({ isTouching: true });
    this.updateJoystick(e);
  },

  onJoystickTouchMove(e: any) {
    if (this.data.isTouching) {
      this.updateJoystick(e);
    }
  },

  onJoystickTouchEnd() {
    // 摇杆回中
    this.setData({
      isTouching: false,
      handleLeft: 50,
      handleTop: 50,
      joystickX: 0,
      joystickY: 0,
    });
    this.sendCmd(CmdCode.JOYSTICK, new Uint8Array([128, 128])); // (0, 0)
  },

  updateJoystick(e: any) {
    const touch = e.touches[0];
    const query = wx.createSelectorQuery().in(this);
    query.select('#joystick-container').boundingClientRect((rect: any) => {
      if (!rect) return;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const maxRadius = rect.width / 2;

      let dx = touch.clientX - (rect.left + centerX);
      let dy = touch.clientY - (rect.top + centerY);
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > maxRadius) {
        dx = (dx / distance) * maxRadius;
        dy = (dy / distance) * maxRadius;
      }

      // 映射到 -100 ~ 100 用于发送
      const x = Math.round((dx / maxRadius) * 100);
      const y = Math.round((dy / maxRadius) * -100); // Y轴反转

      this.setData({
        joystickX: Math.round(dx),  // 直接使用像素偏移
        joystickY: Math.round(dy),
      });

      this.sendCmd(CmdCode.JOYSTICK, new Uint8Array([x + 128, y + 128]));
    }).exec();
  },

  // ========== 滑杆发送角度 ==========

  onHeadingChange(e: any) {
    const value = e.detail.value; // 假设 slider 范围 -90 ~ 90
    this.setData({ headingValue: value });
    // 映射 -90~90 到 0~180
    this.sendCmd(CmdCode.HEADING, new Uint8Array([value + 90]));
  },

  // ========== 断开连接 ==========

  disconnect() {
    if (this.data.heartbeatTimer) {
      clearInterval(this.data.heartbeatTimer);
      this.setData({ heartbeatTimer: null });
    }
    if (this.data.deviceId) {
      wx.closeBLEConnection({ deviceId: this.data.deviceId });
    }
    wx.closeBluetoothAdapter();
    this.setData({
      connected: false,
      deviceStatus: '未连接',
      batteryLevel: null,
      errorCode: null,
    });
  },
});