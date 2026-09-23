import type {
  AddSelectionResponse,
  AdminBoardResponse,
  AdminSessionResponse,
  AdminUsersResponse,
  CreateUserResponse,
  RenameUserResponse,
  SelectionsResponse,
  Team,
  TeamSearchResponse,
  UserTeamSelection,
} from '@cfb/shared';
import { DISPLAY_NAME_MAX_LENGTH, MAX_SELECTIONS } from '@cfb/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { cacheKey } from '../cache/policy';
import { evictL1 } from '../cache/tiers';
import { supabaseAsAdmin } from '../db/client';
import { DbError, type PostgrestClient } from '../db/postgrest';
import {
  createUser,
  deleteSelection,
  deleteUser,
  findTeamByProviderId,
  getUserWithSelections,
  insertSelection,
  insertTeam,
  isUuid,
  listUsers,
  renameUser,
  reorderSelections,
} from '../db/queries';
import { providerName, type AppBindings } from '../env';
import { conflict, internalError, invalidRequest, notFound } from '../http/errors';
import { requireAdmin } from '../middleware/require-admin';
import { servicesFor, type Services } from '../services/context';
import { findTeamIdentity, parseQuery, searchTeams } from '../services/search';

/**
 * `/api/admin/*` — the only authenticated branch of the API.
 *
 * Every route here is behind `requireAdmin` by being mounted here: 401 with no
 * token or a bad one, 403 for a valid token that is not in `admins`. Behind
 * that, every write goes to Postgres with the administrator's OWN token
 * (`supabaseAsAdmin`), so RLS makes the final decision (§30, §31). Nothing in
 * this file is the security boundary; it is the error messages in front of it.
 *
 * Phase 5 completes §8's admin surface: the users list, rename, delete, and a
 * board's selections (add, remove, reorder).
 */
export const adminRoutes = new Hono<AppBindings>();

adminRoutes.use('*', requireAdmin);

/** Admin answers are per-person and are what was just changed: never cache them. */
const NO_STORE = 'private, no-store';

type AdminContext = Context<AppBindings>;

function adminDb(c: AdminContext): PostgrestClient {
  return supabaseAsAdmin(c.env, c.get('admin').accessToken);
}

/**
 * The public board is cached in L1 for up to 60 s (plan §7). After a write,
 * this isolate's copy is dropped so the next read here rebuilds it. Other
 * isolates catch up when theirs expires (docs/ops.md, "Changing a board").
 */
function forgetBoard(c: AdminContext, userId: string): void {
  evictL1(cacheKey('board', providerName(c.env), userId));
}

async function readJson(c: AdminContext): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('The request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function userIdParam(c: AdminContext): string {
  const userId = c.req.param('userId') ?? '';
  // A malformed id is a clean 404 before any database round trip.
  if (!isUuid(userId)) throw notFound('No such user.');
  return userId;
}

/** Mirrors the CHECK constraint in 0001_schema.sql. The database is the enforcer. */
function parseDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidRequest('displayName must be a string.');
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    throw invalidRequest(
      `displayName must be between 1 and ${String(DISPLAY_NAME_MAX_LENGTH)} characters.`,
    );
  }
  return trimmed;
}

/** Provider ids go into provider URLs and PostgREST filters, so they are held to a boring shape. */
const PROVIDER_TEAM_ID = /^[A-Za-z0-9_-]{1,40}$/;

function parseProviderTeamId(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_TEAM_ID.test(value)) {
    throw invalidRequest('providerTeamId must be a provider team id.');
  }
  return value;
}

function parseOrderedIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_SELECTIONS ||
    !value.every((id): id is string => typeof id === 'string' && isUuid(id))
  ) {
    throw invalidRequest(
      `orderedIds must be a list of 1 to ${String(MAX_SELECTIONS)} selection ids.`,
    );
  }
  if (new Set(value).size !== value.length) {
    throw invalidRequest('orderedIds must not repeat a selection.');
  }
  return value;
}

const BOARD_CHANGED = 'This board changed since it was loaded. Reload it and try again.';

/**
 * The database's unique constraints are the real duplicate check (§3, §44).
 * When one fires, say which, in words an administrator can act on.
 */
function explainSelectionConflict(error: unknown): unknown {
  if (!(error instanceof DbError) || error.kind !== 'conflict') return error;
  const detail = error.detail ?? undefined;
  return error.violates('uq_user_team')
    ? conflict('That team is already on this board.', detail)
    : conflict(BOARD_CHANGED, detail);
}

// ─── Session ─────────────────────────────────────────────────────────────────

/**
 * Reaching this handler IS the answer: `requireAdmin` has already returned 401
 * for a missing or bad token and 403 for a valid one that is not in `admins`.
 * The web app's `/admin` route and header link use it to tell those apart.
 */
adminRoutes.get('/session', (c) => {
  const body: AdminSessionResponse = { admin: { authUserId: c.get('admin').authUserId } };
  c.header('Cache-Control', NO_STORE);
  return c.json(body);
});

// ─── Users ───────────────────────────────────────────────────────────────────

/** The public list, but read now and never from a cache: the console shows what it just changed. */
adminRoutes.get('/users', async (c) => {
  const body: AdminUsersResponse = { users: await listUsers(adminDb(c)) };
  c.header('Cache-Control', NO_STORE);
  return c.json(body);
});

/**
 * Creates a board participant. That creates no login, on purpose (plan §11.1):
 * a user is a display profile that owns a board.
 */
adminRoutes.post('/users', async (c) => {
  const payload = await c.req.json<unknown>().catch(() => null);
  const displayName = parseDisplayName(
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['displayName']
      : undefined,
  );

  // Note the client: the administrator's own token, not an elevated key. If they
  // are somehow not in `admins`, Postgres refuses this insert on its own (§31).
  const user = await createUser(adminDb(c), displayName);

  const body: CreateUserResponse = { user };
  c.header('Cache-Control', NO_STORE);
  return c.json(body, 201);
});

adminRoutes.get('/users/:userId', async (c) => {
  const board = await getUserWithSelections(adminDb(c), userIdParam(c));
  const body: AdminBoardResponse = board;
  c.header('Cache-Control', NO_STORE);
  return c.json(body);
});

adminRoutes.patch('/users/:userId', async (c) => {
  const userId = userIdParam(c);
  const displayName = parseDisplayName((await readJson(c))['displayName']);
  const user = await renameUser(adminDb(c), userId, displayName);
  forgetBoard(c, userId);

  const body: RenameUserResponse = { user };
  c.header('Cache-Control', NO_STORE);
  return c.json(body);
});

/** Deletes the participant and their board (`on delete cascade`). Teams stay: other boards may hold them. */
adminRoutes.delete('/users/:userId', async (c) => {
  const userId = userIdParam(c);
  await deleteUser(adminDb(c), userId);
  forgetBoard(c, userId);
  c.header('Cache-Control', NO_STORE);
  return c.body(null, 204);
});

// ─── Selections (§3, §43, §44) ───────────────────────────────────────────────

/**
 * The stored `teams` row for a provider team, creating it from the provider's
 * own identity the first time the team is added to any board (§43). A team
 * already stored is reused as it is: its conference may have been curated.
 */
async function storedTeam(
  services: Services,
  db: PostgrestClient,
  providerTeamId: string,
): Promise<Team> {
  const namespace = services.provider.teamNamespace;
  const existing = await findTeamByProviderId(db, namespace, providerTeamId);
  if (existing !== null) return existing;

  const identity = await findTeamIdentity(services, providerTeamId);
  if (identity === null) throw notFound("That team isn't in the provider's team list.");

  try {
    return await insertTeam(db, namespace, identity);
  } catch (error) {
    // Another request stored it a moment ago (uq_teams_provider_identity).
    if (error instanceof DbError && error.kind === 'conflict') {
      const raced = await findTeamByProviderId(db, namespace, providerTeamId);
      if (raced !== null) return raced;
    }
    throw error;
  }
}

/**
 * Renumbers a board 1…n in its current order. Removing a team leaves a gap,
 * and gaps would eventually run a board into the 24-slot ceiling with fewer
 * than 24 teams on it.
 */
async function compact(
  db: PostgrestClient,
  userId: string,
  selections: readonly UserTeamSelection[],
): Promise<boolean> {
  const numbered = selections.every((selection, index) => selection.order === index + 1);
  if (numbered || selections.length === 0) return false;
  await reorderSelections(
    db,
    userId,
    selections.map((selection) => selection.id),
  );
  return true;
}

async function selectionsOf(db: PostgrestClient, userId: string): Promise<UserTeamSelection[]> {
  return (await getUserWithSelections(db, userId)).selections;
}

/** Adds a team to the end of a board. 409 if it is already there (§3). */
adminRoutes.post('/users/:userId/selections', async (c) => {
  const userId = userIdParam(c);
  const providerTeamId = parseProviderTeamId((await readJson(c))['providerTeamId']);
  const db = adminDb(c);
  const services = servicesFor(c);

  let selections = await selectionsOf(db, userId);
  // A friendlier message ahead of the constraint, which still has the last word.
  if (selections.some((selection) => selection.team.providerTeamId === providerTeamId)) {
    throw conflict('That team is already on this board.');
  }
  if (selections.length >= MAX_SELECTIONS) {
    throw conflict(`A board holds at most ${String(MAX_SELECTIONS)} teams.`);
  }

  const team = await storedTeam(services, db, providerTeamId);
  const last = selections.at(-1)?.order ?? 0;
  if (last >= MAX_SELECTIONS && (await compact(db, userId, selections))) {
    selections = await selectionsOf(db, userId);
  }
  const order = (selections.at(-1)?.order ?? 0) + 1;

  let selectionId: string;
  try {
    selectionId = await insertSelection(db, userId, team.id, order);
  } catch (error) {
    throw explainSelectionConflict(error);
  }
  forgetBoard(c, userId);

  const updated = await selectionsOf(db, userId);
  const selection = updated.find((candidate) => candidate.id === selectionId);
  if (selection === undefined) {
    throw internalError('The team was added, but the board could not be read back.');
  }

  const body: AddSelectionResponse = { userId, selections: updated, selection };
  c.header('Cache-Control', NO_STORE);
  return c.json(body, 201);
});

/** Removes one team from a board, then renumbers the rest 1…n. */
adminRoutes.delete('/selections/:selectionId', async (c) => {
  const db = adminDb(c);
  const { userId } = await deleteSelection(db, c.req.param('selectionId'));
  forgetBoard(c, userId);

  let selections = await selectionsOf(db, userId);
  try {
    if (await compact(db, userId, selections)) selections = await selectionsOf(db, userId);
  } catch (error) {
    // The removal happened and the order is intact; only the numbering has a
    // gap, which the next add or reorder closes. Not worth failing over.
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'compact_failed',
        requestId: c.get('requestId'),
        userId,
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  const body: SelectionsResponse = { userId, selections };
  c.header('Cache-Control', NO_STORE);
  return c.json(body);
});

/**
 * §44 — one `PUT` with the whole order, one `reorder_selections` call, one
 * transaction. The list must be exactly the board's current selections: if it
 * is not, the board changed underneath the editor, and guessing would be worse
 * than asking for a reload.
 */
adminRoutes.put('/users/:userId/selections/order', async (c) => {
  const userId = userIdParam(c);
  const orderedIds = parseOrderedIds((await readJson(c))['orderedIds']);
  const db = adminDb(c);

  const current = new Set((await selectionsOf(db, userId)).map((selection) => selection.id));
  if (orderedIds.length !== current.size || orderedIds.some((id) => !current.has(id))) {
    throw conflict(BOARD_CHANGED);
  }

  try {
    await reorderSelections(db, userId, orderedIds);
  } catch (error) {
    throw explainSelectionConflict(error);
  }
  forgetBoard(c, userId);

  const body: SelectionsResponse = { userId, selections: await selectionsOf(db, userId) };
  c.header('Cache-Control', NO_STORE);
  return c.json(body);
});

// ─── Team search (§43) ───────────────────────────────────────────────────────

/**
 * Candidate team identities for a board. Kept here, beside the console that
 * uses it, rather than pointed at the public `/api/search/teams`: this answer
 * is what the administrator is about to act on, so it is sent `no-store`, while
 * the public one is deliberately cacheable for five minutes. Same ranking, same
 * list — `services/search.ts` — and the route matrix keeps enumerating this
 * one, so the admin branch stays provably closed.
 */
adminRoutes.get('/teams/search', async (c) => {
  const query = parseQuery(c.req.query('q'));
  const teams = await searchTeams(servicesFor(c), query);

  const body: TeamSearchResponse = { teams };
  c.header('Cache-Control', NO_STORE);
  return c.json(body);
});
