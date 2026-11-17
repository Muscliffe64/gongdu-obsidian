# 共读打卡 · Obsidian 插件（给 Claude Code 的入口说明）

和 Qiaomu Reader（乔木阅读器，github.com/joeseesun/qiaomu-reader）一起用的 Obsidian 插件：一屏打卡到共读网站（Muscliffe64/gongdu），打开书时自动同步封面。说明见 `README.md`。

## 硬性规则

1. **只读 Qiaomu Reader 的数据**，不写、不改它的任何文件和设置。它的数据格式以它的源码为准，改动前先去看源码。
2. **封面规则是老师定的**（2026-11-18）：网站上已经有封面图就不换，换只在打卡窗口里勾选；书不在共读书架上不传；用 /api/agent/status 避免重复传；失败过的不在每次打开时重试；不弹窗。改这些先问老师。
3. **不引入依赖和构建工具**：`node build.js` 把 `src/` 打成 `main.js`。`main.js` 不进 Git，发布时附在 Release 里。
4. **每个改动写 `node:test` 测试**（`npm test`）。不需要 Obsidian 的逻辑放在 `src/` 的纯模块里测；要用 Obsidian 的放在 `main.js`、`checkin-modal.js`、`obsidian-io.js`，用 `scripts/obsidian-e2e.mjs` 在真的 Obsidian 里试。
5. **测试只对着本机的共读服务器**，不碰线上的网站。
6. 界面文案用中文，语气平实，不用表情符号。
7. Git：在分支上改，开 PR，不直接推 `main`。
