# -*- coding: utf-8 -*-
"""
爬虫管理器 - 协调所有爬虫的运行
"""

import asyncio
import logging
from datetime import datetime
from typing import Dict, List, Optional

from .base import BaseScraper
from .steam import SteamScraper
from .buff import BuffScraper
from .youpin import YoupinScraper
from .c5game import C5GameScraper
from database import async_session, save_price_record, ScrapeLog
from config import settings


class ScraperManager:
    """爬虫管理器"""

    # 所有可用的爬虫
    SCRAPERS = {
        "steam": SteamScraper,
        "buff": BuffScraper,
        "youpin": YoupinScraper,
        "c5game": C5GameScraper,
    }

    def __init__(self):
        self.logger = logging.getLogger("scraper.manager")

    async def run_all(self, sources: List[str] = None) -> Dict:
        """
        运行所有爬虫

        Args:
            sources: 要运行的数据源列表，默认全部

        Returns:
            统计信息
        """
        if sources is None:
            sources = list(self.SCRAPERS.keys())

        self.logger.info(f"🚀 开始爬取数据源: {', '.join(sources)}")
        start_time = datetime.now()

        stats = {
            "total_items": 0,
            "sources": {},
            "errors": []
        }

        for source in sources:
            if source not in self.SCRAPERS:
                self.logger.warning(f"未知数据源: {source}")
                continue

            try:
                count = await self.run_source(source)
                stats["sources"][source] = count
                stats["total_items"] += count
            except Exception as e:
                self.logger.error(f"爬取 {source} 失败: {e}")
                stats["errors"].append({"source": source, "error": str(e)})

        duration = (datetime.now() - start_time).total_seconds()
        stats["duration_seconds"] = duration

        self.logger.info(f"✅ 爬取完成！共 {stats['total_items']} 条，耗时 {duration:.1f}s")

        return stats

    async def run_source(self, source: str) -> int:
        """
        运行单个数据源的爬虫

        Args:
            source: 数据源名称

        Returns:
            爬取的物品数量
        """
        scraper_class = self.SCRAPERS.get(source)
        if not scraper_class:
            raise ValueError(f"未知数据源: {source}")

        self.logger.info(f"📦 开始爬取: {source}")
        start_time = datetime.now()
        count = 0
        error_msg = None

        try:
            async with scraper_class() as scraper:
                async with async_session() as session:
                    async for item_data in scraper.scrape_all():
                        # 保存到数据库
                        await save_price_record(
                            session,
                            market_hash_name=item_data["market_hash_name"],
                            source=source,
                            data=item_data
                        )
                        count += 1

                        if count % 100 == 0:
                            self.logger.info(f"   {source}: 已处理 {count} 条")

        except Exception as e:
            error_msg = str(e)
            self.logger.error(f"爬取 {source} 出错: {e}")

        # 记录爬取日志
        duration = (datetime.now() - start_time).total_seconds()
        await self._log_scrape(source, count, error_msg, start_time, duration)

        self.logger.info(f"   {source}: 完成，共 {count} 条，耗时 {duration:.1f}s")

        return count

    async def scrape_item(self, market_hash_name: str, sources: List[str] = None) -> Dict:
        """
        爬取单个物品的价格（从多个数据源）

        Args:
            market_hash_name: 物品名称
            sources: 数据源列表

        Returns:
            各数据源的价格数据
        """
        if sources is None:
            sources = list(self.SCRAPERS.keys())

        results = {}

        for source in sources:
            scraper_class = self.SCRAPERS.get(source)
            if not scraper_class:
                continue

            try:
                async with scraper_class() as scraper:
                    data = await scraper.scrape_item(market_hash_name)
                    if data:
                        results[source] = data

                        # 保存到数据库
                        async with async_session() as session:
                            await save_price_record(session, market_hash_name, source, data)

            except Exception as e:
                self.logger.error(f"从 {source} 获取 {market_hash_name} 失败: {e}")

        return results

    async def _log_scrape(self, source: str, count: int, error: Optional[str],
                          start_time: datetime, duration: float):
        """记录爬取日志"""
        async with async_session() as session:
            log = ScrapeLog(
                source=source,
                status="success" if not error else "failed",
                items_count=count,
                error_message=error,
                started_at=start_time,
                finished_at=datetime.now(),
                duration_seconds=duration
            )
            session.add(log)
            await session.commit()


# 全局管理器实例
manager = ScraperManager()
