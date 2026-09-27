// index.ts
// pages/index/index.ts
import { CmdCode, ActionValue, packFrame, bufferToHex } from '../utils/protocol';

// ========== 心跳参数 ==========
const HEARTBEAT_PERIOD_MS = 2000; // 心跳周期：2秒
const HEARTBEAT_MISS_LIMIT = 5;   // 连续5个周期(~10秒)设备无回复判失联

// 设备列表本地缓存 key
const DEVICE_LIST_KEY = 'jdy_device_list';

// 定义 Page Data 的类型
interface PageData {
  connected: boolean;
  deviceName: string;
  deviceId: string;
  serviceId: string;
  writeCharId: string;
  notifyCharId: string;
  batteryLevel: number | null;
  batteryClass: string;
  heartbeatTimer: number | null;
  errorCode: number | null;
  deviceStatus: string;
   // 设备选择弹窗
  deviceList: Array<{ deviceId: string; name: string }>;
  showDevicePopup: boolean;
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
   _foundDevices: [] as { deviceId: string; name: string; rssi: number }[],
  _discoveryTimer: null as unknown as number,
  _joystickRect: null as any,
  _missedHeartbeats: 0,   // 未收到设备回复的心跳周期计数
  _lastSendAt: 0,         // 最近一次发送任何指令的时间戳
  data: {
    connected: false,
    deviceName: '',
    deviceId: '',
    serviceId: '',
    writeCharId: '',
    notifyCharId: '',
    batteryLevel: null,
    batteryClass: '',
    heartbeatTimer: null,
    errorCode: null,
    deviceStatus: '未连接',
    deviceList: [],
    showDevicePopup: false,

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
     // 恢复上次缓存的设备列表
    const cached = wx.getStorageSync(DEVICE_LIST_KEY) || [];
    this.setData({ deviceList: cached });
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

    // ========== 更新电量值与图标颜色 ==========

  updateBattery(level: number) {
    let cls = 'battery-low';
    if (level > 50) cls = 'battery-high';
    else if (level > 20) cls = 'battery-medium';
    this.setData({ batteryLevel: level, batteryClass: cls });
  },

   // ========== 权限申请（能申请的就主动申请，申请不了的引导去设置） ==========

  async ensurePermissions(): Promise<boolean> {
    // 1. 小程序级蓝牙授权（scope.bluetooth）
    try {
      await wx.authorize({ scope: 'scope.bluetooth' });
    } catch (e) {
      const { authSetting } = await wx.getSetting();
      if (authSetting['scope.bluetooth'] === false) {
        // 被拒绝过，弹窗不再出现，只能引导去小程序设置页
        const { confirm } = await wx.showModal({
          title: '需要蓝牙权限',
          content: '请在设置页面中开启蓝牙权限后重试',
          confirmText: '去设置'
        });
        if (confirm) {
          const { authSetting: s } = await wx.openSetting();
          if (!s['scope.bluetooth']) return false;
        } else {
          return false;
        }
      } else {
        return false;
      }
    }

    // 2. Android 搜索 BLE 必须有定位权限（不申请会静默扫不到设备）
    const sys = wx.getSystemInfoSync();
    if (sys.platform === 'android') {
      try {
        await wx.getLocation({ type: 'wgs84' });
      } catch (e) {
        wx.showModal({
          title: '无法搜索设备',
          content: 'Android 搜索蓝牙需要微信拥有定位权限。请到【手机系统设置 → 应用 → 微信 → 权限 → 位置信息】中开启，并打开手机定位总开关。',
          showCancel: false
        });
        return false;
      }
    }
    return true;
  },
  // ========== 连接设备流程 ==========

  async onConnect() {
     if (!(await this.ensurePermissions())) return;

    try {
      await wx.openBluetoothAdapter({ mode: 'central' });
    } catch (err) {
      wx.showToast({ title: '请开启蓝牙权限', icon: 'none' });
      return;
    }

    const adapter = await wx.getBluetoothAdapterState();
    if (!adapter.available) {
      wx.showToast({ title: '蓝牙不可用，请开启手机蓝牙', icon: 'none' });
      return;
    }

    // 列表里已有设备 → 直接弹出选择，不再搜索
    if (this.data.deviceList.length > 0) {
      this.setData({ showDevicePopup: true });
      return;
    }
    // 列表为空 → 搜索
    this.startDiscovery();
  },

  startDiscovery() {
    this._foundDevices = [];
    wx.showLoading({ title: '搜索中...', mask: true });

    wx.startBluetoothDevicesDiscovery({
      services: ['0000FFE0-0000-1000-8000-00805F9B34FB'],
      allowDuplicatesKey: true,
      success: () => {
        this._discoveryTimer = setTimeout(() => this.stopAndPick(), 8000) as unknown as number;
      },
      fail: (err) => {
        console.error('搜索失败', err);
        wx.hideLoading();
        wx.showToast({ title: '搜索失败 ' + (err.errCode || ''), icon: 'none' });
      }
    });

    wx.onBluetoothDeviceFound((res) => {
      res.devices.forEach((d) => {
        const name = d.localName || d.name || '';
        if (name && !name.toUpperCase().includes('JDY')) return;
        const exist = this._foundDevices.find(x => x.deviceId === d.deviceId);
        if (!exist) {
          this._foundDevices.push({ deviceId: d.deviceId, name, rssi: d.RSSI || 0 });
        } else {
          exist.rssi = d.RSSI || exist.rssi;
          if (!exist.name && name) exist.name = name;
        }
      });
    });
  },
   stopAndPick() {
    wx.stopBluetoothDevicesDiscovery();
    if (this._discoveryTimer) { clearTimeout(this._discoveryTimer); this._discoveryTimer = null as unknown as number; }
    wx.hideLoading();

    // 本次扫到的有效设备（按信号强弱排序，但不显示信号值）
    const found = (this._foundDevices || [])
      .filter(d => d.name.toUpperCase().includes('JDY'))
      .sort((a, b) => b.rssi - a.rssi)
      .map(d => ({ deviceId: d.deviceId, name: d.name }));

    if (found.length === 0) {
      wx.showToast({ title: '未扫到JDY设备，确认模块已上电且未被其他手机连接', icon: 'none', duration: 3000 });
      // 缓存列表若还在，仍弹出供选择
      if (this.data.deviceList.length > 0) this.setData({ showDevicePopup: true });
      return;
    }

    // 与缓存合并去重（deviceId 唯一，新扫到的更新名字并排前），写回本地
    const merged = [...found];
    this.data.deviceList.forEach(old => {
      if (!merged.some(n => n.deviceId === old.deviceId)) merged.push(old);
    });
    wx.setStorageSync(DEVICE_LIST_KEY, merged);
    this.setData({ deviceList: merged, showDevicePopup: true });
  },

  // ========== 设备选择弹窗 ==========

  closeDevicePopup() {
    this.setData({ showDevicePopup: false });
  },

  // 弹窗内阻止冒用遮罩关闭
  noop() {},

  onSelectDevice(e: any) {
    const { deviceId, name } = e.currentTarget.dataset;
    this.setData({ showDevicePopup: false });
    if (this.data.connected && this.data.deviceId !== deviceId) {
      wx.closeBLEConnection({ deviceId: this.data.deviceId });
    }
    this.createConnection(deviceId, name);
  },

  onReSearch() {
    this.setData({ showDevicePopup: false });
    this.startDiscovery();
  },

  onDeleteDevice(e: any) {
    const { deviceId, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除设备',
      content: `确定从列表移除 ${name} 吗？`,
      success: (res) => {
        if (!res.confirm) return;
        const list = this.data.deviceList.filter(d => d.deviceId !== deviceId);
        wx.setStorageSync(DEVICE_LIST_KEY, list);
        this.setData({ deviceList: list });
        // 删除的是当前已连接设备时，同步断开
        if (this.data.connected && this.data.deviceId === deviceId) {
          this.disconnect();
        }
        // 列表删空则关闭弹窗
        if (list.length === 0) this.setData({ showDevicePopup: false });
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
    this._missedHeartbeats = 0;
    // 根据命令码解析
    switch (cmd) {
      case CmdCode.BATTERY:
        if (dataLen >= 1) {
          this.updateBattery(view.getUint8(4));
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
        // 心跳应答/状态上报帧
        // 数据域约定: Data[0]=电量(0~100), Data[1]=运行状态; 若固件顺序不同请对调
        if (dataLen >= 1) {
          const battery = Math.max(0, Math.min(100, view.getUint8(4)));
          if (battery <= 100) {
            this.updateBattery(battery);
          }
          if (dataLen >= 2) {
            const status = view.getUint8(5);
            this.setData({ deviceStatus: this.getStatusText(status) });
          }
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

    // 建议1：任何指令都视为"在线证明"，记录时间戳，心跳周期内不再补发
    this._lastSendAt = Date.now();
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
    this._missedHeartbeats = 0;
    this._lastSendAt = Date.now();
    const timer = setInterval(() => {
      if (!this.data.connected) return;

      // 建议1：本周期内刚发过其它指令(如摇杆连续帧)，说明链路活跃，不重复发心跳
      if (Date.now() - this._lastSendAt >= HEARTBEAT_PERIOD_MS) {
        this.sendCmd(CmdCode.HEARTBEAT);
      }

      // 建议2：超时计数——连续约10秒没收到设备任何数据即判无响应
      this._missedHeartbeats++;
      if (this._missedHeartbeats > HEARTBEAT_MISS_LIMIT) {
        this._missedHeartbeats = 0;
        wx.showToast({ title: '设备无响应', icon: 'none' });
        this.setData({ deviceStatus: '设备无响应' });
      }
    }, HEARTBEAT_PERIOD_MS) as unknown as number;
    this.setData({ heartbeatTimer: timer });
  },

 
  // ========== 动作按键处理 (12键合并为一个功能码) ==========

  // ========== 动作按键处理 (12键动作 + 系统按钮统一入口) ==========

  onAction(e: any) {
    const action = e.currentTarget.dataset.action;

    // 系统按钮分流
    if (action === 'reboot') { this.onReboot(); return; }
    if (action === 'leg_reset') { this.onLegReset(); return; }

    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }

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
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }
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
    // 触摸开始时同步缓存面板位置，move 中不再走异步查询
    this._joystickRect = null;
    wx.createSelectorQuery().in(this).select('#joystick-container').boundingClientRect((rect: any) => {
      this._joystickRect = rect;
    }).exec();
    this.setData({ isTouching: true });
    this.updateJoystick(e);
  },

  onJoystickTouchMove(e: any) {
    if (this.data.isTouching) {
      this.updateJoystick(e);
    }
  },

  onJoystickTouchEnd() {
    this.resetJoystick();
  },

  onJoystickTouchCancel() {
    this.resetJoystick();
  },

  resetJoystick() {
    // 摇杆回中
    this.setData({
      isTouching: false,
      joystickX: 0,
      joystickY: 0,
    });
    this.sendCmd(CmdCode.JOYSTICK, new Uint8Array([128, 128])); // (0, 0)
  },

  updateJoystick(e: any) {
    const touch = e.touches && e.touches[0];
    // 关键修复：touchend 之后到达的过期回调直接丢弃，防止旧坐标把摇杆"写回去"
    if (!touch || !this.data.isTouching) return;

    const rect = this._joystickRect;
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
  },


  // ========== 滑杆发送角度 ==========

  onHeadingChanging(e: any) {
    // 拖动过程中只更新数值显示，不发送，避免指令刷屏
    this.setData({ headingValue: e.detail.value });
  },

  onHeadingChange(e: any) {
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' });
      return;
    }
    const value = e.detail.value; // 假设 slider 范围 -90 ~ 90
    this.setData({ headingValue: value });
    // 映射 -90~90 到 0~180
    this.sendCmd(CmdCode.HEADING, new Uint8Array([value + 90]));
  },

  // ========== 断开连接 ==========

  // 按钮入口（wxml 绑定的是 onDisconnect）
  onDisconnect() {
    this.disconnect();
    wx.showToast({ title: '已断开', icon: 'none' });
  },

  disconnect() {
    if (this.data.heartbeatTimer) {
      clearInterval(this.data.heartbeatTimer);
      this.setData({ heartbeatTimer: null });
    }
    if (this.data.deviceId) {
      wx.closeBLEConnection({
        deviceId: this.data.deviceId,
        fail: (err) => console.warn('closeBLEConnection 失败(可忽略，多为设备已先行断开)', err),
      });
    }
    wx.closeBluetoothAdapter({
      complete: () => {
        this.setData({
          connected: false,
          deviceStatus: '未连接',
          deviceId: '',
          deviceName: '',
          serviceId: '',
          writeCharId: '',
          notifyCharId: '',
          batteryLevel: null,
          batteryClass: '',
          errorCode: null,
        });
      },
    });
  },
});