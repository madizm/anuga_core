# 鲅鱼圈模拟领域词汇

## Simulation Area（模拟区域）

一次模拟所使用的、由用户在全域 DEM 上选定的单一连续区域。模拟区域的权威表示是其 Cell Mask，而不是用户最初绘制的多边形。

## Cell Mask（计算单元掩膜）

属于某个模拟区域的有效 30 m DEM Cell 集合。集合不包含 DEM NoData Cell，且必须四邻域连通。

## Cell（计算单元）

全域 DEM 上一个 30×30 m 栅格单元。Cell 由全域 DEM 行列号稳定标识，例如 `r0123-c0456`。

## Area Hash（区域哈希）

由 Dataset Version、Cell Mask、DEM 网格定义及网格生成规则共同确定的模拟区域身份。不同绘制几何若解析为相同 Cell Mask，则具有相同 Area Hash。

## Dataset Version（数据集版本）

共同决定模拟输入值的一组全域栅格数据的不可变版本标识，包括 DEM、建筑覆盖率和曼宁糙率。

## Local Mesh（局部计算网格）

仅覆盖一个 Simulation Area 的 ANUGA 三角网格。每个 Cell 确定性拆分为两个三角形，外边界为透射边界。

## Inlet（入口）

Simulation Area 的 Cell Mask 内一个或多个四邻域连续 Cell 的集合，以及施加在这些 Cell 上的入流参数。
