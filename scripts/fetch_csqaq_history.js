/**
 * CSQAQ 历史价格爬取 v5 — Playwright浏览器请求版
 *
 * 核心思路：Node.js和浏览器走不同的网络出口IP
 * 浏览器的IP和CSQAQ绑定的IP一致，所以让Playwright浏览器来发请求
 * 导航到 api.csqaq.com 域名，fetch就是同源请求，无CORS问题
 *
 * 使用方式：
 *   node scripts/fetch_csqaq_history.js
 *
 * 可选参数：
 *   --skip=N         跳过前N个
 *   --limit=N        只爬N个（测试用）
 *   --pages=N        排行榜爬N页（默认10）
 *   --headless       无头模式
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================
const CONFIG = {
    API_TOKEN: 'AAHPH1C7I7O8J6R4U074H4N1',
    PLATFORM: 1,
    PERIOD: 1095,
    RATE_LIMIT_MS: 1500,
    DATA_DIR: path.join(__dirname, '..', 'data'),
    DB_FILE: path.join(__dirname, '..', 'data', 'prices.json'),
    DB_LITE_FILE: path.join(__dirname, '..', 'data', 'prices_lite.json'),
    LITE_HISTORY_DAYS: 7,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
    const args = {};
    process.argv.slice(2).forEach(a => {
        const m = a.match(/^--(\w[\w-]*)(?:=(.*))?$/);
        if (m) args[m[1]] = m[2] !== undefined ? m[2] : true;
    });
    return args;
}

function findBrowser() {
    const ps = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    return ps.find(p => fs.existsSync(p)) || null;
}

// ==================== 数据库 ====================

function loadDatabase() {
    try {
        if (fs.existsSync(CONFIG.DB_FILE)) {
            const raw = JSON.parse(fs.readFileSync(CONFIG.DB_FILE, 'utf-8'));
            if (!raw.meta) raw.meta = raw.stats || { totalScrapes: 0, lastUpdate: null };
            if (!raw.items) raw.items = {};
            return raw;
        }
    } catch (e) { console.error('加载数据库失败:', e.message); }
    return { items: {}, meta: { totalScrapes: 0, lastUpdate: null } };
}

function saveDatabase(db) {
    db.meta.lastUpdate = new Date().toISOString();
    fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify(db, null, 2), 'utf-8');

    const cutoff = Date.now() - CONFIG.LITE_HISTORY_DAYS * 86400000;
    const lite = { items: {}, meta: { ...db.meta } };
    for (const [key, item] of Object.entries(db.items)) {
        lite.items[key] = {
            ...item,
            priceHistory: (item.priceHistory || []).filter(p => p.t > cutoff),
            transactions: (item.transactions || []).slice(-100),
            csqaqHistory: undefined,
            sell_order_summary: item.sell_order_summary ? {
                total: item.sell_order_summary.total,
                price_range: item.sell_order_summary.price_range,
                updated_at: item.sell_order_summary.updated_at,
            } : null,
        };
    }
    fs.writeFileSync(CONFIG.DB_LITE_FILE, JSON.stringify(lite, null, 2), 'utf-8');
}

function normalizeHistory(rawHistory) {
    if (!rawHistory || !Array.isArray(rawHistory)) return [];
    return rawHistory.map(point => {
        if (Array.isArray(point)) {
            const ts = point[0] > 1e12 ? point[0] : point[0] * 1000;
            return { date: new Date(ts).toISOString().slice(0, 10), price: parseFloat(point[1]) };
        }
        if (typeof point !== 'object' || point === null) return null;
        const date = point.time || point.date || point.x;
        const price = point.value || point.price || point.y;
        if (!date || price == null) return null;
        let dateStr;
        if (typeof date === 'number') {
            dateStr = new Date(date > 1e12 ? date : date * 1000).toISOString().slice(0, 10);
        } else {
            dateStr = String(date).slice(0, 10);
        }
        return { date: dateStr, price: parseFloat(price) };
    }).filter(Boolean);
}

function mergeHistory(db, key, sellHistory, buyHistory) {
    const item = db.items[key];
    if (!item) return 0;

    item.csqaqHistory = {
        sell: normalizeHistory(sellHistory),
        buy: normalizeHistory(buyHistory),
        source: 'csqaq',
        fetched_at: new Date().toISOString(),
    };

    if (!item.priceHistory) item.priceHistory = [];
    const existingDates = new Set(
        item.priceHistory.map(p => new Date(p.t).toISOString().slice(0, 10))
    );

    let added = 0;
    for (const point of normalizeHistory(sellHistory)) {
        if (!existingDates.has(point.date)) {
            item.priceHistory.push({ t: new Date(point.date).getTime(), p: point.price, v: null, src: 'csqaq' });
            existingDates.add(point.date);
            added++;
        }
    }
    item.priceHistory.sort((a, b) => a.t - b.t);
    return added;
}

// 解析chart返回的各种格式
function parseChartData(data) {
    if (!data) return null;

    // 格式1: 对象数组 [{time, value}, ...]
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && !Array.isArray(data[0])) {
        return data;
    }

    // 格式2: 二维数组 [[time, price], ...]
    if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
        return data;
    }

    // 格式3: CSQAQ实际格式 {timestamp:[...], main_data:[...], num_data:[...]}
    //   timestamp = 时间戳, main_data = 价格(单位:元), num_data = 在售数量
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        // 优先匹配CSQAQ的字段名
        if (data.timestamp && data.main_data &&
            Array.isArray(data.timestamp) && Array.isArray(data.main_data) &&
            data.timestamp.length === data.main_data.length) {
            return data.timestamp.map((t, i) => ({
                time: t,
                value: data.main_data[i],  // 已经是元，不需要转换
                volume: data.num_data ? data.num_data[i] : null,
            }));
        }

        // 通用平行数组
        const arrays = {};
        for (const [k, v] of Object.entries(data)) {
            if (Array.isArray(v) && v.length > 0) arrays[k] = v;
        }
        const keys = Object.keys(arrays);
        if (keys.length >= 2) {
            let timeKey = keys.find(k => /time|date|x|timestamp/i.test(k)) || keys[0];
            let valKey = keys.find(k => /main|value|price|y/i.test(k));
            if (!valKey) valKey = keys.find(k => k !== timeKey) || keys[1];
            if (timeKey === valKey) valKey = keys.find(k => k !== timeKey) || keys[1];

            const timeArr = arrays[timeKey];
            const valArr = arrays[valKey];
            if (timeArr && valArr && timeArr.length === valArr.length) {
                return timeArr.map((t, i) => ({ time: t, value: valArr[i] }));
            }
        }
    }

    // 格式4: 纯数字平铺 [time1, price1, time2, price2, ...]
    if (Array.isArray(data) && data.length >= 2 && typeof data[0] === 'number') {
        if (data.length % 2 === 0 && data[0] > 1e9) {
            const pairs = [];
            for (let i = 0; i < data.length; i += 2) {
                pairs.push({ time: data[i], value: data[i + 1] });
            }
            return pairs;
        }
    }

    return null;
}

// ==================== 主流程 ====================

async function main() {
    const args = parseArgs();
    const skipCount = parseInt(args.skip) || 0;
    const limitCount = parseInt(args.limit) || 0;
    const maxPages = parseInt(args.pages) || 10;
    const headless = args.headless === true;

    console.log('═══════════════════════════════════════════');
    console.log('   CSQAQ 历史价格爬取 v5 (浏览器IP)');
    console.log('═══════════════════════════════════════════');

    // 1. 加载数据库
    const db = loadDatabase();
    console.log(`\n📦 本地数据库: ${Object.keys(db.items).length}个饰品`);

    // 2. 启动浏览器
    const execPath = findBrowser();
    console.log(`🌐 浏览器: ${execPath ? path.basename(execPath) : 'Playwright默认'}`);

    const browser = await chromium.launch({ headless, executablePath: execPath });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // 3. 关键！导航到 api.csqaq.com，建立同源上下文
    //    这样后续fetch调用就是同源请求，不受CORS限制
    //    而且走浏览器的网络出口IP（和csqaq绑定的一致）
    console.log('📡 建立浏览器连接...');
    try {
        await page.goto('https://api.csqaq.com/', { waitUntil: 'commit', timeout: 10000 });
    } catch (e) {
        // api.csqaq.com 首页可能返回404/错误，没关系，只要建立了origin
    }
    await sleep(1000);
    console.log('✅ 浏览器就绪\n');

    // 封装：通过浏览器发API请求（同源，用浏览器IP）
    async function apiPost(endpoint, body) {
        return await page.evaluate(async ({ endpoint, body, token }) => {
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'ApiToken': token,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(body),
                });
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    return { code: res.status, msg: text.substring(0, 300), data: null };
                }
            } catch (e) {
                return { code: -1, msg: e.message, data: null };
            }
        }, { endpoint, body, token: CONFIG.API_TOKEN });
    }

    // 4. 测试连接
    console.log('🔌 测试API...');
    const testRes = await apiPost('/api/v1/info/get_rank_list', {
        page_index: 1, page_size: 1,
        filter: { "排序": ["价格_售价_降序"] },
        show_recently_price: false,
    });

    if (testRes.code === 200) {
        console.log('✅ API连接成功！浏览器IP匹配！\n');
    } else {
        console.error('❌ API失败:', testRes.msg || JSON.stringify(testRes).substring(0, 300));
        if (testRes.msg?.includes('IP')) {
            console.error('\n浏览器IP也不对？请确认csqaq.com的"自动获取"是在同一个浏览器操作的');
        }
        await browser.close();
        process.exit(1);
    }

    await sleep(CONFIG.RATE_LIMIT_MS);

    // 5. 获取排行榜
    console.log(`📋 获取排行榜（${maxPages}页 × 50个）...`);

    const cacheFile = path.join(CONFIG.DATA_DIR, 'csqaq_items.json');
    let csqaqItems = [];

    // 检查缓存
    if (fs.existsSync(cacheFile)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
            if (Date.now() - (cached.fetched_at || 0) < 86400000 && cached.items?.length > 0) {
                csqaqItems = cached.items;
                console.log(`   ✅ 使用缓存（${csqaqItems.length}个）`);
            }
        } catch(e) {}
    }

    if (csqaqItems.length === 0) {
        for (let pg = 1; pg <= maxPages; pg++) {
            const res = await apiPost('/api/v1/info/get_rank_list', {
                page_index: pg,
                page_size: 50,
                filter: { "排序": ["价格_售价_降序"] },
                show_recently_price: false,
            });

            if (res.code !== 200) {
                console.log(`   第${pg}页失败: ${res.msg?.substring(0, 100) || res.code}`);
                break;
            }

            const list = res.data?.data || res.data?.list || [];
            if (list.length === 0) { console.log(`   第${pg}页空`); break; }

            if (pg === 1) {
                console.log(`   🔍 示例: id=${list[0].id}, name="${list[0].name}"`);
            }

            csqaqItems.push(...list.map(item => ({
                id: item.id,
                name: item.name,
            })));

            console.log(`   📄 第${pg}页: ${list.length}个（累计${csqaqItems.length}）`);
            await sleep(CONFIG.RATE_LIMIT_MS);
        }

        if (csqaqItems.length > 0) {
            fs.writeFileSync(cacheFile, JSON.stringify({ fetched_at: Date.now(), items: csqaqItems }, null, 2), 'utf-8');
            console.log(`   💾 已缓存${csqaqItems.length}个`);
        }
    }

    if (csqaqItems.length === 0) {
        console.error('❌ 排行榜为空');
        await browser.close();
        process.exit(1);
    }

    // 6. 匹配本地数据库
    const nameToKey = new Map();
    for (const [key, item] of Object.entries(db.items)) {
        if (item.name) {
            nameToKey.set(item.name, key);
            const short = item.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
            if (!nameToKey.has(short)) nameToKey.set(short, key);
        }
    }

    const toFetch = [];
    const matched = new Set();

    for (const ci of csqaqItems) {
        const dbKey = nameToKey.get(ci.name);
        const short = ci.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
        const finalKey = dbKey || nameToKey.get(short);

        if (finalKey && !matched.has(finalKey)) {
            const existing = db.items[finalKey];
            if (existing?.csqaqHistory?.fetched_at) {
                const age = Date.now() - new Date(existing.csqaqHistory.fetched_at).getTime();
                if (age < 3 * 86400000) continue;
            }
            toFetch.push({ key: finalKey, name: ci.name, csqaqId: ci.id });
            matched.add(finalKey);
        }
    }

    console.log(`\n🔗 匹配: ${toFetch.length}个饰品`);

    let items = toFetch;
    if (skipCount > 0) { items = items.slice(skipCount); console.log(`⏭️  跳过${skipCount}`); }
    if (limitCount > 0) { items = items.slice(0, limitCount); console.log(`🔢 限制${limitCount}`); }

    if (items.length === 0) {
        console.log('\n✅ 无需爬取');
        await browser.close();
        return;
    }

    console.log(`\n🚀 开始（${items.length}个，约${Math.ceil(items.length * 5 / 60)}分钟）\n`);

    let success = 0, failed = 0;
    const startTime = Date.now();
    let chartDebugDone = false;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const idx = skipCount + i + 1;
        const total = skipCount + items.length;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const eta = i > 0 ? Math.round((elapsed / i) * (items.length - i)) : 0;

        process.stdout.write(`[${idx}/${total}] ${item.name} `);

        // 卖价历史
        const sellRes = await apiPost('/api/v1/info/chart', {
            good_id: item.csqaqId,
            key: 'sell_price',
            platform: CONFIG.PLATFORM,
            period: CONFIG.PERIOD,
            style: 'all_style',
        });

        // 调试第一次chart返回
        if (!chartDebugDone && sellRes.code === 200) {
            chartDebugDone = true;
            const dataStr = JSON.stringify(sellRes.data, null, 2);
            console.log(`\n   🔍 Chart data结构:\n${dataStr.substring(0, 1200)}`);
            if (sellRes.data && typeof sellRes.data === 'object' && !Array.isArray(sellRes.data)) {
                console.log(`   🔍 字段: ${Object.keys(sellRes.data).join(', ')}`);
                for (const [k, v] of Object.entries(sellRes.data)) {
                    const t = Array.isArray(v) ? `array[${v.length}] 首项=${JSON.stringify(v[0])}` : `${typeof v}=${JSON.stringify(v).substring(0, 50)}`;
                    console.log(`      ${k}: ${t}`);
                }
            }
            console.log('');
        }

        await sleep(CONFIG.RATE_LIMIT_MS);

        // 买价历史
        const buyRes = await apiPost('/api/v1/info/chart', {
            good_id: item.csqaqId,
            key: 'buy_price',
            platform: CONFIG.PLATFORM,
            period: CONFIG.PERIOD,
            style: 'all_style',
        });

        await sleep(CONFIG.RATE_LIMIT_MS);

        // 解析
        const sellParsed = sellRes.code === 200 ? parseChartData(sellRes.data) : null;
        const buyParsed = buyRes.code === 200 ? parseChartData(buyRes.data) : null;

        if (sellParsed || buyParsed) {
            const added = mergeHistory(db, item.key, sellParsed, buyParsed);
            const sc = normalizeHistory(sellParsed).length;
            const bc = normalizeHistory(buyParsed).length;
            console.log(`✅ 卖${sc}天 买${bc}天 +${added}条`);
            success++;
        } else {
            console.log(`❌`);
            failed++;
        }

        if ((i + 1) % 25 === 0) {
            console.log(`\n   💾 保存 ${i+1}/${items.length}\n`);
            saveDatabase(db);
        }
    }

    await browser.close();

    console.log('\n💾 保存...');
    saveDatabase(db);

    const totalTime = Math.round((Date.now() - startTime) / 1000);
    console.log('\n═══════════════════════════════════════════');
    console.log('   完成！');
    console.log('═══════════════════════════════════════════');
    console.log(`✅ ${success}  ❌ ${failed}`);
    console.log(`⏱️  ${Math.floor(totalTime/60)}分${totalTime%60}秒`);

    const withHistory = Object.values(db.items).filter(i => i.csqaqHistory?.sell?.length > 0);
    console.log(`📊 有历史: ${withHistory.length}个`);
    if (withHistory.length > 0) {
        const oldest = withHistory.reduce((min, i) => {
            const d = i.csqaqHistory.sell[0]?.date;
            return d && d < min ? d : min;
        }, '9999');
        console.log(`📅 最早: ${oldest}`);
    }
}

main().catch(err => { console.error('💥', err); process.exit(1); });
