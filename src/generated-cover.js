'use strict';
// 认出 Qiaomu Reader 自己画的文字封面（书里没有封面图时它用书名画一张），这种不传：网站有自己的文字封面。
// 它的样子（Qiaomu Reader src/book-cover.js）：600×900，整张底色是 6 种纸色之一，
// 右上角和右边中间都是空白的底色；书名从左边写，右下角有两个淡淡的圆圈。缓存里是缩小到 240×360 的 JPEG。
// 判断方法：右上角一块、右边中间一条，像素几乎全是同一种纸色，就认为是它画的。真的封面很少会这样。

const PAPERS = ['#dce7df', '#eee2cf', '#dce5ec', '#e9dcd5', '#e4dfed', '#e8e7d5']
  .map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));

const TOLERANCE = 14; // JPEG 压缩会让颜色有一点偏差

/** 一块区域里有多少比例的像素接近这种颜色。rgba：Uint8ClampedArray，宽 w。 */
function share(rgba, w, h, box, color) {
  const x0 = Math.floor(box[0] * w), x1 = Math.ceil(box[2] * w);
  const y0 = Math.floor(box[1] * h), y1 = Math.ceil(box[3] * h);
  let near = 0, all = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      all++;
      if (Math.abs(rgba[i] - color[0]) <= TOLERANCE && Math.abs(rgba[i + 1] - color[1]) <= TOLERANCE && Math.abs(rgba[i + 2] - color[2]) <= TOLERANCE) near++;
    }
  }
  return all ? near / all : 0;
}

// 相对位置（左、上、右、下）。书名最宽写到 x≈0.86，圆圈最高到 y≈0.81。
const TOP_RIGHT = [0.6, 0.02, 0.96, 0.09];
const RIGHT_MIDDLE = [0.89, 0.25, 0.97, 0.6];

/** 是不是 Qiaomu Reader 画的文字封面。 */
function isGeneratedCover(rgba, w, h) {
  if (!w || !h || h / w < 1.3 || h / w > 1.7) return false;
  return PAPERS.some(c => share(rgba, w, h, TOP_RIGHT, c) > 0.97 && share(rgba, w, h, RIGHT_MIDDLE, c) > 0.97);
}

module.exports = { isGeneratedCover, PAPERS };
