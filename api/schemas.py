# -*- coding: utf-8 -*-
"""
API数据模型（Pydantic）
"""

from datetime import datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


# ========== 基础响应 ==========

class APIResponse(BaseModel):
    """统一API响应格式"""
    success: bool = True
    data: Any = None
    error: Optional[str] = None


# ========== 价格数据 ==========

class PriceData(BaseModel):
    """单个数据源的价格"""
    source: str
    ask: Optional[float] = Field(None, description="最低售价")
    ask_volume: Optional[int] = Field(None, description="在售数量")
    bid: Optional[float] = Field(None, description="最高求购价")
    bid_volume: Optional[int] = Field(None, description="求购数量")
    volume_24h: Optional[int] = Field(None, description="24h成交量")
    last_sale_price: Optional[float] = Field(None, description="最近成交价")
    recorded_at: Optional[datetime] = None


class ItemPrice(BaseModel):
    """物品价格（聚合多数据源）"""
    market_hash_name: str
    name_cn: Optional[str] = None
    prices: Dict[str, PriceData] = {}  # source -> price data
    updated_at: Optional[datetime] = None


class PriceLatestResponse(BaseModel):
    """最新价格响应"""
    success: bool = True
    data: List[ItemPrice] = []
    total: int = 0


# ========== K线数据 ==========

class OHLCData(BaseModel):
    """OHLC K线数据"""
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: Optional[int] = None


class OHLCResponse(BaseModel):
    """K线响应"""
    success: bool = True
    market_hash_name: str
    source: str
    interval: str  # 5m, 30m, 1h, 1d
    data: List[OHLCData] = []


# ========== 历史数据 ==========

class PriceHistoryPoint(BaseModel):
    """历史价格点"""
    timestamp: datetime
    ask: Optional[float] = None
    bid: Optional[float] = None
    volume: Optional[int] = None


class PriceHistoryResponse(BaseModel):
    """历史价格响应"""
    success: bool = True
    market_hash_name: str
    source: str
    data: List[PriceHistoryPoint] = []


# ========== 搜索 ==========

class SearchResult(BaseModel):
    """搜索结果"""
    market_hash_name: str
    name_cn: Optional[str] = None
    category: Optional[str] = None
    weapon: Optional[str] = None


class SearchResponse(BaseModel):
    """搜索响应"""
    success: bool = True
    query: str
    data: List[SearchResult] = []
    total: int = 0


# ========== 统计 ==========

class StatsResponse(BaseModel):
    """统计信息响应"""
    success: bool = True
    total_items: int = 0
    total_price_records: int = 0
    sources: List[str] = []
    last_update: Optional[datetime] = None
