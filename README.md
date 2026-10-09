# 坦克大战 · Tank Battle

一个纯 HTML / CSS / JavaScript 实现的经典「坦克大战」游戏，单文件、零依赖，双击即可游玩。

![Tank Battle](https://img.shields.io/badge/HTML-CSS-JS-f5b942) ![No Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)

## ✨ 特性

- 🕹️ 经典玩法：守护基地、消灭敌方坦克
- 🧱 可破坏砖墙、不可破坏钢墙、水面、草丛四种地形
- 🤖 敌方 AI：随机移动 + 追踪玩家 + 自动射击
- 📈 关卡递增：每关敌人数量与地形复杂度逐步提升
- 🎵 Web Audio 合成音效（射击 / 命中 / 爆炸）
- 💥 粒子爆炸特效与屏幕震动
- 📱 自适应布局，支持移动端缩放

## 🎮 操作

| 按键 | 功能 |
| --- | --- |
| `W` `A` `S` `D` / `方向键` | 移动坦克 |
| `空格` / `J` | 开火 |
| `P` | 暂停 / 继续 |

## 🚀 快速开始

直接用浏览器打开 `index.html` 即可，无需安装任何依赖。

## 🗺️ 玩法说明

- 保护地图底部中央的 **基地（鹰徽）**，基地被摧毁即游戏结束
- 消灭全部敌方坦克即可进入下一关
- 每击毁一辆敌方坦克 +100 分
- 共 3 条生命，被击中后短暂无敌并闪烁
- 坦克无法通过砖墙、钢墙和水面；子弹可以越过水面

## 📂 项目结构

```
Tank-battle/
└── index.html   # 游戏全部代码（HTML + CSS + JS）
```

## 📄 许可证

[MIT](LICENSE)
