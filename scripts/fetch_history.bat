@echo off
chcp 65001 >nul
cd /d "%~dp0.."

echo ═══════════════════════════════════════════
echo   CSQAQ 历史价格数据爬取 (Playwright)
echo ═══════════════════════════════════════════
echo.
echo 此脚本通过浏览器从 csqaq.com 获取历史价格数据
echo 不需要API Token，不受IP绑定限制
echo.
echo 先测试3个饰品，按任意键开始...
pause >nul

node scripts/fetch_csqaq_history.js --limit=3

echo.
echo 测试完成！如果成功，请运行以下命令爬取全部：
echo node scripts/fetch_csqaq_history.js
echo.
echo 按任意键退出...
pause >nul
