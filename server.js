/**
 * CS2 Price Hub - 完整服务 v2
 *
 * 功能:
 *   1. 定时爬取 Buff 商品列表（每5分钟）
 *   2. 爬取详情页：价格历史 + 成交记录（推算交易量）
 *   3. REST API
 *   4. 内置前端页面
 */

const { chromium } = require('playwright');
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ==================== 配置 ====================
const CONFIG = {
    SCRAPE_INTERVAL: 5 * 60 * 1000,   // 5分钟
    DETAIL_INTERVAL: 15 * 60 * 1000,  // 15分钟爬一批详情
    API_PORT: 3000,
    MAX_PAGES: 5,
    DETAIL_BATCH: 10,                  // 每批获取10个详情
    DATA_DIR: path.join(__dirname, 'data'),
    HISTORY_DIR: path.join(__dirname, 'data', 'history'),
    DB_FILE: path.join(__dirname, 'data', 'prices.json'),           // 完整数据（本地用）
    DB_LITE_FILE: path.join(__dirname, 'data', 'prices_lite.json'), // 精简版（推GitHub给Vercel用）
    HEADLESS: true,
    // 价格快照：保留最近7天推GitHub，完整历史存本地
    LITE_HISTORY_DAYS: 7,
};

// 确保目录
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.HISTORY_DIR)) fs.mkdirSync(CONFIG.HISTORY_DIR, { recursive: true });

// ==================== 数据库 ====================
class Database {
    constructor() { this.data = this._load(); }

    _load() {
        try {
            if (fs.existsSync(CONFIG.DB_FILE)) {
                const raw = JSON.parse(fs.readFileSync(CONFIG.DB_FILE, 'utf-8'));
                // 兼容旧格式
                if (!raw.meta) raw.meta = raw.stats || { totalScrapes: 0, lastUpdate: raw.lastUpdate || null };
                if (!raw.items) raw.items = {};
                return raw;
            }
        } catch (e) {}
        return { items: {}, meta: { totalScrapes: 0, lastUpdate: null } };
    }

    save() {
        this.data.meta.lastUpdate = new Date().toISOString();

        // 1. 保存完整数据（本地用，包含全部历史）
        fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');

        // 2. 保存精简版（推GitHub给Vercel，只含最近7天快照 + 最近100条成交）
        this._saveLite();

        // 3. 保存每日快照（用于长期对比）
        this._saveDailySnapshot();
    }

    _saveLite() {
        const cutoff = Date.now() - CONFIG.LITE_HISTORY_DAYS * 86400000;
        const lite = { items: {}, meta: { ...this.data.meta } };
        for (const [key, item] of Object.entries(this.data.items)) {
            lite.items[key] = {
                ...item,
                priceHistory: (item.priceHistory || []).filter(p => p.t > cutoff),
                transactions: (item.transactions || []).slice(-100),
                // 精简版不需要完整sell_order详情，只保留摘要
                sell_order_summary: item.sell_order_summary ? {
                    total: item.sell_order_summary.total,
                    price_range: item.sell_order_summary.price_range,
                    updated_at: item.sell_order_summary.updated_at,
                } : null,
            };
        }
        fs.writeFileSync(CONFIG.DB_LITE_FILE, JSON.stringify(lite, null, 2), 'utf-8');
    }

    _saveDailySnapshot() {
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const file = path.join(CONFIG.HISTORY_DIR, `${today}.json`);
        // 每天只生成一次快照（取当天最新价格）
        const snapshot = {};
        for (const [key, item] of Object.entries(this.data.items)) {
            snapshot[key] = {
                name: item.name,
                ask: item.prices?.buff?.ask,
                bid: item.prices?.buff?.bid,
                ask_volume: item.prices?.buff?.ask_volume,
                steam_price_cny: item.prices?.buff?.steam_price_cny,
                steam_price_usd: item.prices?.buff?.steam_price_usd,
                quick_price: item.prices?.buff?.quick_price,
                sell_reference_price: item.detail?.sell_reference_price || null,
                recent_sold_count: item.detail?.recent_sold_count || 0,
                volume_24h: this.getVolume24h(key),
                updated_at: item.prices?.buff?.updated_at,
            };
        }
        fs.writeFileSync(file, JSON.stringify({ date: today, snapshot }, null, 2), 'utf-8');
    }

    upsertFromList(raw) {
        const key = raw.market_hash_name;
        if (!key) return;
        if (!this.data.items[key]) {
            this.data.items[key] = {
                market_hash_name: key, name: raw.name,
                goods_id: raw.goods_id,
                prices: {}, priceHistory: [], transactions: [],
            };
        }
        const it = this.data.items[key];
        it.name = raw.name || it.name;
        it.short_name = raw.short_name || it.short_name || null;
        it.goods_id = raw.goods_id || it.goods_id;
        it.appid = raw.appid || it.appid || 730;
        it.icon_url = raw.icon_url || it.icon_url || null;
        it.transacted_num = raw.transacted_num || it.transacted_num || 0;
        if (!it.priceHistory) it.priceHistory = [];
        if (!it.transactions) it.transactions = [];
        if (!it.prices) it.prices = {};

        it.prices.buff = {
            ask: raw.sell_min_price,
            ask_volume: raw.sell_num,
            bid: raw.buy_max_price,
            bid_volume: raw.buy_num,
            steam_price_cny: raw.steam_price_cny,
            steam_price_usd: raw.steam_price_usd,
            quick_price: raw.quick_price,
            updated_at: new Date().toISOString(),
        };

        // 追加价格快照（用于自建K线），全量保留不截断
        it.priceHistory.push({
            t: Date.now(), p: raw.sell_min_price, v: raw.sell_num,
        });
    }

    // 写入从详情页获取的成交记录
    upsertTransactions(marketHashName, txList) {
        const it = this.data.items[marketHashName];
        if (!it) return;
        // txList: [{price, time, paintwear}, ...]
        // 去重（按时间+价格）
        const existing = new Set(it.transactions.map(t => `${t.time}_${t.price}`));
        for (const tx of txList) {
            const k = `${tx.time}_${tx.price}`;
            if (!existing.has(k)) {
                it.transactions.push(tx);
                existing.add(k);
            }
        }
        // 按时间排序，全量保留不截断
        it.transactions.sort((a, b) => a.time - b.time);
    }

    // 写入Buff价格历史
    upsertBuffHistory(marketHashName, history) {
        const it = this.data.items[marketHashName];
        if (!it) return;
        it.buffPriceHistory = history;  // [[timestamp, price], ...]
    }

    // 写入商品详情信息（来自 /goods/info 接口）
    upsertGoodsInfo(marketHashName, info) {
        const it = this.data.items[marketHashName];
        if (!it) return;
        it.detail = {
            recent_sold_count: info.recent_sold_count ?? it.detail?.recent_sold_count ?? 0,
            sell_reference_price: info.sell_reference_price ? parseFloat(info.sell_reference_price) : null,
            market_min_price: info.market_min_price ? parseFloat(info.market_min_price) : null,
            paintwear_range: info.paintwear_range || null,
            paintwear_choices: info.paintwear_choices || null,
            steam_market_url: info.steam_market_url || null,
            containers: info.containers || null,
            user_show_count: info.user_show_count ?? 0,
            has_buff_price_history: info.has_buff_price_history ?? false,
            updated_at: new Date().toISOString(),
        };
        // 也更新图标（详情页的更准确）
        if (info.goods_info?.original_icon_url || info.goods_info?.icon_url) {
            it.icon_url = info.goods_info.original_icon_url || info.goods_info.icon_url;
        }
        if (info.steam_market_url) it.steam_market_url = info.steam_market_url;
    }

    // 写入在售订单分布（来自 /sell_order 接口）
    upsertSellOrders(marketHashName, orders) {
        const it = this.data.items[marketHashName];
        if (!it) return;
        // 只存摘要：价格分布 + 前5个挂单详情
        it.sell_order_summary = {
            total: orders.length,
            price_range: orders.length > 0 ? {
                min: Math.min(...orders.map(o => o.price)),
                max: Math.max(...orders.map(o => o.price)),
                avg: +(orders.reduce((s, o) => s + o.price, 0) / orders.length).toFixed(2),
            } : null,
            top_listings: orders.slice(0, 5).map(o => ({
                price: o.price,
                paintwear: o.paintwear,
                stickers: o.stickers,
                tradable_cooldown: o.tradable_cooldown,
            })),
            updated_at: new Date().toISOString(),
        };
    }

    // ---- 查询方法 ----
    all()            { return Object.values(this.data.items); }
    get(name)        { return this.data.items[name]; }
    search(q) {
        const ql = q.toLowerCase();
        return this.all().filter(i =>
            i.market_hash_name?.toLowerCase().includes(ql) ||
            i.name?.toLowerCase().includes(ql)
        );
    }
    stats() {
        const items = this.all();
        return {
            totalItems: items.length,
            totalScrapes: this.data.meta.totalScrapes,
            lastUpdate: this.data.meta.lastUpdate,
            totalTransactions: items.reduce((s, i) => s + (i.transactions?.length || 0), 0),
        };
    }

    // 推算某个物品的24小时交易量
    getVolume24h(marketHashName) {
        const it = this.data.items[marketHashName];
        if (!it?.transactions?.length) return 0;
        const cutoff = Date.now() / 1000 - 86400;
        return it.transactions.filter(t => t.time > cutoff).length;
    }

    // 需要补充详情的物品（取最久没更新的）
    getItemsNeedingDetail(count) {
        return this.all()
            .filter(i => i.goods_id)
            .sort((a, b) => {
                const ta = a.prices?.buff?.detail_updated_at || '2000-01-01';
                const tb = b.prices?.buff?.detail_updated_at || '2000-01-01';
                return ta.localeCompare(tb);
            })
            .slice(0, count);
    }
}

const db = new Database();

// ==================== 浏览器工具 ====================
function findBrowser() {
    const ps = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    return ps.find(p => fs.existsSync(p)) || null;
}

async function launchBrowser() {
    return chromium.launch({
        headless: CONFIG.HEADLESS,
        executablePath: findBrowser(),
    });
}

// ==================== 爬虫：商品列表 ====================
async function scrapeList(browser) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    const items = [];

    page.on('response', async (res) => {
        if (!res.url().includes('/api/market/goods') || res.status() !== 200) return;
        if (res.url().includes('sell_order') || res.url().includes('price_history') || res.url().includes('bill_order')) return;
        try {
            const json = await res.json();
            if (json.code !== 'OK') return;
            for (const raw of (json.data?.items || [])) {
                items.push({
                    market_hash_name: raw.market_hash_name,
                    name: raw.name,
                    short_name: raw.short_name || null,
                    goods_id: raw.id,
                    appid: raw.appid || 730,
                    sell_min_price: parseFloat(raw.sell_min_price),
                    sell_num: raw.sell_num,
                    buy_max_price: raw.buy_max_price ? parseFloat(raw.buy_max_price) : null,
                    buy_num: raw.buy_num,
                    steam_price_cny: raw.goods_info?.steam_price_cny ? parseFloat(raw.goods_info.steam_price_cny) : null,
                    steam_price_usd: raw.goods_info?.steam_price ? parseFloat(raw.goods_info.steam_price) : null,
                    quick_price: raw.quick_price ? parseFloat(raw.quick_price) : null,
                    icon_url: raw.goods_info?.icon_url || raw.goods_info?.original_icon_url || null,
                    transacted_num: raw.transacted_num || 0,
                });
            }
        } catch {}
    });

    for (let p = 1; p <= CONFIG.MAX_PAGES; p++) {
        await page.goto(`https://buff.163.com/market/csgo#tab=selling&page_num=${p}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
    }

    await ctx.close();
    return items;
}

// ==================== 爬虫：详情页（商品信息+在售订单+成交记录+价格历史） ====================
async function scrapeDetail(browser, item) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' });
    const page = await ctx.newPage();

    const result = {
        transactions: [],
        priceHistory: [],
        goodsInfo: null,
        sellOrders: [],
    };

    page.on('response', async (res) => {
        const u = res.url();
        if (res.status() !== 200) return;

        try {
            // 商品详细信息 /goods/info
            if (u.includes('/goods/info') && !u.includes('sell_order') && !u.includes('buy_order')) {
                const json = await res.json();
                if (json.code === 'OK' && json.data) {
                    result.goodsInfo = json.data;
                }
                return;
            }

            // 在售订单 /sell_order
            if (u.includes('sell_order') && !u.includes('history') && !u.includes('create') && !u.includes('to_deliver')) {
                const json = await res.json();
                if (json.code === 'OK') {
                    for (const o of (json.data?.items || [])) {
                        result.sellOrders.push({
                            price: parseFloat(o.price),
                            paintwear: o.asset_info?.paintwear || null,
                            stickers: o.asset_info?.info?.stickers || null,
                            tradable_cooldown: o.tradable_cooldown || null,
                        });
                    }
                }
                return;
            }

            // 成交记录 /bill_order
            if (u.includes('bill_order')) {
                const json = await res.json();
                if (json.code === 'OK') {
                    for (const tx of (json.data?.items || [])) {
                        result.transactions.push({
                            price: parseFloat(tx.price),
                            time: tx.transact_time || tx.updated_at,
                            paintwear: tx.asset_info?.paintwear,
                        });
                    }
                }
                return;
            }

            // 价格历史 /price_history
            if (u.includes('price_history')) {
                const json = await res.json();
                if (json.code === 'OK' && json.data?.price_history) {
                    result.priceHistory = json.data.price_history;
                }
                return;
            }
        } catch {}
    });

    try {
        await page.goto(`https://buff.163.com/goods/${item.goods_id}?from=market#tab=selling`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await page.waitForTimeout(4000);

        // 尝试点击"成交记录"标签，触发 bill_order 接口
        try {
            const tabBtns = await page.$$('.tab-cont .tab-pane, .detail-tab li, [data-target]');
            for (const btn of tabBtns) {
                const text = await btn.textContent();
                if (text && text.includes('成交')) {
                    await btn.click();
                    await page.waitForTimeout(2000);
                    break;
                }
            }
        } catch {}

    } catch (e) {
        console.error(`   详情页错误 [${item.goods_id}]: ${e.message}`);
    }

    await ctx.close();
    return result;
}

// ==================== 爬虫调度 ====================
class Scraper {
    constructor() { this.running = false; this.browser = null; }

    async init() { this.browser = await launchBrowser(); }

    async runList() {
        if (this.running) return;
        this.running = true;
        const t0 = Date.now();
        console.log(`\n⏰ [${ts()}] 开始爬取商品列表...`);

        try {
            if (!this.browser) await this.init();
            const items = await scrapeList(this.browser);
            items.forEach(i => db.upsertFromList(i));
            db.data.meta.totalScrapes++;
            db.save();
            console.log(`✅ 列表完成: ${items.length} 个饰品, ${((Date.now()-t0)/1000).toFixed(1)}s`);
            gitPush();
        } catch (e) {
            console.error('❌ 列表爬取失败:', e.message);
            // 浏览器可能崩溃，重置
            try { await this.browser?.close(); } catch {}
            this.browser = null;
        }
        this.running = false;
    }

    async runDetails() {
        if (this.running) return;
        this.running = true;
        console.log(`\n🔍 [${ts()}] 开始爬取详情...`);

        try {
            if (!this.browser) await this.init();
            const targets = db.getItemsNeedingDetail(CONFIG.DETAIL_BATCH);

            for (const item of targets) {
                console.log(`   📜 ${item.name} (${item.goods_id})`);
                const detail = await scrapeDetail(this.browser, item);

                if (detail.goodsInfo) {
                    db.upsertGoodsInfo(item.market_hash_name, detail.goodsInfo);
                    console.log(`      商品信息: ✅ 近期成交${detail.goodsInfo.recent_sold_count || 0}件`);
                }
                if (detail.sellOrders.length > 0) {
                    db.upsertSellOrders(item.market_hash_name, detail.sellOrders);
                    console.log(`      在售订单: ${detail.sellOrders.length} 个`);
                }
                if (detail.transactions.length > 0) {
                    db.upsertTransactions(item.market_hash_name, detail.transactions);
                    console.log(`      成交记录: ${detail.transactions.length} 条`);
                }
                if (detail.priceHistory.length > 0) {
                    db.upsertBuffHistory(item.market_hash_name, detail.priceHistory);
                    console.log(`      价格历史: ${detail.priceHistory.length} 条`);
                }

                // 标记已更新
                if (db.data.items[item.market_hash_name]?.prices?.buff) {
                    db.data.items[item.market_hash_name].prices.buff.detail_updated_at = new Date().toISOString();
                }

                await sleep(2000);
            }

            db.save();
            console.log(`✅ 详情完成: ${targets.length} 个`);
            gitPush();
        } catch (e) {
            console.error('❌ 详情爬取失败:', e.message);
            try { await this.browser?.close(); } catch {}
            this.browser = null;
        }
        this.running = false;
    }

    async close() { if (this.browser) await this.browser.close(); }
}

const scraper = new Scraper();

// ==================== REST API ====================
function apiHandler(req, res) {
    const parsed = url.parse(req.url, true);
    const p = parsed.pathname;
    const q = parsed.query;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    // 静态前端
    if (p === '/' || p === '/index.html') return serveFrontend(res);

    // JSON API
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (p === '/api/prices/latest') {
        const limit = Math.min(parseInt(q.limit) || 100, 500);
        const offset = parseInt(q.offset) || 0;
        const source = q.source;
        let items = db.all();

        // 排序：按在售数量降序
        items.sort((a, b) => (b.prices?.buff?.ask_volume || 0) - (a.prices?.buff?.ask_volume || 0));
        items = items.slice(offset, offset + limit).map(enrichItem);

        return json(res, { success: true, data: items, total: db.all().length });
    }

    if (p === '/api/search') {
        const results = db.search(q.q || '').slice(0, 50).map(enrichItem);
        return json(res, { success: true, data: results, total: results.length });
    }

    if (p.startsWith('/api/item/')) {
        const name = decodeURIComponent(p.replace('/api/item/', ''));
        const item = db.get(name);
        if (!item) return json(res, { success: false, error: 'Not found' }, 404);
        return json(res, { success: true, data: enrichItem(item) });
    }

    if (p === '/api/stats') return json(res, { success: true, data: db.stats() });

    // 查询某天的历史快照
    if (p === '/api/history') {
        const date = q.date; // YYYY-MM-DD
        if (!date) {
            // 返回可用日期列表
            try {
                const files = fs.readdirSync(CONFIG.HISTORY_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
                return json(res, { success: true, data: files });
            } catch { return json(res, { success: true, data: [] }); }
        }
        const file = path.join(CONFIG.HISTORY_DIR, `${date}.json`);
        if (!fs.existsSync(file)) return json(res, { success: false, error: '该日期无数据' }, 404);
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return json(res, { success: true, data });
        } catch { return json(res, { success: false, error: '读取失败' }, 500); }
    }

    // 查询某个物品的完整价格历史
    if (p.startsWith('/api/history/item/')) {
        const name = decodeURIComponent(p.replace('/api/history/item/', ''));
        const item = db.get(name);
        if (!item) return json(res, { success: false, error: 'Not found' }, 404);
        return json(res, {
            success: true,
            data: {
                market_hash_name: item.market_hash_name,
                name: item.name,
                priceHistory: item.priceHistory || [],
                transactions: item.transactions || [],
                buffPriceHistory: item.buffPriceHistory || [],
            }
        });
    }

    if (p === '/api/scrape') {
        scraper.runList();
        return json(res, { success: true, message: '爬取已启动' });
    }

    if (p === '/api/scrape/details') {
        scraper.runDetails();
        return json(res, { success: true, message: '详情爬取已启动' });
    }

    json(res, { success: false, error: 'Not found' }, 404);
}

function enrichItem(item) {
    const buff = item.prices?.buff || {};
    return {
        ...item,
        volume_24h: db.getVolume24h(item.market_hash_name),
        transaction_count: item.transactions?.length || 0,
        // 便捷字段
        buff_steam_ratio: (buff.ask && buff.steam_price_cny && buff.steam_price_cny > 0)
            ? +(buff.ask / buff.steam_price_cny).toFixed(4) : null,
    };
}

function json(res, data, status = 200) {
    res.statusCode = status;
    res.end(JSON.stringify(data));
}

// ==================== 前端页面 ====================
function serveFrontend(res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const htmlPath = path.join(__dirname, 'frontend.html');
    if (fs.existsSync(htmlPath)) {
        res.end(fs.readFileSync(htmlPath, 'utf-8'));
    } else {
        res.end('<h1>frontend.html not found</h1>');
    }
}

// ==================== 启动 ====================
function ts() { return new Date().toLocaleTimeString('zh-CN'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 自动推送精简版数据到GitHub
function gitPush() {
    const cwd = __dirname;
    const run = (cmd, args) => new Promise((resolve) => {
        execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
            if (err) console.error(`   git ${args[0]} 失败:`, stderr.trim() || err.message);
            resolve(!err);
        });
    });

    (async () => {
        const ok1 = await run('git', ['add', 'data/prices_lite.json']);
        if (!ok1) return;
        const ok2 = await run('git', ['commit', '-m', `auto: update prices ${new Date().toLocaleString('zh-CN')}`]);
        if (!ok2) { console.log('   📌 数据无变化，跳过推送'); return; }
        const ok3 = await run('git', ['push', 'origin', 'master']);
        if (ok3) console.log('   🚀 数据已推送到GitHub');
    })();
}

async function main() {
    console.log('═'.repeat(55));
    console.log('  🚀 CS2 Price Hub v2');
    console.log('═'.repeat(55));

    const server = http.createServer(apiHandler);
    server.listen(CONFIG.API_PORT, () => {
        console.log(`  🌐 前端界面:  http://localhost:${CONFIG.API_PORT}`);
        console.log(`  📡 API:       http://localhost:${CONFIG.API_PORT}/api/prices/latest`);
        console.log(`  ⏰ 列表爬取:  每 ${CONFIG.SCRAPE_INTERVAL/60000} 分钟`);
        console.log(`  📜 详情爬取:  每 ${CONFIG.DETAIL_INTERVAL/60000} 分钟`);
        console.log('═'.repeat(55));
    });

    // 初次爬取
    await scraper.runList();

    // 定时：商品列表
    setInterval(() => scraper.runList(), CONFIG.SCRAPE_INTERVAL);
    // 定时：详情页（成交记录）
    setInterval(() => scraper.runDetails(), CONFIG.DETAIL_INTERVAL);

    process.on('SIGINT', async () => {
        console.log('\n👋 关闭中...');
        await scraper.close();
        server.close();
        db.save();
        process.exit(0);
    });
}

main().catch(console.error);
