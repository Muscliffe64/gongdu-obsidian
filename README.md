# 共读打卡 · Obsidian 插件

给在 Obsidian 里用 [Qiaomu Reader](https://github.com/joeseesun/qiaomu-reader)（乔木阅读器）读电子书的学生用。读书时阅读器记下的时长、进度和高亮，在这里一屏打卡到班级的[共读](https://github.com/Muscliffe64/gongdu)网站；打开一本书时，自动把阅读器里的封面同步到共读书架上的同一本书。

它不是 Qiaomu Reader 的改版：Qiaomu Reader 照常用、照常更新，这个插件只读它记下的数据，不改它的任何文件。

## 学生怎么用

1. 装好 Qiaomu Reader 和本插件（见下面「安装」）。
2. 到共读网站“我的”页面生成令牌；在 Obsidian 的设置 → 共读打卡里填网站地址和令牌，点「检查」。
3. 读书。读完点左边栏的「共读：读书打卡」按钮（或者命令面板里的「读书打卡」，或者状态栏上的“共读 · …”）。

打卡窗口一屏：

- **书**：自动对到共读书架上的书（按书里写的书名、文件名，以及以前打卡时确认过的）。书架上没有就是「加一本：《…》」，打卡时网站会加上。
- **今天读了几分钟**：阅读器今天记了多少分钟。阅读器记的是所有书一起的；今天别的书已经记过的会减掉，这本书已经记过的会保留（网站上同一本书再交是覆盖）。
- **读到百分之几**：阅读器里这本书的进度。
- **今天的高亮**：勾上想摘的句子，每句可以加想法；也可以自己写一句。今天还没有摘录时至少要有一句。
- **换成阅读器里的封面**：只有网站上这本书已经有封面图（或者去掉过）、而阅读器里找得到封面时才出现，默认不勾。

## 封面怎么同步

打开一本书（在 Qiaomu Reader 里）一两秒后，插件在后台：

1. 问共读网站书架上有哪些书（两分钟内用缓存），对到这本书。**书架上没有就不传**，只给个提示。
2. **网站上已经有封面图就不换**；本人或老师去掉过封面图的也不再自动传。
3. 按这个顺序找封面：书的笔记里写的 `cover:` → 书里自带的封面（EPUB）→ Qiaomu Reader 的封面缓存。
   Qiaomu Reader 在书里没有封面时会用书名画一张文字封面，**这种不传**（网站有自己的文字封面）。
4. 缩到 480×720 以内、280 KB 以内的 JPEG，传上去。
5. 找不到封面就什么也不说，一天内不再找（换了文件马上再试）；图片不收（比如形状不像封面）的，这个文件不再试；断网、服务器出错的，一天后再试。

**安静**：不弹窗。有提示或出了问题，状态栏写一句（一分钟后消掉），左边栏的「共读」按钮上标一个小点（提示是蓝的，出错是红的），打开打卡窗口时最上面会说是什么，小点就消掉了。
之所以还要小点：Qiaomu Reader 读书时会把 Obsidian 的状态栏藏起来，只写在状态栏上读书时看不到。iPad 上的 Obsidian 本来就没有状态栏。

命令面板里还有「再试一次同步这本书的封面」：忘掉这本书传没传过，马上再试一次。

## 读的是哪些数据

依据 Qiaomu Reader 4.9.x 的源码，都是只读：

| 什么 | 在哪里 |
|---|---|
| 今天读了多久 | Qiaomu Reader 插件数据 `data.json` 的 `settings.readingLog["YYYY-MM-DD"]`（秒，所有书一起） |
| 读到哪里 | `<数据文件夹>/reading-progress.json`：`{ 书的路径: { pct, percent, lastRead } }` |
| 高亮 | `<数据文件夹>/reading-highlights.json`：`{ 书的路径: [ { text, created } ] }` |
| 封面缓存 | `.obsidian/plugins/qiaomu-reader/thumbnails-v3/<sha256(JSON.stringify([路径, mtime, size]))>.jpg`，书在 Qiaomu Reader 书库里显示过才有 |
| 书的笔记 | `settings.bookNoteLinks[书的路径]`，笔记属性 `cover:`（图片链接或网址） |

数据文件夹 = Qiaomu Reader 设置里的「数据文件夹」，空着就是「书的文件夹」，再空就是库的根目录。Qiaomu Reader 开着时直接读它内存里的数据（最新），读不到再读文件。

Qiaomu Reader 的阅读页不算 Obsidian 的“当前文件”，打开书时没有 `file-open` 事件，所以插件看的是当前标签页里的 `view.file`（`active-leaf-change`、`layout-change`）。

## 安装

还没上架 Obsidian 社区插件。两种装法：

- **BRAT**：装 BRAT 插件 → Add beta plugin → 填这个仓库（需要仓库是公开的，并且发布了 Release，附上 `main.js`、`manifest.json`、`styles.css`）。
- **手动**：把这三个文件放进库里的 `.obsidian/plugins/gongdu/`，在设置 → 第三方插件里打开「共读打卡」。

## 开发

不用第三方依赖，Node 22 以上。

```bash
node build.js              # 把 src/ 打成 main.js
node build.js <库的路径>    # 同时装到那个库的 .obsidian/plugins/gongdu/
npm test                   # node:test；cover-sync 的测试会起一个本机的共读服务器（../gongdu，或 GONGDU_DIR）
```

| 文件 | 做什么 |
|---|---|
| `src/main.js` | 插件本身：状态栏、命令、左边栏按钮、设置页、打开书时触发同步 |
| `src/checkin-modal.js` | 打卡窗口 |
| `src/cover-sync.js` | 自动同步封面的规则（不碰 Obsidian，测试里换成假的） |
| `src/obsidian-io.js` | 读 Qiaomu Reader 的数据、找封面、缩成 JPEG |
| `src/qiaomu.js` | Qiaomu Reader 数据的格式和路径 |
| `src/epub.js` | 从 EPUB 里取书名、作者、封面（自己读 zip，用 DecompressionStream 解压） |
| `src/generated-cover.js` | 认出 Qiaomu Reader 自己画的文字封面 |
| `src/match.js` | 把阅读器里的书对到共读书架上的书 |
| `src/api.js` | 共读网站的智能体接口 |

### 在真的 Obsidian 里试

`scripts/make-test-vault.js` 建一个测试库（装好 Qiaomu Reader、本插件和三本测试 EPUB），`scripts/obsidian-e2e.mjs` 用单独的用户数据目录起一个 Obsidian（不碰自己平时用的库和设置），用 DevTools 协议一步步操作、截图。用法写在两个脚本开头。
