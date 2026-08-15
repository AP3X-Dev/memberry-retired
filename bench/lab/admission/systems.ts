import { ProductionCoreFixtureSystem } from './fixture-system.js';

/** Canonical registered factories. Required evidence never accepts inline systems. */
export function createRegisteredAdmissionSystems() {
  return Object.freeze({
    control: new ProductionCoreFixtureSystem('memberry-admission-baseline-fixture-v1', 'control'),
    candidate: new ProductionCoreFixtureSystem('memberry-admission-shadow-fixture-v1', 'candidate'),
  });
}
