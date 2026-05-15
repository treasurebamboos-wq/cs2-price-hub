/**
 * CSQAQ API 探测脚本 — 发现所有可用字段
 * 用法: node scripts/csqaq_probe.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CONFIG = {
    API_TOKEN: 'AAHPH1C7I7O8J6R4U074H4N1',
    RATE_LIMIT_MS: 1500,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function findBrowser() {
    const ps = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    return ps.find(p => fs.existsSync(p)) || null;
}

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('   CSQAQ API 数据结构探测');
    console.log('═══════════════════════════════════════════\n');

    const browser = await chromium.launch({ headless: false, executablePath: findBrowser() });
    const page = (await browser.newContext()).newPage ? (await (await browser.newContext()).newPage()) : null;
    if (!page) { await browser.close(); return; }

    try { await page.goto('https://api.csqaq.com/', { waitUntil: 'commit', timeout: 10000 }); } catch(e) {}
    await sleep(1000);

    async function apiPost(endpoint, body) {
        return await page.evaluate(async ({ endpoint, body, token }) => {
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'ApiToken': token, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                return JSON.parse(await res.text());
            } catch (e) { return { code: -1, msg: e.message }; }
        }, { endpoint, body, token: CONFIG.API_TOKEN });
    }

    async function apiGet(endpoint) {
        return await page.evaluate(async ({ endpoint, token }) => {
            try {
                const res = await fetch(endpoint, {
                    method: 'GET',
                    headers: { 'ApiToken': token },
                });
                return JSON.parse(await res.text());
            } catch (e) { return { code: -1, msg: e.message }; }
        }, { endpoint, token: CONFIG.API_TOKEN });
    }

    const results = {};

    // ====== 1. 排行榜完整数据 ======
    console.log('📋 1. 排行榜 get_rank_list (1个item完整结构)...');
    const rankRes = await apiPost('/api/v1/info/get_rank_list', {
        page_index: 1, page_size: 2,
        filter: { "排序": ["价格_售价_降序"] },
        show_recently_price: true,
    });
    if (rankRes.code === 200) {
        const list = rankRes.data?.data || rankRes.data?.list || [];
        results.rank_list = {
            top_level_keys: Object.keys(rankRes.data || {}),
            item_count: list.length,
            first_item: list[0] || null,
            first_item_keys: list[0] ? Object.keys(list[0]) : [],
        };
        console.log('   ✅ 字段数:', results.rank_list.first_item_keys.length);
        console.log('   字段:', results.rank_list.first_item_keys.join(', '));
    } else {
        console.log('   ❌', rankRes.msg);
    }
    await sleep(CONFIG.RATE_LIMIT_MS);

    // ====== 2. 饰品列表 get_page_list ======
    console.log('\n📋 2. 饰品列表 get_page_list...');
    const pageRes = await apiPost('/api/v1/info/get_page_list', {
        page_index: 1, page_size: 2,
        filter: {},
    });
    if (pageRes.code === 200) {
        const list = pageRes.data?.data || pageRes.data?.list || [];
        results.page_list = {
            top_level_keys: Object.keys(pageRes.data || {}),
            item_count: list.length,
            first_item: list[0] || null,
            first_item_keys: list[0] ? Object.keys(list[0]) : [],
        };
        console.log('   ✅ 字段数:', results.page_list.first_item_keys.length);
    } else {
        console.log('   ❌', pageRes.code, pageRes.msg?.substring(0, 200));
    }
    await sleep(CONFIG.RATE_LIMIT_MS);

    // ====== 3. 单件饰品详情 good ======
    const testId = results.rank_list?.first_item?.id;
    if (testId) {
        console.log(`\n🔍 3. 饰品详情 /api/v1/info/good?id=${testId}...`);
        const goodRes = await apiGet(`/api/v1/info/good?id=${testId}`);
        if (goodRes.code === 200) {
            results.good_detail = {
                top_level_keys: Object.keys(goodRes.data || {}),
                data: goodRes.data,
            };
            console.log('   ✅ 字段数:', results.good_detail.top_level_keys.length);
            console.log('   字段:', results.good_detail.top_level_keys.join(', '));
        } else {
            console.log('   ❌', goodRes.code, goodRes.msg?.substring(0, 200));
        }
        await sleep(CONFIG.RATE_LIMIT_MS);

        // ====== 4. 存世量走势 ======
        console.log(`\n📊 4. 存世量走势 /api/v1/info/good/statistic?id=${testId}...`);
        const statRes = await apiGet(`/api/v1/info/good/statistic?id=${testId}`);
        if (statRes.code === 200) {
            results.statistic = {
                top_level_keys: Object.keys(statRes.data || {}),
                data_sample: typeof statRes.data === 'object' ? statRes.data : statRes.data,
            };
            console.log('   ✅');
            // 如果是数组，显示长度和首项
            if (Array.isArray(statRes.data)) {
                console.log('   数组长度:', statRes.data.length, '首项:', JSON.stringify(statRes.data[0]));
            } else {
                console.log('   结构:', JSON.stringify(statRes.data).substring(0, 500));
            }
        } else {
            console.log('   ❌', statRes.code, statRes.msg?.substring(0, 200));
        }
        await sleep(CONFIG.RATE_LIMIT_MS);
    }

    // ====== 5. Chart接口 - 测试不同key ======
    if (testId) {
        const chartKeys = ['sell_price', 'buy_price', 'sell_num', 'buy_num', 'turnover_number'];
        const platforms = [1, 2, 3];
        console.log(`\n📈 5. Chart接口测试 (id=${testId})...`);
        results.chart_tests = [];
        for (const key of chartKeys) {
            for (const platform of platforms) {
                const res = await apiPost('/api/v1/info/chart', {
                    good_id: testId, key, platform, period: 30, style: 'all_style',
                });
                const ok = res.code === 200 && res.data;
                const dataLen = ok && res.data.timestamp ? res.data.timestamp.length : 0;
                results.chart_tests.push({ key, platform, ok, dataLen });
                console.log(`   ${key} P${platform}: ${ok ? '✅ ' + dataLen + '点' : '❌ ' + (res.msg||'').substring(0, 80)}`);
                await sleep(CONFIG.RATE_LIMIT_MS);
            }
        }
    }

    // ====== 6. 挂刀行情 ======
    console.log('\n🔪 6. 挂刀行情...');
    // 尝试几个可能的endpoint
    for (const ep of ['/api/v1/info/knife', '/api/v1/knife/info', '/api/v1/info/steam_conversion']) {
        const res = await apiGet(ep);
        if (res.code === 200) {
            results.knife = { endpoint: ep, data_sample: JSON.stringify(res.data).substring(0, 500) };
            console.log(`   ✅ ${ep}`);
            break;
        } else {
            console.log(`   ❌ ${ep}: ${res.code}`);
        }
        await sleep(CONFIG.RATE_LIMIT_MS);
    }

    // ====== 7. 首页/指数 ======
    console.log('\n📊 7. 首页/指数...');
    for (const ep of ['/api/v1/info/home', '/api/v1/index/home', '/api/v1/info/index']) {
        const res = await apiGet(ep);
        if (res.code === 200) {
            results.home = { endpoint: ep, keys: Object.keys(res.data || {}), data_sample: JSON.stringify(res.data).substring(0, 800) };
            console.log(`   ✅ ${ep}: ${JSON.stringify(res.data).substring(0, 300)}`);
            break;
        } else {
            console.log(`   ❌ ${ep}: ${res.code}`);
        }
        await sleep(CONFIG.RATE_LIMIT_MS);
    }

    // ====== 保存完整结果 ======
    const outFile = path.join(__dirname, '..', 'data', 'csqaq_api_probe.json');
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\n💾 完整结果已保存: ${outFile}`);

    await browser.close();
    console.log('\n✅ 探测完成');
}

main().catch(err => { console.error('💥', err); process.exit(1); });
