# -*- coding: utf-8 -*-
"""
CS2 Price Hub - 数据库模型
"""

from datetime import datetime
from typing import Optional, List
from sqlalchemy import (
    Column, Integer, String, Float, DateTime, Index, Text,
    ForeignKey, UniqueConstraint, create_engine, select, func
)
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, relationship
import json

from config import settings


# ========== 数据库引擎 ==========
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DEBUG,
    future=True
)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


# ========== 数据模型 ==========

class Item(Base):
    """饰品基础信息表"""
    __tablename__ = "items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    market_hash_name = Column(String(255), unique=True, nullable=False, index=True)
    name_cn = Column(String(255))  # 中文名
    category = Column(String(50))  # 分类：knife, rifle, etc
    weapon = Column(String(50))  # 武器类型：AK-47, M4A4, etc
    skin_name = Column(String(100))  # 皮肤名称：Asiimov, Redline, etc
    exterior = Column(String(50))  # 磨损：Factory New, Field-Tested, etc
    rarity = Column(String(50))  # 稀有度：Covert, Classified, etc
    is_stattrak = Column(Integer, default=0)  # 是否暗金
    is_souvenir = Column(Integer, default=0)  # 是否纪念品

    # 变体信息（Doppler等）
    phase = Column(String(50))  # Phase 1, Phase 2, Ruby, Sapphire, etc

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # 关联
    prices = relationship("PriceRecord", back_populates="item")


class PriceRecord(Base):
    """价格记录表 - 存储每次采集的原始数据"""
    __tablename__ = "price_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    item_id = Column(Integer, ForeignKey("items.id"), nullable=False, index=True)
    market_hash_name = Column(String(255), nullable=False, index=True)

    # 数据来源
    source = Column(String(20), nullable=False)  # buff, steam, youpin, c5, csfloat, skinport

    # 价格数据（统一用人民币CNY）
    ask = Column(Float)  # 最低售价（卖一价）
    ask_volume = Column(Integer)  # 在售数量
    bid = Column(Float)  # 最高求购价（买一价）
    bid_volume = Column(Integer)  # 求购数量

    # 成交数据
    volume_24h = Column(Integer)  # 24小时成交量
    last_sale_price = Column(Float)  # 最近成交价

    # 时间戳
    recorded_at = Column(DateTime, default=datetime.utcnow, index=True)

    # 关联
    item = relationship("Item", back_populates="prices")

    __table_args__ = (
        Index("idx_price_source_time", "source", "recorded_at"),
        Index("idx_price_item_source", "item_id", "source"),
    )


class PriceOHLC(Base):
    """K线数据表 - 聚合的OHLC数据"""
    __tablename__ = "price_ohlc"

    id = Column(Integer, primary_key=True, autoincrement=True)
    market_hash_name = Column(String(255), nullable=False, index=True)
    source = Column(String(20), nullable=False)

    # 时间粒度：5m, 30m, 1h, 1d
    interval = Column(String(10), nullable=False)

    # OHLC数据
    open = Column(Float)
    high = Column(Float)
    low = Column(Float)
    close = Column(Float)
    volume = Column(Integer)

    # 时间段起始
    timestamp = Column(DateTime, nullable=False, index=True)

    __table_args__ = (
        UniqueConstraint("market_hash_name", "source", "interval", "timestamp",
                         name="uq_ohlc_item_source_interval_time"),
        Index("idx_ohlc_query", "market_hash_name", "source", "interval", "timestamp"),
    )


class ScrapeLog(Base):
    """爬取日志表"""
    __tablename__ = "scrape_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source = Column(String(20), nullable=False)
    status = Column(String(20))  # success, failed, partial
    items_count = Column(Integer, default=0)
    error_message = Column(Text)
    started_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime)
    duration_seconds = Column(Float)


# ========== 数据库操作函数 ==========

async def init_db():
    """初始化数据库"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("✅ 数据库初始化完成")


async def get_session() -> AsyncSession:
    """获取数据库会话"""
    async with async_session() as session:
        yield session


async def get_or_create_item(session: AsyncSession, market_hash_name: str, **kwargs) -> Item:
    """获取或创建饰品记录"""
    result = await session.execute(
        select(Item).where(Item.market_hash_name == market_hash_name)
    )
    item = result.scalar_one_or_none()

    if not item:
        item = Item(market_hash_name=market_hash_name, **kwargs)
        session.add(item)
        await session.commit()
        await session.refresh(item)

    return item


async def save_price_record(session: AsyncSession, market_hash_name: str, source: str, data: dict):
    """保存价格记录"""
    # 确保饰品存在
    item = await get_or_create_item(session, market_hash_name)

    record = PriceRecord(
        item_id=item.id,
        market_hash_name=market_hash_name,
        source=source,
        ask=data.get("ask"),
        ask_volume=data.get("ask_volume"),
        bid=data.get("bid"),
        bid_volume=data.get("bid_volume"),
        volume_24h=data.get("volume_24h"),
        last_sale_price=data.get("last_sale_price"),
    )
    session.add(record)
    await session.commit()
    return record


async def get_latest_prices(session: AsyncSession, market_hash_name: str = None, source: str = None):
    """获取最新价格"""
    # 子查询：获取每个item+source组合的最新记录ID
    subq = (
        select(
            PriceRecord.market_hash_name,
            PriceRecord.source,
            func.max(PriceRecord.id).label("max_id")
        )
        .group_by(PriceRecord.market_hash_name, PriceRecord.source)
    )

    if market_hash_name:
        subq = subq.where(PriceRecord.market_hash_name == market_hash_name)
    if source:
        subq = subq.where(PriceRecord.source == source)

    subq = subq.subquery()

    # 主查询
    query = (
        select(PriceRecord)
        .join(subq, PriceRecord.id == subq.c.max_id)
        .order_by(PriceRecord.market_hash_name)
    )

    result = await session.execute(query)
    return result.scalars().all()
