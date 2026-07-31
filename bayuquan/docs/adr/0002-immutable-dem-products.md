# Bind display and simulation to immutable DEM products

The workbench selects an immutable DEM Product before resolving a Simulation Area, and the resulting scenario and job retain that product identity. Display tiles, terrain values, computational cells, and result rasters use the product's same grid resolution; visual smoothing may occur only during screen rendering. This favors reproducibility and avoids showing terrain detail different from the model input, at the cost of making finer interpolated products substantially more expensive to simulate.

A derived 10 m product is strictly nested within the original 30 m grid, uses bilinear elevation interpolation, preserves ancillary cells by nearest-neighbour replication, and continues to declare 30 m Information Resolution. Products are versioned rather than overwritten, and changing products requires a new Simulation Area because Cell identities are product-relative.

Both initial products use WGS 84 ellipsoidal height; water levels and any future terrain products must use that same vertical reference unless a separately versioned, explicit conversion is introduced.
