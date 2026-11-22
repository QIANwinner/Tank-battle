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

完整套件见 `.github/workflows/ci.yml`。新增浏览器流程会检查养成备份往返、刷新后恢复、保存失败提示与重试、精简 HUD，并输出固定日期种子 20261113 的每日模式 180 帧 p50/p95/max 帧间隔。主回归与发布冒烟默认把截图写到系统临时目录并打印路径，不覆盖 README 的战斗截图。可用 `TB_SHOT` 指定输出文件；主回归的第二个命令行参数优先于该变量。

比较性能时应固定 Chrome 版本、窗口尺寸、画质、存档和机器负载。脚本不是压力关卡或手机帧率保证；后续平衡测试应记录固定操作下的通关时长、受伤次数及金币收入。

样式在 `assets/game.css`，存档重试在 `assets/storage.js`；战斗与 UI 仍在 `index.html`。新增离线必需资源时同步修改 `sw.js` 的 ASSETS，并更新缓存版本。保存失败的待写内容仅在当前页面内存中保留，不能替代持久化事务或外部备份。

## 冷启动与开局

启动静态服务器后，在 Git Bash 或其他 POSIX shell 运行：

```sh
for trial in 1 2 3; do
  TB_THROTTLE=4 TB_MOBILE=1 node .workbuddy/regression/perf_probe.js
done
```

探针每次使用新的临时 Chrome 配置，在本机 HTTP 上访问正常游戏入口（不使用 `?test=1`），绕过 Service Worker 并点击首次引导的「开始游戏」。`fcp` 取 Paint Timing，`ready` 取 DOMContentLoaded 结束时刻。`startHandler` 是点击处理耗时；`startPaint` 是点击到第二次 rAF 回调的间隔，代表已经有一次绘制机会，不是屏幕实测延迟。开场字幕结束后再采 90 帧。

| 指标（三次独立运行的中位数） | v1.1.196 | v1.1.197 |
| --- | ---: | ---: |
| 首次内容绘制 | 1352 ms | 940 ms |
| 菜单初始化完成 | 4733 ms | 2571 ms |
| 开始按钮处理 | 594 ms | 128 ms |
| 点击至首次绘制机会 | 762 ms | 401 ms |
| 开场后帧间隔 P95 | 100.1 ms | 33.4 ms |

同机 Chrome 156 无头模式、390×844 触屏视口、DPR 1、CPU 降速 4 倍、默认画质、全新存档。结果用于比较主线程开销，不包含公网下载延迟，也不是对真机帧率的承诺。

## 战斗帧间隔

```sh
TB_BATTLE=1 TB_SCENE=boss node .workbuddy/regression/perf_probe.js
```

`TB_BATTLE=1` 会打开一个真实的 Chrome 窗口（不是无头模式），在显示器自己的垂直同步节奏上采样；`TB_SCENE` 取 `wave`（6 辆普通敌人）或 `boss`（另加 Boss、散射弹幕和粒子）。脚本先在空白页采 720 帧作为这台机器当下的基线（`reference`），再进固定种子 20261113 的每日模式，热身 1.5 秒后采 6 秒：`drawGapsMs` 是相邻两次出画的间隔分位数，`callbackMs` 是单次 `tick` 的脚本耗时，`mainThreadMsPerSec` 把主线程时间拆成脚本、样式和布局，`slowFrames` 列出最慢的三个长动画帧。

采样期间不要切走或遮挡该窗口：失焦会让游戏暂停，脚本会直接报错而不是给出一份无意义的数字。结果只能和同一台机器、同一刷新率下的 `reference` 以及上一版本的同场景结果对比。
