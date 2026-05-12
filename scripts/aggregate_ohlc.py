# -*- coding: utf-8 -*-
"""
K线数据聚合脚本

将原始价格数据聚合为OHLC K线数据
"""

import asyncio
from datetime import datetime, timedelta
from sqlalchemy import select, func, and_
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database import async_session, PriceRecord, PriceOHLC, init_db


# 时间间隔配置（分钟）
INTERVALS = {
    "5m": 5,
    "30m": 30,
    "1h": 60,
    "1d": 1440,
}


async def aggregate_ohlc(interval: str = "1d", days: int = 30):
    """
    聚合K线数据

    Args:
        interval: 时间间隔 (5m, 30m, 1h, 1d)
        days: 聚合多少天的数据
    """
    if interval not in INTERVALS:
        print(f"无效的时间间隔: {interval}")
        return

    minutes = INTERVALS[interval]
    since = datetime.utcnow() - timedelta(days=days)

    print(f"📊 聚合K线数据: 间隔={interval}, 天数={days}")

    async with async_session() as session:
        # 获取所有物品和数据源的组合
        combos = await session.execute(
            select(
                PriceRecord.market_hash_name,
                PriceRecord.source
            )
            .where(PriceRecord.recorded_at >= since)
            .distinct()
        )

        count = 0
        for market_hash_name, source in combos:
            # 获取该物品的所有价格记录
            records = await session.execute(
                select(PriceRecord)
                .where(PriceRecord.market_hash_name == market_hash_name)
                .where(PriceRecord.source == source)
                .where(PriceRecord.recorded_at >= since)
                .order_by(PriceRecord.recorded_at)
            )
            records = records.scalars().all()

            if not records:
                continue

            # 按时间段分组
            buckets = {}
            for record in records:
                if record.ask is None:
                    continue

                # 计算所属的时间桶
                ts = record.recorded_at
                bucket_start = ts.replace(
                    minute=(ts.minute // minutes) * minutes if minutes < 60 else 0,
                    second=0,
                    microsecond=0
                )
                if minutes >= 60:
                    bucket_start = bucket_start.replace(hour=(ts.hour // (minutes // 60)) * (minutes // 60))
                if minutes >= 1440:
                    bucket_start = bucket_start.replace(hour=0)

                if bucket_start not in buckets:
                    buckets[bucket_start] = []
                buckets[bucket_start].append(record)

            # 计算每个桶的OHLC
            for bucket_start, bucket_records in buckets.items():
                prices = [r.ask for r in bucket_records if r.ask]
                volumes = [r.volume_24h or 0 for r in bucket_records]

                if not prices:
                    continue

                ohlc = PriceOHLC(
                    market_hash_name=market_hash_name,
                    source=source,
                    interval=interval,
                    timestamp=bucket_start,
                    open=prices[0],
                    high=max(prices),
                    low=min(prices),
                    close=prices[-1],
                    volume=sum(volumes) if any(volumes) else None
                )

                # 使用upsert
                existing = await session.execute(
                    select(PriceOHLC)
                    .where(PriceOHLC.market_hash_name == market_hash_name)
                    .where(PriceOHLC.source == source)
                    .where(PriceOHLC.interval == interval)
                    .where(PriceOHLC.timestamp == bucket_start)
                )
                existing = existing.scalar_one_or_none()

                if existing:
                    existing.open = ohlc.open
                    existing.high = ohlc.high
                    existing.low = ohlc.low
                    existing.close = ohlc.close
                    existing.volume = ohlc.volume
                else:
                    session.add(ohlc)

                count += 1

        await session.commit()

    print(f"✅ 完成！共生成 {count} 条K线数据")


async def main():
    await init_db()

    # 聚合各个时间间隔的数据
    for interval in ["1d", "1h"]:
        await aggregate_ohlc(interval, days=30)


if __name__ == "__main__":
    asyncio.run(main())
