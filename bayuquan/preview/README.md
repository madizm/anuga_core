# 鲅鱼圈 Fill–Spill 非权威本地预览

本目录实现单机 CPU 上的小范围地形蓄水/溢流预览。它不是 ANUGA
二维浅水动力计算，也不能作为防洪、应急调度或工程设计的权威依据。

## 本地运行

```bash
.venv/bin/python -m bayuquan.preview.local_preview \
  OUTPUT/model/web/elevation_5m_cog.tif \
  /tmp/bayuquan-80mm.cog.tif \
  --effective-rainfall-mm 80 \
  --window 2413,1779,128,128 \
  --preprocessing-cache /tmp/bayuquan-2413-1779-128.npz
```

`--window` 为必填参数，顺序是 `column_offset,row_offset,width,height`。当前
Python heap 实现仅适合本地验证窗口，CLI 不允许直接运行 5947 万 Cell 的全域
5 m DEM。

`--effective-rainfall-mm` 是扣除初损、入渗等损失后的**有效降雨深度**，不是未经
处理的原始累计降雨。当前输入在窗口内均匀分布。任务完成后，命令向 stdout 输出
JSON 摘要。

## 预处理缓存

指定 `--preprocessing-cache` 后，首次运行会原子写入不含 Python pickle 的 NPZ。
缓存身份包含：

- 缓存 schema 版本；
- DEM 绝对路径、文件大小和修改时间；
- 像素窗口；
- 输出 transform。

同一地形窗口改用其他有效累计雨量时会直接复用缓存。身份不一致或缓存损坏时会
重新运行 Priority-Flood 并替换缓存。

## COG 输出

输出为单波段 Float32 Cloud Optimized GeoTIFF：

- band：`maximum_water_depth`；
- unit：`m`；
- NoData：`-9999`；
- DEM 有效但不属于蓄水洼地的 Cell：`0 m`；
- DEM NoData Cell：保持 NoData；
- CRS、Grid Resolution 和像素对齐：继承所选 DEM 窗口。

写出过程按 raster block 恢复水深，不创建另一张全窗口水深工作数组。COG tags
包含质量平衡、最大水深、湿区面积，以及 `0.05、0.15、0.30、0.50、1.00 m`
阈值影响面积。

## 当前物理假设

- 窗口有效栅格的外圈默认为 Open Outlet；
- 使用 D8 最陡下降方向将有效降雨汇入洼地；
- 以 D8 watershed 和最低鞍点构建 Depression Hierarchy；子洼地分别蓄水，
  均达到共同鞍点后才激活合并水面；
- 洼地按有限体积蓄水，到 Spill Elevation 后向父洼地或出口溢流；
- 没有雨型时输出是静态累计有效降雨对应的潜在最大水深；
- 不模拟动量、流速、洪峰传播、潮位回水、桥涵、管网、动态排水或建筑阻水。

## 尚未完成的全域生产条件

当前小窗口实现已经包含 Depression Hierarchy / Fill–Spill–Merge 激活语义和
手算双洼地测试。全域版本仍必须将 Python heap、plateau 列表和内存中 merge
曲线替换为分块或 external-memory 实现，
并对 100 万、1000 万和全域 Cell 运行时间、RSS、输出耗时及质量误差基准。完成
这些工作前，本模块只能用于小窗口算法和 COG 链路验证。
