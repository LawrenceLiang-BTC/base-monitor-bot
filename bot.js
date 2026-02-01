require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  apiKey: process.env.BASESCAN_API_KEY,
  interval: parseInt(process.env.CHECK_INTERVAL) * 1000 || 30000
};

const bot = new TelegramBot(config.botToken, { polling: true });
const addressesFile = './addresses.json';
let monitoredAddresses = {};

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
}

function saveAddresses() {
  fs.writeFileSync(addressesFile, JSON.stringify(monitoredAddresses, null, 2));
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

  return `
${remark}
${monitorAddress}

${direction} ${formatAmount(amount)} ${tx.tokenSymbol}
代币: ${tx.tokenName}
时间: ${new Date(parseInt(tx.timeStamp) * 1000).toLocaleString('zh-CN')}
  `.trim();
}

async function sendNotification(message) {
  try {
    await bot.sendMessage(config.chatId, message);
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
          await sendNotification(formatTransaction(tx, address));
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
/help - 显示帮助信息

示例:
/add 0x1234...5678
/remark 0x1234...5678 我的钱包
/remove 0x1234...5678
  `.trim();

  bot.sendMessage(msg.chat.id, help);
});

async function init() {
  if (!config.botToken || !config.chatId || !config.apiKey) {
    console.error('错误: 请在 .env 文件中配置所有必需参数');
    process.exit(1);
  }

  loadAddresses();

  console.log('BASE 链监控 Bot 启动');
  console.log('监控地址数量:', Object.keys(monitoredAddresses).length);
  console.log('检查间隔:', config.interval / 1000, '秒');

  await sendNotification(`🤖 监控 Bot 已启动\n当前监控 ${Object.keys(monitoredAddresses).length} 个地址\n\n发送 /help 查看命令`);

  setInterval(checkTransactions, config.interval);
}

init();
