# -*- coding: utf-8 -*-
"""
CS2 Price Hub - 主入口

类似 cs2.sh 的CS2饰品价格API服务

功能:
- 聚合多平台价格数据（Buff、Steam、悠悠有品、C5等）
- 提供REST API查询
- 定时自动爬取更新
- 历史价格 & K线数据

使用:
    # 启动API服务
    python main.py serve

    # 手动爬取数据
    python main.py scrape

    # 爬取单个物品
    python main.py scrape --item "AK-47 | Asiimov (Field-Tested)"

    # 初始化数据库
    python main.py init
"""

import asyncio
import logging
import argparse
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from config import settings
from database import init_db
from api import router
from scrapers import manager


# ========== 日志配置 ==========
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# ========== 定时任务 ==========
scheduler = AsyncIOScheduler()


async def scheduled_scrape():
    """定时爬取任务"""
    logger.info("⏰ 开始定时爬取...")
    try:
        # 优先爬取不需要登录的数据源
        await manager.run_all(sources=["steam", "youpin", "c5game"])

        # 如果配置了Buff Cookie，也爬取Buff
        if settings.BUFF_COOKIE:
            await manager.run_all(sources=["buff"])
    except Exception as e:
        logger.error(f"定时爬取失败: {e}")


# ========== FastAPI应用 ==========
@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # 启动时
    logger.info("🚀 CS2 Price Hub 启动中...")

    # 初始化数据库
    await init_db()

    # 启动定时任务
    scheduler.add_job(
        scheduled_scrape,
        trigger=IntervalTrigger(minutes=settings.SCRAPE_INTERVAL_MINUTES),
        id="scrape_job",
        name="定时爬取",
        replace_existing=True
    )
    scheduler.start()
    logger.info(f"⏰ 定时任务已启动，每 {settings.SCRAPE_INTERVAL_MINUTES} 分钟爬取一次")

    yield

    # 关闭时
    scheduler.shutdown()
    logger.info("👋 CS2 Price Hub 已关闭")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="CS2饰品价格聚合API，类似 cs2.sh",
    lifespan=lifespan
)

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(router, prefix="/api/v1", tags=["prices"])


# 根路径
@app.get("/")
async def root():
    return {
        "name": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "docs": "/docs",
        "api": "/api/v1",
        "endpoints": {
            "latest_prices": "/api/v1/prices/latest",
            "item_price": "/api/v1/prices/{market_hash_name}",
            "price_history": "/api/v1/prices/{market_hash_name}/history",
            "ohlc": "/api/v1/prices/{market_hash_name}/ohlc",
            "search": "/api/v1/search?q={keyword}",
            "stats": "/api/v1/stats",
        }
    }


# ========== CLI命令 ==========
def cli():
    parser = argparse.ArgumentParser(description="CS2 Price Hub - CS2饰品价格API")
    subparsers = parser.add_subparsers(dest="command", help="命令")

    # serve命令
    serve_parser = subparsers.add_parser("serve", help="启动API服务")
    serve_parser.add_argument("--host", default=settings.API_HOST, help="监听地址")
    serve_parser.add_argument("--port", type=int, default=settings.API_PORT, help="端口")
    serve_parser.add_argument("--reload", action="store_true", help="开发模式（自动重载）")

    # scrape命令
    scrape_parser = subparsers.add_parser("scrape", help="爬取数据")
    scrape_parser.add_argument("--source", "-s", nargs="+",
                               choices=["steam", "buff", "youpin", "c5game"],
                               help="数据源")
    scrape_parser.add_argument("--item", "-i", type=str, help="爬取单个物品")

    # init命令
    subparsers.add_parser("init", help="初始化数据库")

    args = parser.parse_args()

    if args.command == "serve":
        uvicorn.run(
            "main:app",
            host=args.host,
            port=args.port,
            reload=args.reload
        )

    elif args.command == "scrape":
        async def run_scrape():
            await init_db()
            if args.item:
                # 爬取单个物品
                result = await manager.scrape_item(args.item, args.source)
                print(f"\n📊 {args.item} 的价格:")
                for source, data in result.items():
                    print(f"  [{source}]")
                    print(f"    最低售价: ¥{data.get('ask')}")
                    print(f"    在售数量: {data.get('ask_volume')}")
                    print(f"    最高求购: ¥{data.get('bid')}")
            else:
                # 爬取所有
                sources = args.source or ["steam", "youpin", "c5game"]
                await manager.run_all(sources)

        asyncio.run(run_scrape())

    elif args.command == "init":
        asyncio.run(init_db())
        print("✅ 数据库初始化完成")

    else:
        parser.print_help()


if __name__ == "__main__":
    cli()
