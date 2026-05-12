# -*- coding: utf-8 -*-
"""
API路由
"""

from datetime import datetime, timedelta
from typing import Optional, List
from fastapi import APIRouter, Query, HTTPException, Depends
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import (
    get_session, Item, PriceRecord, PriceOHLC,
    get_latest_prices, async_session
)
from .schemas import (
    APIResponse, ItemPrice, PriceData, PriceLatestResponse,
    OHLCResponse, OHLCData, PriceHistoryResponse, PriceHistoryPoint,
    SearchResponse, SearchResult, StatsResponse
)

router = APIRouter()


# ========== 价格接口 ==========

@router.get("/prices/latest", response_model=PriceLatestResponse)
async def get_latest_prices_api(
    market_hash_name: Optional[str] = Query(None, description="物品名称（支持模糊匹配）"),
    source: Optional[str] = Query(None, description="数据源：buff, steam, youpin, c5game"),
    limit: int = Query(100, ge=1, le=1000, description="返回数量"),
    offset: int = Query(0, ge=0, description="偏移量"),
):
    """
    获取最新价格

    - 不带参数：返回所有物品的最新价格
    - market_hash_name: 筛选特定物品
    - source: 筛选特定数据源
    """
    async with async_session() as session:
        # 构建子查询：每个item+source的最新记录
        subq = (
            select(
                PriceRecord.market_hash_name,
                PriceRecord.source,
                func.max(PriceRecord.id).label("max_id")
            )
            .group_by(PriceRecord.market_hash_name, PriceRecord.source)
        )

        if market_hash_name:
            subq = subq.where(PriceRecord.market_hash_name.contains(market_hash_name))
        if source:
            subq = subq.where(PriceRecord.source == source)

        subq = subq.subquery()

        # 主查询
        query = (
            select(PriceRecord)
            .join(subq, PriceRecord.id == subq.c.max_id)
            .order_by(desc(PriceRecord.recorded_at))
            .offset(offset)
            .limit(limit)
        )

        result = await session.execute(query)
        records = result.scalars().all()

        # 聚合同一物品的多数据源价格
        items_dict = {}
        for record in records:
            name = record.market_hash_name
            if name not in items_dict:
                items_dict[name] = ItemPrice(
                    market_hash_name=name,
                    prices={},
                    updated_at=record.recorded_at
                )

            items_dict[name].prices[record.source] = PriceData(
                source=record.source,
                ask=record.ask,
                ask_volume=record.ask_volume,
                bid=record.bid,
                bid_volume=record.bid_volume,
                volume_24h=record.volume_24h,
                last_sale_price=record.last_sale_price,
                recorded_at=record.recorded_at
            )

        items = list(items_dict.values())

        return PriceLatestResponse(
            success=True,
            data=items,
            total=len(items)
        )


@router.get("/prices/{market_hash_name}", response_model=APIResponse)
async def get_item_price(
    market_hash_name: str,
    source: Optional[str] = Query(None, description="数据源"),
):
    """获取单个物品的最新价格"""
    async with async_session() as session:
        query = (
            select(PriceRecord)
            .where(PriceRecord.market_hash_name == market_hash_name)
        )

        if source:
            query = query.where(PriceRecord.source == source)

        # 获取每个source的最新记录
        subq = (
            select(
                PriceRecord.source,
                func.max(PriceRecord.id).label("max_id")
            )
            .where(PriceRecord.market_hash_name == market_hash_name)
            .group_by(PriceRecord.source)
        )

        if source:
            subq = subq.where(PriceRecord.source == source)

        subq = subq.subquery()

        query = (
            select(PriceRecord)
            .join(subq, PriceRecord.id == subq.c.max_id)
        )

        result = await session.execute(query)
        records = result.scalars().all()

        if not records:
            raise HTTPException(status_code=404, detail="Item not found")

        prices = {}
        for record in records:
            prices[record.source] = PriceData(
                source=record.source,
                ask=record.ask,
                ask_volume=record.ask_volume,
                bid=record.bid,
                bid_volume=record.bid_volume,
                volume_24h=record.volume_24h,
                last_sale_price=record.last_sale_price,
                recorded_at=record.recorded_at
            )

        item = ItemPrice(
            market_hash_name=market_hash_name,
            prices=prices,
            updated_at=max(r.recorded_at for r in records)
        )

        return APIResponse(success=True, data=item)


# ========== 历史价格 ==========

@router.get("/prices/{market_hash_name}/history", response_model=PriceHistoryResponse)
async def get_price_history(
    market_hash_name: str,
    source: str = Query("buff", description="数据源"),
    days: int = Query(30, ge=1, le=365, description="历史天数"),
):
    """获取历史价格"""
    async with async_session() as session:
        since = datetime.utcnow() - timedelta(days=days)

        query = (
            select(PriceRecord)
            .where(PriceRecord.market_hash_name == market_hash_name)
            .where(PriceRecord.source == source)
            .where(PriceRecord.recorded_at >= since)
            .order_by(PriceRecord.recorded_at)
        )

        result = await session.execute(query)
        records = result.scalars().all()

        data = [
            PriceHistoryPoint(
                timestamp=r.recorded_at,
                ask=r.ask,
                bid=r.bid,
                volume=r.volume_24h
            )
            for r in records
        ]

        return PriceHistoryResponse(
            success=True,
            market_hash_name=market_hash_name,
            source=source,
            data=data
        )


# ========== K线数据 ==========

@router.get("/prices/{market_hash_name}/ohlc", response_model=OHLCResponse)
async def get_ohlc(
    market_hash_name: str,
    source: str = Query("buff", description="数据源"),
    interval: str = Query("1d", description="时间间隔: 5m, 30m, 1h, 1d"),
    days: int = Query(30, ge=1, le=365, description="历史天数"),
):
    """
    获取K线数据（OHLC）

    - interval: 5m(5分钟), 30m(30分钟), 1h(1小时), 1d(1天)
    """
    if interval not in ["5m", "30m", "1h", "1d"]:
        raise HTTPException(status_code=400, detail="Invalid interval")

    async with async_session() as session:
        since = datetime.utcnow() - timedelta(days=days)

        query = (
            select(PriceOHLC)
            .where(PriceOHLC.market_hash_name == market_hash_name)
            .where(PriceOHLC.source == source)
            .where(PriceOHLC.interval == interval)
            .where(PriceOHLC.timestamp >= since)
            .order_by(PriceOHLC.timestamp)
        )

        result = await session.execute(query)
        records = result.scalars().all()

        data = [
            OHLCData(
                timestamp=r.timestamp,
                open=r.open,
                high=r.high,
                low=r.low,
                close=r.close,
                volume=r.volume
            )
            for r in records
        ]

        return OHLCResponse(
            success=True,
            market_hash_name=market_hash_name,
            source=source,
            interval=interval,
            data=data
        )


# ========== 搜索 ==========

@router.get("/search", response_model=SearchResponse)
async def search_items(
    q: str = Query(..., min_length=1, description="搜索关键词"),
    limit: int = Query(20, ge=1, le=100),
):
    """搜索物品"""
    async with async_session() as session:
        query = (
            select(Item)
            .where(
                (Item.market_hash_name.contains(q)) |
                (Item.name_cn.contains(q))
            )
            .limit(limit)
        )

        result = await session.execute(query)
        items = result.scalars().all()

        data = [
            SearchResult(
                market_hash_name=item.market_hash_name,
                name_cn=item.name_cn,
                category=item.category,
                weapon=item.weapon
            )
            for item in items
        ]

        return SearchResponse(
            success=True,
            query=q,
            data=data,
            total=len(data)
        )


# ========== 统计 ==========

@router.get("/stats", response_model=StatsResponse)
async def get_stats():
    """获取统计信息"""
    async with async_session() as session:
        # 物品总数
        item_count = await session.execute(select(func.count(Item.id)))
        total_items = item_count.scalar() or 0

        # 价格记录总数
        price_count = await session.execute(select(func.count(PriceRecord.id)))
        total_records = price_count.scalar() or 0

        # 数据源列表
        sources_result = await session.execute(
            select(PriceRecord.source).distinct()
        )
        sources = [r[0] for r in sources_result.all()]

        # 最后更新时间
        last_update_result = await session.execute(
            select(func.max(PriceRecord.recorded_at))
        )
        last_update = last_update_result.scalar()

        return StatsResponse(
            success=True,
            total_items=total_items,
            total_price_records=total_records,
            sources=sources,
            last_update=last_update
        )
