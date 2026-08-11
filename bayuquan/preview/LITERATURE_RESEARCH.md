# Literature research for the Fill–Spill preview

This note identifies primary or publisher-hosted literature suitable for the
preview documentation. The papers describe the underlying algorithm families;
they do not validate this repository's implementation, make it authoritative,
or establish that it is suitable for full-domain or production use.

## Priority-Flood

Richard Barnes, Clarence Lehman, and David Mulla, “Priority-Flood: An optimal
depression-filling and watershed-labeling algorithm for digital elevation
models,” *Computers & Geosciences* 62 (2014), 117–127.
[Publisher/DOI](https://doi.org/10.1016/j.cageo.2013.04.024).
[Author manuscript PDF](https://arxiv.org/pdf/1511.04463).

The paper presents Priority-Flood as a priority-queue algorithm that floods a
DEM inward from its edges. It covers depression filling and variants for
watershed labels and flow directions on connected grids. This is the direct
reference for describing the preview's edge-seeded Priority-Flood terrain
preprocessing; it does not by itself justify the preview's later storage and
spill calculations.

## D8 flow routing and watershed assignment

John F. O'Callaghan and David M. Mark, “The extraction of drainage networks
from digital elevation data,” *Computer Vision, Graphics, and Image Processing*
28(3) (1984), 323–344.
[Publisher/DOI](https://doi.org/10.1016/S0734-189X(84)80011-0).

This is the foundational reference for the deterministic eight-neighbour,
single-flow-direction method commonly called D8. D8 assigns a cell to one of
its eight neighbours along the steepest downslope gradient, which requires the
elevation drop to be evaluated over the orthogonal or diagonal link distance.
Following receivers to their terminal depression or outlet supplies the
watershed assignment used by this preview.

## Depression hierarchy

Richard Barnes, Kerry L. Callaghan, and Andrew D. Wickert, “Computing water
flow through complex landscapes – Part 2: Finding hierarchies in depressions
and morphological segmentations,” *Earth Surface Dynamics* 8 (2020), 431–445.
[Open-access publisher article and DOI](https://doi.org/10.5194/esurf-8-431-2020).
[Open-access PDF](https://esurf.copernicus.org/articles/8/431/2020/esurf-8-431-2020.pdf).

The paper introduces the depression hierarchy as a forest of binary trees.
Leaf nodes represent the smallest nested depressions, and parent nodes arise
when depressions overflow into one another; the hierarchy retains their
topographic and topological connectivity until drainage to an external outlet.
This is the direct reference for the preview's nested-depression and
lowest-saddle hierarchy terminology.

## Fill–Spill–Merge

Richard Barnes, Kerry L. Callaghan, and Andrew D. Wickert, “Computing water
flow through complex landscapes – Part 3: Fill–Spill–Merge: flow routing in
depression hierarchies,” *Earth Surface Dynamics* 9 (2021), 105–121.
[Open-access publisher article and DOI](https://doi.org/10.5194/esurf-9-105-2021).
[Open-access PDF](https://esurf.copernicus.org/articles/9/105/2021/esurf-9-105-2021.pdf).

The companion paper presents Fill–Spill–Merge as runoff routing over a
depression hierarchy: runoff fills a depression, spills to a connected
neighbour after reaching the spill elevation, and merges the water surfaces
when both connected depressions are full. This supports the preview's finite
storage and hierarchical activation vocabulary. The paper's performance and
accuracy results belong to its own implementation and study areas and must not
be presented as benchmarks for this repository.

## Safe documentation scope

These references support describing the preview as a small-window CPU
implementation inspired by established terrain-processing and depression-flow
algorithms. Documentation should continue to state that the output is
non-authoritative, that the current implementation is not a shallow-water
dynamics model, and that full-domain operation still requires blocked or
external-memory engineering and separate validation.
