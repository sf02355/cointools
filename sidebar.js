let orderResults = [];
let messages = [];
let trackedOrders = new Map();
let serverTimeOffset = 0;
let heartbeatInterval = null;
let reconnectAttempts = 0;
let isAutoRunning = false;
let currentPrice = null;
const maxReconnectDelay = 30000;
var API_KEY = '123456';
const RECV_WINDOW = 20000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;


async function syncServerTime() {
  try {
    const response = await fetch('https://api.bybit.com/v5/market/time', { timeout: 10000 });
    const data = await response.json();
    if (data.retCode === 0) {
      serverTimeOffset = parseInt(data.result.timeNano) / 1000000 - Date.now();
      addMessage('服务器时间同步成功', 'success');
      return parseInt(data.result.timeNano) / 1000000;
    } else {
      addMessage(`服务器时间同步失败: ${data.retMsg}`, 'error');
      throw new Error(data.retMsg);
    }
  } catch (error) {
    addMessage(`服务器时间同步错误: ${error.message}`, 'error');
    throw error;
  }
}

function getAdjustedTimestamp() {
  return Math.floor(Date.now() + serverTimeOffset);
}

async function getHttpSignature(parameters, secret, timestamp) {
  try {
    const paramString = `${timestamp}${API_KEY}${RECV_WINDOW}${parameters}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(paramString));
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    addMessage(`签名生成失败: ${error.message}`, 'error');
    throw error;
  }
}

async function httpRequest(endpoint, method, data, info, apiSecret, retries = MAX_RETRIES) {
  await syncServerTime();
  const localTime = Date.now();
  const serverTime = getAdjustedTimestamp();
  if (Math.abs(serverTime - localTime) > RECV_WINDOW) {
    addMessage('本地时间与服务器时间差过大，请同步系统时间', 'error');
    return { success: false, error: '时间同步失败' };
  }

  const timestamp = serverTime.toString();
  let params = '';
  let url = `https://api.bybit.com${endpoint}`;
  let body = undefined;

  if (method === 'GET') {
    params = Object.keys(data).sort().reduce((str, key) => {
      return str + (str ? '&' : '') + `${key}=${encodeURIComponent(data[key])}`;
    }, '');
    url = `${url}?${params}`;
  } else {
    params = JSON.stringify(data);
    body = params;
  }

  const signature = await getHttpSignature(params, apiSecret, timestamp);

  const headers = {
    'X-BAPI-SIGN-TYPE': '2',
    'X-BAPI-SIGN': signature,
    'X-BAPI-API-KEY': API_KEY,
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': RECV_WINDOW.toString(),
    'Content-Type': 'application/json; charset=utf-8',
    'Accept': 'application/json'
  };

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      timeout: 10000
    });
    const data = await response.json();
    if (data.retCode === 0) {
      return { success: true, data };
    } else {
      if (data.retCode === 170003) {
        addMessage(`${info} 失败: 包含未知参数，请检查订单参数`, 'error');
      } else if (data.retCode === 130004) {
        addMessage(`${info} 失败: 账户余额不足`, 'error');
      } else if (data.retCode === 10001) {
        addMessage(`${info} 失败: 时间戳无效，请检查时间同步`, 'error');
      }
      throw new Error(data.retMsg || 'API 请求失败');
    }
  } catch (error) {
    console.error(`${info} 错误:`, error.message, { retCode: data?.retCode, retMsg: data?.retMsg });
    if (retries > 0 && (
      error.message.includes('ECONNRESET') ||
      error.message.includes('timeout') ||
      data?.retCode === 10001 ||
      data?.retCode === 10004
    )) {
      addMessage(`${info} 重试 ${MAX_RETRIES - retries + 1}/${MAX_RETRIES}`, 'info');
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return httpRequest(endpoint, method, data, info, apiSecret, retries - 1);
    }
    addMessage(`${info} 失败: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
}

async function encryptConfig(config, password) {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(config));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password.padEnd(32, '\0').slice(0, 32)),
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return {
      iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''),
      encrypted: Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, '0')).join('')
    };
  } catch (error) {
    addMessage(`加密失败: ${error.message}`, 'error');
    throw error;
  }
}

async function decryptConfig(encryptedData, password) {
  try {
    const encoder = new TextEncoder();
    const iv = new Uint8Array(encryptedData.iv.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const encrypted = new Uint8Array(encryptedData.encrypted.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password.padEnd(32, '\0').slice(0, 32)),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (error) {
    addMessage(`解密失败: ${error.message}`, 'error');
    throw error;
  }
}

async function saveConfig() {
  const password = document.getElementById('password').value;
  if (!password) {
    addMessage('请输入密码', 'error');
    return;
  }
  const config = {
    tpPercent: parseFloat(document.getElementById('tp-percent').value) || 0,
    slPercent: parseFloat(document.getElementById('sl-percent').value) || 0,
    apiKey: document.getElementById('api-key').value.trim(),
    apiSecret: document.getElementById('api-secret').value.trim(),
    orderQuantity: parseFloat(document.getElementById('order-quantity').value) || 0
  };
  try {
    const encryptedConfig = await encryptConfig(config, password);
    chrome.storage.local.set({ encryptedConfig }, () => {
      addMessage('配置已保存', 'success');
    });
  } catch (error) {
    addMessage('保存配置失败', 'error');
  }
}

async function loadConfig() {
  console.log('loadConfig');
  const password = document.getElementById('password').value;
  if (!password) {
    addMessage('请输入密码', 'error');
    return;
  }
  chrome.storage.local.get(['encryptedConfig'], async (result) => {
    if (!result.encryptedConfig) {
      addMessage('无保存的配置', 'error');
      return;
    }
    try {
      const config = await decryptConfig(result.encryptedConfig, password);
      document.getElementById('tp-percent').value = stringToNumber(config.tpPercent.toString(),5);
      document.getElementById('sl-percent').value = stringToNumber(config.slPercent.toString(),5);
      document.getElementById('api-key').value = config.apiKey;
      API_KEY = config.apiKey;
      document.getElementById('api-secret').value = config.apiSecret;
      document.getElementById('order-quantity').value = stringToNumber(config.orderQuantity.toString(),1);
      addMessage('配置已加载', 'success');
    } catch (error) {
      addMessage('加载配置失败，密码错误或数据损坏', 'error');
    }
  });
}

/**
 * 将字符串转换为数字，并可选择性地格式化小数位数。
 *
 * @param {string} str - 需要转换的字符串。
 * @param {number} [decimalPlaces] - (可选) 需要保留的小数位数。如果提供，必须为非负整数。
 * @returns {number} 转换并格式化后的数字。
 * @throws {Error} 如果输入不是有效的字符串，或者无法转换为有限数字，
 * 或者 decimalPlaces 不是有效的非负整数时，抛出异常。
 */
function stringToNumber(str, decimalPlaces) {
  // 1. 验证输入字符串
  if (typeof str !== 'string' || str.trim() === '') {
    throw new Error("输入必须是一个非空的字符串。");
  }

  // 2. 尝试将字符串转换为数字
  const num = Number(str.trim()); // 使用 trim() 移除首尾空格

  // 3. 验证转换结果是否为有限数字 (不是 NaN, Infinity, -Infinity)
  if (!Number.isFinite(num)) {
    throw new Error(`输入字符串 "${str}" 无法转换为有效的有限数字。`);
  }

  // 4. 如果指定了小数位数，则进行处理
  if (decimalPlaces !== undefined && decimalPlaces !== null) {
    // 验证 decimalPlaces 是否为非负整数
    if (typeof decimalPlaces !== 'number' || !Number.isInteger(decimalPlaces) || decimalPlaces < 0) {
      throw new Error("指定的小数位数必须是一个非负整数。");
    }

    // 使用 toFixed 进行四舍五入并转换为字符串，然后再转回数字
    return Number(num.toFixed(decimalPlaces));
  } else {
    // 5. 如果未指定小数位数，直接返回转换后的数字
    return num;
  }
}

function startHeartbeat(ws) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: 'ping' }));
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

async function queryOrderStatus(orderId, clientOrderId, apiKey, apiSecret, retries = MAX_RETRIES) {
  const data = { category: 'spot', orderId };
  const result = await httpRequest('/v5/order/realtime', 'GET', data, `查询订单 ${orderId}`, apiSecret, retries);
  if (result.success && result.data.result.list.length > 0) {
    const order = result.data.result.list[0];
    let message = `订单 ${orderId} 状态: ${order.orderStatus}`;
    if (order.takeProfit && order.stopLoss) {
      message += `, 止盈: ${order.takeProfit}, 止损: ${order.stopLoss}`;
    }
    addMessage(message, 'info');
    return { status: order.orderStatus, order };
  }
  addMessage(`订单 ${orderId} 状态查询失败: ${result.error || '无数据'}`, 'error');
  return null;
}

async function queryWalletBalance(apiKey, apiSecret) {
  const data = { accountType: 'UNIFIED' };
  const result = await httpRequest('/v5/account/wallet-balance', 'GET', data, '查询钱包余额', apiSecret);
  if (result.success) {
    const coins = result.data.result.list[0].coin;
    const allUnlocked = coins.every(coin => parseFloat(coin.locked) === 0);
    addMessage(`钱包余额查询: 所有币种 locked ${allUnlocked ? '均为 0' : '存在非 0'}`, 'info');
    return { allUnlocked, coins };
  }
  addMessage(`钱包余额查询失败: ${result.error}`, 'error');
  return null;
}

async function cancelOrder(orderId, clientOrderId, cookieHeader) {
  const formData = new URLSearchParams({ order_id: orderId, client_order_id: clientOrderId });
  try {
    const response = await fetch('https://api2-2.bybit.com/spot/api/order/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-MY',
        'Origin': 'https://www.bybit.com',
        'Referer': 'https://www.bybit.com/zh-MY/trade/spot/NXPC/USDT',
        'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      },
      body: formData
    });
    const data = await response.json();
    if (data.ret_code === 0 && data.result.success) {
      addMessage(`订单 ${orderId} 已取消`, 'success');
      return true;
    }
    throw new Error(data.ret_msg || `取消失败 (ret_code: ${data.ret_code})`);
  } catch (error) {
    console.error(`取消订单 ${orderId} 错误:`, error.message, { response: data });
    addMessage(`订单 ${orderId} 取消失败: ${error.message}`, 'error');
    return false;
  }
}

async function placeOrder(price, quantity, tpPercent, slPercent, symbolId, apiKey, apiSecret, isAuto = false) {
  if (isNaN(price) || isNaN(quantity) || isNaN(tpPercent) || isNaN(slPercent)) {
    document.getElementById('json-output').textContent = '错误：请输入有效的数字';
    document.getElementById('json-output').style.color = 'red';
    document.getElementById('submit-result').textContent = '未提交：输入无效';
    addMessage('输入无效，无法提交订单', 'error');
    return null;
  }
  if (!apiKey || !apiSecret) {
    document.getElementById('json-output').textContent = '错误：请输入 API 密钥和私钥';
    document.getElementById('json-output').style.color = 'red';
    document.getElementById('submit-result').textContent = '未提交：API 密钥缺失';
    addMessage('请输入 API 密钥和私钥', 'error');
    return null;
  }
  if (tpPercent <= 0 || slPercent <= 0) {
    document.getElementById('json-output').textContent = '错误：止盈止损百分比必须大于 0';
    document.getElementById('json-output').style.color = 'red';
    document.getElementById('submit-result').textContent = '未提交：止盈止损无效';
    addMessage('止盈止损百分比必须大于 0', 'error');
    return null;
  }
  if (!symbolId.match(/^[A-Z0-9]+$/)) {
    document.getElementById('json-output').textContent = '错误：交易对格式无效';
    document.getElementById('json-output').style.color = 'red';
    document.getElementById('submit-result').textContent = '未提交：交易对无效';
    addMessage('交易对格式无效，请输入如 NXPCUSDT', 'error');
    return null;
  }
  if (price <= 0) {
    document.getElementById('json-output').textContent = '错误：订单价格无效';
    document.getElementById('json-output').style.color = 'red';
    document.getElementById('submit-result').textContent = '未提交：价格无效';
    addMessage('订单价格无效，必须大于 0', 'error');
    return null;
  }

  const tpPrice = (price * (1 + tpPercent / 100)).toFixed(5);
  const slPrice = (price * (1 - slPercent / 100)).toFixed(5);
  const clientOrderId = Date.now().toString();
  const order = {
    category: 'spot',
    symbol: symbolId,
    side: 'Buy',
    orderType: 'Limit',
    qty: quantity.toFixed(1),
    price: price.toFixed(5),
    timeInForce: 'GTC',
    takeProfit: tpPrice,
    tpOrderType: 'Limit',
    tpLimitPrice: tpPrice,
    stopLoss: slPrice,
    slOrderType: 'Limit',
    slLimitPrice: slPrice,
    orderLinkId: clientOrderId
  };

  document.getElementById('json-output').textContent = JSON.stringify(order, null, 2);
  document.getElementById('json-output').style.color = 'black';
  
  const result = await httpRequest('/v5/order/create', 'POST', order, `提交订单 ${clientOrderId}`, apiSecret);
  if (result.success) {
    const data = result.data;
    data.client_order_id = clientOrderId;
    data.timestamp = Date.now();
    orderResults.push(data);
    renderOrderResults();
    const latestIndex = orderResults.length - 1;
    document.querySelector(`#order-results-list li[data-index="${latestIndex}"]`)?.click();
    addMessage(`订单 ${data.result?.orderId || clientOrderId} 提交成功，止盈止损已设置${isAuto ? '（自动，价格=${price}）' : ''}`, 'success');
    return { orderId: data.result.orderId, clientOrderId };
  } else {
    orderRunning = false;
    toggleOrderButtonState();
    const errorResult = {
      retCode: result.data?.retCode || -1,
      retMsg: result.error || '网络错误',
      client_order_id: clientOrderId,
      timestamp: Date.now()
    };
    orderResults.push(errorResult);
    renderOrderResults();
    document.querySelector(`#order-results-list li[data-index="${orderResults.length - 1}"]`)?.click();
    addMessage(`订单提交失败: ${result.error}${isAuto ? '（自动）' : ''}`, 'error');
    return null;
  }
}

async function trackOrder(orderId, clientOrderId, apiKey, apiSecret, cookieHeader) {
  if (trackedOrders.has(orderId)) return;
  let queryCount = 0;

  const interval = setInterval(async () => {
    queryCount++;
    console.log(`查询订单 ${orderId} 状态，次数: ${queryCount}`);
    const result = await queryOrderStatus(orderId, clientOrderId, apiKey, apiSecret);
    if (!result) {
      if (queryCount >= 12) {
        console.log(`订单 ${orderId} 状态查询失败，取消订单`);
        
        clearInterval(interval);
        trackedOrders.delete(orderId);
        const cancelled = await cancelOrder(orderId, clientOrderId, cookieHeader);
        orderRunning = false;
        toggleOrderButtonState();
        if (cancelled && isAutoRunning) {
          addMessage(`自动运行：订单 ${orderId} 已取消，10秒后开始新循环`, 'info');
          setTimeout(() => {
            if (isAutoRunning) startAutoRun();
          }, 10000);
        }
      }
      return;
    }
    const { status, order } = result;
    if (status === 'Filled' || status === 'Cancelled') {
      
      const balanceResult = await queryWalletBalance(apiKey, apiSecret);
      addMessage(
        `订单 ${orderId} 已完成，止盈止损${balanceResult && balanceResult.allUnlocked ? '结束' : '未结束'}`,
        balanceResult && balanceResult.allUnlocked ? 'success' : 'info'
      );
      if (balanceResult && balanceResult.allUnlocked ) {
        orderRunning = false;
        toggleOrderButtonState();
        clearInterval(interval);
        trackedOrders.delete(orderId);
        if(isAutoRunning){
          addMessage(`自动运行：订单 ${orderId} 已完成，钱包无锁定，10秒后开始新循环`, 'info');
          setTimeout(() => {
            if (isAutoRunning) startAutoRun();
          }, 10000);
        }
      } 
    } else if (queryCount >= 12) {
      clearInterval(interval);
      trackedOrders.delete(orderId);
      const cancelled = await cancelOrder(orderId, clientOrderId, cookieHeader);
      if (cancelled && isAutoRunning) {
        addMessage(`自动运行：订单 ${orderId} 已取消，10秒后开始新循环`, 'info');
        setTimeout(() => {
          if (isAutoRunning) startAutoRun();
        }, 10000);
      }
    }
  }, 6000);
  //这里上面的时间是6秒，作用是每6秒查询一次订单状态，如果订单状态为Filled或者Cancelled，则停止查询，否则继续查询，直到查询次数达到12次，然后取消订单
  trackedOrders.set(orderId, { clientOrderId, queryCount, interval });
}

async function startAutoRun() {
  if (!isAutoRunning) {
    isAutoRunning = true;
    document.getElementById('auto-run-btn').disabled = true;
    document.getElementById('stop-auto-btn').disabled = false;
    document.getElementById('auto-status').textContent = '运行中';
    document.getElementById('auto-status').classList.remove('stopped');
    document.getElementById('auto-status').classList.add('running');
    addMessage('自动运行已启动', 'success');

  }

  const quantity = parseFloat(document.getElementById('order-quantity').value);
  const tpPercent = parseFloat(document.getElementById('tp-percent').value);
  const slPercent = parseFloat(document.getElementById('sl-percent').value);
  const symbolId = document.getElementById('symbol-id').value;
  const apiKey = document.getElementById('api-key').value.trim();
  const apiSecret = document.getElementById('api-secret').value.trim();

  if (!currentPrice) {
    addMessage('自动运行失败：当前价格不可用，请等待价格更新', 'error');
    stopAutoRun();
    return;
  }

  const adjustedPrice = currentPrice - 0.0001;
  if (adjustedPrice <= 0) {
    addMessage('自动运行失败：调整后价格无效', 'error');
    stopAutoRun();
    return;
  }

  const result = await placeOrder(
    adjustedPrice,
    quantity,
    tpPercent,
    slPercent,
    symbolId,
    apiKey,
    apiSecret,
    true
  );

  if (result) {
    trackOrder(result.orderId, result.clientOrderId, apiKey, apiSecret, '');
  } else {
    addMessage('自动运行暂停：下单失败', 'error');
    stopAutoRun();
  }
}

function stopAutoRun() {
  isAutoRunning = false;
  document.getElementById('auto-run-btn').disabled = false;
  document.getElementById('stop-auto-btn').disabled = true;
  document.getElementById('auto-status').textContent = '已停止';
  document.getElementById('auto-status').classList.remove('running');
  document.getElementById('auto-status').classList.add('stopped');
  addMessage('自动运行已停止', 'success');
}

function ensureSidebarOpen() {
  chrome.runtime.sendMessage({ action: 'toggleSidebar' }, (response) => {
    if (chrome.runtime.lastError) {
      addMessage(`打开侧边栏失败: ${chrome.runtime.lastError.message}`, 'error');
      console.error('侧边栏消息错误:', chrome.runtime.lastError.message);
      return;
    }
    if (response && response.success) {
      addMessage('侧边栏已打开', 'success');
    } else {
      addMessage(`侧边栏响应失败: ${response?.message || '无响应'}`, 'error');
      console.error('侧边栏响应:', response);
    }
  });
}

document.getElementById('toggle-btn').addEventListener('click', ensureSidebarOpen);

document.getElementById('test-communication-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'testCommunication' }, (response) => {
    if (chrome.runtime.lastError) {
      document.getElementById('submit-result').textContent = `错误：${chrome.runtime.lastError.message}`;
      document.getElementById('submit-result').style.color = 'red';
      addMessage(`测试通信失败: ${chrome.runtime.lastError.message}`, 'error');
      return;
    }
    document.getElementById('submit-result').textContent = response?.message || '无响应';
    document.getElementById('submit-result').style.color = response?.success ? 'green' : 'red';
    addMessage('测试通信成功', 'success');
  });
});

document.getElementById('save-config-btn').addEventListener('click', saveConfig);
document.getElementById('load-config-btn').addEventListener('click', loadConfig);

let orderRunning = false;
document.getElementById('place-order-btn').addEventListener('click', async () => {
  const price = parseFloat(document.getElementById('order-price').value);
  const quantity = parseFloat(document.getElementById('order-quantity').value);
  const tpPercent = parseFloat(document.getElementById('tp-percent').value);
  const slPercent = parseFloat(document.getElementById('sl-percent').value);
  const symbolId = document.getElementById('symbol-id').value;
  const apiKey = document.getElementById('api-key').value.trim();
  const apiSecret = document.getElementById('api-secret').value.trim();

  const result = await placeOrder(price, quantity, tpPercent, slPercent, symbolId, apiKey, apiSecret);
  if (result) {
    orderRunning = true;
    toggleOrderButtonState();
    trackOrder(result.orderId, result.clientOrderId, apiKey, apiSecret, '');
  }
});

document.getElementById('auto-run-btn').addEventListener('click', startAutoRun);
document.getElementById('stop-auto-btn').addEventListener('click', stopAutoRun);

//一个函数来控制单次提交订单和自动提交中间按钮的状态
function toggleOrderButtonState() {
  if (orderRunning || isAutoRunning) {
    let em =document.getElementById('place-order-btn');
    //移除按钮的btn-primary样式
    em.classList.remove('btn-primary');
    //添加按钮的btn-danger样式
    em.classList.add('btn-danger');
    em.disabled = true;
    
  }else{
    let em =document.getElementById('place-order-btn');
    em.classList.remove('btn-danger');
    em.classList.add('btn-primary');
    em.disabled = false;
    
  }
}

const symbol = 'NXPCUSDT';
const fallbackSymbol = 'BTCUSDT';
let ws = null;

function initializePriceWebSocket() {
  ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
  ws.onopen = () => {
    ws.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${symbol}`] }));
    startHeartbeat(ws);
    addMessage('价格 WebSocket 连接成功', 'success');
  };
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.op === 'subscribe' && !data.success) {
        ws.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${fallbackSymbol}`] }));
        addMessage(`价格订阅失败: ${data.ret_msg}`, 'error');
      } else if (data.topic === `publicTrade.${symbol}` || data.topic === `publicTrade.${fallbackSymbol}`) {
        if (data.data && data.data.length > 0) {
          const trade = data.data[0];
          currentPrice = parseFloat(trade.p);
          updatePriceDisplay(currentPrice, trade.T, data.topic.split('.')[1]);
        }
      }
    } catch (error) {
      addMessage(`价格 WebSocket 消息解析失败: ${error.message}`, 'error');
    }
  };
  ws.onclose = (event) => {
    stopHeartbeat();
    addMessage(`价格 WebSocket 连接断开`, 'error');
    if (event.code !== 1000) {
      reconnectAttempts++;
      const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
      setTimeout(initializePriceWebSocket, delay);
    }
  };
  ws.onerror = () => {
    addMessage('价格 WebSocket 发生错误', 'error');
  };
}

function updatePriceDisplay(price, timestamp, symbol) {
  document.getElementById('current-price').textContent = `${parseFloat(price).toFixed(5)} (${symbol})`;
  document.getElementById('last-updated').textContent = new Date(timestamp).toLocaleString();
}

function addMessage(text, type = 'info') {
  messages.unshift({ text, type, timestamp: Date.now() });
  if (messages.length > 20) messages.pop();
  renderMessages();
}

let lastRenderedMessages = null;
function renderMessages() {
  const list = document.getElementById('message-list');
  if (!list) return;
  const currentMessages = JSON.stringify(messages);
  if (currentMessages === lastRenderedMessages) return;
  lastRenderedMessages = currentMessages;
  list.innerHTML = messages.map(msg =>
    `<li class="${msg.type}">[${new Date(msg.timestamp).toLocaleTimeString()}] ${msg.text}</li>`
  ).join('');
}

let lastRenderedOrders = null;
function renderOrderResults() {
  const list = document.getElementById('order-results-list');
  if (!list) return;
  const currentOrders = JSON.stringify(orderResults);
  if (currentOrders === lastRenderedOrders) return;
  lastRenderedOrders = currentOrders;
  list.innerHTML = orderResults.map((result, index) => {
    const status = (result.ret_code === 0 || result.retCode === 0) ? '成功' : '失败';
    const orderId = result.result?.orderId || result.client_order_id || '未知';
    const timestamp = new Date(result.timestamp).toLocaleString();
    return `<li data-index="${index}">订单 ${orderId} (${status}, ${timestamp})</li>`;
  }).join('');
  list.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      list.querySelectorAll('li').forEach(item => item.classList.remove('selected'));
      li.classList.add('selected');
      const index = li.dataset.index;
      const result = orderResults[index];
      document.getElementById('submit-result').textContent = JSON.stringify(result, null, 2);
      document.getElementById('submit-result').style.color = (result.ret_code === 0 || result.retCode === 0) ? 'green' : 'red';
    });
  });
}

syncServerTime();
setInterval(syncServerTime, 60000*3);
initializePriceWebSocket();
setTimeout(ensureSidebarOpen, 1000);


function initPage(){
  const btnOrder = document.getElementById('tabOrderBtn');
  const btnLog = document.getElementById('tabLogBtn');
  const btnSet = document.getElementById('tabSetBtn');
  const tabOrder = document.getElementById('tabOrder');
  const tabLog = document.getElementById('tabLog');
  const tabSet = document.getElementById('tabSet');

  tabOrder.style.display = 'block';
  tabLog.style.display = 'none';
  tabSet.style.display = 'none';
  btnOrder.classList.add('active');
  btnLog.classList.remove('active');
  btnSet.classList.remove('active');

  btnOrder.addEventListener('click', () => {
    tabOrder.style.display = 'block';
    tabLog.style.display = 'none';
    tabSet.style.display = 'none';
    btnOrder.classList.add('active');
    btnLog.classList.remove('active');
    btnSet.classList.remove('active');
  });

  btnLog.addEventListener('click', () => {
    tabOrder.style.display = 'none';
    tabLog.style.display = 'block';
    tabSet.style.display = 'none';
    btnOrder.classList.remove('active');  
    btnLog.classList.add('active');
    btnSet.classList.remove('active');
  })
  btnSet.addEventListener('click', () => {
    tabOrder.style.display = 'none';
    tabLog.style.display = 'none';
    tabSet.style.display = 'block'; 
    btnOrder.classList.remove('active');
    btnLog.classList.remove('active');
    btnSet.classList.add('active');
  })
}
initPage();