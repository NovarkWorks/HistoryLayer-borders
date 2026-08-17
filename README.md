# History Layer — borders

The historical border data behind [History Layer](https://historylayer.com),
served from its own origin so that the dataset and the application that draws
it arrive separately, each under its own terms.

**Everything here is GPL-3.0.** Take it, modify it, redistribute it — anything
you derive from it carries the same licence. The full text is in
[`LICENSES/GPL-3.0.txt`](./LICENSES/GPL-3.0.txt) and is served at
`/LICENSES/GPL-3.0.txt`.

## What this is

54 world border snapshots from 123,000 BCE to 2026, and the same data
again at higher resolution in `detail/` (54 files). They are a
**modified version** of
[aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps),
copyright its authors: simplified with mapshaper (Visvalingam, `keep-shapes`
on so small polities do not vanish) and converted to TopoJSON, one file per
year. Nothing about the geometry was invented, corrected or re-attributed.

```
data/
  manifest.json     the year list and per-year counts
  polities.json     Wikidata metadata joined onto the names in the snapshots
  years/            the coarse tier — what draws when the world is on screen
  detail/           the same data, for when the view is close enough to matter
LICENSES/GPL-3.0.txt
scripts/            the corresponding source: how the data above was produced
```

## Serving it

Any static host will do. The layout the application expects:

```
https://<this-host>/data/manifest.json
https://<this-host>/data/years/world_1914.json
https://<this-host>/data/detail/world_1914.json
https://<this-host>/data/polities.json
```

These are cross-origin reads, so the host must send CORS headers or the map
will simply not draw:

```
Access-Control-Allow-Origin: *
```

`*` is the honest choice here — this is a public dataset that anybody may copy
anyway, and the licence says so.

The files never change between rebuilds, so cache them hard. Put a CDN in
front of it: the application degrades badly without this host, since a history
map with no borders is not much of one.

## Rebuilding

```sh
npm install
npm run fetch     # download the upstream snapshots into raw/
npm run build     # simplify -> TopoJSON -> data/
```

Do not edit `data/` by hand. It is output, and the application verifies it.

## Why this repository exists

The application is not licensed under the GPL — it is copyright Novark LLC —
and it can differ because it is not derived from this dataset. It reads a
format: the built bundle contains the field names it looks for (`SUBJECTO`,
`BORDERPRECISION`) and not one coordinate, and fetches every border from
here at runtime. Point the same code at Natural Earth and it draws that
instead.

That argument stands on its own. This repository makes it visible, and carries
the offer of corresponding source that the GPL asks for.

`src/rulers.ts` is application code that `build-borders.mjs` imports to count
dependencies into the manifest. Novark LLC owns it and has licensed this copy
under GPL-3.0 along with the rest of this repository; the copy that lives in
the application is under the application's own terms.
