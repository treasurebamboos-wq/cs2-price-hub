# CS2 Price Hub - 快速开始

## 🚀 一键安装

```bash
cd cs2_price_hub

# 安装依赖（需等待约2分钟）
npm install playwright

# 安装浏览器（首次需要）
npx playwright install chromium
```

## ▶️ 运行爬虫

```bash
# 爬取所有平台（会打开浏览器窗口）
node scraper_browser.js

# 只爬取特定平台
node scraper_browser.js buff
node scraper_browser.js youpin
node scraper_browser.js c5
```

## 📊 查看数据

爬取的数据保存在 `data/prices.json`

## ⚙️ 配置选项

编辑 `scraper_browser.js` 顶部：

```javascript
// 爬取页数（默认3页）
maxPages: 3

// 是否显示浏览器窗口
headless: false  // true=后台运行, false=显示窗口
```

## 🔐 Buff登录

如果提示需要登录：
1. 脚本会打开浏览器窗口
2. 手动扫码登录
3. 登录成功后，重新运行脚本

## ❓ 常见问题

**Q: 浏览器打开后一片空白？**
A: 等待几秒，页面正在加载

**Q: 提示超时？**
A: 网络问题，重试即可

**Q: 数据在哪？**
A: `data/prices.json` 文件
