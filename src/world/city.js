import { CityLayout } from './cityLayout.js';
import { buildRoads } from './roads.js';
import { buildBuildings } from './buildings.js';
import { buildTrees } from './trees.js';
import { buildStreetLights } from './streetLights.js';

/** Builds the whole static city and exposes the layout for physics / AI / minimap. */
export class City {
  constructor(scene) {
    this.layout = new CityLayout();
    this.roads = buildRoads(this.layout);
    this.buildings = buildBuildings(this.layout);
    this.trees = buildTrees(this.layout);
    this.streetLights = buildStreetLights(this.layout);
    scene.add(this.roads, this.buildings, this.trees, this.streetLights.group);
  }

  update(night) {
    this.streetLights.update(night);
  }
}
