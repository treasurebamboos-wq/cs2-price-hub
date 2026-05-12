# -*- coding: utf-8 -*-
"""
Steam市场爬虫（官方API，无需登录）
"""

from typing import Dict, Optional, AsyncGenerator
import asyncio
from urllib.parse import quote

from .base import BaseScraper
from config import settings


class SteamScraper(BaseScraper):
    """Steam市场爬虫"""

    SOURCE_NAME = "steam"
    BASE_URL = "https://steamcommunity.com"

    # Steam货币代码
    CURRENCY_CNY = 23

    async def scrape_item(self, market_hash_name: str) -> Optional[Dict]:
        """
        获取单个物品的价格

        API: /market/priceoverview/
        """
        url = f"{self.BASE_URL}/market/priceoverview/"
        params = {
            "appid": 730,
            "currency": self.CURRENCY_CNY,
            "market_hash_name": market_hash_name
        }

        data = await self._get(url, params=params)
        if not data or not data.get("success"):
            return None

        return {
            "market_hash_name": market_hash_name,
            "ask": self._parse_price(data.get("lowest_price")),
            "ask_volume": None,  # priceoverview不提供数量
            "bid": None,
            "bid_volume": None,
            "volume_24h": self._parse_int(data.get("volume")),
            "last_sale_price": self._parse_price(data.get("median_price")),
        }

    async def scrape_item_detail(self, market_hash_name: str) -> Optional[Dict]:
        """
        获取物品详情（包含在售数量、买卖订单）

        API: /market/listings/730/{item}/render/
        """
        encoded = quote(market_hash_name)
        url = f"{self.BASE_URL}/market/listings/730/{encoded}/render/"
        params = {
            "start": 0,
            "count": 10,
            "currency": self.CURRENCY_CNY,
            "language": "schinese",
            "format": "json"
        }

        data = await self._get(url, params=params)
        if not data:
            return None

        # 获取买卖订单
        orders = await self._get_orders(market_hash_name)

        result = {
            "market_hash_name": market_hash_name,
            "ask_volume": data.get("total_count", 0),
        }

        if orders:
            result.update(orders)

        return result

    async def _get_orders(self, market_hash_name: str) -> Optional[Dict]:
        """获取买卖订单信息"""
        encoded = quote(market_hash_name)
        url = f"{self.BASE_URL}/market/listings/730/{encoded}"

        # 需要从HTML中解析item_nameid，这里简化处理
        # 实际实现需要先获取页面解析item_nameid
        return None

    async def scrape_all(self) -> AsyncGenerator[Dict, None]:
        """
        Steam没有批量API，需要遍历物品列表

        这里提供一个搜索方式来获取列表
        """
        # 获取热门物品列表
        url = f"{self.BASE_URL}/market/search/render/"
        params = {
            "appid": 730,
            "norender": 1,
            "count": 100,
            "sort_column": "popular",
            "sort_dir": "desc",
            "currency": self.CURRENCY_CNY
        }

        page = 0
        while True:
            params["start"] = page * 100
            data = await self._get(url, params=params)

            if not data or not data.get("results"):
                break

            for item in data["results"]:
                hash_name = item.get("hash_name")
                if not hash_name:
                    continue

                # 解析价格
                price_str = item.get("sell_price_text", "")
                price = self._parse_price(price_str)

                yield {
                    "market_hash_name": hash_name,
                    "ask": price,
                    "ask_volume": item.get("sell_listings", 0),
                    "bid": None,
                    "bid_volume": None,
                    "volume_24h": None,
                    "last_sale_price": None,
                }

                # 请求间隔
                await asyncio.sleep(settings.REQUEST_DELAY)

            page += 1

            # 检查是否还有更多
            total = data.get("total_count", 0)
            if page * 100 >= total:
                break

    def _parse_price(self, price_str: str) -> Optional[float]:
        """解析价格字符串"""
        if not price_str:
            return None
        try:
            # 移除货币符号、逗号、空格
            clean = price_str.replace("¥", "").replace(",", "").replace(" ", "")
            clean = clean.replace("$", "").replace("€", "").replace("£", "")
            # 处理可能的分号格式
            if "." not in clean and len(clean) > 2:
                clean = clean[:-2] + "." + clean[-2:]
            return float(clean)
        except:
            return None

    def _parse_int(self, s: str) -> Optional[int]:
        """解析整数字符串"""
        if not s:
            return None
        try:
            return int(s.replace(",", ""))
        except:
            return None
