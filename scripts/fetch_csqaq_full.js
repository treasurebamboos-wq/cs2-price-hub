/**
 * CSQAQ 全量数据爬取 v3 — 英文名二次匹配 + 自动建条目
 *
 * 策略：CSQAQ数据为主
 *   1. 排行榜爬取 → 中文名匹配DB
 *   2. 未匹配的 → 爬详情拿英文名(market_hash_name) → 二次匹配DB
 *   3. 仍未匹配 → 以CSQAQ数据创建新DB条目
 *   4. 自动过滤纪念品/印花等非交易皮肤
 *   5. 双IP自动切换
 *
 * 用法:
 *   node scripts/fetch_csqaq_full.js                  # 默认full模式
 *   node scripts/fetch_csqaq_full.js --mode=rank      # 只爬排行榜
 *   node scripts/fetch_csqaq_full.js --mode=full      # 排行榜+详情+存世量
 *   node scripts/fetch_csqaq_full.js --pages=200      # 排行榜页数(默认200)
 *   node scripts/fetch_csqaq_full.js --limit=500      # 限制详情爬取数量
 *   node scripts/fetch_csqaq_full.js --time=60        # 最长运行N分钟后自动停
 *   node scripts/fetch_csqaq_full.js --skip-matched   # 跳过已有csqaq详情的
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CONFIG = {
    API_TOKEN: 'AAHPH1C7I7O8J6R4U074H4N1',
    RATE_LIMIT_MS: 1500,
    IP_RETRY_MAX: 20,
    IP_RETRY_DELAY_MS: 3000,
    DATA_DIR: path.join(__dirname, '..', 'data'),
    DB_FILE: path.join(__dirname, '..', 'data', 'prices.json'),
    RANK_CACHE: path.join(__dirname, '..', 'data', 'csqaq_rank_cache.json'),
};

// 过滤掉的品类关键词（不爬这些）
const SKIP_KEYWORDS = ['（纪念品）', '纪念品 |', '印花 |', '胶囊 |', '音乐盒 |'];

// ==================== Chart 数据解析 ====================
function parseChartData(data) {
    if (!data) return null;
    // 格式1: 对象数组 [{time, value}, ...]
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && !Array.isArray(data[0])) return data;
    // 格式2: 二维数组 [[time, price], ...]
    if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) return data;
    // 格式3: CSQAQ实际格式 {timestamp:[...], main_data:[...], num_data:[...]}
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        if (data.timestamp && data.main_data &&
            Array.isArray(data.timestamp) && Array.isArray(data.main_data) &&
            data.timestamp.length === data.main_data.length) {
            return data.timestamp.map((t, i) => ({
                time: t, value: data.main_data[i],
                volume: data.num_data ? data.num_data[i] : null,
            }));
        }
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
            const timeArr = arrays[timeKey], valArr = arrays[valKey];
            if (timeArr && valArr && timeArr.length === valArr.length) {
                return timeArr.map((t, i) => ({ time: t, value: valArr[i] }));
            }
        }
    }
    // 格式4: 纯数字平铺
    if (Array.isArray(data) && data.length >= 2 && typeof data[0] === 'number') {
        if (data.length % 2 === 0 && data[0] > 1e9) {
            const pairs = [];
            for (let i = 0; i < data.length; i += 2) pairs.push({ time: data[i], value: data[i + 1] });
            return pairs;
        }
    }
    return null;
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
    return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    ].find(p => fs.existsSync(p)) || null;
}
function isIpError(res) {
    return res?.msg?.includes('IP') && res.msg.includes('不符');
}
function shouldSkip(name) {
    return SKIP_KEYWORDS.some(kw => name.includes(kw));
}

// ==================== 数据库 ====================
function loadDB() {
    try {
        if (fs.existsSync(CONFIG.DB_FILE)) {
            const raw = JSON.parse(fs.readFileSync(CONFIG.DB_FILE, 'utf-8'));
            if (!raw.items) raw.items = {};
            if (!raw.meta) raw.meta = { totalScrapes: 0, lastUpdate: null };
            return raw;
        }
    } catch (e) { console.error('加载DB失败:', e.message); }
    return { items: {}, meta: { totalScrapes: 0, lastUpdate: null } };
}

function saveDB(db) {
    db.meta.lastUpdate = new Date().toISOString();
    fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
    // Lite version
    const cutoff = Date.now() - 7 * 86400000;
    const lite = { items: {}, meta: { ...db.meta } };
    for (const [key, item] of Object.entries(db.items)) {
        lite.items[key] = {
            ...item,
            priceHistory: (item.priceHistory || []).filter(p => p.t > cutoff),
            transactions: (item.transactions || []).slice(-100),
            csqaqHistory: undefined,
        };
    }
    fs.writeFileSync(CONFIG.DB_FILE.replace('prices.json', 'prices_lite.json'), JSON.stringify(lite, null, 2), 'utf-8');
}

// ==================== 名称匹配 ====================
function buildNameMaps(db) {
    const cnMap = new Map();  // 中文名 → DB key
    const enMap = new Map();  // 英文名(key) → DB key

    for (const [key, item] of Object.entries(db.items)) {
        // 英文名就是key本身
        enMap.set(key, key);
        enMap.set(key.toLowerCase(), key);

        // 中文名
        if (item.name) {
            cnMap.set(item.name, key);
            // 去掉磨损后缀再存一份
            const short = item.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
            if (!cnMap.has(short)) cnMap.set(short, key);
        }
    }
    return { cnMap, enMap };
}

function matchByChinese(cnMap, csqaqName) {
    let key = cnMap.get(csqaqName);
    if (!key) {
        const short = csqaqName.replace(/\s*\([^)]*\)\s*$/, '').trim();
        key = cnMap.get(short);
    }
    return key || null;
}

function matchByEnglish(enMap, marketHashName) {
    if (!marketHashName) return null;
    return enMap.get(marketHashName) || enMap.get(marketHashName.toLowerCase()) || null;
}

// ==================== 主流程 ====================
async function main() {
    const args = parseArgs();
    const mode = args.mode || 'full';
    const limitCount = parseInt(args.limit) || 0;
    const maxPages = parseInt(args.pages) || 200;
    const timeLimit = parseInt(args.time) || 0; // 分钟
    const skipMatched = args['skip-matched'] === true;
    const startTime = Date.now();
    const deadline = timeLimit > 0 ? startTime + timeLimit * 60000 : Infinity;

    console.log('═══════════════════════════════════════════');
    console.log('   CSQAQ 全量数据爬取 v3');
    console.log('   英文名二次匹配 + 自动建条目');
    console.log(`   模式: ${mode} | 排行榜: ${maxPages}页`);
    if (timeLimit) console.log(`   时间限制: ${timeLimit}分钟`);
    if (skipMatched) console.log('   跳过已有详情的饰品');
    console.log('═══════════════════════════════════════════\n');

    const db = loadDB();
    const { cnMap, enMap } = buildNameMaps(db);
    console.log(`📦 本地DB: ${Object.keys(db.items).length}个饰品\n`);

    // 启动浏览器
    const browser = await chromium.launch({ headless: false, executablePath: findBrowser() });
    const page = await (await browser.newContext()).newPage();
    try { await page.goto('https://api.csqaq.com/', { waitUntil: 'commit', timeout: 10000 }); } catch(e) {}
    await sleep(1000);

    let ipStats = { success: 0, ipRetries: 0 };

    // ==================== API调用(带IP重试) ====================
    async function apiCall(method, endpoint, body) {
        for (let attempt = 0; attempt <= CONFIG.IP_RETRY_MAX; attempt++) {
            const res = await page.evaluate(async ({ method, endpoint, body, token }) => {
                try {
                    const opts = { method, headers: { 'ApiToken': token } };
                    if (method === 'POST') {
                        opts.headers['Content-Type'] = 'application/json';
                        opts.body = JSON.stringify(body);
                    }
                    const res = await fetch(endpoint, opts);
                    return JSON.parse(await res.text());
                } catch (e) { return { code: -1, msg: e.message }; }
            }, { method, endpoint, body, token: CONFIG.API_TOKEN });

            if (!isIpError(res)) { ipStats.success++; return res; }
            ipStats.ipRetries++;
            if (attempt < CONFIG.IP_RETRY_MAX) {
                if (attempt === 0) process.stdout.write(`🔄IP`);
                else process.stdout.write(`.`);
                try { await page.goto('https://api.csqaq.com/', { waitUntil: 'commit', timeout: 5000 }); } catch(e) {}
                await sleep(CONFIG.IP_RETRY_DELAY_MS);
            } else {
                console.log(` ❌IP耗尽`);
                return res;
            }
        }
    }
    const apiPost = (ep, body) => apiCall('POST', ep, body);
    const apiGet = (ep) => apiCall('GET', ep, null);

    function isTimeUp() {
        if (Date.now() >= deadline) {
            console.log(`\n⏰ 已到${timeLimit}分钟时间限制，保存并退出`);
            return true;
        }
        return false;
    }

    // ==================== 测试连接 ====================
    console.log('🔌 测试API...');
    const testRes = await apiPost('/api/v1/info/get_rank_list', {
        page_index: 1, page_size: 1,
        filter: { "排序": ["价格_售价_降序"] }, show_recently_price: false,
    });
    if (testRes.code !== 200) {
        console.error('❌ API失败:', testRes.msg || JSON.stringify(testRes).substring(0, 300));
        await browser.close(); process.exit(1);
    }
    console.log('✅ API连接成功\n');
    await sleep(CONFIG.RATE_LIMIT_MS);

    // ==================== Phase 1: 排行榜 ====================
    console.log(`📋 Phase 1: 排行榜...`);
    let allRankItems = [];

    // 检查缓存(1小时内有效)
    if (fs.existsSync(CONFIG.RANK_CACHE)) {
        try {
            const cached = JSON.parse(fs.readFileSync(CONFIG.RANK_CACHE, 'utf-8'));
            if (Date.now() - (cached.fetched_at || 0) < 3600000 && cached.items?.length > 0) {
                allRankItems = cached.items;
                console.log(`   ✅ 使用缓存 (${allRankItems.length}个, ${Math.round((Date.now() - cached.fetched_at) / 60000)}分钟前)`);
            }
        } catch(e) {}
    }

    if (allRankItems.length === 0) {
        for (let pg = 1; pg <= maxPages; pg++) {
            const res = await apiPost('/api/v1/info/get_rank_list', {
                page_index: pg, page_size: 50,
                filter: { "排序": ["价格_售价_降序"] }, show_recently_price: true,
            });
            if (res.code !== 200 || !(res.data?.data?.length)) {
                if (res.code !== 200) console.log(`   ❌ 第${pg}页:`, res.msg?.substring(0, 100));
                else console.log(`   📄 第${pg}页: 空，排行榜结束`);
                break;
            }
            allRankItems.push(...res.data.data);
            if (pg % 10 === 0) console.log(`   📄 第${pg}页 (累计${allRankItems.length})`);
            await sleep(CONFIG.RATE_LIMIT_MS);
            if (isTimeUp()) break;
        }
        // 保存缓存
        if (allRankItems.length > 0) {
            fs.writeFileSync(CONFIG.RANK_CACHE, JSON.stringify({
                fetched_at: Date.now(), items: allRankItems,
            }), 'utf-8');
            console.log(`   💾 缓存已保存 (${allRankItems.length}个)`);
        }
    }

    // 过滤非交易品
    const filtered = allRankItems.filter(ri => !shouldSkip(ri.name));
    const skipped = allRankItems.length - filtered.length;
    console.log(`   📊 总计${allRankItems.length} → 过滤纪念品/印花等${skipped}个 → 有效${filtered.length}个`);

    // ==================== 分类：已匹配 vs 未匹配 ====================
    const cnMatched = [];     // 中文名匹配到DB的
    const unmatched = [];     // 没匹配到的（需要二次匹配）
    const processedKeys = new Set();

    for (const ri of filtered) {
        const dbKey = matchByChinese(cnMap, ri.name);
        if (dbKey && !processedKeys.has(dbKey)) {
            processedKeys.add(dbKey);
            cnMatched.push({ key: dbKey, csqaqId: ri.id, name: ri.name, rankData: ri });
        } else if (!dbKey) {
            unmatched.push({ csqaqId: ri.id, name: ri.name, rankData: ri });
        }
    }
    console.log(`\n   🔗 中文名匹配: ${cnMatched.length}个`);
    console.log(`   ❓ 未匹配(待英文名二次匹配): ${unmatched.length}个\n`);

    // 合并排行榜数据到已匹配的
    for (const m of cnMatched) {
        const item = db.items[m.key];
        if (!item.csqaq) item.csqaq = {};
        item.csqaq.id = m.csqaqId;
        item.csqaq.rank = buildRankData(m.rankData);
        item.csqaq.rank_at = new Date().toISOString();
    }
    saveDB(db);

    if (mode === 'rank') {
        await browser.close();
        printSummary({ cnMatched: cnMatched.length, enMatched: 0, newCreated: 0, detailOk: 0, detailFail: 0, statsOk: 0, histOk: 0, histFail: 0, ipStats, startTime });
        return;
    }

    let enMatchCount = 0, newCreated = 0, detailOk = 0, detailFail = 0;
    let statsOk = 0;

    // history模式：跳过Phase 2/3，直接爬价格历史
    if (mode === 'history') {
        console.log('⏭️  history模式，跳过Phase 2/3，直接爬价格历史...\n');
    } else {

    // ==================== Phase 2: 详情爬取 ====================
    // 策略：先处理未匹配的（用英文名二次匹配+建新条目），再更新已匹配的
    let itemsToDetail = [...unmatched]; // 先处理未匹配的

    // 已匹配的如果需要更新详情，也加进来
    const matchedNeedDetail = skipMatched
        ? cnMatched.filter(m => !db.items[m.key]?.csqaq?.detail_at)
        : cnMatched;
    // 未匹配的优先，已匹配的排后面
    const allDetailItems = [...itemsToDetail.map(u => ({ ...u, isUnmatched: true })),
                            ...matchedNeedDetail.map(m => ({ ...m, isUnmatched: false }))];

    let detailList = allDetailItems;
    if (limitCount > 0) detailList = detailList.slice(0, limitCount);

    console.log(`🔍 Phase 2: 详情 (${detailList.length}个: ${Math.min(unmatched.length, limitCount || Infinity)}个未匹配 + ${detailList.length - Math.min(unmatched.length, limitCount || Infinity)}个已匹配)...`);
    console.log(`   预计 ~${Math.ceil(detailList.length * 2 / 60)}分钟\n`);

    const newItemKeys = []; // 新建的DB条目，Phase 3需要

    for (let i = 0; i < detailList.length; i++) {
        if (isTimeUp()) break;

        const di = detailList[i];
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const eta = i > 0 ? Math.round((elapsed / i) * (detailList.length - i)) : 0;
        const tag = di.isUnmatched ? '🆕' : '📝';
        process.stdout.write(`   ${tag} [${i + 1}/${detailList.length}] ${di.name.substring(0, 30)}... `);

        const res = await apiGet(`/api/v1/info/good?id=${di.csqaqId}`);
        if (res.code === 200 && res.data) {
            const gi = res.data.goods_info || {};
            let dbKey = di.key; // 已匹配的已有key

            if (di.isUnmatched) {
                // 二次匹配：用英文名
                const mhn = gi.market_hash_name;
                const engKey = matchByEnglish(enMap, mhn);

                if (engKey && !processedKeys.has(engKey)) {
                    // 英文名匹配成功！
                    dbKey = engKey;
                    processedKeys.add(engKey);
                    enMatchCount++;
                    process.stdout.write(`✅英文匹配 `);
                } else if (mhn && !processedKeys.has(mhn)) {
                    // 完全新饰品 → 创建DB条目
                    dbKey = mhn;
                    db.items[mhn] = {
                        name: di.name,
                        icon_url: gi.img || null,
                        goods_id: gi.buff_id || null,
                        prices: { buff: {
                            ask: gi.buff_sell_price || null,
                            bid: gi.buff_buy_price || null,
                            ask_volume: gi.buff_sell_num || 0,
                            bid_volume: gi.buff_buy_num || 0,
                            steam_price_cny: gi.steam_sell_price || null,
                        }},
                        priceHistory: [],
                        transactions: [],
                    };
                    // 更新匹配表
                    enMap.set(mhn, mhn);
                    enMap.set(mhn.toLowerCase(), mhn);
                    if (di.name) { cnMap.set(di.name, mhn); }
                    processedKeys.add(mhn);
                    newCreated++;
                    newItemKeys.push(mhn);
                    process.stdout.write(`🆕新建 `);
                } else {
                    // 重复或无英文名
                    console.log(`⏭️ 跳过(重复或无名)`);
                    detailFail++;
                    await sleep(CONFIG.RATE_LIMIT_MS);
                    continue;
                }
            }

            // 写入CSQAQ数据
            const item = db.items[dbKey];
            if (!item) { detailFail++; await sleep(CONFIG.RATE_LIMIT_MS); continue; }
            if (!item.csqaq) item.csqaq = {};
            item.csqaq.id = di.csqaqId;
            if (!item.csqaq.rank) item.csqaq.rank = buildRankData(di.rankData);
            item.csqaq.detail = buildDetailData(gi);
            if (res.data.container?.length > 0) {
                item.csqaq.container = res.data.container.map(c => ({
                    name: c.name, price: c.price, roi: c.roi, comment: c.comment, img: c.url,
                }));
            }
            if (res.data.button_list?.length > 0) item.csqaq.wearButtons = res.data.button_list;
            if (res.data.statistic_list?.length > 0) {
                item.csqaq.statisticList = res.data.statistic_list.map(s => ({
                    name: s.name, statistic: s.statistic, exterior: s.exterior_localized_name, quality: s.quality_localized_name,
                }));
            }
            if (res.data.dpl?.length > 0) item.csqaq.doppler = res.data.dpl;
            item.csqaq.rank_at = item.csqaq.rank_at || new Date().toISOString();
            item.csqaq.detail_at = new Date().toISOString();

            console.log(`✅ ETA:${Math.round(eta / 60)}m`);
            detailOk++;
        } else {
            console.log(`❌ ${res.code} ${(res.msg||'').substring(0, 50)}`);
            detailFail++;
        }
        await sleep(CONFIG.RATE_LIMIT_MS);

        if ((i + 1) % 25 === 0) {
            const elapsed2 = Math.round((Date.now() - startTime) / 60);
            console.log(`   💾 保存 (${i + 1}/${detailList.length}) | 新匹配:${enMatchCount} 新建:${newCreated} | IP重试:${ipStats.ipRetries} | ${elapsed2}分钟`);
            saveDB(db);
        }
    }
    console.log(`\n   Phase 2 完成: ✅${detailOk} ❌${detailFail} | 英文匹配:${enMatchCount} 新建:${newCreated}\n`);
    saveDB(db);

    if (mode === 'detail') {
        await browser.close();
        printSummary({ cnMatched: cnMatched.length, enMatched: enMatchCount, newCreated, detailOk, detailFail, statsOk: 0, histOk: 0, histFail: 0, ipStats, startTime });
        return;
    }

    // ==================== Phase 3: 存世量 ====================
    // 对所有有csqaq.id但没有existence的饰品爬存世量
    const needExistence = [];
    for (const [key, item] of Object.entries(db.items)) {
        if (item.csqaq?.id && (!item.csqaq.existence || !item.csqaq.existence_at)) {
            needExistence.push({ key, csqaqId: item.csqaq.id, name: item.name || key });
        }
    }

    console.log(`📊 Phase 3: 存世量 (${needExistence.length}个需要)...`);
    statsOk = 0;

    for (let i = 0; i < needExistence.length; i++) {
        if (isTimeUp()) break;
        const { key, csqaqId, name } = needExistence[i];
        process.stdout.write(`   [${i + 1}/${needExistence.length}] `);

        const res = await apiGet(`/api/v1/info/good/statistic?id=${csqaqId}`);
        if (res.code === 200 && Array.isArray(res.data)) {
            db.items[key].csqaq.existence = res.data.map(d => ({
                count: d.statistic, date: d.created_at?.substring(0, 10),
            }));
            db.items[key].csqaq.existence_at = new Date().toISOString();
            console.log(`✅ ${res.data.length}天`);
            statsOk++;
        } else {
            console.log(`❌`);
        }
        await sleep(CONFIG.RATE_LIMIT_MS);
        if ((i + 1) % 25 === 0) {
            console.log(`   💾 保存... (${i + 1}/${needExistence.length})`);
            saveDB(db);
        }
    }
    console.log(`   存世量: ✅${statsOk}\n`);
    saveDB(db);

    } // end of mode !== 'history' else block

    // ==================== Phase 4: 价格历史曲线 ====================
    // 对所有有csqaq.id但缺少csqaqHistory（或数据太旧）的饰品爬 chart API
    const needHistory = [];
    for (const [key, item] of Object.entries(db.items)) {
        if (!item.csqaq?.id) continue;
        const ch = item.csqaqHistory;
        if (ch?.sell?.length > 0 && ch.fetched_at) {
            const age = Date.now() - new Date(ch.fetched_at).getTime();
            if (age < 3 * 86400000) continue; // 3天内的跳过
        }
        needHistory.push({ key, csqaqId: item.csqaq.id, name: item.name || key });
    }

    // history模式下limit也生效
    let historyList = needHistory;
    if (mode === 'history' && limitCount > 0) historyList = historyList.slice(0, limitCount);

    console.log(`📈 Phase 4: 价格历史 (${historyList.length}个需要${needHistory.length > historyList.length ? ', 总共' + needHistory.length + '个' : ''})...`);
    if (historyList.length > 0) console.log(`   预计 ~${Math.ceil(historyList.length * 4 / 60)}分钟\n`);

    let histOk = 0, histFail = 0;
    let chartDebugDone = false;

    for (let i = 0; i < historyList.length; i++) {
        if (isTimeUp()) break;
        const { key, csqaqId, name } = needHistory[i];
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const eta = i > 0 ? Math.round((elapsed / i) * (historyList.length - i)) : 0;
        process.stdout.write(`   [${i + 1}/${historyList.length}] ${name.substring(0, 30)}... `);

        // 卖价历史
        const sellRes = await apiPost('/api/v1/info/chart', {
            good_id: csqaqId, key: 'sell_price',
            platform: 1, period: 1095, style: 'all_style',
        });

        // 调试第一次chart返回
        if (!chartDebugDone && sellRes.code === 200 && sellRes.data) {
            chartDebugDone = true;
            const keys = typeof sellRes.data === 'object' && !Array.isArray(sellRes.data) ? Object.keys(sellRes.data) : [];
            console.log(`\n   🔍 Chart字段: ${keys.join(', ')}`);
            for (const k of keys) {
                const v = sellRes.data[k];
                if (Array.isArray(v)) console.log(`      ${k}: array[${v.length}]`);
            }
            console.log('');
            process.stdout.write(`   [${i + 1}/${needHistory.length}] ${name.substring(0, 30)}... `);
        }

        await sleep(CONFIG.RATE_LIMIT_MS);

        // 买价历史
        const buyRes = await apiPost('/api/v1/info/chart', {
            good_id: csqaqId, key: 'buy_price',
            platform: 1, period: 1095, style: 'all_style',
        });
        await sleep(CONFIG.RATE_LIMIT_MS);

        // 解析并存储
        const sellParsed = sellRes.code === 200 ? parseChartData(sellRes.data) : null;
        const buyParsed = buyRes.code === 200 ? parseChartData(buyRes.data) : null;

        if (sellParsed || buyParsed) {
            const sellNorm = normalizeHistory(sellParsed);
            const buyNorm = normalizeHistory(buyParsed);
            db.items[key].csqaqHistory = {
                sell: sellNorm, buy: buyNorm,
                source: 'csqaq', fetched_at: new Date().toISOString(),
            };
            console.log(`✅ 卖${sellNorm.length}天 买${buyNorm.length}天 ETA:${Math.round(eta / 60)}m`);
            histOk++;
        } else {
            console.log(`❌ sell:${sellRes.code} buy:${buyRes.code}`);
            histFail++;
        }

        if ((i + 1) % 25 === 0) {
            console.log(`   💾 保存... (${i + 1}/${historyList.length})`);
            saveDB(db);
        }
    }
    console.log(`\n   Phase 4: ✅${histOk} ❌${histFail}\n`);

    await browser.close();
    saveDB(db);
    printSummary({ cnMatched: cnMatched.length, enMatched: enMatchCount, newCreated, detailOk, detailFail, statsOk, histOk, histFail, ipStats, startTime });
}

// ==================== 工具函数 ====================
function buildRankData(ri) {
    return {
        buff_sell_price: ri.buff_sell_price, buff_buy_price: ri.buff_buy_price,
        buff_sell_num: ri.buff_sell_num, buff_buy_num: ri.buff_buy_num,
        yyyp_sell_price: ri.yyyp_sell_price, yyyp_buy_price: ri.yyyp_buy_price,
        yyyp_sell_num: ri.yyyp_sell_num, yyyp_buy_num: ri.yyyp_buy_num,
        yyyp_lease_price: ri.yyyp_lease_price, yyyp_long_lease_price: ri.yyyp_long_lease_price,
        steam_sell_price: ri.steam_sell_price, steam_buy_price: ri.steam_buy_price,
        steam_sell_num: ri.steam_sell_num, steam_buy_num: ri.steam_buy_num,
        sell_price_1: ri.sell_price_1, sell_price_7: ri.sell_price_7,
        sell_price_15: ri.sell_price_15, sell_price_30: ri.sell_price_30,
        sell_price_90: ri.sell_price_90, sell_price_180: ri.sell_price_180,
        sell_price_365: ri.sell_price_365,
        sell_price_rate_1: ri.sell_price_rate_1, sell_price_rate_7: ri.sell_price_rate_7,
        sell_price_rate_15: ri.sell_price_rate_15, sell_price_rate_30: ri.sell_price_rate_30,
        sell_price_rate_90: ri.sell_price_rate_90, sell_price_rate_180: ri.sell_price_rate_180,
        sell_price_rate_365: ri.sell_price_rate_365,
        statistic: ri.statistic, rank_num: ri.rank_num,
        img: ri.img, rarity: ri.rarity_localized_name, exterior: ri.exterior_localized_name,
    };
}

function buildDetailData(gi) {
    return {
        market_hash_name: gi.market_hash_name, buff_id: gi.buff_id,
        buff_sell_price: gi.buff_sell_price, buff_buy_price: gi.buff_buy_price,
        buff_sell_num: gi.buff_sell_num, buff_buy_num: gi.buff_buy_num,
        yyyp_id: gi.yyyp_id,
        yyyp_sell_price: gi.yyyp_sell_price, yyyp_buy_price: gi.yyyp_buy_price,
        yyyp_sell_num: gi.yyyp_sell_num, yyyp_buy_num: gi.yyyp_buy_num,
        yyyp_lease_num: gi.yyyp_lease_num, yyyp_transfer_price: gi.yyyp_transfer_price,
        yyyp_lease_price: gi.yyyp_lease_price, yyyp_long_lease_price: gi.yyyp_long_lease_price,
        yyyp_lease_annual: gi.yyyp_lease_annual, yyyp_long_lease_annual: gi.yyyp_long_lease_annual,
        yyyp_steam_price: gi.yyyp_steam_price,
        steam_sell_price: gi.steam_sell_price, steam_buy_price: gi.steam_buy_price,
        steam_sell_num: gi.steam_sell_num, steam_buy_num: gi.steam_buy_num,
        c5_sell_price: gi.c5_sell_price, c5_buy_price: gi.c5_buy_price,
        c5_sell_num: gi.c5_sell_num, c5_buy_num: gi.c5_buy_num,
        c5_lease_price: gi.c5_lease_price, c5_long_lease_price: gi.c5_long_lease_price,
        igxe_sell_price: gi.igxe_sell_price, igxe_buy_price: gi.igxe_buy_price,
        igxe_sell_num: gi.igxe_sell_num, igxe_buy_num: gi.igxe_buy_num,
        igxe_lease_price: gi.igxe_lease_price, igxe_long_lease_price: gi.igxe_long_lease_price,
        igxe_lease_num: gi.igxe_lease_num,
        eco_sell_price: gi.eco_sell_price, eco_buy_price: gi.eco_buy_price,
        eco_sell_num: gi.eco_sell_num, eco_buy_num: gi.eco_buy_num,
        r8_sell_price: gi.r8_sell_price, r8_sell_num: gi.r8_sell_num,
        turnover_number: gi.turnover_number, turnover_avg_price: gi.turnover_avg_price,
        steam_buff_buy_conversion: gi.steam_buff_buy_conversion,
        steam_buff_sell_conversion: gi.steam_buff_sell_conversion,
        buff_steam_buy_conversion: gi.buff_steam_buy_conversion,
        buff_steam_sell_conversion: gi.buff_steam_sell_conversion,
        sell_price_rate_1: gi.sell_price_rate_1, sell_price_rate_7: gi.sell_price_rate_7,
        sell_price_rate_30: gi.sell_price_rate_30, sell_price_rate_90: gi.sell_price_rate_90,
        sell_price_rate_180: gi.sell_price_rate_180, sell_price_rate_365: gi.sell_price_rate_365,
        sell_price_1: gi.sell_price_1, sell_price_7: gi.sell_price_7,
        sell_price_30: gi.sell_price_30, sell_price_90: gi.sell_price_90,
        sell_price_180: gi.sell_price_180, sell_price_365: gi.sell_price_365,
        yyyp_sell_price_rate_1: gi.yyyp_sell_price_rate_1, yyyp_sell_price_rate_7: gi.yyyp_sell_price_rate_7,
        yyyp_sell_price_rate_30: gi.yyyp_sell_price_rate_30, yyyp_sell_price_rate_90: gi.yyyp_sell_price_rate_90,
        type: gi.type_localized_name, rarity: gi.rarity_localized_name,
        quality: gi.quality_localized_name, exterior: gi.exterior_localized_name,
        statistic: gi.statistic, rank_num: gi.rank_num, rank_num_change: gi.rank_num_change,
        min_float: gi.min_float, max_float: gi.max_float,
        group_hash_name: gi.group_hash_name, img: gi.img,
    };
}

function printSummary({ cnMatched, enMatched, newCreated, detailOk, detailFail, statsOk, histOk, histFail, ipStats, startTime }) {
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    const dbData = JSON.parse(fs.readFileSync(CONFIG.DB_FILE, 'utf-8'));
    const totalCsqaq = Object.values(dbData.items || {}).filter(i => i.csqaq).length;
    const withHistory = Object.values(dbData.items || {}).filter(i => i.csqaqHistory?.sell?.length > 0).length;
    console.log('═══════════════════════════════════════════');
    console.log('   完成！');
    console.log('═══════════════════════════════════════════');
    console.log(`中文名匹配: ${cnMatched}`);
    console.log(`英文名二次匹配: ${enMatched}`);
    console.log(`全新建条目: ${newCreated}`);
    console.log(`详情: ✅${detailOk} ❌${detailFail}`);
    console.log(`存世量: ✅${statsOk}`);
    console.log(`价格历史: ✅${histOk || 0} ❌${histFail || 0}`);
    console.log(`DB总CSQAQ饰品: ${totalCsqaq} | 有价格历史: ${withHistory}`);
    console.log(`API调用: ${ipStats.success} | IP重试: ${ipStats.ipRetries}`);
    console.log(`耗时: ${Math.floor(totalTime / 60)}分${totalTime % 60}秒`);
}

main().catch(err => { console.error('💥', err); process.exit(1); });
