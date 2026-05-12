/**
 * CS2 Price Hub - 浏览器自动化爬虫
 *
 * 使用 Playwright 模拟真实浏览器访问，绑过反爬检测
 * 这就是 cs2.sh / Pricempire 使用的核心技术
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 数据库文件
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'prices.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 加载已有数据
function loadData() {
    if (fs.existsSync(DB_FILE)) {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    }
    return { items: {}, lastUpdate: null };
}

// 保存数据
function saveData(data) {
    data.lastUpdate = new Date().toISOString();
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 查找系统已安装的Chrome/Edge
 */
function findBrowser() {
    const possiblePaths = [
        // Chrome
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
        // Edge
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Buff爬虫 - 使用真实浏览器
 */
async function scrapeBuff(browser, options = {}) {
    const { maxPages = 3 } = options;
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        locale: 'zh-CN',
    });

    const page = await context.newPage();
    const items = [];

    try {
        console.log('🌐 打开 Buff...');

        // 拦截API响应，这是核心！
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('/api/market/goods') && response.status() === 200) {
                try {
                    const json = await response.json();
                    if (json.code === 'OK' && json.data?.items) {
                        for (const item of json.data.items) {
                            items.push({
                                market_hash_name: item.market_hash_name,
                                name: item.name,
                                sell_min_price: parseFloat(item.sell_min_price),
                                sell_num: item.sell_num,
                                buy_max_price: item.buy_max_price ? parseFloat(item.buy_max_price) : null,
                                buy_num: item.buy_num,
                                steam_price: item.goods_info?.steam_price_cny ? parseFloat(item.goods_info.steam_price_cny) : null,
                                source: 'buff',
                                updated_at: new Date().toISOString()
                            });
                        }
                        console.log(`   📦 捕获到 ${json.data.items.length} 个饰品，累计 ${items.length}`);
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            }
        });

        // 访问Buff
        await page.goto('https://buff.163.com/market/csgo#tab=selling&page_num=1', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // 等待页面加载
        await page.waitForTimeout(3000);

        // 检查是否需要登录
        const pageContent = await page.content();
        if (pageContent.includes('Login Required') || pageContent.includes('请先登录')) {
            console.log('⚠️ Buff需要登录');
            console.log('💡 请在打开的浏览器窗口中手动登录，然后按回车继续...');

            // 等待用户登录（最多等待5分钟）
            await page.waitForTimeout(300000);
        }

        // 翻页获取数据
        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
            console.log(`📄 正在获取第 ${pageNum}/${maxPages} 页...`);

            if (pageNum > 1) {
                // 构造下一页URL
                const nextUrl = `https://buff.163.com/market/csgo#tab=selling&page_num=${pageNum}`;
                await page.goto(nextUrl, { waitUntil: 'domcontentloaded' });
            }

            // 等待数据加载
            await page.waitForTimeout(2500);
        }

        console.log(`✅ Buff爬取完成，共 ${items.length} 个饰品`);

    } catch (error) {
        console.error(`❌ Buff爬取失败: ${error.message}`);
    } finally {
        await context.close();
    }

    return items;
}

/**
 * 悠悠有品爬虫
 */
async function scrapeYoupin(browser, options = {}) {
    const { maxPages = 3 } = options;
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        locale: 'zh-CN',
    });

    const page = await context.newPage();
    const items = [];

    try {
        console.log('🌐 打开悠悠有品...');

        // 拦截API响应
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('youpin') && response.status() === 200) {
                try {
                    const text = await response.text();
                    const json = JSON.parse(text);

                    // 尝试不同的数据结构
                    let list = json.Data?.ProductList ||
                               json.data?.list ||
                               json.Data?.list ||
                               [];

                    for (const item of list) {
                        if (item.HashName || item.hashName) {
                            items.push({
                                market_hash_name: item.HashName || item.hashName,
                                name: item.CommodityName || item.commodityName || item.ItemName,
                                sell_min_price: item.Price || item.price,
                                sell_num: item.OnSaleCount || item.onSaleCount || item.SaleCount,
                                source: 'youpin',
                                updated_at: new Date().toISOString()
                            });
                        }
                    }

                    if (list.length > 0) {
                        console.log(`   📦 悠悠有品捕获 ${list.length} 个，累计 ${items.length}`);
                    }
                } catch (e) {
                    // 忽略
                }
            }
        });

        await page.goto('https://www.youpin898.com/market/csgo', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await page.waitForTimeout(5000);

        // 滚动页面触发加载
        for (let i = 0; i < maxPages; i++) {
            console.log(`📄 悠悠有品 第 ${i + 1}/${maxPages} 页...`);
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(2000);
        }

        console.log(`✅ 悠悠有品爬取完成，共 ${items.length} 个饰品`);

    } catch (error) {
        console.error(`❌ 悠悠有品爬取失败: ${error.message}`);
    } finally {
        await context.close();
    }

    return items;
}

/**
 * 主函数
 */
async function main() {
    console.log('═'.repeat(60));
    console.log('🚀 CS2 Price Hub - 浏览器自动化爬虫');
    console.log('═'.repeat(60));

    // 查找系统浏览器
    const browserPath = findBrowser();

    let browser;
    if (browserPath) {
        console.log(`🌐 使用系统浏览器: ${browserPath}`);
        browser = await chromium.launch({
            headless: false,  // 显示浏览器窗口
            executablePath: browserPath,
            slowMo: 100,
        });
    } else {
        console.log('🌐 使用Playwright内置浏览器...');
        browser = await chromium.launch({
            headless: false,
            slowMo: 100,
        });
    }

    const data = loadData();
    const allItems = [];

    try {
        // 选择要爬取的平台
        const sources = process.argv.slice(2);
        const scrapeAll = sources.length === 0;

        if (scrapeAll || sources.includes('buff')) {
            const buffItems = await scrapeBuff(browser, { maxPages: 3 });
            allItems.push(...buffItems);
        }

        if (scrapeAll || sources.includes('youpin')) {
            const youpinItems = await scrapeYoupin(browser, { maxPages: 3 });
            allItems.push(...youpinItems);
        }

        // 合并到数据库
        for (const item of allItems) {
            const key = item.market_hash_name;
            if (!key) continue;

            if (!data.items[key]) {
                data.items[key] = { prices: {} };
            }
            data.items[key].name = item.name || data.items[key].name;
            data.items[key].prices[item.source] = {
                price: item.sell_min_price,
                volume: item.sell_num,
                buy_price: item.buy_max_price,
                steam_price: item.steam_price,
                updated_at: item.updated_at
            };
        }

        // 保存数据
        saveData(data);

        console.log('\n' + '═'.repeat(60));
        console.log('📊 爬取完成！');
        console.log('═'.repeat(60));
        console.log(`   总计: ${allItems.length} 条价格数据`);
        console.log(`   饰品: ${Object.keys(data.items).length} 个`);
        console.log(`   数据保存至: ${DB_FILE}`);
        console.log('═'.repeat(60));

        // 显示部分数据
        if (Object.keys(data.items).length > 0) {
            console.log('\n📋 部分数据预览:');
            const preview = Object.entries(data.items).slice(0, 8);
            for (const [name, info] of preview) {
                const prices = Object.entries(info.prices || {})
                    .map(([src, p]) => `${src}:¥${p.price}`)
                    .join(' | ');
                console.log(`   ${(info.name || name).substring(0, 40)}`);
                console.log(`      ${prices || '暂无价格'}`);
            }
        }

    } finally {
        await browser.close();
    }
}

// 运行
main().catch(console.error);
