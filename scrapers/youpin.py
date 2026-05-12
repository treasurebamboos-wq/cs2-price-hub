# -*- coding: utf-8 -*-
"""
悠悠有品爬虫（无需登录）
"""

from typing import Dict, Optional, AsyncGenerator
import asyncio
import time
import hashlib

from .base import BaseScraper
from config import settings


class YoupinScraper(BaseScraper):
    """悠悠有品爬虫"""

    SOURCE_NAME = "youpin"
    BASE_URL = "https://api.youpin898.com"

    def _get_headers(self) -> Dict:
        headers = super()._get_headers()
        headers.update({
            "Origin": "https://www.youpin898.com",
            "Referer": "https://www.youpin898.com/",
        })
        return headers

    async def scrape_item(self, market_hash_name: str) -> Optional[Dict]:
        """搜索单个物品"""
        url = f"{self.BASE_URL}/api/homepage/es/template/search"

        payload = {
            "gameId": 730,
            "keyword": market_hash_name,
            "pageIndex": 1,
            "pageSize": 20,
            "sortType": 0,
        }

        data = await self._post(url, json=payload)

        if not data or data.get("Code") != 0:
            return None

        items = data.get("Data", {}).get("ProductList", [])
        for item in items:
            if item.get("HashName") == market_hash_name:
                return self._parse_item(item)

        return None

    async def scrape_all(self) -> AsyncGenerator[Dict, None]:
        """爬取所有物品"""
        url = f"{self.BASE_URL}/api/homepage/es/template/search"

        page = 1
        while True:
            payload = {
                "gameId": 730,
                "pageIndex": page,
                "pageSize": 100,
                "sortType": 1,  # 按销量排序
            }

            data = await self._post(url, json=payload)

            if not data or data.get("Code") != 0:
                break

            items = data.get("Data", {}).get("ProductList", [])
            if not items:
                break

            for item in items:
                parsed = self._parse_item(item)
                if parsed:
                    yield parsed

            # 检查是否还有更多
            total = data.get("Data", {}).get("TotalCount", 0)
            if page * 100 >= total:
                break

            page += 1
            await asyncio.sleep(settings.REQUEST_DELAY)

    def _parse_item(self, item: Dict) -> Optional[Dict]:
        """解析物品数据"""
        try:
            return {
                "market_hash_name": item.get("HashName"),
                "name_cn": item.get("CommodityName"),
                "ask": item.get("Price"),
                "ask_volume": item.get("OnSaleCount"),
                "bid": item.get("BuyPrice"),
                "bid_volume": item.get("BuyNum"),
                "volume_24h": item.get("TransactionCount"),
                "last_sale_price": item.get("LastSoldPrice"),
            }
        except Exception as e:
            self.logger.error(f"解析物品失败: {e}")
            return None
