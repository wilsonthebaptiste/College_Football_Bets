import { teamRow, uuidFor } from './boards';
import type { RecordedRequest, StubRoute } from './supabase-stub';

/**
 * A small in-memory Postgres behind a fake PostgREST, for the admin routes.
 *
 * It answers exactly the queries `src/db/queries.ts` makes, and it enforces the
 * constraints those routes lean on, the way Postgres reports them:
 *   - uq_user_team, uq_user_order, uq_teams_provider_identity → 409, 23505
 *   - a selection for a user that does not exist            → 409, 23503
 *   - selection_order outside 1–24                          → 400, 23514
 *   - deleting a user cascades to their selections
 *   - reorder_selections with another board's ids           → 400, 22023
 *
 * `refuseWrites` makes every write fail the way RLS refuses one (403, 42501),
 * for the tests that prove the database, not the Worker, has the last word.
 */

interface UserRecord {
  id: string;
  display_name: string;
}

interface SelectionRecord {
  id: string;
  user_id: string;
  team_id: string;
  selection_order: number;
  created_at: string;
}

type TeamRecord = Record<string, unknown> & { id: string };

export interface FakeDb {
  users: UserRecord[];
  teams: TeamRecord[];
  selections: SelectionRecord[];
  refuseWrites: boolean;
  /** Every reorder_selections call, in order. */
  reorders: { userId: string; ids: string[] }[];
  routes: StubRoute[];
  boardOf(userId: string): string[];
}

let counter = 0;
const newId = (): string => uuidFor(700_000 + (counter += 1));

function eqParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value?.startsWith('eq.') === true ? value.slice(3) : null;
}

function dbError(status: number, code: string, message: string) {
  return { status, body: { code, message, details: null, hint: null } };
}

export function createFakeDb(boards: Record<string, { name: string; teams: string[] }>): FakeDb {
  const db: FakeDb = {
    users: [],
    teams: [],
    selections: [],
    refuseWrites: false,
    reorders: [],
    routes: [],
    boardOf: (userId) =>
      db.selections
        .filter((selection) => selection.user_id === userId)
        .sort((a, b) => a.selection_order - b.selection_order)
        .map((selection) =>
          String(db.teams.find((team) => team.id === selection.team_id)?.['provider_team_id']),
        ),
  };

  for (const [userId, board] of Object.entries(boards)) {
    db.users.push({ id: userId, display_name: board.name });
    board.teams.forEach((providerTeamId, index) => {
      if (!db.teams.some((team) => team['provider_team_id'] === providerTeamId)) {
        db.teams.push(teamRow(providerTeamId) as TeamRecord);
      }
      const team = db.teams.find((candidate) => candidate['provider_team_id'] === providerTeamId)!;
      db.selections.push({
        id: newId(),
        user_id: userId,
        team_id: team.id,
        selection_order: index + 1,
        created_at: '2026-09-01T00:00:00Z',
      });
    });
  }

  const selectionsOf = (userId: string) =>
    db.selections
      .filter((selection) => selection.user_id === userId)
      .sort((a, b) => a.selection_order - b.selection_order)
      .map((selection) => ({
        id: selection.id,
        selection_order: selection.selection_order,
        created_at: selection.created_at,
        teams: db.teams.find((team) => team.id === selection.team_id) ?? null,
      }));

  const refused = () => dbError(403, '42501', 'new row violates row-level security policy');

  const on = (
    method: string,
    path: string,
    respond: (url: URL, request: RecordedRequest) => { status: number; body: unknown },
  ): StubRoute => {
    let lastUrl: URL | null = null;
    return {
      match: (url, requestMethod) => {
        lastUrl = url;
        return requestMethod === method && url.pathname === path;
      },
      respond: (request) => respond(lastUrl!, request),
    };
  };

  db.routes = [
    // ── app_users ──────────────────────────────────────────────────────────
    on('GET', '/rest/v1/app_users', (url) => {
      const id = eqParam(url, 'id');
      const select = url.searchParams.get('select') ?? '';
      const users = [...db.users]
        .filter((user) => id === null || user.id === id)
        .sort((a, b) => a.display_name.localeCompare(b.display_name));
      if (select.includes('(count)')) {
        return {
          status: 200,
          body: users.map((user) => ({
            ...user,
            user_team_selections: [{ count: selectionsOf(user.id).length }],
          })),
        };
      }
      return {
        status: 200,
        body: users.map((user) => ({ ...user, user_team_selections: selectionsOf(user.id) })),
      };
    }),
    on('POST', '/rest/v1/app_users', (_url, request) => {
      if (db.refuseWrites) return refused();
      const name = (request.body as { display_name: string }).display_name;
      const user = { id: newId(), display_name: name };
      db.users.push(user);
      return { status: 201, body: [user] };
    }),
    on('PATCH', '/rest/v1/app_users', (url, request) => {
      if (db.refuseWrites) return { status: 200, body: [] }; // RLS: USING hides every row
      const user = db.users.find((candidate) => candidate.id === eqParam(url, 'id'));
      if (user === undefined) return { status: 200, body: [] };
      user.display_name = (request.body as { display_name: string }).display_name;
      return { status: 200, body: [user] };
    }),
    on('DELETE', '/rest/v1/app_users', (url) => {
      if (db.refuseWrites) return { status: 200, body: [] };
      const id = eqParam(url, 'id');
      const user = db.users.find((candidate) => candidate.id === id);
      if (user === undefined) return { status: 200, body: [] };
      db.users = db.users.filter((candidate) => candidate.id !== id);
      db.selections = db.selections.filter((selection) => selection.user_id !== id); // cascade
      return { status: 200, body: [user] };
    }),

    // ── teams ──────────────────────────────────────────────────────────────
    on('GET', '/rest/v1/teams', (url) => {
      const id = eqParam(url, 'id');
      const provider = eqParam(url, 'provider');
      const providerTeamId = eqParam(url, 'provider_team_id');
      return {
        status: 200,
        body: db.teams.filter(
          (team) =>
            (id === null || team.id === id) &&
            (provider === null || team['provider'] === provider) &&
            (providerTeamId === null || team['provider_team_id'] === providerTeamId),
        ),
      };
    }),
    on('POST', '/rest/v1/teams', (_url, request) => {
      if (db.refuseWrites) return refused();
      const row = request.body as Record<string, unknown>;
      if (
        db.teams.some(
          (team) =>
            team['provider'] === row['provider'] &&
            team['provider_team_id'] === row['provider_team_id'],
        )
      ) {
        return dbError(
          409,
          '23505',
          'duplicate key value violates unique constraint "uq_teams_provider_identity"',
        );
      }
      const team = { ...row, id: newId() } as TeamRecord;
      db.teams.push(team);
      return { status: 201, body: [team] };
    }),

    // ── user_team_selections ───────────────────────────────────────────────
    on('POST', '/rest/v1/user_team_selections', (_url, request) => {
      if (db.refuseWrites) return refused();
      const row = request.body as Omit<SelectionRecord, 'id' | 'created_at'>;
      if (!db.users.some((user) => user.id === row.user_id)) {
        return dbError(
          409,
          '23503',
          'insert or update on table "user_team_selections" violates foreign key constraint "user_team_selections_user_id_fkey"',
        );
      }
      if (row.selection_order < 1 || row.selection_order > 24) {
        return dbError(400, '23514', 'new row violates check constraint');
      }
      const mine = db.selections.filter((selection) => selection.user_id === row.user_id);
      if (mine.some((selection) => selection.team_id === row.team_id)) {
        return dbError(
          409,
          '23505',
          'duplicate key value violates unique constraint "uq_user_team"',
        );
      }
      if (mine.some((selection) => selection.selection_order === row.selection_order)) {
        return dbError(
          409,
          '23505',
          'duplicate key value violates unique constraint "uq_user_order"',
        );
      }
      const selection = { ...row, id: newId(), created_at: '2026-09-19T00:00:00Z' };
      db.selections.push(selection);
      return { status: 201, body: [selection] };
    }),
    on('DELETE', '/rest/v1/user_team_selections', (url) => {
      if (db.refuseWrites) return { status: 200, body: [] };
      const id = eqParam(url, 'id');
      const selection = db.selections.find((candidate) => candidate.id === id);
      if (selection === undefined) return { status: 200, body: [] };
      db.selections = db.selections.filter((candidate) => candidate.id !== id);
      return { status: 200, body: [selection] };
    }),

    // ── RPC ────────────────────────────────────────────────────────────────
    on('POST', '/rest/v1/rpc/reorder_selections', (_url, request) => {
      if (db.refuseWrites) return dbError(403, '42501', 'forbidden');
      const { p_user_id: userId, p_ordered_ids: ids } = request.body as {
        p_user_id: string;
        p_ordered_ids: string[];
      };
      db.reorders.push({ userId, ids });
      const owned = ids.filter((id) =>
        db.selections.some((selection) => selection.id === id && selection.user_id === userId),
      );
      if (owned.length !== ids.length) {
        return dbError(400, '22023', `orderedIds do not all belong to user ${userId}`);
      }
      ids.forEach((id, index) => {
        const selection = db.selections.find((candidate) => candidate.id === id)!;
        selection.selection_order = index + 1;
      });
      // The deferred uq_user_order check, at COMMIT.
      const orders = db.selections
        .filter((selection) => selection.user_id === userId)
        .map((selection) => selection.selection_order);
      if (new Set(orders).size !== orders.length) {
        return dbError(
          409,
          '23505',
          'duplicate key value violates unique constraint "uq_user_order"',
        );
      }
      return { status: 204, body: null };
    }),
  ];

  return db;
}
