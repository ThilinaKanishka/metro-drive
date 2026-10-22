# Credits

Metro Drive's code generates most of its world procedurally. The third-party assets below are all
**CC0 1.0 (public domain)**: no attribution is required, but credit is given gladly.
License text: <https://creativecommons.org/publicdomain/zero/1.0/>

## 3D models (`public/models/`)

The models were Draco-compressed with [glTF-Transform](https://gltf-transform.dev/). Unused animation clips were removed from the characters. Geometry and textures are otherwise unmodified.

| Files | Asset pack | Author | Source | License |
| --- | --- | --- | --- | --- |
| `cars/sedan.glb`, `sedan-sports.glb`, `hatchback-sports.glb`, `suv.glb`, `suv-luxury.glb`, `truck.glb`, `van.glb`, `taxi.glb`, `police.glb`, `ambulance.glb`, `delivery.glb`, `truck-flat.glb`, `garbage-truck.glb`, `wheel-default.glb` | Car Kit 3.1 | Kenney | <https://kenney.nl/assets/car-kit> | CC0 1.0 |
| `characters/character-a.glb` … `character-r.glb` (18 characters, with idle / walk / sprint / die / emote-yes animations) | Blocky Characters 2.0 | Kenney | <https://kenney.nl/assets/blocky-characters> | CC0 1.0 |
| `nature/tree_default.glb`, `tree_oak.glb`, `tree_detailed.glb`, `tree_fat.glb`, `tree_pineRoundB.glb`, `tree_pineTallA.glb`, `plant_bush.glb`, `plant_bushLarge.glb`, `plant_bushDetailed.glb`, `grass.glb`, `grass_large.glb`, `flower_redA.glb`, `flower_yellowA.glb`, `flower_purpleA.glb`, `fence_simple.glb` | Nature Kit | Kenney | <https://kenney.nl/assets/nature-kit> | CC0 1.0 |
| `props/road-sign-street.glb` | City Kit (Roads) | Kenney | <https://kenney.nl/assets/city-kit-roads> | CC0 1.0 |

## Textures (`public/textures/`)

The textures were resized (1024 px for asphalt, 512 px for the rest, roughness at half that) and re-encoded as JPEG. Only the colour, normal (OpenGL) and roughness maps are used.

| Files | Material | Author | Source | License |
| --- | --- | --- | --- | --- |
| `asphalt_color.jpg`, `asphalt_normal.jpg`, `asphalt_rough.jpg` | Asphalt 026 C | ambientCG (Lennart Demes) | <https://ambientcg.com/view?id=Asphalt026C> | CC0 1.0 |
| `sidewalk_color.jpg`, `sidewalk_normal.jpg`, `sidewalk_rough.jpg` | Paving Stones 112 | ambientCG (Lennart Demes) | <https://ambientcg.com/view?id=PavingStones112> | CC0 1.0 |
| `brick_color.jpg`, `brick_normal.jpg`, `brick_rough.jpg` | Paving Stones 092 (red brick) | ambientCG (Lennart Demes) | <https://ambientcg.com/view?id=PavingStones092> | CC0 1.0 |
| `concrete_color.jpg`, `concrete_normal.jpg`, `concrete_rough.jpg` | Concrete 034 | ambientCG (Lennart Demes) | <https://ambientcg.com/view?id=Concrete034> | CC0 1.0 |
| `grass_color.jpg`, `grass_normal.jpg` | Ground 037 | ambientCG (Lennart Demes) | <https://ambientcg.com/view?id=Ground037> | CC0 1.0 |

## Libraries

| Library | Use | License |
| --- | --- | --- |
| [three.js](https://threejs.org/) | Rendering, the `Sky` shader, glTF / Draco loaders, SkeletonUtils | MIT |
| [Draco decoder](https://google.github.io/draco/) (`public/draco/`, from three.js) | Decoding compressed meshes | Apache 2.0 |
| [postprocessing](https://github.com/pmndrs/postprocessing) | Effect composer, bloom, SMAA, FXAA | Zlib |
| [N8AO](https://github.com/N8python/n8ao) | Screen-space ambient occlusion | ISC |

Everything else (city layout, buildings and facades, the procedural fallback vehicles and people, street furniture, sky dressing, decals, ad and sign textures, audio) is generated in code.
