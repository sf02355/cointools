// Global Variables & Constants
let orderResults = []; 
let messages = [];
let trackedOrders = new Map(); 
let gridOrders = new Map(); // Stores active Bybit orderId -> {clientOrderId, price, side, status, quantity, filledQty, levelIndexInLevelsArray, symbol, gridPairIndex}
let activeBuyOrdersPerLevel = new Map(); // Map<priceString, orderId | "PLACING..."> 
let activeSellOrdersPerLevel = new Map(); // Map<priceString, orderId | "PLACING..."> 

let isPlacingOrder = false; // Global lock for placing any grid order

let gridConfig = { 
    symbol: 'NXPCUSDT', upperPrice: 0, lowerPrice: 0, gridCount: 0, // gridCount is number of price levels
    numberOfGrids: 0, // Actual number of buy/sell pairs
    totalUsdt: 0, usdtPerGrid: 0, interval: 0, levels: [], 
    basePrecision: 5, quotePrecision: 5, qtyPrecision: 1,
};
let instrumentInfo = {}; 

let serverTimeOffset = 0;
let priceWsHeartbeatInterval = null;
let orderWsHeartbeatInterval = null;
let reconnectAttempts = 0; 
let isGridRunning = false;
let currentPrice = null;
let currentFeeRate = { takerFeeRate: '0.001', makerFeeRate: '0.001' }; 
const maxReconnectDelay = 30000; 
var API_KEY = ''; 
var API_SECRET = ''; 
const RECV_WINDOW = 20000; 
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; 
let priceWs = null; 
let orderWs = null; 
let gridCheckInterval = null; 

// --- DOM Elements ---
let gridSymbolInput, upperPriceInput, lowerPriceInput, gridCountInput, totalUsdtInput;
let usdtPerGridSpan, priceIntervalSpan, qtyPerBuyGridSpan, qtyPerSellGridSpan, gridPreviewTableBody;
let startGridBtn, stopGridBtn, calculateGridBtn, gridStatusSpan;
let currentPriceSpan, lastUpdatedSpan, feeRateSpan, currentSymbolSpan;
let apiKeyInput, apiSecretInput, passwordInput; 
let messageList;

// --- Utility & API Functions ---

async function syncServerTime() {
  try {
    const response = await fetch('https://api.bybit.com/v5/market/time');
    const data = await response.json();
    if (data.retCode === 0 && data.result && data.result.timeNano) {
      serverTimeOffset = parseInt(data.result.timeNano) / 1000000 - Date.now();
      return parseInt(data.result.timeNano) / 1000000;
    } else {
      addMessage(`服务器时间同步失败: ${data.retMsg || '未知错误'}`, 'error');
      throw new Error(data.retMsg || '服务器时间同步失败');
    }
  } catch (error) {
    addMessage(`服务器时间同步网络错误: ${error.message}`, 'error');
    throw error;
  }
}

function getAdjustedTimestamp() {
  return Math.floor(Date.now() + serverTimeOffset);
}

async function getCookiesFromBackground(url) {
    return new Promise((resolve, reject) => {
        if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
           return reject(new Error("Chrome runtime 不可用. 无法获取 cookies."));
        }
        chrome.runtime.sendMessage({ action: 'getCookies', url: url }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("获取 cookies 时发生错误:", chrome.runtime.lastError.message);
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (response && response.success) {
                resolve(response.cookieHeader);
            } else {
                reject(new Error(response?.message || "从 background 获取 cookies 失败"));
            }
        });
    });
}

async function getHttpApiSignature(parameters, secret, timestamp, recvWindow) {
    const apiKeyToUse = API_KEY || (apiKeyInput ? apiKeyInput.value.trim() : '');
    const stringToSign = `${timestamp}${apiKeyToUse}${recvWindow}${parameters}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey( 'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'] );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
    return Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getWebSocketAuthSignature(apiSecret, expiresTimestamp) {
    const stringToSign = `GET/realtime${expiresTimestamp}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
    return Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}


async function httpRequest_V5(endpoint, method, reqData = {}, info = "API Request", retries = MAX_RETRIES) {
  const currentApiKey = API_KEY || (apiKeyInput ? apiKeyInput.value.trim() : '');
  const currentApiSecret = API_SECRET || (apiSecretInput ? apiSecretInput.value.trim() : '');
  if (!currentApiKey || !currentApiSecret) {
    addMessage(`${info} 失败: API密钥未配置`, 'error');
    return { success: false, error: 'API密钥未配置', data: null };
  }
  const timestamp = getAdjustedTimestamp().toString();
  const recvWindow = RECV_WINDOW.toString();
  let paramsQueryString = ''; let bodyPayload = '';
  if (method === 'GET') {
    paramsQueryString = Object.keys(reqData).sort().map(key => `${key}=${encodeURIComponent(reqData[key])}`).join('&');
  } else {
    bodyPayload = JSON.stringify(reqData); paramsQueryString = bodyPayload; 
  }
  const signature = await getHttpApiSignature(paramsQueryString, currentApiSecret, timestamp, recvWindow);
  const headers = {
    'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-SIGN': signature, 'X-BAPI-API-KEY': currentApiKey,
    'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': recvWindow,
    'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json'
  };
  let url = `https://api.bybit.com${endpoint}`;
  if (method === 'GET' && paramsQueryString) { url += `?${paramsQueryString}`; }
  try {
    const response = await fetch(url, { method, headers, body: method !== 'GET' ? bodyPayload : undefined });
    const responseData = await response.json();
    if (responseData.retCode === 0) { return { success: true, data: responseData }; } 
    else {
        console.error(`${info} 失败 (V5):`, responseData);
        addMessage(`${info} 失败 (V5): ${responseData.retMsg} (Code: ${responseData.retCode})`, 'error');
        if (retries > 0 && [10001, 10004, 10006, 10002].includes(responseData.retCode)) {
            addMessage(`重试 ${MAX_RETRIES - retries + 1}/${MAX_RETRIES}`, 'info');
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (MAX_RETRIES - retries + 1) ));
            return httpRequest_V5(endpoint, method, reqData, info, retries - 1);
        }
        return { success: false, error: responseData.retMsg, data: responseData };
    }
  } catch (error) {
      console.error(`${info} 网络错误 (V5):`, error);
      addMessage(`${info} 网络错误 (V5): ${error.message}`, 'error');
      if (retries > 0) {
          addMessage(`重试 ${MAX_RETRIES - retries + 1}/${MAX_RETRIES}`, 'info');
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (MAX_RETRIES - retries + 1)));
          return httpRequest_V5(endpoint, method, reqData, info, retries - 1);
      }
      return { success: false, error: error.message, data: null };
  }
}

async function getFeeRate() {
    const result = await httpRequest_V5('/v5/account/fee-rate', 'GET', { category: 'spot' }, '查询交易费率');
    if (result.success && result.data.result && result.data.result.list && result.data.result.list.length > 0) {
        const feeInfo = result.data.result.list[0];
        currentFeeRate = { takerFeeRate: feeInfo.takerFeeRate, makerFeeRate: feeInfo.makerFeeRate };
        if(feeRateSpan) feeRateSpan.textContent = `Taker: ${parseFloat(feeInfo.takerFeeRate) * 100}%, Maker: ${parseFloat(feeInfo.makerFeeRate) * 100}%`;
        addMessage(`费率查询成功: Maker ${currentFeeRate.makerFeeRate}, Taker ${currentFeeRate.takerFeeRate}`, 'success');
    } else {
        addMessage(`费率查询失败: ${result.error || '无数据返回'}`, 'error');
        if(feeRateSpan) feeRateSpan.textContent = "查询失败";
    }
}

async function getInstrumentInfo(symbol) {
    if (!symbol) {
        addMessage('获取交易对信息失败: symbol 未提供', 'error');
        instrumentInfo['DEFAULT'] = instrumentInfo['DEFAULT'] || { tickSize: "0.00001", minOrderQty: 1, maxOrderQty: 1000000, qtyStep: "0.1", baseCoin: 'UNKNOWN', quoteCoin: 'USDT' };
        gridConfig.quotePrecision = (instrumentInfo['DEFAULT'].tickSize.split('.')[1] || '').length;
        gridConfig.qtyPrecision = (instrumentInfo['DEFAULT'].qtyStep.split('.')[1] || '').length;
        return instrumentInfo['DEFAULT'];
    }
    const result = await httpRequest_V5('/v5/market/instruments-info', 'GET', { category: 'spot', symbol: symbol }, `查询交易对信息 ${symbol}`);
    if (result.success && result.data.result && result.data.result.list && result.data.result.list.length > 0) {
        const info = result.data.result.list[0];
        const tickSizeStr = (info.priceFilter && typeof info.priceFilter.tickSize === 'string') ? info.priceFilter.tickSize : "0.00001";
        const qtyStepStr = (info.lotSizeFilter && typeof info.lotSizeFilter.qtyStep === 'string') ? info.lotSizeFilter.qtyStep : "0.1";
        instrumentInfo[symbol] = {
            tickSize: parseFloat(tickSizeStr),
            minOrderQty: (info.lotSizeFilter && parseFloat(info.lotSizeFilter.minOrderQty)) || 0.00001,
            maxOrderQty: (info.lotSizeFilter && parseFloat(info.lotSizeFilter.maxOrderQty)) || 10000000,
            qtyStep: parseFloat(qtyStepStr),
            baseCoin: info.baseCoin || symbol.replace('USDT', ''),
            quoteCoin: info.quoteCoin || 'USDT',
        };
        gridConfig.quotePrecision = (tickSizeStr.split('.')[1] || '').length;
        gridConfig.qtyPrecision = (qtyStepStr.split('.')[1] || '').length;
        if (!(info.priceFilter && typeof info.priceFilter.tickSize === 'string')) {
            addMessage(`警告: 交易对 ${symbol} 的 priceFilter.tickSize 缺失或格式不正确，使用默认值 ${tickSizeStr}`, 'warning');
        }
        if (!(info.lotSizeFilter && typeof info.lotSizeFilter.qtyStep === 'string')) {
            addMessage(`警告: 交易对 ${symbol} 的 lotSizeFilter.qtyStep 缺失或格式不正确，使用默认值 ${qtyStepStr}`, 'warning');
        }
        addMessage(`交易对信息 ${symbol}: 价格精度 ${gridConfig.quotePrecision}, 数量精度 ${gridConfig.qtyPrecision}, 最小下单量 ${instrumentInfo[symbol].minOrderQty}`, 'success');
        return instrumentInfo[symbol];
    } else {
        addMessage(`获取交易对信息 ${symbol} 失败: ${result.error || '无数据'}`, 'error');
        gridConfig.quotePrecision = gridConfig.quotePrecision || 5;
        gridConfig.qtyPrecision = gridConfig.qtyPrecision || 1;
        instrumentInfo[symbol] = instrumentInfo[symbol] || { tickSize: 0.00001, minOrderQty: 1, maxOrderQty: 1000000, qtyStep: 0.1, baseCoin: symbol.replace('USDT',''), quoteCoin: 'USDT' };
        instrumentInfo[symbol].tickSizeStr = "0.00001"; instrumentInfo[symbol].qtyStepStr = "0.1";
        return instrumentInfo[symbol];
    }
}

// --- Grid Trading Logic ---

async function calculateGridLevels() {
    const symbol = gridSymbolInput ? gridSymbolInput.value.trim().toUpperCase() : gridConfig.symbol;
    if (!symbol) { addMessage('请输入交易对以计算网格', 'error'); return null; }
    const currentInstrument = await getInstrumentInfo(symbol);
    const quotePrecisionNum = Number.isFinite(gridConfig.quotePrecision) ? gridConfig.quotePrecision : 5;
    const qtyPrecisionNum = Number.isFinite(gridConfig.qtyPrecision) ? gridConfig.qtyPrecision : 1;
    const upper = upperPriceInput ? parseFloat(upperPriceInput.value) : 0;
    const lower = lowerPriceInput ? parseFloat(lowerPriceInput.value) : 0;
    const count = gridCountInput ? parseInt(gridCountInput.value) : 0; 
    const totalUSDT投入 = totalUsdtInput ? parseFloat(totalUsdtInput.value) : 0;

    if (isNaN(upper) || isNaN(lower) || isNaN(count) || isNaN(totalUSDT投入) || upper <= lower || count < 2 || totalUSDT投入 <= 0) {
        addMessage('网格参数无效 (价格、数量或投入)', 'error'); 
        if(gridPreviewTableBody) {
            gridPreviewTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">参数无效</td></tr>';
        }
        return null;
    }
    const numberOfGrids = count - 1; 
    if (numberOfGrids <= 0) { 
         addMessage('网格数量太少，至少需要2个价格水平来形成1个网格。', 'error');
         if(gridPreviewTableBody) gridPreviewTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">网格数量太少</td></tr>';
         return null;
    }

    const interval = parseFloat(((upper - lower) / numberOfGrids).toFixed(quotePrecisionNum));
    const usdtPerGridOperation = parseFloat((totalUSDT投入 / numberOfGrids).toFixed(2)); 
    
    gridConfig.symbol = symbol; gridConfig.upperPrice = upper; gridConfig.lowerPrice = lower;
    gridConfig.gridCount = count; 
    gridConfig.numberOfGrids = numberOfGrids; 
    gridConfig.totalUsdt = totalUSDT投入; 
    gridConfig.usdtPerGrid = usdtPerGridOperation; 
    gridConfig.interval = interval; 
    gridConfig.levels = [];
    
    for (let i = 0; i < count; i++) { 
        const price = parseFloat((lower + i * interval).toFixed(quotePrecisionNum));
        const quantityAtLevel = parseFloat((usdtPerGridOperation / price).toFixed(qtyPrecisionNum)); 
        if (quantityAtLevel < currentInstrument.minOrderQty && i < numberOfGrids) { 
             addMessage(`警告: L${i+1} 买入价 ${price.toFixed(quotePrecisionNum)} 估算数量 ${quantityAtLevel.toFixed(qtyPrecisionNum)} < 最小下单量 ${currentInstrument.minOrderQty}.`, 'error');
        }
        gridConfig.levels.push({ price: price, quantity: quantityAtLevel, indexInLevelsArray: i });
    }

    if(usdtPerGridSpan) usdtPerGridSpan.textContent = usdtPerGridOperation.toFixed(2);
    if(priceIntervalSpan) priceIntervalSpan.textContent = interval.toFixed(quotePrecisionNum);
    
    addMessage('网格计算完成', 'success');
    renderGridPreviewTable(); 
    return gridConfig;
}

async function placeGridOrder_CookieBased(symbol, side, price, quantity, orderLinkId) {
    addMessage(`尝试使用 Cookie 下单: ${side} ${quantity} @ ${price}`, 'info');
    try {
        const cookieHeader = await getCookiesFromBackground("https://www.bybit.com");
        if (!cookieHeader) throw new Error("未能获取到 Cookie。");
        const formData = new URLSearchParams();
        formData.append('symbol_id', symbol); formData.append('side', side.toLowerCase());
        formData.append('type', 'limit'); formData.append('price', price.toString());
        formData.append('quantity', quantity.toString()); formData.append('time_in_force', 'gtc');
        formData.append('client_order_id', orderLinkId);
        const headers = {
            'accept': 'application/json', 'accept-language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'cookie': cookieHeader,
            'origin': 'https://www.bybit.com', 'referer': `https://www.bybit.com/zh-TW/trade/spot/${symbol.replace('USDT','/USDT')}`,
            'platform': 'pc', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        };
        const response = await fetch('https://www.bybit.com/x-api/spot/api/order/create', { method: 'POST', headers: headers, body: formData.toString() });
        const data = await response.json();
        if (data && data.ret_code === 0 && data.result) {
             const returnedOrderId = data.result.order_id || data.result.orderId;
             addMessage(`Cookie 下单成功: ${side} @ ${price} (ID: ${returnedOrderId || orderLinkId})`, 'success');
             if (!returnedOrderId) addMessage(`警告: Cookie 下单成功但未返回 orderId！`, 'warning');
             return { success: true, data: { result: { orderId: returnedOrderId || orderLinkId, orderLinkId: orderLinkId, orderStatus: 'New', cumExecQty: '0' } } };
        } else {
            console.error("Cookie下单失败:", data);
            addMessage(`Cookie 下单失败: ${data.ret_msg || '未知错误'} (Code: ${data.ret_code})`, 'error');
            return { success: false, error: data.ret_msg || '下单失败', data: data };
        }
    } catch (error) {
        console.error("Cookie下单网络错误:", error);
        addMessage(`Cookie 下单网络错误: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

async function manageGridLogic() {
    if (!isGridRunning || !currentPrice || !gridConfig.levels || gridConfig.levels.length === 0 || isPlacingOrder) {
        return;
    }
    
    for (const status of activeBuyOrdersPerLevel.values()) {
        if (status === "PLACING...") { addMessage("已有买单正在处理中 (manageGridLogic)，跳过本次执行。", "debug"); return; }
    }
    for (const status of activeSellOrdersPerLevel.values()) {
        if (status === "PLACING...") { addMessage("已有卖单正在处理中 (manageGridLogic)，跳过本次执行。", "debug"); return; }
    }

    isPlacingOrder = true; 

    try {
        const quotePrecisionNum = Number.isFinite(gridConfig.quotePrecision) ? gridConfig.quotePrecision : 5;
        let targetBuyGridPairIndex = -1; 

        for (let i = gridConfig.numberOfGrids - 1; i >= 0; i--) { 
            const buyLevel = gridConfig.levels[i]; 
            
            if (buyLevel.price < currentPrice) {
                const buyPriceStr = buyLevel.price.toFixed(quotePrecisionNum);
                const sellLevelForThisBuy = gridConfig.levels[i+1]; 
                const sellPriceStrForThisBuy = sellLevelForThisBuy.price.toFixed(quotePrecisionNum);

                if (!activeBuyOrdersPerLevel.has(buyPriceStr) && !activeSellOrdersPerLevel.has(sellPriceStrForThisBuy)) {
                    targetBuyGridPairIndex = i; 
                }
                break; 
            }
        }
        
        if (targetBuyGridPairIndex !== -1) { 
            const buyLevelToPlace = gridConfig.levels[targetBuyGridPairIndex];
            const buyPriceStr = buyLevelToPlace.price.toFixed(quotePrecisionNum); 
            const qtyForThisBuy = parseFloat((gridConfig.usdtPerGrid / buyLevelToPlace.price).toFixed(gridConfig.qtyPrecision));
            
            if (qtyForThisBuy < (instrumentInfo[gridConfig.symbol]?.minOrderQty || 0.000001)) {
                addMessage(`目标买入 @ ${buyPriceStr} 数量 ${qtyForThisBuy} 过小，跳过。`, 'warning');
                isPlacingOrder = false;
                return;
            }

            addMessage(`目标买入网格 ${targetBuyGridPairIndex + 1}: ${buyLevelToPlace.price.toFixed(quotePrecisionNum)} (当前价: ${currentPrice.toFixed(quotePrecisionNum)})`, 'info');
            const orderLinkId = `grid_${gridConfig.symbol}_buy_${buyLevelToPlace.price}_${Date.now()}`;
            
            activeBuyOrdersPerLevel.set(buyPriceStr, "PLACING..."); 
            renderGridPreviewTable();

            const result = await placeGridOrder_CookieBased(gridConfig.symbol, 'Buy', buyLevelToPlace.price, qtyForThisBuy, orderLinkId);
            
            if (result.success && result.data && result.data.result) {
                const orderIdToTrack = result.data.result.orderId;
                gridOrders.set(orderIdToTrack, {
                    clientOrderId: result.data.result.orderLinkId, price: buyLevelToPlace.price, side: 'Buy',
                    status: result.data.result.orderStatus || 'New', quantity: qtyForThisBuy, 
                    filledQty: parseFloat(result.data.result.cumExecQty || "0"), 
                    levelIndexInLevelsArray: buyLevelToPlace.indexInLevelsArray, 
                    gridPairIndex: targetBuyGridPairIndex, 
                    symbol: gridConfig.symbol
                });
                activeBuyOrdersPerLevel.set(buyPriceStr, orderIdToTrack); 
                addMessage(`买单 @ ${buyLevelToPlace.price.toFixed(quotePrecisionNum)} Cookie 下单成功 (ID: ${orderIdToTrack})`, 'success');
            } else {
                addMessage(`买单 @ ${buyLevelToPlace.price.toFixed(quotePrecisionNum)} Cookie 下单失败: ${result.error || '未知错误'}`, 'error');
                activeBuyOrdersPerLevel.delete(buyPriceStr); 
            }
            renderGridPreviewTable();
        }
    } catch (error) {
        console.error("Error in manageGridLogic:", error);
        addMessage("manageGridLogic 发生错误: " + error.message, "error");
    } finally {
        isPlacingOrder = false; 
    }
}


async function startGridTrading() {
    if (isGridRunning) { addMessage("网格已在运行中", "warning"); return; }
    if (!gridConfig.levels || gridConfig.levels.length === 0 || gridConfig.numberOfGrids <= 0) {
        const calculated = await calculateGridLevels();
        if (!calculated || gridConfig.numberOfGrids <= 0) { addMessage("请先计算网格或检查参数 (确保网格数 > 0)", "error"); return; }
    }
    if (!currentPrice) { addMessage("无法获取当前价格，无法启动网格。", "error"); return; }

    isGridRunning = true; isPlacingOrder = false; 
    updateGridUIState();
    addMessage(`启动网格交易 (Cookie 模式 - 精确逐级): ${gridConfig.symbol}`, 'info');
    gridOrders.clear(); activeBuyOrdersPerLevel.clear(); activeSellOrdersPerLevel.clear();
    renderGridPreviewTable(); 
    await manageGridLogic(); 
    initializeOrderWebSocket(); 
    startGridCheckInterval();   
}

async function stopGridTrading(showMessages = true) {
    if (!isGridRunning && gridOrders.size === 0 && showMessages) {
        addMessage("网格未运行或无活动订单", "info"); isGridRunning = false; updateGridUIState(); return;
    }
    if (showMessages) addMessage("正在停止网格交易...", 'info');
    isGridRunning = false; isPlacingOrder = false; updateGridUIState();
    stopGridCheckInterval(); closeOrderWebSocket();
    const orderIdsToCancel = Array.from(gridOrders.keys());
    if (orderIdsToCancel.length === 0) { if (showMessages) addMessage("没有活动的网格订单需要取消", 'info'); } 
    else {
        if (showMessages) addMessage(`准备取消 ${orderIdsToCancel.length} 个订单 (V5 API)...`, 'info');
        const cancelPromises = [];
        for (const orderId of orderIdsToCancel) { 
            const orderData = gridOrders.get(orderId); if (!orderData) continue;
            const data = { category: 'spot', symbol: orderData.symbol, orderId: orderId };
            cancelPromises.push( httpRequest_V5('/v5/order/cancel', 'POST', data, `取消订单 ${orderId}`)
                .then(result => {
                    if (result.success) { if (showMessages) addMessage(`订单 ${orderId} 取消成功`, 'success'); } 
                    else { if (result.data && (result.data.retCode === 170213 || result.data.retCode === 170106 )) { if (showMessages) addMessage(`订单 ${orderId} 可能已成交/取消 (Code: ${result.data.retCode})`, 'info'); } 
                    else { if (showMessages) addMessage(`订单 ${orderId} 取消失败: ${result.error || '未知错误'}`, 'error'); } }
                })
            );
            await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 100));
        }
        await Promise.all(cancelPromises);
    }
    gridOrders.clear(); activeBuyOrdersPerLevel.clear(); activeSellOrdersPerLevel.clear();
    renderGridPreviewTable(); 
    if (showMessages) addMessage("网格交易已停止，所有尝试取消的订单已处理。", 'success');
}


async function handleGridOrderFill(filledOrderUpdate) {
    if (!gridOrders.has(filledOrderUpdate.orderId) ) {
        if (!isGridRunning && !gridOrders.has(filledOrderUpdate.orderId)) return;
    }
    const filledOrderId = filledOrderUpdate.orderId;
    const originalOrderData = gridOrders.get(filledOrderId);
    if (!originalOrderData) return;
    const quotePrecisionNum = Number.isFinite(gridConfig.quotePrecision) ? gridConfig.quotePrecision : 5;
    const qtyPrecisionNum = Number.isFinite(gridConfig.qtyPrecision) ? gridConfig.qtyPrecision : 1;
    
    const actualFilledQty = parseFloat(filledOrderUpdate.cumExecQty || originalOrderData.filledQty || originalOrderData.quantity);
    if (isNaN(actualFilledQty) || actualFilledQty <= 0) {
        addMessage(`错误: 订单 ${filledOrderId} 成交数量无效 (${filledOrderUpdate.cumExecQty || originalOrderData.filledQty})`, 'error');
        gridOrders.delete(filledOrderId); renderGridPreviewTable(); return;
    }
    originalOrderData.filledQty = actualFilledQty; 
    addMessage(`网格订单成交: ${originalOrderData.side} ${actualFilledQty.toFixed(qtyPrecisionNum)} @ ${parseFloat(filledOrderUpdate.avgPrice || originalOrderData.price).toFixed(quotePrecisionNum)} (ID: ${filledOrderId})`, 'success');
    const filledBuyPriceStr = originalOrderData.price.toFixed(quotePrecisionNum); 

    if (originalOrderData.side === 'Buy') {
        activeBuyOrdersPerLevel.delete(filledBuyPriceStr); 
        
        const sellLevelForThisPair = gridConfig.levels[originalOrderData.levelIndexInLevelsArray + 1]; 
        
        if (sellLevelForThisPair) {
            const sellPriceStr = sellLevelForThisPair.price.toFixed(quotePrecisionNum);
            if (activeSellOrdersPerLevel.has(sellPriceStr) && activeSellOrdersPerLevel.get(sellPriceStr) !== "PLACING...") {
                addMessage(`已存在有效卖单 @ ${sellLevelForThisPair.price.toFixed(quotePrecisionNum)}，跳过。`, 'info');
            } else {
                const nextOrderLinkId = `grid_${gridConfig.symbol}_sell_${sellLevelForThisPair.price}_${Date.now()}`;
                const quantityForSellOrder = actualFilledQty; 

                addMessage(`准备放置对应卖单 (Cookie): ${quantityForSellOrder.toFixed(qtyPrecisionNum)} ${gridConfig.symbol} @ ${sellLevelForThisPair.price.toFixed(quotePrecisionNum)}`, 'info');
                activeSellOrdersPerLevel.set(sellPriceStr, "PLACING..."); 
                renderGridPreviewTable();
                const result = await placeGridOrder_CookieBased(gridConfig.symbol, 'Sell', sellLevelForThisPair.price, quantityForSellOrder, nextOrderLinkId);
                if (result.success && result.data && result.data.result) {
                    const sellOrderId = result.data.result.orderId;
                    gridOrders.set(sellOrderId, {
                        clientOrderId: result.data.result.orderLinkId, price: sellLevelForThisPair.price, side: 'Sell',
                        status: result.data.result.orderStatus || 'New', quantity: quantityForSellOrder, 
                        filledQty: 0, 
                        levelIndexInLevelsArray: sellLevelForThisPair.indexInLevelsArray, 
                        gridPairIndex: originalOrderData.gridPairIndex, 
                        symbol: gridConfig.symbol
                    });
                    activeSellOrdersPerLevel.set(sellPriceStr, sellOrderId);
                    addMessage(`对应卖单 @ ${sellLevelForThisPair.price.toFixed(quotePrecisionNum)} Cookie 放置成功 (ID: ${sellOrderId})`, 'success');
                } else {
                    addMessage(`对应卖单 @ ${sellLevelForThisPair.price.toFixed(quotePrecisionNum)} Cookie 放置失败: ${result.error || '未知错误'}`, 'error');
                    activeSellOrdersPerLevel.delete(sellPriceStr); 
                }
            }
        } else { addMessage(`买单成交于最高网格 ${originalOrderData.price.toFixed(quotePrecisionNum)}，无法找到对应的更高卖出点。`, 'warning'); }
    } else { // Original order was 'Sell'
        const sellPriceStr = originalOrderData.price.toFixed(quotePrecisionNum);
        activeSellOrdersPerLevel.delete(sellPriceStr); 
        addMessage(`卖单 @ ${sellPriceStr} 成交。网格 ${originalOrderData.gridPairIndex + 1} 周期完成。`, 'success');
    }
    gridOrders.delete(filledOrderId); 
    renderGridPreviewTable();
    if(isGridRunning) await manageGridLogic(); 
}

// --- WebSocket Functions --- 
function startWsHeartbeat(ws, intervalIdRef, type) { 
    if (intervalIdRef.id) clearInterval(intervalIdRef.id);
    intervalIdRef.id = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 'ping', req_id: `${type}_hb_${Date.now()}` }));
        } else { clearInterval(intervalIdRef.id); intervalIdRef.id = null; }
    }, 20000); 
}
function stopWsHeartbeat(intervalIdRef) { 
     if (intervalIdRef.id) { clearInterval(intervalIdRef.id); intervalIdRef.id = null; }
}
function initializePriceWebSocket() { 
    const symbolToSubscribe = (gridSymbolInput ? gridSymbolInput.value.trim().toUpperCase() : null) || gridConfig.symbol || 'BTCUSDT';
    if(currentSymbolSpan) currentSymbolSpan.textContent = symbolToSubscribe;
    if (priceWs && (priceWs.readyState === WebSocket.OPEN || priceWs.readyState === WebSocket.CONNECTING)) {
        if (priceWs.currentSymbol === symbolToSubscribe) return; 
        priceWs.close(1000, "Symbol changed"); 
    }
    priceWs = new WebSocket('wss://stream.bybit.com/v5/public/spot');
    priceWs.currentSymbol = symbolToSubscribe; 
    const intervalRef = { id: priceWsHeartbeatInterval };
    priceWs.onopen = () => {
        priceWs.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${symbolToSubscribe}`], req_id: `price_sub_${Date.now()}` }));
        startWsHeartbeat(priceWs, intervalRef, 'Price'); priceWsHeartbeatInterval = intervalRef.id;
        addMessage(`价格 WebSocket (${symbolToSubscribe}) 连接成功`, 'success');
        reconnectAttempts = 0; 
    };
    priceWs.onmessage = async (event) => { 
        const data = JSON.parse(event.data);
        if (data.op === 'subscribe') {
            if (!data.success) {
                addMessage(`价格订阅 (${symbolToSubscribe}) 失败: ${data.ret_msg}`, 'error');
                if (symbolToSubscribe !== 'BTCUSDT' && gridSymbolInput) { 
                    addMessage('尝试订阅 BTCUSDT 作为备用', 'info');
                    gridSymbolInput.value = 'BTCUSDT'; gridConfig.symbol = 'BTCUSDT';
                    await getInstrumentInfo('BTCUSDT'); initializePriceWebSocket(); 
                }
            } else { addMessage(`价格订阅 (${data.args ? data.args[0] : symbolToSubscribe}) 成功`, 'success'); }
        } else if (data.topic && data.topic.startsWith(`publicTrade.`)) {
            if (data.data && data.data.length > 0) {
                const trade = data.data[0]; const newPrice = parseFloat(trade.p);
                if (newPrice !== currentPrice || currentPrice === null) {
                    currentPrice = newPrice; updatePriceDisplay(currentPrice, trade.T, trade.s); 
                    if (isGridRunning) { await manageGridLogic(); }
                }
            }
        }
    };
    priceWs.onclose = (event) => {
        stopWsHeartbeat({ id: priceWsHeartbeatInterval }); priceWsHeartbeatInterval = null;
        const reason = event.reason || `Code: ${event.code}`;
        addMessage(`价格 WebSocket (${priceWs.currentSymbol || symbolToSubscribe}) 连接断开 (${reason})`, event.code === 1000 ? 'info' : 'error');
        if (event.code !== 1000) { 
            reconnectAttempts++; const delay = Math.min(1000 * Math.pow(2, reconnectAttempts -1), maxReconnectDelay);
            addMessage(`价格 WebSocket ${reconnectAttempts} 次尝试重连于 ${delay / 1000}s 后...`, 'info');
            setTimeout(initializePriceWebSocket, delay);
        }
    };
    priceWs.onerror = (err) => { console.error("Price WS Error:", err); addMessage(`价格 WebSocket (${priceWs.currentSymbol || symbolToSubscribe}) 发生错误`, 'error'); };
}
async function initializeOrderWebSocket() { 
    const currentApiKey = API_KEY || (apiKeyInput ? apiKeyInput.value.trim() : '');
    const currentApiSecret = API_SECRET || (apiSecretInput ? apiSecretInput.value.trim() : '');
    if (!currentApiKey || !currentApiSecret) { addMessage('无法监听订单，缺少 API 密钥', 'error'); return; }
    if (orderWs && (orderWs.readyState === WebSocket.OPEN || orderWs.readyState === WebSocket.CONNECTING)) return;
    await syncServerTime(); 
    const expires = getAdjustedTimestamp() + 20000; 
    const signature = await getWebSocketAuthSignature(currentApiSecret, expires.toString());
    orderWs = new WebSocket('wss://stream.bybit.com/v5/private');
    const intervalRef = { id: orderWsHeartbeatInterval };
    orderWs.onopen = () => {
        addMessage('订单 WebSocket 连接成功，正在认证...', 'success');
        orderWs.send(JSON.stringify({ op: 'auth', args: [currentApiKey, expires.toString(), signature], req_id: `order_auth_${Date.now()}` }));
    };
    orderWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.op === 'auth') {
            if (data.success) {
                addMessage('订单 WebSocket 认证成功', 'success');
                orderWs.send(JSON.stringify({ op: 'subscribe', args: ['order'], req_id: `order_sub_${Date.now()}` }));
                startWsHeartbeat(orderWs, intervalRef, 'Order'); orderWsHeartbeatInterval = intervalRef.id;
            } else { addMessage(`订单 WebSocket 认证失败: ${data.ret_msg || data.conn_id}`, 'error'); orderWs.close(1000, "Auth failed"); }
        } else if (data.op === 'subscribe') {
            if (data.success) { addMessage(`订单主题 (${data.args ? data.args[0] : 'order'}) 订阅成功`, 'success'); } 
            else { addMessage(`订单主题订阅失败: ${data.ret_msg}`, 'error'); }
        } else if (data.topic === 'order' && data.data) {
            data.data.forEach(async orderUpdate => { 
                if (gridOrders.has(orderUpdate.orderId)) {
                    const localOrder = gridOrders.get(orderUpdate.orderId);
                    if (localOrder && orderUpdate.cumExecQty) localOrder.filledQty = parseFloat(orderUpdate.cumExecQty);
                    if (orderUpdate.orderStatus === 'Filled' || orderUpdate.orderStatus === 'PartiallyFilledAndCancelled') { await handleGridOrderFill(orderUpdate); } 
                    else if (['Cancelled', 'Rejected', 'Deactivated'].includes(orderUpdate.orderStatus)) {
                        addMessage(`网格订单 ${orderUpdate.orderId} 状态: ${orderUpdate.orderStatus}`, 'warning');
                        const GOrder = gridOrders.get(orderUpdate.orderId);
                        if(GOrder) { 
                            const priceStr = GOrder.price.toFixed(gridConfig.quotePrecision);
                            if(GOrder.side === 'Buy') activeBuyOrdersPerLevel.delete(priceStr);
                            else activeSellOrdersPerLevel.delete(priceStr);
                        }
                        gridOrders.delete(orderUpdate.orderId); renderGridPreviewTable(); 
                        if(isGridRunning) await manageGridLogic(); 
                    } else { 
                        const current = gridOrders.get(orderUpdate.orderId);
                        if (current) { current.status = orderUpdate.orderStatus; gridOrders.set(orderUpdate.orderId, current); renderGridPreviewTable(); } 
                    }
                }
            });
        }
    };
    orderWs.onclose = (event) => {
        stopWsHeartbeat({ id: orderWsHeartbeatInterval }); orderWsHeartbeatInterval = null;
        const reason = event.reason || `Code: ${event.code}`;
        addMessage(`订单 WebSocket 连接断开 (${reason})`, event.code === 1000 ? 'info' : 'error');
        if (isGridRunning && event.code !== 1000) { 
            reconnectAttempts++; 
            const delay = Math.min(5000 * Math.pow(2, reconnectAttempts -1), maxReconnectDelay);
            addMessage(`订单 WebSocket 尝试重连于 ${delay / 1000}s 后...`, 'info');
            setTimeout(initializeOrderWebSocket, delay);
        } else if (event.code === 1000 && isGridRunning) { 
            addMessage(`订单 WebSocket 正常关闭，但网格仍在运行。将尝试自动重连。`, 'info');
            setTimeout(initializeOrderWebSocket, 5000); 
        }
    };
    orderWs.onerror = (err) => { console.error("Order WS Error:", err); addMessage('订单 WebSocket 发生错误', 'error'); };
}
function closeOrderWebSocket() { 
    if (orderWs) {
        stopWsHeartbeat({ id: orderWsHeartbeatInterval }); orderWsHeartbeatInterval = null;
        if (orderWs.readyState === WebSocket.OPEN || orderWs.readyState === WebSocket.CONNECTING) { orderWs.close(1000, "User initiated close"); }
        orderWs = null; addMessage('订单 WebSocket 已关闭', 'info');
    }
}
// --- Fallback Grid Check --- 
function startGridCheckInterval() { 
    stopGridCheckInterval(); 
    gridCheckInterval = setInterval(async () => {
        if (!isGridRunning) { if(gridOrders.size === 0) return; }
        const currentOrderIds = Array.from(gridOrders.keys());
        if (currentOrderIds.length === 0) return; 
        const openOrdersResult = await httpRequest_V5('/v5/order/realtime', 'GET', { category: 'spot', symbol: gridConfig.symbol, openOnly: 0, limit: 50 }, `轮询开放订单`);
        let processedInOpenCheck = new Set();
        if (openOrdersResult.success && openOrdersResult.data.result && openOrdersResult.data.result.list) {
            openOrdersResult.data.result.list.forEach(async apiOrder => {
                if (gridOrders.has(apiOrder.orderId)) {
                    processedInOpenCheck.add(apiOrder.orderId);
                    const localOrderData = gridOrders.get(apiOrder.orderId);
                    if (localOrderData.status !== apiOrder.orderStatus || (apiOrder.cumExecQty && parseFloat(apiOrder.cumExecQty) !== localOrderData.filledQty)) {
                        addMessage(`轮询更新订单 ${apiOrder.orderId} 状态: ${localOrderData.status}->${apiOrder.orderStatus}, 成交量: ${localOrderData.filledQty}->${apiOrder.cumExecQty}`, 'info');
                        localOrderData.status = apiOrder.orderStatus;
                        if(apiOrder.cumExecQty) localOrderData.filledQty = parseFloat(apiOrder.cumExecQty);
                        gridOrders.set(apiOrder.orderId, localOrderData); renderGridPreviewTable(); 
                        if (apiOrder.orderStatus === 'Filled' || apiOrder.orderStatus === 'PartiallyFilledAndCancelled') { await handleGridOrderFill(apiOrder); }
                    }
                }
            });
        }
        for (const orderId of currentOrderIds) {
            if (processedInOpenCheck.has(orderId)) continue; 
            const localOrderData = gridOrders.get(orderId);
            if (localOrderData && (localOrderData.status === 'New' || localOrderData.status === 'PartiallyFilled')) {
                addMessage(`轮询发现订单 ${orderId} (本地: ${localOrderData.status}) 不在开放列表，查历史...`, 'info');
                const historyResult = await httpRequest_V5('/v5/order/history', 'GET', { category: 'spot', orderId: orderId, limit: 1 }, `轮询历史 ${orderId}`);
                if (historyResult.success && historyResult.data.result && historyResult.data.result.list && historyResult.data.result.list.length > 0) {
                    const orderFromHistory = historyResult.data.result.list[0];
                    if (orderFromHistory.orderStatus === 'Filled' || orderFromHistory.orderStatus === 'PartiallyFilledAndCancelled') { await handleGridOrderFill(orderFromHistory); } 
                    else if (['Cancelled', 'Rejected', 'Deactivated'].includes(orderFromHistory.orderStatus)) {
                        addMessage(`轮询确认订单 ${orderId} 状态: ${orderFromHistory.orderStatus}`, 'warning');
                        const GOrder = gridOrders.get(orderId);
                        if(GOrder) { const priceStr = GOrder.price.toFixed(gridConfig.quotePrecision); if(GOrder.side === 'Buy') activeBuyOrdersPerLevel.delete(priceStr); else activeSellOrdersPerLevel.delete(priceStr); }
                        gridOrders.delete(orderId); renderGridPreviewTable(); if(isGridRunning) await manageGridLogic(); 
                    } else { addMessage(`轮询订单 ${orderId}: 历史记录状态为 ${orderFromHistory.orderStatus}`, 'info'); }
                } else { addMessage(`轮询订单 ${orderId}: 查询历史失败或无记录。`, 'warning'); }
            }
        }
    }, 60000 * 1); 
}
function stopGridCheckInterval() { if (gridCheckInterval) { clearInterval(gridCheckInterval); gridCheckInterval = null; } }

// --- UI Functions --- 
function updatePriceDisplay(price, timestamp, symbol) { 
    if (currentPriceSpan && lastUpdatedSpan && currentSymbolSpan) {
        const displayPrecision = gridConfig.quotePrecision || (instrumentInfo[symbol] ? (instrumentInfo[symbol].tickSize.split('.')[1] || '').length : 5);
        currentPriceSpan.textContent = `${price.toFixed(displayPrecision)}`;
        lastUpdatedSpan.textContent = new Date(timestamp).toLocaleTimeString();
        if (currentSymbolSpan.textContent !== symbol) { currentSymbolSpan.textContent = symbol; }
    }
}
function addMessage(text, type = 'info') { 
    if (!messages) messages = []; messages.unshift({ text, type, timestamp: Date.now() });
    if (messages.length > 150) messages.pop(); renderMessages(); 
}
function renderMessages() { 
    if (!messageList) return;
    messageList.innerHTML = messages.map(msg => `<li class="${msg.type === 'debug' ? 'info' : msg.type}">[${new Date(msg.timestamp).toLocaleTimeString()}] ${msg.text}</li>`).join('');
}

function renderGridPreviewTable() { 
    if (!gridPreviewTableBody) {
        console.error("renderGridPreviewTable: gridPreviewTableBody is not defined.");
        return;
    }
    // Defensive check for critical Maps
    if (typeof activeBuyOrdersPerLevel === 'undefined' || typeof activeSellOrdersPerLevel === 'undefined' || typeof gridOrders === 'undefined') {
        console.error("CRITICAL: State tracking Maps (activeBuyOrdersPerLevel, activeSellOrdersPerLevel, gridOrders) are undefined in renderGridPreviewTable!");
        addMessage("内部错误: 网格状态跟踪变量未定义，请刷新。", "error");
        gridPreviewTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">内部渲染错误，请刷新</td></tr>';
        return;
    }

    gridPreviewTableBody.innerHTML = ''; 

    if (!gridConfig.levels || gridConfig.levels.length < 2 || gridConfig.numberOfGrids <= 0) {
        const row = gridPreviewTableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 5;
        cell.style.textAlign = "center";
        cell.textContent = (gridConfig.levels && gridConfig.levels.length === 0) ? "请先计算网格" : "网格参数不足";
        return;
    }

    const quotePrecisionNum = Number.isFinite(gridConfig.quotePrecision) ? gridConfig.quotePrecision : 5;
    const qtyPrecisionNum = Number.isFinite(gridConfig.qtyPrecision) ? gridConfig.qtyPrecision : 1;

    for (let i = 0; i < gridConfig.numberOfGrids; i++) { 
        const buyLevel = gridConfig.levels[i];
        const sellLevel = gridConfig.levels[i + 1];
        const buyPriceStr = buyLevel.price.toFixed(quotePrecisionNum);
        const sellPriceStr = sellLevel.price.toFixed(quotePrecisionNum);
        // Calculate quantity based on usdtPerGrid and the specific buyLevel price for this grid pair
        const qtyForThisGrid = parseFloat((gridConfig.usdtPerGrid / buyLevel.price).toFixed(qtyPrecisionNum));


        let statusText = "待命";
        let statusClass = "status-waiting";

        const activeBuyOrderId = activeBuyOrdersPerLevel.get(buyPriceStr);
        // For a given buy level, its corresponding sell is at sellLevel.price (which is gridConfig.levels[i+1].price)
        const activeSellOrderId = activeSellOrdersPerLevel.get(sellPriceStr); 

        if (activeBuyOrderId === "PLACING...") {
            statusText = "买单处理中..."; statusClass = "status-placing-buy";
        } else if (activeBuyOrderId) { 
            const orderDetails = gridOrders.get(activeBuyOrderId);
            statusText = `等待买入 (${orderDetails ? orderDetails.status : '未知'})`; statusClass = "status-active-buy";
        } else if (activeSellOrderId === "PLACING...") { // This sell order corresponds to the buy at buyLevel
            statusText = "卖单处理中..."; statusClass = "status-placing-sell";
        } else if (activeSellOrderId) {
            const orderDetails = gridOrders.get(activeSellOrderId);
            statusText = `等待卖出 (${orderDetails ? orderDetails.status : '未知'})`; statusClass = "status-active-sell";
        }
        
        const row = gridPreviewTableBody.insertRow();
        row.insertCell().textContent = i + 1;
        row.insertCell().textContent = buyLevel.price.toFixed(quotePrecisionNum);
        row.insertCell().textContent = sellLevel.price.toFixed(quotePrecisionNum);
        row.insertCell().textContent = qtyForThisGrid.toFixed(qtyPrecisionNum);
        const statusCell = row.insertCell();
        statusCell.textContent = statusText;
        statusCell.className = statusClass;
    }
}

function updateGridUIState() { 
    const commonInputs = [gridSymbolInput, upperPriceInput, lowerPriceInput, gridCountInput, totalUsdtInput];
    if (isGridRunning) {
        if(gridStatusSpan) { gridStatusSpan.textContent = '运行中'; gridStatusSpan.classList.remove('stopped'); gridStatusSpan.classList.add('running'); }
        if(startGridBtn) startGridBtn.disabled = true; if(stopGridBtn) stopGridBtn.disabled = false; if(calculateGridBtn) calculateGridBtn.disabled = true;
        commonInputs.forEach(input => { if(input) input.disabled = true; });
    } else {
        if(gridStatusSpan) { gridStatusSpan.textContent = '已停止'; gridStatusSpan.classList.remove('running'); gridStatusSpan.classList.add('stopped'); }
        if(startGridBtn) startGridBtn.disabled = false; if(stopGridBtn) stopGridBtn.disabled = true; if(calculateGridBtn) calculateGridBtn.disabled = false;
        commonInputs.forEach(input => { if(input) input.disabled = false; });
    }
}
function switchTab(targetTabId, targetBtn) { 
    document.querySelectorAll('.tab-content.active').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-nav > div.active').forEach(btn => btn.classList.remove('active'));
    const tabToShow = document.getElementById(targetTabId);
    if (tabToShow) tabToShow.classList.add('active'); if (targetBtn) targetBtn.classList.add('active');
}

// --- Initialization --- 
function getElementByIdSafe(id, isCritical = true, context = document) { 
    const element = context.getElementById(id);
    if (!element) {
        const message = `DOM 元素 ID '${id}' 未找到!`;
        if (isCritical) { console.error(message + " (关键元素)"); if (id !== 'message-list' && messageList) { addMessage(`错误: ${message} (关键)`, 'error'); } }
    }
    return element;
}
function initDOMElements() { 
    messageList = getElementByIdSafe('message-list', true);
    gridSymbolInput = getElementByIdSafe('grid-symbol'); upperPriceInput = getElementByIdSafe('upper-price'); lowerPriceInput = getElementByIdSafe('lower-price');
    gridCountInput = getElementByIdSafe('grid-count'); totalUsdtInput = getElementByIdSafe('total-usdt'); usdtPerGridSpan = getElementByIdSafe('usdt-per-grid', false);
    priceIntervalSpan = getElementByIdSafe('price-interval', false); qtyPerBuyGridSpan = getElementByIdSafe('qty-per-buy-grid', false); qtyPerSellGridSpan = getElementByIdSafe('qty-per-sell-grid', false);
    gridPreviewTableBody = getElementByIdSafe('grid-preview-table-body'); 
    startGridBtn = getElementByIdSafe('start-grid-btn');
    stopGridBtn = getElementByIdSafe('stop-grid-btn'); calculateGridBtn = getElementByIdSafe('calculate-grid-btn'); gridStatusSpan = getElementByIdSafe('grid-status');
    currentPriceSpan = getElementByIdSafe('current-price'); lastUpdatedSpan = getElementByIdSafe('last-updated'); feeRateSpan = getElementByIdSafe('fee-rate');
    currentSymbolSpan = getElementByIdSafe('current-symbol'); apiKeyInput = getElementByIdSafe('api-key'); apiSecretInput = getElementByIdSafe('api-secret');
    passwordInput = getElementByIdSafe('password'); 
}
function addSafeListener(elementOrId, eventType, handler, elementIdForLog) { 
    let element = elementOrId;
    if (typeof elementOrId === 'string') { element = getElementByIdSafe(elementOrId, false); elementIdForLog = elementOrId; }
    if (element) { element.addEventListener(eventType, handler); } 
    else { if (typeof elementOrId === 'string') { console.warn(`元素 ID '${elementIdForLog}' 未找到. 无法添加 '${eventType}' 事件监听器.`); } }
}
function initEventListeners() { 
    addSafeListener('tabGridBtn', 'click', (e) => switchTab('tabGrid', e.target)); 
    addSafeListener('tabSetBtn', 'click', (e) => switchTab('tabSet', e.target)); 
    addSafeListener('tabLogBtn', 'click', (e) => switchTab('tabLog', e.target));
    addSafeListener(calculateGridBtn, 'click', calculateGridLevels, 'calculate-grid-btn'); 
    addSafeListener(startGridBtn, 'click', startGridTrading, 'start-grid-btn');
    addSafeListener(stopGridBtn, 'click', () => stopGridTrading(true), 'stop-grid-btn');
    addSafeListener(gridSymbolInput, 'change', async () => { 
        if (!gridSymbolInput) return; const newSymbol = gridSymbolInput.value.trim().toUpperCase();
        if (newSymbol === gridConfig.symbol && instrumentInfo[newSymbol]) return; 
        gridConfig.symbol = newSymbol; await getInstrumentInfo(gridConfig.symbol); initializePriceWebSocket(); 
        gridOrders.clear(); activeBuyOrdersPerLevel.clear(); activeSellOrdersPerLevel.clear(); renderGridPreviewTable();
        if (isGridRunning) { const oldSymbol = priceWs ? priceWs.currentSymbol : '未知'; addMessage(`交易对已更改，停止旧 ${oldSymbol} 网格...`, 'warning'); await stopGridTrading(true); }
        await calculateGridLevels(); 
     }, 'grid-symbol');
    const gridParamInputsForListener = [ { el: upperPriceInput, id: 'upper-price' }, { el: lowerPriceInput, id: 'lower-price' }, { el: gridCountInput, id: 'grid-count' }, { el: totalUsdtInput, id: 'total-usdt' } ];
    gridParamInputsForListener.forEach(item => { addSafeListener(item.el, 'change', () => { if (!isGridRunning) calculateGridLevels(); }, item.id); });
    addSafeListener('save-config-btn', 'click', saveConfig); 
    addSafeListener('load-config-btn', 'click', loadConfig); 
    addSafeListener('get-fee-btn', 'click', getFeeRate);
    addSafeListener('toggle-btn', 'click', () => chrome.runtime.sendMessage({ action: 'toggleSidebar' }));
    addSafeListener('test-communication-btn', 'click', () => { chrome.runtime.sendMessage({ action: 'testCommunication' }, (response) => { addMessage(`通信测试: ${response?.message || '失败'}`, response?.success ? 'success' : 'error'); }); });
}
async function initPage() { 
    initDOMElements(); initEventListeners(); switchTab('tabGrid', getElementByIdSafe('tabGridBtn', false)); 
    updateGridUIState(); addMessage("Bybit 网格助手已加载 (Cookie - 精确逐级)", 'info');
    await syncServerTime(); const configLoaded = await loadConfig(); 
    const initialSymbol = (gridSymbolInput && gridSymbolInput.value) ? gridSymbolInput.value.trim().toUpperCase() : gridConfig.symbol;
    await getInstrumentInfo(initialSymbol); await calculateGridLevels(); 
    if (API_KEY && API_SECRET) { await getFeeRate(); } else if (!configLoaded) { addMessage("API密钥未配置，请在设置中配置。", "warning"); }
    initializePriceWebSocket(); 
    setInterval(syncServerTime, 60000 * 1); 
}
// --- Config Storage --- 
async function encryptConfig(config, password) { 
    try {
        const encoder = new TextEncoder(); const data = encoder.encode(JSON.stringify(config)); const iv = crypto.getRandomValues(new Uint8Array(12)); 
        const keyMaterial = await crypto.subtle.importKey( 'raw', encoder.encode(password.padEnd(32, '\0').slice(0,32)), { name: 'PBKDF2' }, false, ['deriveKey'] );
        const derivedKey = await crypto.subtle.deriveKey( { name: 'PBKDF2', salt: iv, iterations: 100000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, true, ['encrypt'] );
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, derivedKey, data);
        return { iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''), encrypted: Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, '0')).join('') };
    } catch (error) { addMessage(`加密失败: ${error.message}`, 'error'); console.error("Encryption error:", error); throw error; }
}
async function decryptConfig(encryptedData, password) { 
    try {
        const encoder = new TextEncoder(); const iv = new Uint8Array(encryptedData.iv.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        const encrypted = new Uint8Array(encryptedData.encrypted.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        const keyMaterial = await crypto.subtle.importKey( 'raw', encoder.encode(password.padEnd(32, '\0').slice(0,32)), { name: 'PBKDF2' }, false, ['deriveKey'] );
        const derivedKey = await crypto.subtle.deriveKey( { name: 'PBKDF2', salt: iv, iterations: 100000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, true, ['decrypt'] );
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, derivedKey, encrypted);
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch (error) { addMessage(`解密失败: 密码错误或数据损坏. ${error.message}`, 'error'); console.error("Decryption error:", error); throw error; }
}
async function saveConfig() { 
    const currentPassword = passwordInput ? passwordInput.value : ''; if (!currentPassword) { addMessage('请输入配置密码以保存', 'error'); return; }
    const configToSave = { apiKey: apiKeyInput ? apiKeyInput.value.trim() : '', apiSecret: apiSecretInput ? apiSecretInput.value.trim() : '', gridSymbol: gridSymbolInput ? gridSymbolInput.value.trim().toUpperCase() : 'BTCUSDT', upperPrice: upperPriceInput ? upperPriceInput.value : '0', lowerPrice: lowerPriceInput ? lowerPriceInput.value : '0', gridCount: gridCountInput ? gridCountInput.value : '0', totalUsdt: totalUsdtInput ? totalUsdtInput.value : '0', };
    try { const encryptedConfig = await encryptConfig(configToSave, currentPassword); chrome.storage.local.set({ encryptedBybitGridConfig: encryptedConfig }, () => { addMessage('配置已加密保存', 'success'); API_KEY = configToSave.apiKey; API_SECRET = configToSave.apiSecret; }); } catch (error) { addMessage('保存配置失败', 'error'); }
}
async function loadConfig() { 
    const currentPassword = passwordInput ? passwordInput.value : ''; if (!currentPassword) { return false; } 
    return new Promise((resolve) => {
        chrome.storage.local.get(['encryptedBybitGridConfig'], async (result) => {
            if (!result.encryptedBybitGridConfig) { resolve(false); return; }
            try {
                const config = await decryptConfig(result.encryptedBybitGridConfig, currentPassword);
                if(apiKeyInput) apiKeyInput.value = config.apiKey || ''; if(apiSecretInput) apiSecretInput.value = config.apiSecret || '';
                API_KEY = config.apiKey || ''; API_SECRET = config.apiSecret || '';
                if(gridSymbolInput) gridSymbolInput.value = config.gridSymbol || 'BTCUSDT'; if(upperPriceInput) upperPriceInput.value = config.upperPrice || '0';
                if(lowerPriceInput) lowerPriceInput.value = config.lowerPrice || '0'; if(gridCountInput) gridCountInput.value = config.gridCount || '0';
                if(totalUsdtInput) totalUsdtInput.value = config.totalUsdt || '0';
                gridConfig.symbol = config.gridSymbol || 'BTCUSDT'; addMessage('配置已加载并解密', 'success'); resolve(true); 
            } catch (error) { resolve(false); }
        });
    });
}

// --- Start the application ---
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('grid-symbol') && document.querySelector('div.container')) {
        console.log("sidebar.js: Running in sidebar.html context. Initializing page.");
        initPage();
    }
});
