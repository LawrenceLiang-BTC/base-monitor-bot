# BASE 链地址监控 Bot

监控 BASE 链地址交易并通过 Telegram 通知

## 配置

1. 复制 `.env.example` 为 `.env`
2. 填入以下信息：
   - `TELEGRAM_BOT_TOKEN`: 你的 Telegram Bot Token
   - `TELEGRAM_CHAT_ID`: 你的 Telegram Chat ID
   - `BASESCAN_API_KEY`: BaseScan API Key (https://basescan.org/apis)
   - `MONITOR_ADDRESS`: 要监控的 BASE 地址
   - `CHECK_INTERVAL`: 检查间隔（秒，默认 30）

## 安装

```bash
npm install
```

## 运行

```bash
npm start
```

## 功能

- 实时监控指定地址的交易
- 区分转入/转出交易
- 显示交易金额、hash、对方地址
- Telegram 实时通知
