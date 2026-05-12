# -*- coding: utf-8 -*-
"""
爬虫基类
"""

from abc import ABC, abstractmethod
from typing import Dict, List, Optional, AsyncGenerator
import httpx
import asyncio
import logging
from datetime import datetime

from config import settings


class BaseScraper(ABC):
    """爬虫基类"""

    SOURCE_NAME: str = "unknown"
    BASE_URL: str = ""

    def __init__(self):
        self.logger = logging.getLogger(f"scraper.{self.SOURCE_NAME}")
        self.client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self):
        self.client = httpx.AsyncClient(
            timeout=settings.REQUEST_TIMEOUT,
            headers=self._get_headers(),
            follow_redirects=True
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.client:
            await self.client.aclose()

    def _get_headers(self) -> Dict:
        """获取请求头"""
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }

    async def _request(self, method: str, url: str, **kwargs) -> Optional[Dict]:
        """发送请求"""
        try:
            response = await self.client.request(method, url, **kwargs)

            if response.status_code == 429:
                self.logger.warning(f"Rate limited, waiting 30s...")
                await asyncio.sleep(30)
                return None

            response.raise_for_status()
            return response.json()

        except httpx.HTTPStatusError as e:
            self.logger.error(f"HTTP error: {e.response.status_code}")
            return None
        except Exception as e:
            self.logger.error(f"Request failed: {e}")
            return None

    async def _get(self, url: str, params: Dict = None) -> Optional[Dict]:
        """GET请求"""
        return await self._request("GET", url, params=params)

    async def _post(self, url: str, data: Dict = None, json: Dict = None) -> Optional[Dict]:
        """POST请求"""
        return await self._request("POST", url, data=data, json=json)

    @abstractmethod
    async def scrape_all(self) -> AsyncGenerator[Dict, None]:
        """
        爬取所有数据

        Yields:
            Dict: 价格数据，格式：
            {
                "market_hash_name": str,
                "ask": float,           # 最低售价
                "ask_volume": int,      # 在售数量
                "bid": float,           # 最高求购价
                "bid_volume": int,      # 求购数量
                "volume_24h": int,      # 24h成交量
                "last_sale_price": float  # 最近成交价
            }
        """
        pass

    @abstractmethod
    async def scrape_item(self, market_hash_name: str) -> Optional[Dict]:
        """爬取单个物品"""
        pass
