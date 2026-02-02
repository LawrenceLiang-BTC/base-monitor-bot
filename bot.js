require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  apiKey: process.env.BASESCAN_API_KEY,
  interval: parseInt(process.env.CHECK_INTERVAL) * 1000 || 30000,
  minTransferAmount: parseFloat(process.env.MIN_TRANSFER_AMOUNT) || 0.1 // 最小转入额度，默认0.1
};

const bot = new TelegramBot(config.botToken, { polling: true });
const addressesFile = './addresses.json';
const blacklistFile = './blacklist.json';
let monitoredAddresses = {};
let blacklistedContracts = {};
let isInitializing = true; // 标记是否在初始化阶段

function loadAddresses() {
  if (fs.existsSync(addressesFile)) {
    monitoredAddresses = JSON.parse(fs.readFileSync(addressesFile, 'utf8'));
  } else {
    const initialAddress = process.env.MONITOR_ADDRESS;
    if (initialAddress) {
      monitoredAddresses[initialAddress.toLowerCase()] = { lastBlock: 0 };
      saveAddresses();
    }
  }

  // 加载黑名单
  if (fs.existsSync(blacklistFile)) {
    blacklistedContracts = JSON.parse(fs.readFileSync(blacklistFile, 'utf8'));
  }
}

function saveAddresses() {
  fs.writeFileSync(addressesFile, JSON.stringify(monitoredAddresses, null, 2));
}

function saveBlacklist() {
  fs.writeFileSync(blacklistFile, JSON.stringify(blacklistedContracts, null, 2));
}

async function getTokenTransfers(address, startBlock) {
  try {
    const response = await axios.get('https://base.blockscout.com/api', {
      params: {
        module: 'account',
        action: 'tokentx',
        address: address,
        startblock: startBlock,
        sort: 'asc'
      },
      timeout: 5000
    });

    if (response.data.message === 'OK') {
      return response.data.result;
    }
    return [];
  } catch (error) {
    // 静默处理 500 错误，避免刷屏
    if (error.response?.status !== 500) {
      console.error('获取代币交易失败:', error.message);
    }
    return [];
  }
}

function formatAmount(value) {
  if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(2) + 'K';
  return value.toFixed(2);
}

function formatTransaction(tx, monitorAddress) {
  const addressData = monitoredAddresses[monitorAddress.toLowerCase()];
  const remark = addressData?.remark || '未命名';
  const isIncoming = tx.to.toLowerCase() === monitorAddress.toLowerCase();
  const direction = isIncoming ? '📥 买入' : '📤 卖出';
  const decimals = parseInt(tx.tokenDecimal) || 18;
  const amount = parseInt(tx.value) / Math.pow(10, decimals);

  // 检查是否是黑名单中的合约地址
  if (blacklistedContracts[tx.contractAddress.toLowerCase()]) {
    console.log('已过滤黑名单合约:', tx.contractAddress, tx.tokenName);
    return null;
  }

  // 检查转入额度是否过小（防止钓鱼）
  if (isIncoming && amount < config.minTransferAmount) {
    console.log('已过滤小额转入:', tx.contractAddress, tx.tokenName, amount);
    return null;
  }

  return `
【${remark}】 ${direction}
${tx.tokenName} (${tx.tokenSymbol})
CA: ${tx.contractAddress}
数量: ${formatAmount(amount)}
地址: ${monitorAddress}
时间: ${new Date(parseInt(tx.timeStamp) * 1000).toLocaleString('zh-CN')}
  `.trim();
}

async function sendNotification(message) {
  try {
    if (message) {
      await bot.sendMessage(config.chatId, message);
    }
  } catch (error) {
    console.error('发送消息失败:', error.message);
  }
}

async function checkTransactions() {
  for (const [address, data] of Object.entries(monitoredAddresses)) {
    const transactions = await getTokenTransfers(address, data.lastBlock);

    if (transactions.length > 0) {
      for (const tx of transactions) {
        const blockNum = parseInt(tx.blockNumber);
        if (blockNum > data.lastBlock) {
          console.log('发现新交易:', tx.hash, '地址:', address);

          // 只在非初始化阶段发送通知
          if (!isInitializing) {
            await sendNotification(formatTransaction(tx, address));
          } else {
            console.log('初始化阶段，跳过通知:', tx.hash);
          }

          data.lastBlock = blockNum;
        }
      }
      saveAddresses();
    }
  }
}

bot.onText(/\/add (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== config.chatId) return;

  const address = match[1].trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/i.test(address)) {
    bot.sendMessage(msg.chat.id, '❌ 地址格式错误');
    return;
  }

  if (monitoredAddresses[address]) {
    bot.sendMessage(msg.chat.id, '⚠️ 该地址已在监控中');
    return;
  }

  // 获取最新区块作为起点
  const txs = await getTokenTransfers(address, 0);
  const lastBlock = txs.length > 0 ? Math.max(...txs.map(tx => parseInt(tx.blockNumber))) : 0;

  monitoredAddresses[address] = { lastBlock };
  saveAddresses();
  bot.sendMessage(msg.chat.id, `✅ 已添加监控地址:\n${address}\n从区块 ${lastBlock} 开始监控`);
  console.log('添加监控地址:', address, '起始区块:', lastBlock);
});

bot.onText(/\/remove (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== config.chatId) return;

  const address = match[1].trim().toLowerCase();

  if (!monitoredAddresses[address]) {
    bot.sendMessage(msg.chat.id, '❌ 该地址未在监控中');
    return;
  }

  delete monitoredAddresses[address];
  saveAddresses();
  bot.sendMessage(msg.chat.id, `✅ 已移除监控地址:\n${address}`);
  console.log('移除监控地址:', address);
});

bot.onText(/\/list/, async (msg) => {
  if (msg.chat.id.toString() !== config.chatId) return;

  const addresses = Object.keys(monitoredAddresses);
  if (addresses.length === 0) {
    bot.sendMessage(msg.chat.id, '📋 当前没有监控任何地址');
    return;
  }

  const list = addresses.map((addr, i) => {
    const remark = monitoredAddresses[addr].remark || '未命名';
    return `${i + 1}. ${remark}\n   ${addr}`;
  }).join('\n\n');
  bot.sendMessage(msg.chat.id, `📋 当前监控地址 (${addresses.length}):\n\n${list}`);
});

bot.onText(/\/remark (.+) (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== config.chatId) return;

  const address = match[1].trim().toLowerCase();
  const remark = match[2].trim();

  if (!monitoredAddresses[address]) {
    bot.sendMessage(msg.chat.id, '❌ 该地址未在监控中');
    return;
  }

  monitoredAddresses[address].remark = remark;
  saveAddresses();
  bot.sendMessage(msg.chat.id, `✅ 已设置备注:\n${address}\n备注: ${remark}`);
});

bot.onText(/\/help/, async (msg) => {
  if (msg.chat.id.toString() !== config.chatId) return;

  const help = `
🤖 BASE 链监控 Bot 命令:

/add <地址> - 添加监控地址
/remove <地址> - 移除监控地址
/remark <地址> <备注> - 设置地址备注
/list - 查看所有监控地址
/blacklist <CA地址> - 添加黑名单合约
/unblacklist <CA地址> - 移除黑名单合约
/blacklist_list - 查看黑名单列表
/help - 显示帮助信息

示例:
/add 0x1234...5678
/remark 0x1234...5678 我的钱包
/remove 0x1234...5678
/blacklist 0xabcd...ef01
  `.trim();

  bot.sendMessage(msg.chat.id, help);
});

// 添加黑名单命令
bot.onText(/\/blacklist (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== config.chatId) return;

  const contractAddress = match[1].trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/i.test(contractAddress)) {
    bot.sendMessage(msg.chat.id, '❌ 合约地址格式错误');
    return;
  }

  if (blacklistedContracts[contractAddress]) {
    bot.sendMessage(msg.chat.id, '⚠️ 该合约已在黑名单中');
    return;
  }

  blacklistedContracts[contractAddress] = {
    addedAt: new Date().toISOString()
  };
  saveBlacklist();
  bot.sendMessage(msg.chat.id, `✅ 已添加到黑名单:\n${contractAddress}`);
  console.log('添加黑名单合约:', contractAddress);
});

// 移除黑名单命令
bot.onText(/\/unblacklist (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== config.chatId) return;

  const contractAddress = match[1].trim().toLowerCase();

  if (!blacklistedContracts[contractAddress]) {
    bot.sendMessage(msg.chat.id, '❌ 该合约不在黑名单中');
    return;
  }

  delete blacklistedContracts[contractAddress];
  saveBlacklist();
  bot.sendMessage(msg.chat.id, `✅ 已从黑名单移除:\n${contractAddress}`);
  console.log('移除黑名单合约:', contractAddress);
});

// 查看黑名单列表
bot.onText(/\/blacklist_list/, async (msg) => {
  if (msg.chat.id.toString() !== config.chatId) return;

  const contracts = Object.keys(blacklistedContracts);
  if (contracts.length === 0) {
    bot.sendMessage(msg.chat.id, '📋 黑名单为空');
    return;
  }

  const list = contracts.map((addr, i) => {
    return `${i + 1}. ${addr}`;
  }).join('\n');
  bot.sendMessage(msg.chat.id, `📋 黑名单合约 (${contracts.length}):\n\n${list}`);
});

async function init() {
  if (!config.botToken || !config.chatId || !config.apiKey) {
    console.error('错误: 请在 .env 文件中配置所有必需参数');
    process.exit(1);
  }

  loadAddresses();

  console.log('BASE 链监控 Bot 启动中...');
  console.log('监控地址数量:', Object.keys(monitoredAddresses).length);
  console.log('检查间隔:', config.interval / 1000, '秒');
  console.log('最小转入额度过滤:', config.minTransferAmount);

  // 启动时更新所有地址的lastBlock到当前最新区块，避免重启时发送历史交易
  console.log('正在同步最新区块...');
  for (const [address, data] of Object.entries(monitoredAddresses)) {
    try {
      const txs = await getTokenTransfers(address, 0);
      if (txs.length > 0) {
        const latestBlock = Math.max(...txs.map(tx => parseInt(tx.blockNumber)));
        console.log(`${data.remark || address}: 当前区块 ${data.lastBlock} -> 最新区块 ${latestBlock}`);
        data.lastBlock = latestBlock;
      } else {
        console.log(`${data.remark || address}: 未获取到交易记录，保持当前区块 ${data.lastBlock}`);
      }
    } catch (error) {
      console.error(`${data.remark || address}: 同步失败`, error.message);
    }
  }
  saveAddresses();
  console.log('区块同步完成！');

  // 初始化完成，开始正常监控
  isInitializing = false;

  await sendNotification(`🤖 监控 Bot 已启动\n当前监控 ${Object.keys(monitoredAddresses).length} 个地址\n最小转入额度: ${config.minTransferAmount}\n\n发送 /help 查看命令`);

  setInterval(checkTransactions, config.interval);
}

init();
