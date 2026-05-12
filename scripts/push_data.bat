@echo off
chcp 65001 >nul
cd /d "%~dp0.."

echo [%date% %time%] 推送价格数据到GitHub...

git add data/prices.json
git commit -m "auto: update prices.json [%date% %time%]"
git push origin master

if %errorlevel%==0 (
    echo [%date% %time%] 推送成功！
) else (
    echo [%date% %time%] 推送失败！
)
