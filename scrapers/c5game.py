# -*- coding: utf-8 -*-
"""
C5Game爬虫（无需登录）
"""

from typing import Dict, Optional, AsyncGenerator
import asyncio

from .base import BaseScraper
from config import settings


class C5GameScraper(BaseScraper):
    """C5Game爬虫"""

    SOURCE_NAME = "c5game"
    BASE_URL = "https://www.c5game.com"

    def _get_headers(self) -> Dict:
        headers = super()._get_headers()
        headers.update({
            "Referer": "https://www.c5game.com/csgo",
        })
        return headers

    async def scrape_item(self, market_hash_name: str) -> Optional[Dict]:
        """搜索单个物品"""
        url = f"{self.BASE_URL}/api/product/search"

        params = {
            "keyword": market_hash_name,
            "appId": 730,
            "page": 1,
            "limit": 20,
        }

        data = await self._get(url, params=params)

        if not data or data.get("success") is not True:
            return None

        items = data.get("data", {}).get("list", [])
        for item in items:
            if item.get("hashName") == market_hash_name:
                return self._parse_item(item)

        return None

    async def scrape_all(self) -> AsyncGenerator[Dict, None]:
        """爬取所有物品"""
        url = f"{self.BASE_URL}/api/product/list"

        page = 1
        while True:
            params = {
                "appId": 730,
                "page": page,
                "limit": 100,
                "sort": "sell",  # 按销量排序
            }

            data = await self._get(url, params=params)

            if not data or data.get("success") is not True:
                break

            items = data.get("data", {}).get("list", [])
            if not items:
                break

            for item in items:
                parsed = self._parse_item(item)
                if parsed:
                    yield parsed

            # 检查是否还有更多
            total = data.get("data", {}).get("total", 0)
            if page * 100 >= total:
                break

            page += 1
            await asyncio.sleep(settings.REQUEST_DELAY)

    def _parse_item(self, item: Dict) -> Optional[Dict]:
        """解析物品数据"""
        try:
            return {
                "market_hash_name": item.get("hashName"),
                "name_cn": item.get("itemName"),
                "ask": item.get("price"),
                "ask_volume": item.get("sellNum"),
                "bid": item.get("buyPrice"),
                "bid_volume": item.get("buyNum"),
                "volume_24h": item.get("sellCount"),
                "last_sale_price": item.get("recentPrice"),
            }
        except Exception as e:
            self.logger.error(f"解析物品失败: {e}")
            return None
