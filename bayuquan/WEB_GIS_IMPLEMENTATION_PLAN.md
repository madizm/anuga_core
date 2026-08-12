# 鲅鱼圈 ANUGA Web GIS 实施计划

> **实施状态更新日期：2026-07-30（CST）**

> **架构替换（2026-07-15）**：固定 75×56 区域和固定 ANUGA mesh 的假设已废止。新流程先从全域 DEM 解析并锁定单个局部 `Simulation Area`，按其 `Cell Mask` 生成和缓存局部结构化 mesh，然后才允许编辑入口和提交任务。区域采用 Cell 中心点纳格、排除 NoData、四邻域连通、最多 25,000 Cell；详细决策见 `docs/adr/0001-local-computational-domains.md`。下文描述固定模型的章节是迁移基线，不再是目标领域模型。

当前替换进度：区域解析与缓存、确定性局部 mesh、全域建筑/Manning COG、不可变 Scenario/Job 区域快照、局部 ANUGA Worker、动态窗口 FrameRasterizer、五波段逐帧 COG、“先区域、后入口”编辑器和流向动态可视化均已接通。建筑源覆盖范围外按已确认规则解释为无建筑并使用场景基础 Manning。真实 Docker E2E 已覆盖“绘制区域→局部网格→入口→Job→三帧实时播放”；流向功能的真实 Docker 用例已加入测试套件，仍需在重建后的完整服务栈归档最终结果。

### 当前实施状态摘要

| 阶段 | 状态 | 截至 2026-07-15 的实施结果 |
|---|---|---|
| A：固定模型运行时 | 已完成 | 固定 mesh/NPZ、mesh hash 校验、多入口 Region/Inlet Operator、入口初始水位及水量报告均已实现。 |
| B：固定栅格与逐帧 COG | 已完成 | 预计算重心插值、五波段 COG、逐 yieldstep 原子发布、DEM 对齐校验和 SWW 保留均已实现。 |
| C：后端与任务队列 | 已完成 | FastAPI、SQLAlchemy/Alembic、PostGIS、Celery、Redis、MinIO、TiTiler、SSE 与 Docker Compose 已连通。 |
| D：Web GIS 编辑器 | 已完成 | 用户可在 MapLibre 中编辑、校验和提交多入口；DEM、建筑覆盖率和随场景切换的曼宁糙率图层均已接入。 |
| E：实时播放 | 已完成 | Job 进度、SSE 补帧、时间轴、跟随最新帧、三物理量切换、同步三联图、点选查询、双栅格缓冲和流向粒子动画已实现。 |
| F：端到端与工程加固 | 进行中 | 已有真实 Docker Playwright 流程、数值/API 回归和构建优化；故障矩阵、资源限制、结构化指标及完整运维文档仍待完成。 |

当前验证基线：

- 本次局部计算域及 API Python 回归：39 项通过，1 项因本机失效的 Meson editable ninja 路径跳过；
- 前端 Vitest：11 项通过；
- Playwright 流向深链接用例已通过，覆盖动画开启/关闭、二进制速度场解析和减少动态效果降级；真实 Docker 流向用例已加入完整三帧 Job 流程；
- 完整 6 小时场景已通过 Docker 运行，生成 73 帧并达到 `COMPLETED`；
- 已验证 MinIO 中后期帧 COG 可访问，帧 3、49、72 的瓦片均返回 HTTP 200；
- TiTiler 已设置 `GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR`，避免运行中新增 COG 被 GDAL 的 S3 目录缓存误判为不存在；
- API/Worker 的 Docker 原生 ANUGA 编译层已与服务源码分离，后续服务代码重建可复用编译缓存。
- 独立 DEM COG、瓦片接口、高程图例、建筑覆盖率及曼宁糙率图层已完成接入。

## 1. 文档目的

本文档定义鲅鱼圈洪水模拟 Web GIS 第一版的产品范围、交互设计、系统架构、数据契约、模拟执行、逐帧 COG 发布、测试标准和实施顺序。

系统目标是让用户在固定的 30 m DEM 网格上选择一个或多个入流区域，设置流量、速度和初始水位，提交 ANUGA 模拟，并在 `evolve` 运行过程中立即查看已经生成的水深、水位和流速帧。

---

## 2. 已确认的产品范围

### 2.1 支持范围

- 仅支持鲅鱼圈固定区域。
- 使用现有 DEM、建筑物和曼宁糙率成果。
- 使用固定 EPSG:32651 模型坐标系。
- 使用固定 ANUGA 三角网格。
- 支持多个入口，每个入口由一个或多个连续的 30×30 m DEM 网格组成。
- 每个入口独立设置：
  - 恒定总流量，单位 m³/s；
  - 零速度或速度分量；
  - 可选初始水面高程，单位 m。
- 外边界固定为透射边界。
- 每个 `yieldstep` 生成一个多波段 COG。
- 模拟运行中立即发布已完成帧。
- COG 同时包含水深、水位和流速。
- 保存 SWW、COG、日志、场景快照和汇总报告。

### 2.2 第一版不支持

- 其他地区或用户上传 DEM；
- `inflow_area` 概念；
- 自由绘制任意精度入口多边形；
- 用户和权限管理；
- 模拟任务取消；
- 自动删除历史任务；
- 用户自定义外边界条件；
- 多机 MPI 调度；
- 动态流量过程线；
- 排水管网；
- 实时修改正在运行的模拟参数。

---

## 3. 当前数据与成果基线

### 3.1 基础数据

| 数据 | 路径 | 说明 |
|---|---|---|
| DEM | `bayuquan/elevation.tif` | EPSG:32651，30 m |
| 建筑原始数据 | `OUTPUT/buildings/buildings.gpkg` | EPSG:32651 |
| 建筑覆盖率 | `OUTPUT/model/buildings/building_fraction_30m.tif` | 与 DEM 对齐 |
| 低糙率 | `OUTPUT/model/buildings/manning_low_30m.tif` | 30 m |
| 中糙率 | `OUTPUT/model/buildings/manning_middle_30m.tif` | 30 m |
| 高糙率 | `OUTPUT/model/buildings/manning_high_30m.tif` | 30 m |

### 3.2 历史固定网格映射

以下产物属于已经退役的固定区域实现，仅作为迁移基线记录。固定区域预处理器及其测试边界数据已经删除，当前系统按用户选择的 Cell Mask 动态生成局部网格。

历史产物：

| 文件 | 用途 |
|---|---|
| `bayuquan_fixed_mesh.msh` | 所有任务共用的固定 ANUGA 网格 |
| `grid_triangle_mapping.npz` | 网格 ID 到 ANUGA 三角形的运行时映射 |
| `triangle_grid_mapping.csv` | 映射审计表 |
| `dem_grid_cells.csv` | 网格属性表 |
| `dem_grid_cells.geojson` | 前端地图图层，EPSG:4326 |
| `dem_grid_cells.gpkg` | 后端/PostGIS 图层，EPSG:32651 |
| `mapping_report.json` | 映射统计和网格哈希 |

当前统计：

- 固定 ANUGA 三角形：12,503 个；
- DEM 网格：75×56，共 4,200 格；
- 可选择网格：4,087 格；
- 已映射三角形：12,503 个；
- 未映射三角形：0；
- 每格对应 1～6 个三角形。

### 3.3 权威数据原则

- 用户入口的权威表示是 `cell_id` 集合，而不是绘制多边形。
- ANUGA 网格的权威版本由 mesh SHA-256 标识。
- 前端不接触三角形编号和 NPZ 映射。
- Worker 必须加载固定 mesh，不能为每个任务重新生成网格。
- 所有输出 COG 必须与输入 DEM 使用相同网格原点、行列数和 30 m 分辨率。

---

## 4. 核心领域模型

### 4.1 Fixed Model

固定模型包含：

- 模拟区域；
- 固定 DEM 网格；
- 固定 ANUGA 三角网格；
- DEM 网格—三角形映射；
- 高程栅格；
- 建筑覆盖率；
- 三套曼宁糙率；
- 固定透射边界配置；
- 数据版本与哈希。

### 4.2 Scenario

场景是用户可编辑、可重复运行的参数集合：

```json
{
  "name": "多入口测试",
  "durationSeconds": 21600,
  "yieldstepSeconds": 300,
  "frictionScenario": "middle",
  "inlets": []
}
```

### 4.3 Inlet

每个入口包含：

```json
{
  "id": "inlet-001",
  "name": "西侧入口",
  "enabled": true,
  "cellIds": [
    "r0025-c0025",
    "r0025-c0026",
    "r0025-c0027"
  ],
  "dischargeM3s": 100.0,
  "velocityMode": "components",
  "velocityUMps": 1.5,
  "velocityVMps": -0.5,
  "initialWaterLevelM": 8.0,
  "displayColor": "#00D8FF"
}
```

约束：

- `cellIds` 不能为空；
- 同一入口内不能重复；
- 不同入口不能使用同一个网格；
- 入口网格必须四邻域连续；
- `dischargeM3s > 0`；
- 初始水位必须与 DEM 使用相同高程基准；
- 速度分量单位为 m/s；
- 禁用入口不进入任务快照。

### 4.4 Simulation Job

Job 是场景的一次不可变执行快照。场景后续修改不能改变已经提交的 Job。

### 4.5 Frame

Frame 对应一个 ANUGA `yieldstep`，包括：

- 帧序号；
- 模拟时间；
- 多波段 COG；
- 最大水深；
- 最大流速；
- 受淹面积；
- 发布时间。

---

## 5. UI 信息架构

### 5.1 页面布局

```text
┌──────────────────────────────────────────────────────────────┐
│ 鲅鱼圈洪水模拟 | 场景名称 | 保存 | 校验 | 运行模拟          │
├────────────┬──────────────────────────────┬──────────────────┤
│ 图层面板   │                              │ 入口与参数面板   │
│            │                              │                  │
│ DEM        │                              │ 入口1            │
│ 建筑覆盖率 │          Web GIS 地图        │ 入口2            │
│ 曼宁糙率   │                              │ + 新建入口        │
│ 30m网格    │                              │                  │
│ 模拟结果   │                              │ 场景参数         │
├────────────┴──────────────────────────────┴──────────────────┤
│ 播放 | 当前时间 | 时间轴 | 显示量 | 色带 | 透明度 | 播放速度 │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 视觉方向

采用“水动力调度台”风格：

- 深蓝灰底图；
- 青色表示入口和正常水体；
- 黄色、橙色、红色表示高风险；
- 所有数值明确显示单位；
- 图层和入口使用高辨识度颜色；
- 色带兼顾色觉障碍用户；
- 不依赖颜色作为唯一状态标识。

### 5.3 网格图层加载

前端加载：

```http
GET /api/model/grid
```

返回4,087个网格的 GeoJSON。第一版直接使用 GeoJSON，不引入矢量瓦片。

MapLibre 配置使用：

```typescript
promoteId: "cell_id"
```

通过 `feature-state` 高亮选择状态，避免每次选择都重建 GeoJSON。

网格线只在指定缩放级别以上显示。

### 5.4 入口创建流程

1. 点击“新建入口”；
2. 选择单击、画刷或框选模式；
3. 在30 m网格上选择连续网格；
4. 地图实时高亮并显示入口颜色；
5. 右侧显示网格、高程、面积和糙率统计；
6. 输入流量、速度和初始水位；
7. 保存入口；
8. 可继续创建其他入口。

### 5.5 网格选择交互

支持：

- 单击选择/取消；
- 按住 Shift 增加选择；
- 按住 Alt 删除选择；
- 鼠标画刷连续选择；
- 矩形框选；
- 清空当前入口；
- 地图定位当前入口。

前端即时检查：

- 网格是否属于可选集合；
- 当前入口是否连续；
- 是否与其他入口重叠。

后端仍需执行完整权威校验。

### 5.6 网格统计

每个入口显示：

```text
选中网格：3
几何面积：2,700 m²
ANUGA三角形：11
实际水力面积：2,845 m²
高程范围：3～7 m
平均高程：4.8 m
建筑覆盖率：0～12%
曼宁系数：0.04～0.08
```

几何面积：

\[
A_{grid}=N\times900
\]

实际水力面积：

\[
A_{anuga}=\sum_{i\in triangles}A_i
\]

两者均需展示，不应暗示完全相等。

### 5.7 速度输入

模式一：零速度。

```python
zero_velocity=True
```

模式二：分量输入。

- `u`：向东为正；
- `v`：向北为正。

模式三：速度和地图方位角。

- 方位角0°表示正北；
- 顺时针增加。

转换：

\[
u=V\sin(\theta)
\]

\[
v=V\cos(\theta)
\]

地图在入口中心显示方向箭头。

### 5.8 初始水位

每个入口支持：

- 初始干燥；
- 指定初始水面高程 `H0`。

选中三角形的初始状态：

\[
stage_i=\max(Z_i,H_0)
\]

其他区域：

\[
stage=Z
\]

如果多个入口空间重叠会导致初始水位和动量语义冲突，因此第一版禁止重叠。

UI 必须提示：初始水位只在 `t=0` 设置，不会持续维持。

### 5.9 运行前检查

提交前显示：

- 入口数量；
- 总流量；
- 总输入水量；
- 初始蓄水量；
- 输出帧数；
- 所有网格是否有效；
- 入口是否连续；
- 入口之间是否重叠；
- 流量和速度范围；
- 固定透射边界说明；
- 固定模型版本。

用户确认后创建 Job。

### 5.10 运行中体验

- 页面立即进入任务视图；
- 显示当前模拟时间和已发布帧数；
- 第一帧就绪后时间轴立即可用；
- 默认开启“跟随最新帧”；
- 用户可以暂停跟随并查看历史帧；
- 任务完成后保留完整时间轴。

### 5.11 结果播放

单图模式提供：

```text
[水深] [水位] [流速]
```

三联模式同步显示三幅地图：

- 同一帧；
- 同一中心点；
- 同一缩放级别；
- 同一鼠标位置。

时间轴支持：

- 播放/暂停；
- 上一帧/下一帧；
- 拖动跳转；
- 0.5×、1×、2×、5×；
- 跟随最新帧；
- 循环播放。

前端预加载当前帧前后各2帧，并使用双图层缓冲避免瓦片切换闪烁。

---

## 6. 系统架构

```text
┌──────────────────── React + MapLibre ─────────────────────┐
│ 网格选择、多入口参数、任务进度、COG动画                  │
└──────────────────────────┬────────────────────────────────┘
                           │ REST + SSE
                           ▼
┌──────────────────────── FastAPI ──────────────────────────┐
│ 固定模型、场景、空间校验、任务、帧清单、瓦片代理         │
└───────────────┬──────────────────────┬────────────────────┘
                │                      │
                ▼                      ▼
       PostgreSQL/PostGIS         Redis + Celery
       场景、几何、任务、帧        队列与进度事件
                                       │
                                       ▼
                           ANUGA Docker Worker
                           固定mesh + 多入口 + evolve
                                       │
                                       ▼
                           FrameRasterizer + COGWriter
                                       │
                                       ▼
                                  MinIO / S3
                                       │
                                       ▼
                                    TiTiler
                                       │
                                       ▼
                                   MapLibre
```

### 6.1 部署单元

Docker Compose 第一版包含：

```text
web
api
worker
postgres
redis
minio
titiler
```

Worker 并发初始设为1，避免多个 ANUGA 任务争用 CPU 和内存。并发需求明确后再增加 Worker 数量。

### 6.2 模块与接口

#### FixedModelCatalog 模块

接口负责提供：

- 固定模型版本；
- 网格 GeoJSON；
- mesh 路径和哈希；
- raster 路径；
- 网格—三角形映射；
- 栅格插值映射。

#### GridSelection 模块

接口：

```python
selection = grid_selection.resolve(cell_ids)
```

返回：

- 规范化 cell IDs；
- 三角形索引；
- 几何面积；
- 实际三角形面积；
- 高程统计；
- 连通性结果。

#### Scenario 模块

接口负责：

- 场景创建与更新；
- 参数规范化；
- 多入口冲突校验；
- Job 快照生成。

#### SimulationRunner 模块

接口：

```python
run_simulation(spec, frame_sink, progress_sink)
```

内部隐藏：

- ANUGA Domain 加载；
- 高程与糙率赋值；
- 多个 `Inlet_operator`；
- 初始水位；
- `evolve`；
- 水量报告。

#### FrameRasterizer 模块

接口：

```python
frame = rasterizer.rasterize(domain, time_seconds)
```

内部隐藏：

- 固定像元中心映射；
- 重心插值；
- 水深和流速计算；
- 干区掩膜；
- 栅格统计。

#### FramePublisher 模块

接口：

```python
published = publisher.publish(frame)
```

内部隐藏：

- 临时文件；
- COG 转换；
- 上传 MinIO；
- 数据库事务；
- SSE 事件。

---

## 7. 前端技术方案

### 7.1 技术栈

- React；
- TypeScript；
- Vite；
- MapLibre GL JS；
- TanStack Query；
- Zustand；
- Apache ECharts；
- Vitest；
- Playwright。

### 7.2 前端目录

```text
apps/web/src/
├── app/
├── map/
│   ├── ModelMap.tsx
│   ├── GridLayer.ts
│   ├── FrameLayer.ts
│   └── MapInspector.tsx
├── inlets/
│   ├── InletList.tsx
│   ├── GridSelectionTool.ts
│   ├── InletEditor.tsx
│   └── inletStore.ts
├── scenarios/
├── jobs/
├── playback/
├── api/
└── design-system/
```

### 7.3 前端状态

需要区分：

- 服务端场景状态；
- 当前未保存编辑状态；
- 当前地图选择工具状态；
- Job 实时状态；
- 帧播放状态。

不要把所有状态放进单个全局 Store。

---

## 8. 后端技术方案

### 8.1 技术栈

- FastAPI；
- Pydantic；
- SQLAlchemy；
- Alembic；
- PostgreSQL/PostGIS；
- Redis；
- Celery；
- boto3 或兼容 S3 客户端；
- pytest。

### 8.2 后端目录

```text
apps/api/
├── main.py
├── fixed_model/
├── scenarios/
├── grid_selection/
├── jobs/
├── frames/
├── events/
├── storage/
└── db/

apps/worker/
├── tasks.py
├── simulation/
│   ├── spec.py
│   ├── runner.py
│   ├── inlet_factory.py
│   └── initial_conditions.py
├── raster/
│   ├── interpolation.py
│   ├── frame_rasterizer.py
│   └── cog_writer.py
└── publishing/
    ├── frame_publisher.py
    └── progress_publisher.py
```

---

## 9. 数据库设计

### 9.1 `fixed_model_versions`

```text
id
name
crs
mesh_sha256
mesh_uri
grid_uri
dem_uri
building_fraction_uri
manning_low_uri
manning_middle_uri
manning_high_uri
created_at
```

第一版只有一个 active 版本，但 Job 必须保存版本 ID。

### 9.2 `model_grid_cells`

```text
cell_id primary key
row
column
geometry Polygon EPSG:32651
elevation_m
building_fraction
manning_low
manning_middle
manning_high
triangle_count
effective_triangle_area_m2
selectable
```

### 9.3 `scenarios`

```text
id UUID
name
duration_seconds
yieldstep_seconds
friction_scenario
created_at
updated_at
```

### 9.4 `scenario_inlets`

```text
id UUID
scenario_id UUID
name
enabled
discharge_m3s
velocity_mode
velocity_u_mps
velocity_v_mps
initial_water_level_m
display_color
sort_order
```

### 9.5 `scenario_inlet_cells`

```text
inlet_id UUID
cell_id
primary key (inlet_id, cell_id)
```

数据库约束确保同一入口不重复。不同入口冲突由场景事务校验。

### 9.6 `simulation_jobs`

```text
id UUID
scenario_id UUID
fixed_model_version_id
status
scenario_snapshot JSONB
current_frame
frame_count
simulation_time_seconds
maximum_depth_m
applied_volume_m3
final_water_volume_m3
error_code
error_message
created_at
started_at
completed_at
```

状态：

```text
QUEUED
PREPARING
RUNNING
COMPLETED
FAILED
```

### 9.7 `simulation_frames`

```text
job_id UUID
frame_index
time_seconds
cog_uri
maximum_depth_m
maximum_speed_mps
wet_area_m2
created_at
primary key (job_id, frame_index)
unique (job_id, time_seconds)
```

### 9.8 `simulation_artifacts`

```text
id UUID
job_id UUID
type
uri
size_bytes
sha256
created_at
```

Artifact 类型：

```text
SWW
LOG
REPORT
MAX_DEPTH_COG
FRAME_MANIFEST
SCENARIO_SNAPSHOT
```

---

## 10. HTTP 接口

### 10.1 固定模型

```http
GET /api/model
GET /api/model/grid
GET /api/model/grid/{cellId}
```

`GET /api/model` 返回：

```json
{
  "version": "9bf89256",
  "crs": "EPSG:32651",
  "gridRows": 56,
  "gridColumns": 75,
  "cellSizeM": 30,
  "selectableCellCount": 4087,
  "gridManifestUrl": "/api/dem-products/{productId}/simulation-areas/{areaHash}/grid/manifest",
  "boundaryCondition": "transmissive"
}
```

### 10.2 场景

```http
POST /api/scenarios
GET /api/scenarios
GET /api/scenarios/{scenarioId}
PUT /api/scenarios/{scenarioId}
POST /api/scenarios/{scenarioId}/validate
```

场景整体更新采用单次事务，不为每个入口暴露大量局部修改接口。

### 10.3 任务

```http
POST /api/scenarios/{scenarioId}/jobs
GET /api/jobs
GET /api/jobs/{jobId}
GET /api/jobs/{jobId}/frames
GET /api/jobs/{jobId}/events
```

不提供取消接口。

### 10.4 帧和瓦片

```http
GET /api/jobs/{jobId}/frames/{frameIndex}
GET /api/jobs/{jobId}/frames/{frameIndex}/flow
GET /api/jobs/{jobId}/frames/{frameIndex}/tilejson/{quantity}
GET /api/jobs/{jobId}/frames/{frameIndex}/tiles/{quantity}/{z}/{x}/{y}.png
```

`quantity`：

```text
depth
stage
speed
```

API 可以代理 TiTiler，避免前端接触 MinIO 内部地址。

`flow` 返回 `application/vnd.bayuquan.flow-field` 二进制数据：44-byte little-endian
头部依次包含魔数 `BQFV`、协议版本、宽、高、保留字段和 WGS84 边界，随后是逐
Cell 交错排列的 Float32 `velocity_u, velocity_v`。干区向量写为 NaN。协议带版本，
前端必须拒绝未知版本和长度不一致的数据。

---

## 11. 场景校验

### 11.1 基础校验

- 场景至少有一个启用入口；
- 模拟时间为正；
- `yieldstep` 为正且不大于模拟时间；
- 输出帧数在配置上限内；
- 糙率场景只能为 low/middle/high。

### 11.2 网格校验

- 所有 `cell_id` 存在；
- 所有网格 `selectable=true`；
- 每个入口内部无重复；
- 不同入口无交集；
- 每个入口四邻域连通。

四邻域：

```text
(row-1, col)
(row+1, col)
(row, col-1)
(row, col+1)
```

### 11.3 水动力参数校验

- 流量有限且大于0；
- 速度有限；
- 初始水位有限；
- 初始水位与网格高程差超出配置阈值时给出警告；
- 总流量和总水量超出配置阈值时给出警告或拒绝。

### 11.4 校验结果

返回错误和警告，错误阻止运行，警告由用户确认。

---

## 12. ANUGA Worker 实现

### 12.1 固定网格加载

```python
domain = anuga.Domain("bayuquan_fixed_mesh.msh")
```

加载后显式补齐 EPSG:32651 和北半球元数据，同时保持 mesh 原有局部原点。

Worker 启动时验证：

- mesh SHA-256；
- NPZ 中的 mesh SHA-256；
- 三角形数量；
- DEM网格形状；
- 栅格原点和分辨率。

任何不一致立即失败，禁止继续模拟。

### 12.2 高程与糙率

- 高程从固定 DEM 采样；
- 曼宁系数按场景选择 low/middle/high；
- 初始全域 `stage=elevation`；
- 初始动量为0。

### 12.3 网格到 Region

```python
selected_linear_cells = row * ncols + column
triangle_ids = np.flatnonzero(
    np.isin(mapping["triangle_cell_index"], selected_linear_cells)
)
region = anuga.Region(domain, indices=triangle_ids)
```

多个入口的三角形集合必须无交集。

### 12.4 初始水位

对每个入口：

```python
stage[triangle_ids] = np.maximum(
    elevation[triangle_ids],
    initial_water_level,
)
```

需要同时保持 centroid 和 vertex 表示一致，并在模拟前计算初始水量。

### 12.5 创建多个 Inlet Operator

```python
for inlet in spec.inlets:
    anuga.Inlet_operator(
        domain,
        region=inlet.region,
        Q=inlet.discharge_m3s,
        velocity=inlet.velocity,
        zero_velocity=inlet.zero_velocity,
        label=inlet.id,
    )
```

### 12.6 固定透射边界

```python
boundary = anuga.Transmissive_boundary(domain)
domain.set_boundary({"open": boundary})
```

前端不提供修改入口。

### 12.7 运行循环

```python
for time in domain.evolve(
    yieldstep=spec.yieldstep_seconds,
    finaltime=spec.duration_seconds,
):
    frame = rasterizer.rasterize(domain, time)
    publisher.publish(frame)
    progress.publish(time)
```

SWW 持续写入，帧同时发布。

### 12.8 水量报告

报告至少包含：

- 每个入口请求和实际施加流量；
- 每个入口累计输入体积；
- 总输入体积；
- 初始水体积；
- 最终域内水体积；
- 推算边界流出体积；
- 最大水深；
- 最大流速；
- 曾经受淹面积；
- 模拟耗时；
- 模型版本与参数快照。

---

## 13. 固定栅格插值

### 13.1 为什么需要预计算

每帧重新搜索4,200个像元属于哪个三角形没有必要。固定 mesh 和固定输出网格允许一次性建立插值映射。

下一项预处理成果：

```text
OUTPUT/model/grid_mapping/raster_interpolation_mapping.npz
```

包含：

- 每个有效像元中心所在三角形；
- 三个重心插值权重；
- 模拟区域 mask；
- mesh SHA-256；
- 栅格 transform；
- 行列数。

### 13.2 插值方式

对每个像元中心使用固定三角形和重心权重：

\[
q_p=w_1q_1+w_2q_2+w_3q_3
\]

适用于：

- stage；
- elevation；
- xmomentum；
- ymomentum。

派生：

\[
depth=\max(stage-elevation,0)
\]

\[
speed=\frac{\sqrt{xmomentum^2+ymomentum^2}}
{\max(depth,\epsilon)}
\]

### 13.3 网格参数

必须固定为：

```text
rows: 56
columns: 75
cellsize: 30 m
xllcorner: 430266.732731661061
yllcorner: 4460689.216226855293
upper-left y: 4462369.216226855293
CRS: EPSG:32651
```

禁止使用 `sww2dem` 自动推导新的原点，否则输入网格和输出像元可能错位。

---

## 14. 多波段 COG 规范

### 14.1 文件组织

```text
jobs/{jobId}/
├── input/scenario.json
├── frames/
│   ├── 000000000.tif
│   ├── 000000300.tif
│   └── ...
├── result/model.sww
├── result/maximum_depth.tif
├── result/report.json
└── logs/worker.log
```

帧文件名使用模拟秒数，零填充后便于字典序排序。

### 14.2 波段

| 波段 | 名称 | 单位 | 描述 |
|---:|---|---|---|
| 1 | depth | m | 水深 |
| 2 | stage | m | 绝对水面高程 |
| 3 | speed | m/s | 流速大小 |
| 4 | velocity_u | m/s | 东向速度分量，向东为正 |
| 5 | velocity_v | m/s | 北向速度分量，向北为正 |

### 14.3 格式

- Float32；
- EPSG:32651；
- 30 m；
- NoData = −9999；
- DEFLATE 或 ZSTD；
- TILED=YES；
- 每个波段写入描述和单位；
- 使用内部 mask；
- 大栅格才需要 overviews，当前75×56无需强制生成。

### 14.4 干区

- `depth` 数据保留为0；
- 当 `depth < 0.01 m` 时将显示 mask 设置为透明；
- stage、speed、velocity_u 和 velocity_v 在干区同样透明；
- 数据值和显示 mask 分离，保留后续分析能力。

### 14.5 原子发布

每帧必须按以下顺序：

1. 写入本地临时 GeoTIFF；
2. 转换为 COG；
3. 使用 GDAL/rasterio 验证；
4. 上传到临时对象键；
5. 服务端复制或重命名到最终对象键；
6. 写入 `simulation_frames`；
7. 提交数据库事务；
8. 发布 `frame.ready`。

前端永远不能看到半写入文件。

---

## 15. 实时事件设计

### 15.1 SSE 端点

```http
GET /api/jobs/{jobId}/events
Accept: text/event-stream
```

### 15.2 事件类型

#### `job.status`

```json
{
  "status": "RUNNING",
  "simulationTimeSeconds": 1800,
  "finalTimeSeconds": 21600,
  "currentFrame": 6,
  "frameCount": 73
}
```

#### `frame.ready`

```json
{
  "frameIndex": 6,
  "timeSeconds": 1800,
  "maximumDepthM": 1.95,
  "maximumSpeedMps": 2.1,
  "wetAreaM2": 85000,
  "tilejson": {
    "depth": "/api/jobs/.../tilejson/depth",
    "stage": "/api/jobs/.../tilejson/stage",
    "speed": "/api/jobs/.../tilejson/speed"
  }
}
```

#### `job.completed`

包含最终报告和 artifacts。

#### `job.failed`

包含稳定错误码和面向用户的错误信息。

### 15.3 重连

- SSE 事件带递增 ID；
- 前端使用 `Last-Event-ID` 重连；
- 重连后先调用帧清单接口补齐遗漏帧；
- Redis 只用于实时广播，PostgreSQL 是任务和帧状态的权威来源。

---

## 16. TiTiler 与地图显示

### 16.1 波段选择

同一个 COG 通过不同 `bidx` 提供：

- depth → band 1；
- stage → band 2；
- speed → band 3。

### 16.2 色带

水深默认分级：

```text
0.01–0.30 m
0.30–0.50 m
0.50–1.00 m
1.00–2.00 m
2.00–3.00 m
>3.00 m
```

水位使用连续感知均匀色带。流速使用浅黄—橙—红色带。

### 16.3 数值查询

点击地图时后端从对应 COG 读取三个波段，返回：

```json
{
  "timeSeconds": 1800,
  "depthM": 1.24,
  "stageM": 6.82,
  "speedMps": 0.73
}
```

---

## 17. 对象存储

### 17.1 Bucket

```text
fixed-models
simulation-jobs
```

### 17.2 不删除策略

第一版不实现删除和生命周期规则。仍应记录：

- 每个对象大小；
- 每个 Job 总大小；
- Bucket 总使用量。

这是可观测性，不是删除策略。

---

## 18. 可靠性设计

### 18.1 Job 幂等性

- Job ID 唯一；
- 每次运行写入 attempt 前缀；
- 成功后将 attempt 标记为当前成果；
- Celery 重试不能覆盖已完成 Job；
- 数据库状态变更使用事务和条件更新。

### 18.2 Worker 失败

第一版 Worker 崩溃后可将任务标记为 FAILED，不要求从检查点恢复。用户可以从同一场景重新创建 Job。

已经完成的帧保留并可查看，但任务状态明确标记失败。

### 18.3 数值保护

- 检查 NaN/Inf；
- 检查负水深容差；
- 检查累计输入水量；
- 检查 COG band 范围；
- 检查帧时间严格递增；
- 检查最终时间等于配置；
- 检查入口实际面积大于0。

---

## 19. 测试计划

### 19.1 网格映射测试

- 12,503个三角形全部映射；
- 三角形只映射一次；
- 映射 mesh 哈希一致；
- 4,087个 cell ID 唯一；
- GPKG 几何全部有效；
- 任意 cell ID 转换后的 `Region.indices` 与映射一致；
- `Region.get_area()` 与映射三角形面积之和一致。

### 19.2 场景校验测试

- 不存在 cell ID 被拒绝；
- 空入口被拒绝；
- 不连续入口被拒绝；
- 多入口重叠被拒绝；
- 非法流量和速度被拒绝；
- 初始水位异常产生正确警告。

### 19.3 ANUGA测试

- 单入口恒定流量体积：`Q×T`；
- 多入口总体积：`T×ΣQ`；
- 每个 Inlet Operator 的累计体积正确；
- 初始水量计算正确；
- 初始水位只作用于选中三角形；
- 固定透射边界生效；
- 同一配置重复运行使用相同三角网格。

### 19.4 栅格测试

- COG 为75×56；
- transform 与 DEM 完全一致；
- CRS 为EPSG:32651；
- 三个波段顺序正确；
- depth 非负；
- 干区 mask 正确；
- COG 与 ANUGA 三角形抽样值误差在容限内；
- 帧时间与文件名一致。

### 19.5 API测试

- 场景事务更新；
- 校验接口；
- Job 快照不可变；
- 帧发布后清单立即可见；
- 重复帧不能插入；
- SSE 断线重连；
- FAILED 状态错误信息稳定。

### 19.6 前端测试

使用 Vitest 和 Playwright：

- 网格单击、框选、画刷；
- 多入口颜色和选择隔离；
- 重叠入口提示；
- 参数编辑；
- 场景提交；
- 接收第一帧事件后显示地图；
- 时间轴随着帧增加；
- 三个波段切换；
- SSE 重连后帧不丢失；
- 三联地图同步。

### 19.7 端到端测试

测试流程：

1. 启动 Docker Compose；
2. 创建两个入口；
3. 每个入口选择连续网格；
4. 设置不同 Q、速度和初始水位；
5. 运行短时模拟；
6. 等待第一帧；
7. 验证地图可见；
8. 等待完成；
9. 验证所有帧、SWW和报告；
10. 核对总输入水量。

保留现有100 m³/s、6小时场景作为回归基线。

---

## 20. 可观测性

每个 Job 记录：

- 排队时间；
- 网格加载时间；
- 初始化时间；
- 每个 `yieldstep` 计算时间；
- 每帧栅格化时间；
- 每帧 COG 写入时间；
- 上传时间；
- 总运行时间；
- SWW 和 COG 大小；
- 当前内存；
- 数值警告；
- 水量平衡。

日志使用结构化 JSON，并带 `job_id`、`frame_index` 和 `simulation_time_seconds`。

---

## 21. 安全与资源限制

虽然第一版没有用户系统，仍需限制：

- 最大入口数量；
- 单入口最大网格数；
- 最大总流量；
- 最大速度；
- 最大模拟时间；
- 最小 `yieldstep`；
- 最大输出帧数；
- Worker CPU 和内存；
- API 请求体大小。

这些限制通过后端配置管理，前端同步展示。

---

## 22. 实施阶段

### 阶段 A：固定模型运行时（已完成）

交付：

- 固定 mesh 加载；
- NPZ 映射加载；
- mesh/hash 校验；
- cell IDs → triangle IDs；
- 多入口 Region；
- 多个 Inlet Operator；
- 每入口初始水位；
- 配置驱动的 Worker CLI；
- 水量报告。

完成标准：单入口和多入口 Docker 模拟通过体积守恒测试。

### 阶段 B：固定栅格与逐帧 COG（已完成）

交付：

- `raster_interpolation_mapping.npz`；
- FrameRasterizer；
- 五波段 COGWriter（depth/stage/speed/velocity_u/velocity_v）；
- DEM 对齐验证；
- 每帧统计；
- 原子文件发布；
- SWW 保留。

完成标准：运行中每个 `yieldstep` 都能生成有效、对齐的 COG。

### 阶段 C：后端与任务队列（已完成）

交付：

- FastAPI；
- 数据库迁移；
- 固定网格接口；
- 场景接口；
- 空间和参数校验；
- Job 创建与状态机；
- Celery Worker；
- MinIO；
- SSE；
- Docker Compose。

完成标准：通过 HTTP 创建场景并运行任务，第一帧在模拟结束前可访问。

### 阶段 D：Web GIS 编辑器（已完成）

交付：

- MapLibre地图；
- DEM、建筑、网格图层；
- 多入口网格选择；
- 入口列表；
- 流量、速度、初始水位编辑；
- 前端校验；
- 运行前检查；
- 场景保存。

完成标准：用户无需编辑 JSON 即可提交多入口场景。

实施备注：完成标准已达到；DEM 使用独立 COG 瓦片，建筑覆盖率和曼宁糙率使用固定网格属性渲染，并具有独立图例和图层控制。

### 阶段 E：实时播放（已完成）

交付：

- Job进度；
- SSE帧接收；
- TiTiler集成；
- 时间轴；
- 跟随最新帧；
- 水深/水位/流速切换；
- 三联视图；
- 点选查询；
- 帧预加载与双图层缓冲。

完成标准：模拟运行中第一帧可见，后续帧自动追加且播放无明显闪烁。

### 阶段 F：端到端与工程加固（进行中）

交付：

- Playwright E2E；
- 数值回归；
- 故障场景测试；
- 日志和指标；
- 资源限制；
- 运维说明；
- 数据和模型版本说明。

完成标准：从网格选择到结果播放的完整 Docker 环境自动测试通过。

---

## 23. 验收标准

### 功能验收

状态标记：`[x]` 已实现并验证，`[~]` 已实现但仍需扩大验收覆盖，`[ ]` 尚未完成。

- [x] 能加载全部4,087个可选网格；
- [~] 能创建至少5个互不重叠入口；多入口机制和重叠防护已实现，五入口浏览器验收用例待补；
- [x] 每个入口能设置独立 Q、速度和初始水位；
- [x] 后端能拒绝不连续和重叠入口；
- [x] 模拟固定使用透射边界；
- [x] 第一帧在任务结束前出现在地图；
- [x] 每帧同时包含 depth/stage/speed；
- [x] 时间轴能播放所有已发布帧；
- [~] SWW、COG、场景快照和报告已永久保存；Worker 日志对象化和永久保存尚未完成。

### 数值验收

- [x] 所有三角形映射且只映射一次；
- [x] 多入口累计输入体积与理论值一致；
- [x] 初始水位只作用于选择区域；
- [x] COG transform 与 DEM 完全一致；
- [x] 栅格化和 COG 校验拒绝 NaN/Inf；
- [x] 干区不显示为水面，API 使用 depth tile 强制执行 `depth >= 0.01 m` 显示遮罩；
- [~] 已有固定重心插值和合成数据测试；仍需归档真实 ANUGA 三角形与 COG 抽样误差报告。

### 性能验收

针对当前75×56输出网格：

- [x] 网格图层使用 GeoJSON `promoteId` 和 feature-state，首次加载及选择交互流畅；
- [x] 单击、画刷和框选无明显延迟；
- [~] 75×56 COG 未成为当前模拟的主要瓶颈，但正式耗时阈值和长期指标尚未固化；
- [~] `frame.ready` 后可立即请求瓦片，仍需记录端到端发布延迟分位数；
- [x] 时间轴使用双栅格源缓冲和淡入切换，不出现持续白屏。

---

## 24. WebFlood 原型调研与可借鉴方向

对本地参考工程 `/Users/madizm/geovis/bayuquan/hl` 进行了调研。该工程是基于
`aeplay/WebFlood` 的浏览器端 WebGL 浅水模拟原型，使用 GLSL、浮点纹理和
ping-pong FBO 在 GPU 中更新水深与速度，并在此基础上增加了中文界面、降雨、
排水、街道风险分级等功能。

调研结论是：参考工程的实时表达和面向业务的产品思路值得吸收，但其浏览器端
求解器、数据格式和工程实现不应直接进入本系统。ANUGA、不可变 Job、逐帧 COG、
权威后端校验及可复现任务快照继续作为正式计算链路。

### 24.1 借鉴事项及优先级

#### P0：流向动态可视化

流向动态可视化调整为全部借鉴事项中的最高优先级。参考工程通过
`flow-viz-f.glsl` 沿速度场对噪声纹理积分，形成动态流线；本系统借鉴其表达
目标，不复用旧 GLSL 或旧模拟状态纹理。

目标方案：

- 正式结果增加 `velocity_u` 和 `velocity_v` 数据，或提供等价的权威矢量场接口；
- 前端在 MapLibre 结果地图上提供粒子、流线或方向箭头图层；
- 流向图层与现有水深、水位、流速标量图层同步使用同一 Job 和 Frame；
- 干区和低于可配置速度阈值的区域不显示流向；
- 图例同时表达方向与速度，动画速度只用于可读性，不能暗示真实时间倍率；
- 单图和三联图模式均可启用，地图移动、缩放和帧切换时不得残留上一帧粒子；
- 为低性能设备提供箭头或静态流线降级模式，并遵守减少动态效果的系统设置；
- E2E 验证帧切换、暂停播放、三联同步、干区遮罩和降级模式。

数据契约优先考虑把帧 COG 从现有三波段扩展为五波段：

| 波段 | 名称 | 单位 |
|---:|---|---|
| 1 | depth | m |
| 2 | stage | m |
| 3 | speed | m/s |
| 4 | velocity_u | m/s，向东为正 |
| 5 | velocity_v | m/s，向北为正 |

实施前需要用真实 ANUGA 帧验证从动量和水深派生速度分量的干湿阈值、插值误差、
瓦片传输成本和浏览器渲染性能，再决定采用多波段 COG、独立矢量场资源或二者
组合。标量 `speed` 仍保留为权威便捷查询结果。

首个纵向切片已于 2026-07-30 完成：FrameRasterizer 和 COGWriter 已发布五波段
结果；API 通过版本化二进制接口发布湿区交错 `u/v` 速度场；结果地图支持流向
粒子、帧切换清理、单图/三联图显示，以及 `prefers-reduced-motion` 静态箭头降级。
剩余工作是使用完整 Docker 真实 Job 归档传输成本、流向插值误差和低性能设备
帧率基准。

#### P1：空间化累计灾害成果

参考工程持续累计最大水深、最大流速和淹没持续时间。本系统目前在 Worker 中
已经计算部分累计数组和全局标量，但尚未完整发布空间成果。计划新增：

- `maximum_depth.tif`；
- `maximum_speed.tif`；
- `flood_duration.tif`；
- `arrival_time.tif`，记录首次超过湿润阈值的时间；
- 相应的 TileJSON、瓦片、点选查询、图例和下载入口。

累计成果必须由 Worker 基于权威 ANUGA 帧生成，使用与局部计算域 DEM 完全一致的
CRS、transform、mask 和 30 m 网格，并在 Job 完成后作为不可变 Artifact 发布。

#### P1：监测点与过程线

参考工程允许在地图上添加 Gauge 并显示水深过程线。本系统应将其深化为可复现的
场景监测点：

- 用户可在计算域内添加、命名、移动和删除监测点；
- 监测点随 Scenario 保存，并进入不可变 Job 快照；
- Worker 在每个 yieldstep 提取水深、水位、流速及速度分量；
- API 返回完整时间序列、峰值、峰现时间和首次受淹时间；
- 前端显示过程线，并支持 CSV 导出；
- 点位必须记录 WGS84 展示坐标、模型 CRS 坐标及其解析到的 Cell，避免坐标歧义。

参考工程界面中的“流量分析”实际读取的是单点水深，不应沿用该命名。本系统只有
在具有断面及积分定义时才使用“流量”，普通点位统一称为“监测点”或“水深过程线”。

#### P2：街道及重点对象风险汇总

参考工程尝试按街道点位统计低、中、高、极高风险。应保留“把水动力结果转化为
管理对象风险”的产品方向，但改为权威空间统计：

- 街道、社区、道路、医院、学校等对象使用带版本的 Polygon、LineString 或 Point
  数据集；
- 对面对象统计最大水深、最大流速、淹没面积比例、到达时间和持续时间；
- 对线和点对象采用适合其几何类型的采样与汇总方法；
- 风险规则必须配置化、可版本化，并记录阈值标准来源；
- 前端展示各等级数量、对象名单、排序依据，并支持点击定位和导出；
- 风险结果必须关联 Job、对象数据版本和规则版本。

不采用参考工程的单点代表整条街道和硬编码瞬时水深阈值做法。其 JavaScript 中
`0.2 < height <= 0.5` 一类连续比较也不符合 JavaScript 区间语义，不能复用。

#### P2：防洪工程交互试验与方案对比

参考工程支持直接在运行中的纹理上绘制障碍物。借鉴其快速试验意图，但不允许
修改正在运行的正式模拟：

1. 用户绘制堤线、挡水墙或局部抬高区；
2. 几何吸附并解析到模型 Cell 或 mesh 边；
3. 干预措施作为 Scenario 的可校验、可版本化输入；
4. 每次修改创建新的不可变 Job；
5. 提供基准 Job 与干预 Job 的最大水深差、淹没面积差、风险对象变化和水量报告
   对比。

需要先确认 ANUGA 中堤线、抬高地形和内部边界的权威表示，再确定领域模型和 UI。

#### P3：降雨与排水场景

参考工程加入了降雨量和排水量输入，说明内涝场景有明确价值。正式扩展方向包括：

- 均匀降雨和栅格化降雨；
- 带时间变化的设计雨型或实测雨型；
- 排水能力栅格；
- 排水口、泵站及能力曲线；
- 降雨、河流入口和排水设施的组合场景；
- 对每类源汇分别进行水量平衡和报告。

所有源汇必须通过明确单位、时间过程和 ANUGA Operator 实现。参考工程把
`rainHeight` 加入每次 shader 纹理采样、把排水量直接从单步水深扣除的做法存在
重复施加和量纲不明确问题，不可复用。

#### P3：结果下载中心

参考工程提供浏览器 TIFF 导出，说明用户需要把模拟成果带出系统。本系统不复用
其无完整地理参考的 16-bit TIFF 写法，而是在现有 Artifact 和对象存储体系上提供：

- 单帧或批量 COG；
- 累计灾害 COG；
- SWW；
- Scenario/Job 快照；
- 水量与风险报告；
- 监测点过程线 CSV；
- 对象风险统计 CSV/GeoJSON；
- 文件大小、SHA-256、生成时间和数据版本。

下载应使用后端授权或代理地址，不暴露 MinIO 内部 URI。

#### P4：浏览器快速预览模式（阶段 0～4 已实现）

浏览器预览作为独立的、非权威的方案草绘能力，不替代 ANUGA 正式计算。当前
实现使用维护中的 WebGL2 API 和 ping-pong 浮点 FBO，与 MapLibre 自定义图层连接；
不直接移植旧 GLOW.js/WebFlood 代码。预览输入使用当前未保存草稿，结果只存在
浏览器内存中，不写入 Job、COG、SWW、历史记录或正式报告。

当前交付：

- WebGL2、`EXT_color_buffer_float` 和浮点帧缓冲能力检测；
- 紧凑 `SimulationGrid` 到南北方向明确的规则 GPU 网格展开；
- 入口总流量、速度、初始水位、雨型和 Manning 场景映射；
- CPU reference 与规则栅格 Rusanov 通量、湿干保护和摩阻更新；
- WebGL2 GPU 状态双缓冲、动态时间步估计和浏览器状态快照；
- 动态和静态模式的容量、快照频率及渲染差异以 `apps/web/README.md` 为准；
- GPU 多级最大波速归约只回读单个 float，CFL 更新不再依赖完整状态回读；
- 静态模式将 React 进度发布限制为最高 4 Hz；
- 1M 模式启动前执行 1024×1024 浮点状态纹理试分配，初始化失败时主动释放私有 WebGL 上下文；
- 完整快照复用双缓冲矢量/半浮点数组，并移除未消费的独立水深数组；
- 1M Cell Chrome/WebGL2 性能基准及基线以 `apps/web/docs/static-preview-benchmark.md`
  为准；
- MapLibre 水面、地形贴合和流向粒子适配；
- 开始、暂停、重置、模拟倍率、显示量、流向开关和当前时间控制；
- 场景参数变化后预览失效，区域/DEM/正式任务切换时释放预览资源；
- 将堤防、简化河道、排水口和静态溃口编译为共享的水工预览模型，并将其作为
  CPU reference 与 WebGL2 Adapter 的共同输入；
- 对断面河道、涵洞和桥梁显示兼容性提示，不静默忽略其工程影响；
- 预览与正式 ANUGA 结果使用不同视觉标识和数据生命周期。

当前明确限制：堤防、简化河道、排水口和静态溃口目前只提供规则栅格近似，
不代表正式工程语义；断面河道、涵洞和桥梁尚未纳入浏览器 solver。所有这些
要素的工程结论仍必须提交 ANUGA 正式模拟。

### 24.2 明确不借鉴的实现

- 不使用浏览器 GPU 求解器替代 ANUGA；
- 不复用硬编码在 shader 中的边界条件、降雨和排水算法；
- 不复用缺少 CRS、transform、NoData 和原子发布保证的浏览器 TIFF；
- 不把模拟参数、显示参数、资源路径和业务对象混装在可变的单个 JSON 对象中；
- 不使用单点瞬时水深替代街道或行政区空间风险；
- 不允许用户直接修改运行中 Job 的地形或水动力状态。

### 24.3 推荐交付顺序

1. 流向动态可视化的数据可行性原型、真实帧性能基准与正式实现；
2. 最大水深、最大流速、淹没时长和到达时间累计 COG；
3. 场景监测点、过程线 API、图表及 CSV 导出；
4. 街道和重点对象数据模型、空间统计及风险规则版本；
5. 防洪干预领域模型与基准/方案 Job 对比；
6. 降雨和排水 Operator；
7. 统一结果下载中心；
8. 增加断面河道栅格化近似、涵洞/桥梁结构 link，并基于真实设备基准评估 WebGPU Adapter。

## 25. 下一步

截至 2026-07-15，阶段 A、B、C、D、E 已完成。下一项产品增强优先实施流向动态
可视化，同时继续完成阶段 F 的工程加固：

1. 验证 `velocity_u`/`velocity_v` 栅格契约并实现流向粒子、流线或箭头原型；
2. 使用真实 ANUGA 帧建立流向动态可视化的插值误差、传输成本、帧切换和浏览器性能基准；
3. 建立 QUEUED、PREPARING、RUNNING、FAILED、TiTiler/MinIO 不可用及 SSE 断线的故障场景矩阵；
4. 增加最大入口数、单入口网格数、总流量、速度、模拟时长、最小 yieldstep 和最大帧数限制；
5. 完成 Worker 结构化 JSON 日志、耗时、内存、对象大小和水量平衡指标；
6. 增加长时间轴播放、SSE 重连和中后期 COG 可访问性的自动回归，覆盖 GDAL S3 目录缓存问题；
7. 编写部署、备份、恢复、升级、故障排查以及数据和固定模型版本说明；
8. 在完整 Docker 环境运行最终数值回归和端到端验收，并归档验收报告。
