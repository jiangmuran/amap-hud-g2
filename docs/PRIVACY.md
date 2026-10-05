# 隐私政策 / Privacy Policy

最后更新：2026-10-05

本应用（以下称「本应用」）是运行在 Even Realities App 内、配合 G2 眼镜使用的导航插件。我们尽量少收集数据：**本应用没有自己的服务器，不会收集、上传或出售你的个人信息。**

## 本应用使用的权限

| 权限 | 用途 | 数据去向 |
|---|---|---|
| **定位（location）** | 实时导航、偏航重算、周边搜索、显示当前街道与天气 | 定位坐标只在你的手机上处理。只有在搜索、规划路线、查询地址或天气时，相关坐标才会随请求发送给高德开放平台 |
| **网络（network）**，仅允许访问 `https://restapi.amap.com` | 调用高德地图 Web 服务 API：地点搜索、路线规划、逆地理编码、天气、静态地图 | 请求直接从你的手机发给高德，包含你填写的高德 Key、查询关键词和相关坐标 |

## 本地存储的数据

以下数据保存在你手机上的 Even App 存储中，不会上传：

- 你填写的高德 Key 和接口地址；
- 家、公司、眼镜快捷点、最近目的地；
- 显示偏好（地图朝向、底图、专注模式、刷新频率、手机系统）；
- 本月接口调用次数统计。

行程轨迹和速度统计只保存在内存中，关闭应用后清除。地图图片只在内存中使用，不缓存到本地。

## 第三方服务

地图、地点、路线和天气数据由**高德开放平台**提供。你发给高德的请求受[高德地图开放平台服务协议](https://lbs.amap.com/pages/terms/)和高德隐私政策约束。

## 删除数据

在应用的设置中清除 Key 和收藏，或者在 Even App 中卸载本应用，即可删除所有本地数据。

## 联系

https://github.com/jiangmuran/amap-hud-g2/issues

---

**English summary**: This app has no backend and does not collect, upload or sell personal data. Location is processed on your phone, and coordinates are sent only to AMap (`restapi.amap.com`) when you search, plan a route, or look up an address or the weather. Your AMap key, saved places and preferences stay in local Even App storage. Trip tracks live in memory only. Map and place data are provided by AMap and are subject to AMap's terms and privacy policy.
