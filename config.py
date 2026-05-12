# -*- coding: utf-8 -*-
"""
CS2 Price Hub - 配置文件
"""

import os
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """应用配置"""

    # 基础配置
    APP_NAME: str = "CS2 Price Hub"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = True

    # 数据库
    DATABASE_URL: str = "sqlite+aiosqlite:///./data/cs2_prices.db"

    # API配置
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8000

    # 爬虫配置
    SCRAPE_INTERVAL_MINUTES: int = 5  # 每5分钟爬取一次
    REQUEST_TIMEOUT: int = 30
    REQUEST_DELAY: float = 2.0  # 请求间隔（秒）

    # Buff配置（如果有Cookie可以填，没有就留空用其他数据源）
    BUFF_COOKIE: str = ""

    # Steam配置
    STEAM_API_KEY: str = ""  # 可选，有的话可以获取更多数据

    # 数据保留
    PRICE_HISTORY_DAYS: int = 365 * 3  # 保留3年历史数据

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()

# 确保数据目录存在
Path("data").mkdir(exist_ok=True)
