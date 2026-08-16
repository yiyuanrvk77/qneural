@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在检查 GitHub 登录状态...
gh auth status >nul 2>&1
if errorlevel 1 (
  echo 还没有登录 GitHub，请先运行：gh auth login
  pause
  exit /b 1
)
echo 正在创建 GitHub 仓库并推送代码（默认公开，如需私有请把 --public 改成 --private）...
gh repo create qneural --public --source . --push --description "问络 · 问题神经网络平台：关联式提问与单点纵深"
echo.
echo 完成！仓库地址稍后会显示在上方输出中。
pause
