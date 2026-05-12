# CS2 Price Hub

> 类似 [cs2.sh](https://cs2.sh) 的CS2饰品价格聚合API服务

## 功能特点

- 🔄 **多平台聚合** - Steam、悠悠有品、C5Game（+Buff可选）
- 🚀 **无需登录** - Steam/悠悠有品/C5不需要登录即可爬取
- ⏰ **定时更新** - 自动每5分钟爬取最新价格
- 📊 **K线数据** - 支持5分钟/30分钟/1小时/1天K线
- 📈 **历史价格** - 保存3年历史数据
- 🔍 **搜索功能** - 支持中英文搜索饰品
- 🌐 **REST API** - 标准RESTful接口，易于集成

## 快速开始

### 1. 安装依赖

```bash
cd cs2_price_hub
pip install -r requirements.txt
```

### 2. 配置（可选）

```bash
# 复制配置文件
cp .env.example .env

# 编辑配置（如果需要爬取Buff，填写Cookie）
```

### 3. 初始化数据库

```bash
python main.py init
```

### 4. 启动服务

```bash
# 启动API服务（包含定时爬取）
python main.py serve

# 或开发模式（自动重载）
python main.py serve --reload
```

### 5. 访问API

- 文档: http://localhost:8000/docs
- 最新价格: http://localhost:8000/api/v1/prices/latest
- 搜索: http://localhost:8000/api/v1/search?q=AK-47

## API接口

### 获取最新价格

```http
GET /api/v1/prices/latest
GET /api/v1/prices/latest?market_hash_name=AK-47
GET /api/v1/prices/latest?source=steam
```

响应示例：
```json
{
  "success": true,
  "data": [
    {
      "market_hash_name": "AK-47 | Asiimov (Field-Tested)",
      "prices": {
        "steam": {
          "ask": 156.80,
          "ask_volume": 234,
          "bid": 145.00,
          "bid_volume": 56
        },
        "youpin": {
          "ask": 148.50,
          "ask_volume": 189
        }
      }
    }
  ],
  "total": 1
}
```

### 获取单个物品价格

```http
GET /api/v1/prices/{market_hash_name}
```

### 获取历史价格

```http
GET /api/v1/prices/{market_hash_name}/history?source=steam&days=30
```

### 获取K线数据

```http
GET /api/v1/prices/{market_hash_name}/ohlc?interval=1d&source=steam
```

间隔选项：`5m`, `30m`, `1h`, `1d`

### 搜索物品

```http
GET /api/v1/search?q=龙狙&limit=20
```

### 获取统计信息

```http
GET /api/v1/stats
```

## 手动爬取

```bash
# 爬取所有数据源（不需要登录的）
python main.py scrape

# 只爬取Steam
python main.py scrape -s steam

# 爬取单个物品
python main.py scrape --item "AK-47 | Asiimov (Field-Tested)"
```

## 数据源说明

| 数据源 | 需要登录 | 数据质量 | 说明 |
|--------|----------|----------|------|
| Steam | ❌ 否 | ⭐⭐⭐ | 官方API，稳定 |
| 悠悠有品 | ❌ 否 | ⭐⭐⭐ | 国内平台，数据全 |
| C5Game | ❌ 否 | ⭐⭐⭐ | 国内平台 |
| Buff | ✅ 是 | ⭐⭐⭐⭐⭐ | 需要Cookie，数据最全 |

## 项目结构

```
cs2_price_hub/
├── api/                # API模块
│   ├── routes.py       # 路由定义
│   └── schemas.py      # 数据模型
├── scrapers/           # 爬虫模块
│   ├── base.py         # 爬虫基类
│   ├── steam.py        # Steam爬虫
│   ├── buff.py         # Buff爬虫
│   ├── youpin.py       # 悠悠有品爬虫
│   ├── c5game.py       # C5爬虫
│   └── manager.py      # 爬虫管理器
├── scripts/            # 工具脚本
│   └── aggregate_ohlc.py  # K线聚合
├── data/               # 数据目录
├── config.py           # 配置
├── database.py         # 数据库模型
├── main.py             # 主入口
├── requirements.txt
└── README.md
```

## 与 cs2.sh 的对比

| 特性 | cs2.sh | CS2 Price Hub |
|------|--------|---------------|
| Buff数据 | ✅ | ✅（需Cookie）|
| Steam数据 | ✅ | ✅ |
| 悠悠有品 | ✅ | ✅ |
| 免费使用 | 有限制 | 完全免费 |
| 自己部署 | ❌ | ✅ |
| 源码开放 | ❌ | ✅ |
| 3年历史 | ✅ | ✅（自己积累）|

## 部署建议

### 本地开发
```bash
python main.py serve --reload
```

### 生产环境
```bash
# 使用gunicorn + uvicorn
gunicorn main:app -w 4 -k uvicorn.workers.UvicornWorker -b 0.0.0.0:8000
```

### Docker部署
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["python", "main.py", "serve"]
```

## 注意事项

⚠️ **请求频率**
- Steam API限制较严，建议延迟3秒以上
- 悠悠有品/C5相对宽松，1-2秒即可
- Buff需要登录，且有反爬机制

⚠️ **数据准确性**
- 价格数据仅供参考，不构成投资建议
- 各平台价格可能有延迟

## License

MIT
