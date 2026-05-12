# -*- coding: utf-8 -*-
"""
Buff爬虫

注意：Buff需要Cookie才能正常访问，否则会返回"Login Required"
"""

from typing import Dict, Optional, AsyncGenerator
import asyncio
import time

from .base import BaseScraper
from config import settings


class BuffScraper(BaseScraper):
    """Buff爬虫"""

    SOURCE_NAME = "buff"
    BASE_URL = "https://buff.163.com"

    # Buff分类
    CATEGORIES = [
        "knife",  # 匕首
        "pistol",  # 手枪
        "smg",  # 微冲
        "rifle",  # 步枪
        "shotgun",  # 霰弹枪
        "machinegun",  # 机枪
        "hands",  # 手套
    ]

    def _get_headers(self) -> Dict:
        headers = super()._get_headers()
        headers.update({
            "Host": "buff.163.com",
            "Referer": "https://buff.163.com/market/csgo",
            "X-Requested-With": "XMLHttpRequest",
        })
        if settings.BUFF_COOKIE:
            headers["Cookie"] = settings.BUFF_COOKIE
        return headers

    async def scrape_item(self, market_hash_name: str) -> Optional[Dict]:
        """获取单个物品（通过搜索）"""
        url = f"{self.BASE_URL}/api/market/goods"
        params = {
            "game": "csgo",
            "page_num": 1,
            "page_size": 10,
            "search": market_hash_name,
            "_": int(time.time() * 1000)
        }

        data = await self._get(url, params=params)

        if not data:
            return None

        if data.get("code") == "Login Required":
            self.logger.error("需要Cookie！请在 .env 中设置 BUFF_COOKIE")
            return None

        if data.get("code") != "OK":
            return None

        items = data.get("data", {}).get("items", [])
        if not items:
            return None

        # 找到匹配的物品
        for item in items:
            if item.get("market_hash_name") == market_hash_name:
                return self._parse_item(item)

        return None

    async def scrape_category(self, category: str) -> AsyncGenerator[Dict, None]:
        """爬取某个分类的所有物品"""
        page = 1
        while True:
            url = f"{self.BASE_URL}/api/market/goods"
            params = {
                "game": "csgo",
                "page_num": page,
                "page_size": 80,
                "category_group": category,
                "use_suggestion": 0,
                "_": int(time.time() * 1000)
            }

            data = await self._get(url, params=params)

            if not data:
                break

            if data.get("code") == "Login Required":
                self.logger.error("需要Cookie！请在 .env 中设置 BUFF_COOKIE")
                break

            if data.get("code") != "OK":
                break

            items = data.get("data", {}).get("items", [])
            if not items:
                break

            for item in items:
                parsed = self._parse_item(item)
                if parsed:
                    yield parsed

            # 检查是否还有更多页
            total_page = data.get("data", {}).get("total_page", 1)
            if page >= total_page:
                break

            page += 1
            await asyncio.sleep(settings.REQUEST_DELAY)

    async def scrape_all(self) -> AsyncGenerator[Dict, None]:
        """爬取所有分类"""
        for category in self.CATEGORIES:
            self.logger.info(f"开始爬取分类: {category}")
            async for item in self.scrape_category(category):
                yield item
            await asyncio.sleep(settings.REQUEST_DELAY)

    def _parse_item(self, item: Dict) -> Optional[Dict]:
        """解析物品数据"""
        try:
            goods_info = item.get("goods_info", {})

            return {
                "market_hash_name": item.get("market_hash_name"),
                "name_cn": item.get("name"),
                "ask": self._safe_float(item.get("sell_min_price")),
                "ask_volume": item.get("sell_num"),
                "bid": self._safe_float(item.get("buy_max_price")),
                "bid_volume": item.get("buy_num"),
                "volume_24h": None,  # Buff API不直接提供24h成交量
                "last_sale_price": self._safe_float(item.get("quick_price")),
                # 额外信息
                "buff_id": item.get("id"),
                "steam_price": self._safe_float(goods_info.get("steam_price")),
                "steam_price_cny": self._safe_float(goods_info.get("steam_price_cny")),
            }
        except Exception as e:
            self.logger.error(f"解析物品失败: {e}")
            return None

    def _safe_float(self, value) -> Optional[float]:
        """安全转换为浮点数"""
        if value is None:
            return None
        try:
            return float(value)
        except:
            return None
