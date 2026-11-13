# 开发与验证

游戏无需构建；测试使用 Node.js 22+ 和 Chrome。通过 TB_CHROME 指定 Chrome 可执行文件，TB_PROFILE 指定独立测试目录（测试脚本会清空该目录，请勿指向个人浏览器资料目录）。

在仓库根目录启动服务器：

```sh
node .workbuddy/regression/serve.js
```

另一终端运行：

```sh
node --test .workbuddy/regression/reliability.test.js
node .workbuddy/regression/tb_cdp_test.js
node .workbuddy/regression/tb_release_smoke.js
```

完整套件见 `.github/workflows/ci.yml`。新增浏览器流程会检查养成备份往返、刷新后恢复、保存失败提示与重试、精简 HUD，并输出固定日期种子 20261113 的每日模式 180 帧 p50/p95/max 帧间隔。TB_SHOT 可指定输出截图路径。

比较性能时应固定 Chrome 版本、窗口尺寸、画质、存档和机器负载。脚本不是压力关卡或手机帧率保证；后续平衡测试应记录固定操作下的通关时长、受伤次数及金币收入。

样式在 `assets/game.css`，存档重试在 `assets/storage.js`；战斗与 UI 仍在 `index.html`。新增离线必需资源时同步修改 `sw.js` 的 ASSETS，并更新缓存版本。保存失败的待写内容仅在当前页面内存中保留，不能替代持久化事务或外部备份。
