# -*- coding: utf-8 -*-
"""
CS2 Price Hub - 爬虫模块
"""

from .base import BaseScraper
from .steam import SteamScraper
from .buff import BuffScraper
from .youpin import YoupinScraper
from .c5game import C5GameScraper
from .manager import ScraperManager, manager

__all__ = [
    "BaseScraper",
    "SteamScraper",
    "BuffScraper",
    "YoupinScraper",
    "C5GameScraper",
    "ScraperManager",
    "manager",
]
