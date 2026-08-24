// The two particle bursts: dust when pieces collide, confetti when a round is celebrated.
// Filed as src/scene/ParticleEffects.hx in the Haxe sibling.
//
// The two configs are ~70 lines of tuned numbers with the reasoning that produced them
// attached, and they were the biggest single block of noise between the sky dome and the
// cameras in main.ts. Behind this boundary the callers say "dust here" and "celebrate at
// this height", and the emitter/state/config triples never leave the module — which also
// means the state reset on a new round cannot be half-done, which is the bug shape here
// (clearing the emitter but keeping the old state leaves the particle count stale).
import type { Node3D, ParticleEmitter3D, ParticleEmitterConfig, ParticleEmitterState } from '@flighthq/sdk';
import {
  addNodeChild,
  buildParticleCurve,
  clearParticleEmitter3D,
  createParticleEmitter3D,
  createParticleEmitterConfig,
  createParticleEmitterState,
  emitParticleBurst3D,
  stepParticleEmitter3D,
} from '@flighthq/sdk';
import { STACK_X, STACK_Z } from '../game/gameConfig';

export interface ParticleEffects {
  /** A kick of dust at a contact point, given in physics space. */
  burstDust: (physicsX: number, worldY: number) => void;
  /** The confetti fan across the pasture at the end of a round. */
  burstCelebration: (worldY: number) => void;
  /** Wipe both emitters and their state for a new round. */
  reset: () => void;
  /** Advance whatever is still in flight. Returns true while anything is moving. */
  step: (deltaTime: number) => boolean;
}

// Paper, not sparks. Four things separate the two, and the old burst had all four wrong:
// confetti keeps its size (scaleEnd is a MULTIPLIER, so the old 0.02 shrank every piece
// to nothing), holds its colour until it lands rather than dimming from the first frame,
// tumbles fast, and falls slowly enough to hang in the air and flutter.
const CELEBRATION_CONFIG: ParticleEmitterConfig = createParticleEmitterConfig({
  alphaCurve: buildParticleCurve((t) => (t < 0.74 ? 1 : 1 - (t - 0.74) / 0.26)),
  alphaEnd: 1,
  alphaStart: 1,
  colorEndB: 1,
  colorEndG: 1,
  colorEndR: 1,
  colorStartB: 1,
  colorStartG: 1,
  colorStartR: 1,
  directionX: 0,
  directionY: 1,
  directionZ: 0,
  duration: 0,
  // Nearly a hemisphere: a party popper sprays sideways as much as up, where the old
  // narrower cone threw a fountain.
  emitterConeAngle: 2.5,
  emitterRadius: 0.22,
  emitterShape: 'cone3d',
  gravityY: -1.15,
  lifetimeMax: 4.4,
  lifetimeMin: 2.4,
  loop: false,
  maxParticles: 760,
  rotationSpeedMax: 17,
  rotationSpeedMin: -17,
  scaleEnd: 1,
  // Small and many. At 0.26 the pieces read as sheets of paper rather than confetti,
  // especially early on when the camera is still close to the pile.
  scaleMax: 0.135,
  scaleMin: 0.05,
  spawnRate: 0,
  speedMax: 3.4,
  speedMin: 1.5,
  worldSpace: true,
});

const DUST_CONFIG: ParticleEmitterConfig = createParticleEmitterConfig({
  alphaEnd: 0,
  alphaStart: 0.42,
  colorEndB: 0.58,
  colorEndG: 0.69,
  colorEndR: 0.76,
  colorStartB: 0.72,
  colorStartG: 0.8,
  colorStartR: 0.86,
  directionX: 0,
  directionY: 1,
  directionZ: 0,
  duration: 0,
  emitterConeAngle: 1.35,
  emitterRadius: 0.012,
  emitterShape: 'cone3d',
  gravityY: -0.5,
  lifetimeMax: 0.42,
  lifetimeMin: 0.18,
  loop: false,
  maxParticles: 96,
  rotationSpeedMax: 2,
  rotationSpeedMin: -2,
  scaleEnd: 0.002,
  scaleMax: 0.036,
  scaleMin: 0.008,
  spawnRate: 0,
  speedMax: 0.35,
  speedMin: 0.08,
  worldSpace: true,
});

// One fan of colour per confetti burst, spread across the pasture width.
const CELEBRATION_COLORS = [
  0xffd166ff, 0xef8354ff, 0x7ea16bff, 0xf7ede2ff, 0x8ecae6ff, 0xe5989bff, 0xb08fd8ff,
];
const DUST_COLOR = 0xe8d6a9cc;

export function createParticleEffects(sceneRoot: Node3D): ParticleEffects {
  const dustEmitter: ParticleEmitter3D = createParticleEmitter3D({
    blendMode: 'normal',
    data: { worldSpace: true },
    name: 'horse-impact-dust',
  });
  addNodeChild(sceneRoot, dustEmitter);
  const celebrationEmitter: ParticleEmitter3D = createParticleEmitter3D({
    blendMode: 'normal',
    data: { worldSpace: true },
    name: 'horse-confetti',
  });
  addNodeChild(sceneRoot, celebrationEmitter);

  let dustState: ParticleEmitterState = createParticleEmitterState();
  let celebrationState: ParticleEmitterState = createParticleEmitterState();

  return {
    burstDust(physicsX, worldY) {
      emitParticleBurst3D(
        dustEmitter,
        dustState,
        DUST_CONFIG,
        8,
        STACK_X,
        worldY,
        STACK_Z - physicsX,
        DUST_COLOR,
      );
    },

    burstCelebration(worldY) {
      for (let index = 0; index < CELEBRATION_COLORS.length; index++) {
        const horizontalOffset = -1.8 + (index / (CELEBRATION_COLORS.length - 1)) * 3.6;
        emitParticleBurst3D(
          celebrationEmitter,
          celebrationState,
          CELEBRATION_CONFIG,
          92,
          STACK_X + (Math.random() - 0.5) * 0.16,
          worldY,
          STACK_Z - horizontalOffset,
          CELEBRATION_COLORS[index],
        );
      }
    },

    reset() {
      clearParticleEmitter3D(dustEmitter);
      clearParticleEmitter3D(celebrationEmitter);
      dustState = createParticleEmitterState();
      celebrationState = createParticleEmitterState();
    },

    step(deltaTime) {
      // Stepped only while something is actually in flight, so an idle title screen pays
      // nothing for the emitters existing.
      const dustIsMoving = dustEmitter.data.particleCount > 0;
      const celebrationIsMoving = celebrationEmitter.data.particleCount > 0;
      if (dustIsMoving) stepParticleEmitter3D(dustEmitter, dustState, DUST_CONFIG, deltaTime);
      if (celebrationIsMoving) {
        stepParticleEmitter3D(celebrationEmitter, celebrationState, CELEBRATION_CONFIG, deltaTime);
      }
      return dustIsMoving || celebrationIsMoving;
    },
  };
}
