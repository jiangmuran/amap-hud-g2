# Even Hub 上架资料

在 [hub.evenrealities.com](https://hub.evenrealities.com) 项目页填写时直接复制以下内容。截图在 `store/screenshots/`，图标是 `store/icon-24.png`（像素数据在 `store/icon_data.json`）。

> 机器可读版本：`store/listing.json`（上传脚本使用）。门户限制：名称 ≤20、简介 ≤50、描述 ≤2000、标签 ≤5 个（每个 ≤20）、截图 ≤8 张且必须是 576×288 PNG、图标为 24×24 单色 PNG（每个像素都必须属于某个 2×2 实心块）、不能含 emoji。

## 应用名

`RealMapCN`（包名 `com.realmapcn.nav`）

## 一句话简介（Tagline）

**中文**：科幻风导航 HUD：转向指引、雷达地图、周边评分与楼层，眼镜上直接选目的地。

**English**: Sci-fi navigation HUD — turn-by-turn, radar map, nearby places with ratings, pick destinations right on your glasses.

## 详细描述

**中文**

把导航搬到 G2 的视野里，用一套为单色微型显示屏设计的科幻 HUD 呈现。

• 转向指引：大号转向箭头和距离、即将进入的道路，以及"然后…"的下一步预告
• 局部雷达地图：带距离环和罗盘刻度，可选车头朝上或正北朝上，随车速自动缩放，可叠加街道线框
• 全局地图与路书：全程总览，后续路段一目了然
• 偏航自动重算，到达时显示行程总结
• 在眼镜上直接选目的地：「前往」页列出家、公司和收藏的地点，用戒指或镜腿选择即可出发，不用掏手机
• 周边筛选：地铁站、超市、美食等 10 类，显示评分、人均和楼层，选中后直接导航到入口
• 仪表盘：速度表、行程、用时、均速、海拔、航向、爬升
• 专注模式：远离路口时几乎熄屏，接近转向时自动亮起
• 支持步行、骑行、电动车、驾车

需要自备高德开放平台「Web服务」Key（免费申请），在手机端设置中填写即可。地图与地点数据来自高德地图。

**English**

Bring navigation into your G2 field of view with a sci-fi HUD designed for the monochrome micro-display.

• Turn-by-turn: large maneuver arrows, distance, next road, and a "then…" preview
• Radar mini-map with range rings and compass ticks; heading-up or north-up; auto-zoom by speed; optional street wireframe
• Route overview and roadbook
• Automatic rerouting and an arrival summary
• Pick destinations on the glasses: Home, Work and saved places in the GO view — choose with the ring or temple, no phone needed
• Nearby: metro, supermarkets, food and 7 more categories, with ratings, average price and floor; navigate straight to the entrance
• Telemetry: speedometer, trip distance, time, average speed, altitude, heading, climb
• Focus mode: the display stays nearly dark until a turn approaches
• Walking, cycling, e-bike and driving

Requires your own free AMap (高德开放平台) Web Service key, entered in the phone settings. Map and place data © AMap.

## 分类

导航 / Navigation（如果没有这个分类，就选 工具 / Utilities）

## 权限说明（与 app.json 一致）

| 权限 | 说明 |
|---|---|
| network（白名单 `https://restapi.amap.com`） | 调用高德地图 Web 服务 API，用于地点搜索、路线规划、逆地理编码和天气查询。 |
| location | 获取手机定位，用于实时导航、偏航重算和周边搜索。 |

## 链接

- 隐私政策：https://github.com/jiangmuran/amap-hud-g2/blob/main/docs/PRIVACY.md
- 支持 / 反馈：https://github.com/jiangmuran/amap-hud-g2/issues
- 源代码：https://github.com/jiangmuran/amap-hud-g2

## 截图（store/screenshots）

用 `NN-name.png`（576×288，G2 绿色）或 `NN-name@2x.png`（1152×576）。`-gray` 后缀的版本是发给眼镜的原始灰度数据。

| 文件 | 内容 |
|---|---|
| 01-nav | 导航主界面：转向 + 雷达地图 |
| 02-overview | 全局路线总览 |
| 03-roadbook | 路书 |
| 04-telemetry | 仪表 |
| 05-radar | 周边：美食（评分 / 人均 / 楼层） |
| 06-poi | 地点详情卡 |
| 07-go | 前往：快捷目的地 |
| 08-cruise | 巡航：航向带、地址、天气 |

## 给审核员的备注（Review notes）

**中文**
本应用需要高德开放平台「Web服务」Key 才能搜索和规划路线。审核用测试 Key：`<在此填写测试 Key，审核结束后可在高德控制台删除>`。
测试步骤：
1. 手机端首次打开选择系统；
2. 进入 设置 → 高德开放平台，粘贴 Key，点「保存并测试」；
3. 搜索任意地点 → 开始导航；
4. 眼镜上滑动切换视图，单击执行操作，单击后长按打开菜单，在根页面双击会弹出退出确认。
眼镜端可以独立完成整个流程：在「前往」页选择目的地即可开始导航，在「周边」页选择地点即可导航。

**English**
An AMap Web Service key is required for search and routing. Test key for review: `<test key here>`.
Steps: choose your phone OS on first launch → Settings → AMap → paste key → "Save & test" → search a place → Start. On the glasses: swipe to switch views, tap to act, tap-then-long-press for the menu; double-tap on the root page shows the exit dialog. The core flow also works from the glasses alone (GO view → pick a destination).

## 版本说明（v0.3.0）

**中文**
- 眼镜画面刷新更流畅：只刷新有变化的区域，最久未更新的区域优先，不会再出现画面只更新一部分的情况
- 刷新频率随速度自适应：步行时地图约 3 秒刷新一次，驾车约 0.8 秒；操作后立即响应
- 后台流量减少约一半，操作更跟手
- 修复方向箭头指向错误

**English**
- Smoother glasses rendering: only changed regions are refreshed, oldest first — no more partially updated screens
- Speed-adaptive refresh: map updates every ~3 s when walking, ~0.8 s when driving; instant response to input
- About half the background traffic, snappier controls
- Fixed direction arrows pointing the wrong way

## 提交前检查清单

- [ ] 应用名已确定，并且已同步到 `app.json`
- [ ] `npm run pack` 打包成功
- [ ] 以 Beta 安装后锁屏 5 分钟，眼镜仍然正常响应
- [ ] 根页面双击会弹出系统退出确认
- [ ] 退出后再打开官方应用（如 Conversate）正常，不需要重启眼镜
- [ ] 隐私政策覆盖 network 和 location 两项权限
- [ ] 审核备注里已填测试 Key
