import type { Season } from '@cfb/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  toPrediction,
  toProviderGame,
  toRankings,
  toSchedule,
  toSeason,
  toTeamIdentity,
} from '../../src/providers/espn/normalize';
import {
  readCalendar,
  readErrorBody,
  readGroup,
  readRankings,
  readRefPage,
  readSchedule,
  readScoreboard,
  readStandalonePredictor,
  readSummary,
  readTeamList,
} from '../../src/providers/espn/validate';
import { deriveSlots, scheduleItems } from '../../src/services/derive';
import { toTeamGame } from '../../src/services/perspective';
import { fixture, fixtureNames } from '../helpers/fixtures';

/**
 * Plan Phase 2 exit criterion: "Feeding each fixture through validate.ts after
 * random field deletion never throws."
 *
 * Property-style: for every captured payload, repeatedly walk to a random
 * node, damage it (delete it, null it, or swap its type), and push the result
 * through EVERY reader and every normalizer downstream of whatever still
 * validates. The property is totality. Readers answer or return `null`, and
 * the pipeline after them never throws, whatever ESPN changes (§40).
 *
 * Deterministic: a seeded PRNG, so a failure reproduces exactly. The seed and
 * iteration are in the failure message.
 */

const SEASON: Season = { year: 2026, type: 'regular', week: 3 };
const NOW = Date.parse('2026-09-18T04:33:10.967Z');

/** mulberry32: small, fast, seedable. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

const REPLACEMENTS: readonly unknown[] = [null, 0, -1, '', 'garbage', true, [], {}, 1e308, '99'];

interface Damage {
  undo: () => void;
  description: string;
}

/**
 * Walk from the root, descending into a random child with high probability,
 * and damage wherever the walk stops. Returns how to undo it, so a large
 * fixture is mutated in place instead of cloned per iteration.
 */
function damage(root: Container, random: () => number): Damage | null {
  let parent: Container = root;
  const trail: string[] = [];
  for (let depth = 0; depth < 40; depth += 1) {
    const keys = Array.isArray(parent)
      ? parent.map((_, index) => String(index))
      : Object.keys(parent);
    if (keys.length === 0) return null;
    const key = keys[Math.floor(random() * keys.length)]!;
    trail.push(key);
    const child: unknown = Array.isArray(parent) ? parent[Number(key)] : parent[key];
    if (isContainer(child) && random() < 0.8) {
      parent = child;
      continue;
    }

    const target = parent;
    const had = Array.isArray(target) ? Number(key) < target.length : key in target;
    const original = child;
    const roll = random();
    if (roll < 0.5) {
      if (Array.isArray(target)) target.splice(Number(key), 1);
      else delete target[key];
      return {
        description: `deleted ${trail.join('.')}`,
        undo: () => {
          if (Array.isArray(target)) target.splice(Number(key), 0, original);
          else if (had) target[key] = original;
        },
      };
    }
    const replacement = REPLACEMENTS[Math.floor(random() * REPLACEMENTS.length)];
    if (Array.isArray(target)) target[Number(key)] = replacement;
    else target[key] = replacement;
    return {
      description: `set ${trail.join('.')} = ${JSON.stringify(replacement)}`,
      undo: () => {
        if (Array.isArray(target)) target[Number(key)] = original;
        else target[key] = original;
      },
    };
  }
  return null;
}

/** Everything downstream of `validate.ts`, run on whatever survives it. */
function pipeline(body: unknown): void {
  readErrorBody(body);
  const calendar = readCalendar(body);
  if (calendar !== null) toSeason(calendar);

  const teams = readTeamList(body);
  if (teams !== null) teams.map(toTeamIdentity);

  const schedule = readSchedule(body);
  if (schedule !== null) {
    const { games } = toSchedule([schedule], SEASON);
    const teamIds = new Set(
      games.flatMap((game) => [game.home.team.providerTeamId, game.away.team.providerTeamId]),
    );
    for (const id of teamIds) {
      deriveSlots(games, id, { now: NOW, season: SEASON, complete: true });
      deriveSlots(games, id, { now: NOW, season: { ...SEASON, week: null }, complete: true });
      scheduleItems(games, id, true);
    }
  }

  const scoreboard = readScoreboard(body);
  if (scoreboard !== null) {
    for (const event of scoreboard.events) {
      const game = toProviderGame(event);
      toTeamGame(game, game.home.team.providerTeamId);
    }
  }

  const summary = readSummary(body);
  const standalone = readStandalonePredictor(body);
  if (summary !== null) {
    const game = toProviderGame(summary.event);
    toTeamGame(game, game.away.team.providerTeamId);
    toPrediction(summary, standalone, '2026-09-18T00:00:00.000Z');
  }

  const rankings = readRankings(body);
  if (rankings !== null) toRankings(rankings, SEASON);

  readRefPage(body, 'groups');
  readRefPage(body, 'teams');
  readGroup(body);
}

/** Bigger payloads get fewer rounds; every payload gets several damages per round. */
function roundsFor(bytes: number): number {
  if (bytes > 1_000_000) return 40;
  if (bytes > 300_000) return 80;
  return 200;
}

beforeAll(() => {
  // Unknown statuses are logged once each; the damage produces plenty of them.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('validate.ts is total over damaged ESPN payloads (§40)', () => {
  for (const name of fixtureNames()) {
    it(`${name}: random deletion and type damage never throws`, () => {
      const body = fixture(name);
      if (!isContainer(body)) throw new Error(`${name} is not a JSON container`);
      const seed = [...name].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) >>> 0;
      const random = prng(seed);
      const rounds = roundsFor(JSON.stringify(body).length);

      for (let round = 0; round < rounds; round += 1) {
        const damages: Damage[] = [];
        const count = 1 + Math.floor(random() * 4);
        for (let index = 0; index < count; index += 1) {
          const done = damage(body, random);
          if (done !== null) damages.push(done);
        }
        try {
          pipeline(body);
        } catch (error) {
          const what = damages.map((entry) => entry.description).join('; ');
          throw new Error(
            `${name}, seed ${String(seed)}, round ${String(round)}: ${what}\n${String(error)}`,
          );
        }
        for (const entry of damages.reverse()) entry.undo();
      }
    });
  }

  it('every reader survives inputs that are not objects at all', () => {
    for (const input of [
      undefined,
      null,
      0,
      'text',
      [],
      [[]],
      true,
      { events: 'nope' },
      { rankings: [null] },
    ]) {
      expect(() => pipeline(input)).not.toThrow();
    }
  });
});
