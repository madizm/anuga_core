# 鲅鱼圈洪水模拟

该上下文描述用户选择地形输入、界定计算区域并运行洪水模拟时使用的领域语言。

## Language

**DEM Product（DEM 产品）**:
一套不可变、可复现的地形输入，包含严格对齐的高程、建筑和糙率数据，以及来源、基准、分辨率与派生方法等身份信息。
_Avoid_: DEM 文件、地图图层

**Grid Resolution（网格分辨率）**:
DEM Product 中一个 Cell 的实际边长，也是展示栅格、计算网格和结果栅格共同使用的空间间隔。
_Avoid_: 数据精度

**Information Resolution（信息分辨率）**:
DEM Product 的地形信息最初被观测或采样的空间间隔；插值可以缩小 Grid Resolution，但不会改善 Information Resolution。
_Avoid_: 插值分辨率、显示精度

**Dataset Version（数据集版本）**:
共同决定一个 DEM Product 输入值的不可变版本标识，包括高程、建筑覆盖率和曼宁糙率。
_Avoid_: 当前版本

**Simulation Area（模拟区域）**:
一次模拟使用的、在某个 DEM Product 上选定的单一连续区域。其权威表示是 Cell Mask，而不是用户最初绘制的多边形。
_Avoid_: 绘制框、地图范围

**Cell Mask（计算单元掩膜）**:
属于一个 Simulation Area 的全部有效 Cell 集合；集合不包含 NoData Cell，且必须四邻域连通。
_Avoid_: GeoJSON、多边形

**Cell（计算单元）**:
某个 DEM Product 网格上的一个方形单元，由该产品内的行列号稳定标识，例如 `r0123-c0456`。
_Avoid_: 30 m Cell

**Area Hash（区域哈希）**:
由 Dataset Version、Cell Mask 和 DEM 网格定义共同确定的 Simulation Area 身份。不同绘制几何若解析为相同 Cell Mask，则具有相同 Area Hash。
_Avoid_: 场景 ID

**Local Mesh（局部计算网格）**:
仅覆盖一个 Simulation Area 的 ANUGA 三角网格，每个 Cell 确定性地对应两个三角形。
_Avoid_: DEM 网格

**Inlet（入口）**:
Simulation Area 内一个或多个四邻域连续 Cell 的集合，以及施加在这些 Cell 上的入流参数。
_Avoid_: 入流点
