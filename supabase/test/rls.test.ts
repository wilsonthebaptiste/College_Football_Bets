import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The database security model, proven on real Postgres (plan §5.2).
 *
 * With reads public, write enforcement in the database is the ONLY security
 * boundary in the application (§30, §31). These tests run the repository's
 * migration and seed files, verbatim, on PGlite (Postgres compiled to WASM),
 * with a small simulation of Supabase around them:
 *   - the `anon` and `authenticated` roles,
 *   - `auth.users` and `auth.uid()` (read from the JWT `sub` claim setting, as
 *     Supabase does), and
 *   - Supabase's permissive default privileges, which grant everything in
 *     `public` to both API roles. That is what makes the migrations' own
 *     REVOKEs meaningful: without it, a missing REVOKE would go unnoticed.
 *
 * Each verb on each table is tested separately for each role, because `for
 * all` policies are easy to get subtly wrong (plan §5.2). The same attacks run
 * against the live project through PostgREST in `scripts/verify-rls.mjs`.
 *
 * Ported from the Phase 1 harness, which lived outside the repository.
 */

const MIGRATIONS = [
  'supabase/migrations/0001_schema.sql',
  'supabase/migrations/0002_rls.sql',
  'supabase/migrations/0003_rpc.sql',
];

const ADMIN = '00000000-0000-4000-8000-00000000a0a0';
const STRANGER = '00000000-0000-4000-8000-00000000b0b0';

const sql = (file: string): Promise<string> =>
  readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const SUPABASE_SIMULATION = `
  create role anon nologin;
  create role authenticated nologin;
  create schema extensions;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`;

async function freshDatabase(files: readonly string[] = MIGRATIONS): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_SIMULATION);
  for (const file of files) await db.exec(await sql(file));
  return db;
}

type Role = 'anon' | 'authenticated';

/** Runs `work` as a PostgREST role would: `set role`, with `auth.uid()` = `sub`. */
async function as<T>(
  db: PGlite,
  role: Role,
  sub: string | null,
  work: () => Promise<T>,
): Promise<T> {
  await db.exec(
    `reset role; select set_config('request.jwt.claim.sub', '${sub ?? ''}', false); set role ${role};`,
  );
  try {
    return await work();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

/** The SQLSTATE a statement fails with, or `null` if it succeeded. */
async function errorCode(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

async function one<T>(db: PGlite, query: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(query, params);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no row: ${query}`);
  return row;
}

describe('migrations', () => {
  it('apply cleanly, then re-apply cleanly (every file is re-runnable)', async () => {
    const db = await freshDatabase();
    for (const file of MIGRATIONS) await expect(db.exec(await sql(file))).resolves.toBeDefined();
    await db.close();
  });

  it('fail closed between 0001 and 0002: RLS is on for all four tables before any policy exists', async () => {
    const db = await freshDatabase(['supabase/migrations/0001_schema.sql']);
    const { on, total } = await one<{ on: number; total: number }>(
      db,
      `select count(*) filter (where relrowsecurity)::int as on, count(*)::int as total
         from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );
    expect({ on, total }).toEqual({ on: 4, total: 4 });
    expect(
      await errorCode(() =>
        as(db, 'anon', null, () => db.query(`insert into app_users (display_name) values ('x')`)),
      ),
    ).toBe('42501');
    await db.close();
  });

  it('the seed gives nine boards of six, and is idempotent', async () => {
    const db = await freshDatabase();
    await db.exec(await sql('supabase/seed.sql'));
    await db.exec(await sql('supabase/seed.sql'));
    const counts = await one<{ users: number; teams: number; selections: number }>(
      db,
      `select (select count(*)::int from app_users) as users,
              (select count(*)::int from teams) as teams,
              (select count(*)::int from user_team_selections) as selections`,
    );
    expect(counts).toEqual({ users: 9, teams: 50, selections: 54 });
    await db.close();
  });
});

describe('the security model, verb by verb (§30, §31, plan §5.2)', () => {
  let db: PGlite;
  let wilson: string;
  let freeTeam: string;
  let wilsonTeam: string;
  let wilsonSelection: string;

  beforeAll(async () => {
    db = await freshDatabase();
    await db.exec(await sql('supabase/seed.sql'));
    await db.exec(`insert into auth.users values ('${ADMIN}'), ('${STRANGER}');
                   insert into public.admins (auth_user_id, label) values ('${ADMIN}', 'test admin');`);
    wilson = (
      await one<{ id: string }>(db, `select id from app_users where display_name = 'Wilson'`)
    ).id;
    // Southern Miss: a seeded team that is not on Wilson's board.
    freeTeam = (
      await one<{ id: string }>(db, `select id from teams where provider_team_id = '2572'`)
    ).id;
    const selection = await one<{ id: string; team_id: string }>(
      db,
      `select id, team_id from user_team_selections where user_id = $1 order by selection_order limit 1`,
      [wilson],
    );
    wilsonSelection = selection.id;
    wilsonTeam = selection.team_id;
  });

  afterAll(async () => {
    await db.close();
  });

  /** A fingerprint of every row the attacks could touch. Must not change. */
  const snapshot = () =>
    db.query(
      `select (select json_agg(t order by id) from app_users t) as users,
              (select json_agg(t order by id) from teams t) as teams,
              (select json_agg(t order by id) from user_team_selections t) as selections`,
    );

  const attacks = () => ({
    app_users: {
      insert: `insert into app_users (display_name) values ('__probe__')`,
      update: `update app_users set display_name = 'hacked' where id = '${wilson}'`,
      delete: `delete from app_users where id = '${wilson}'`,
    },
    teams: {
      insert: `insert into teams (provider, provider_team_id, name) values ('espn', '__probe__', '__probe__')`,
      update: `update teams set name = 'hacked' where id = '${freeTeam}'`,
      delete: `delete from teams where id = '${freeTeam}'`,
    },
    user_team_selections: {
      insert: `insert into user_team_selections (user_id, team_id, selection_order) values ('${wilson}', '${freeTeam}', 7)`,
      update: `update user_team_selections set selection_order = 20 where id = '${wilsonSelection}'`,
      delete: `delete from user_team_selections where id = '${wilsonSelection}'`,
    },
  });

  const TABLES = ['app_users', 'teams', 'user_team_selections'] as const;
  const VERBS = ['insert', 'update', 'delete'] as const;

  describe('anon — every viewer (plan §11.1)', () => {
    it.each(TABLES)('can read %s', async (table) => {
      const { count } = await as(db, 'anon', null, () =>
        one<{ count: number }>(db, `select count(*)::int as count from ${table}`),
      );
      expect(count).toBeGreaterThan(0);
    });

    for (const table of TABLES) {
      it.each(VERBS)(`cannot %s ${table}: refused at the GRANT (42501)`, async (verb) => {
        const before = await snapshot();
        const code = await errorCode(() =>
          as(db, 'anon', null, () => db.query(attacks()[table][verb])),
        );
        expect(code).toBe('42501');
        expect(await snapshot()).toEqual(before);
      });
    }

    it('cannot read admins at all', async () => {
      expect(
        await errorCode(() => as(db, 'anon', null, () => db.query(`select * from admins`))),
      ).toBe('42501');
    });

    it('is_admin() is false', async () => {
      const { admin } = await as(db, 'anon', null, () =>
        one<{ admin: boolean }>(db, `select public.is_admin() as admin`),
      );
      expect(admin).toBe(false);
    });

    it('reorder_selections() raises 42501, refused at the GRANT before is_admin() runs', async () => {
      const code = await errorCode(() =>
        as(db, 'anon', null, () =>
          db.query(`select reorder_selections($1::uuid, $2::uuid[])`, [wilson, [wilsonSelection]]),
        ),
      );
      expect(code).toBe('42501');
    });
  });

  describe('authenticated but not an administrator — a signed-in stranger', () => {
    it.each(TABLES)('can read %s', async (table) => {
      const { count } = await as(db, 'authenticated', STRANGER, () =>
        one<{ count: number }>(db, `select count(*)::int as count from ${table}`),
      );
      expect(count).toBeGreaterThan(0);
    });

    for (const table of TABLES) {
      it(`cannot insert into ${table}: refused by RLS WITH CHECK (42501)`, async () => {
        const before = await snapshot();
        const code = await errorCode(() =>
          as(db, 'authenticated', STRANGER, () => db.query(attacks()[table].insert)),
        );
        expect(code).toBe('42501');
        expect(await snapshot()).toEqual(before);
      });

      it.each(['update', 'delete'] as const)(
        `cannot %s ${table}: RLS USING hides every row, so nothing changes`,
        async (verb) => {
          const before = await snapshot();
          const result = await as(db, 'authenticated', STRANGER, () =>
            db.query(attacks()[table][verb]),
          );
          expect(result.affectedRows).toBe(0);
          expect(await snapshot()).toEqual(before);
        },
      );
    }

    it('cannot read admins at all', async () => {
      expect(
        await errorCode(() =>
          as(db, 'authenticated', STRANGER, () => db.query(`select * from admins`)),
        ),
      ).toBe('42501');
    });

    it('is_admin() is false', async () => {
      const { admin } = await as(db, 'authenticated', STRANGER, () =>
        one<{ admin: boolean }>(db, `select public.is_admin() as admin`),
      );
      expect(admin).toBe(false);
    });

    it('reorder_selections() raises 42501 from its is_admin() check, and reorders nothing', async () => {
      const before = await snapshot();
      const code = await errorCode(() =>
        as(db, 'authenticated', STRANGER, () =>
          db.query(`select reorder_selections($1::uuid, $2::uuid[])`, [wilson, [wilsonSelection]]),
        ),
      );
      expect(code).toBe('42501');
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('the administrator — the positive case', () => {
    it('is_admin() is true, and admins is still unreadable through the API roles', async () => {
      const { admin } = await as(db, 'authenticated', ADMIN, () =>
        one<{ admin: boolean }>(db, `select public.is_admin() as admin`),
      );
      expect(admin).toBe(true);
      expect(
        await errorCode(() =>
          as(db, 'authenticated', ADMIN, () => db.query(`select * from admins`)),
        ),
      ).toBe('42501');
    });

    it('can insert, update, and delete on every table', async () => {
      await as(db, 'authenticated', ADMIN, async () => {
        const user = await one<{ id: string }>(
          db,
          `insert into app_users (display_name) values ('Probe') returning id`,
        );
        expect(
          (await db.query(`update app_users set display_name = 'Probe 2' where id = $1`, [user.id]))
            .affectedRows,
        ).toBe(1);

        const team = await one<{ id: string }>(
          db,
          `insert into teams (provider, provider_team_id, name) values ('espn', '238', 'Vanderbilt Commodores') returning id`,
        );
        expect(
          (await db.query(`update teams set display_name = 'Vanderbilt' where id = $1`, [team.id]))
            .affectedRows,
        ).toBe(1);

        const selection = await one<{ id: string }>(
          db,
          `insert into user_team_selections (user_id, team_id, selection_order) values ($1, $2, 1) returning id`,
          [user.id, team.id],
        );
        expect(
          (
            await db.query(`update user_team_selections set selection_order = 2 where id = $1`, [
              selection.id,
            ])
          ).affectedRows,
        ).toBe(1);
        expect(
          (await db.query(`delete from user_team_selections where id = $1`, [selection.id]))
            .affectedRows,
        ).toBe(1);
        expect((await db.query(`delete from teams where id = $1`, [team.id])).affectedRows).toBe(1);
        expect(
          (await db.query(`delete from app_users where id = $1`, [user.id])).affectedRows,
        ).toBe(1);
      });
    });

    it('reorder_selections() renumbers a board atomically', async () => {
      const ids = (
        await db.query<{ id: string }>(
          `select id from user_team_selections where user_id = $1 order by selection_order`,
          [wilson],
        )
      ).rows.map((row) => row.id);
      const reversed = [...ids].reverse();
      await as(db, 'authenticated', ADMIN, () =>
        db.query(`select reorder_selections($1::uuid, $2::uuid[])`, [wilson, reversed]),
      );
      const after = (
        await db.query<{ id: string }>(
          `select id from user_team_selections where user_id = $1 order by selection_order`,
          [wilson],
        )
      ).rows.map((row) => row.id);
      expect(after).toEqual(reversed);
      // Put it back for the tests that follow.
      await as(db, 'authenticated', ADMIN, () =>
        db.query(`select reorder_selections($1::uuid, $2::uuid[])`, [wilson, ids]),
      );
    });

    it('reorder_selections() refuses ids from another board (22023) and changes nothing', async () => {
      const other = (
        await one<{ id: string }>(
          db,
          `select s.id from user_team_selections s join app_users u on u.id = s.user_id
            where u.display_name = 'Avery' limit 1`,
        )
      ).id;
      const before = await snapshot();
      const code = await errorCode(() =>
        as(db, 'authenticated', ADMIN, () =>
          db.query(`select reorder_selections($1::uuid, $2::uuid[])`, [wilson, [other]]),
        ),
      );
      expect(code).toBe('22023');
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('constraints the admin console relies on (§3, §44, plan §5.1)', () => {
    it('a two-statement swap succeeds, because uq_user_order is deferred', async () => {
      const [first, second] = (
        await db.query<{ id: string }>(
          `select id from user_team_selections where user_id = $1 order by selection_order limit 2`,
          [wilson],
        )
      ).rows.map((row) => row.id);
      await db.exec(`begin;
        update user_team_selections set selection_order = 2 where id = '${first!}';
        update user_team_selections set selection_order = 1 where id = '${second!}';
      commit;`);
      await db.exec(`begin;
        update user_team_selections set selection_order = 1 where id = '${first!}';
        update user_team_selections set selection_order = 2 where id = '${second!}';
      commit;`);
    });

    it('a genuine duplicate position is still rejected at COMMIT (23505, uq_user_order)', async () => {
      const [first, second] = (
        await db.query<{ id: string }>(
          `select id from user_team_selections where user_id = $1 order by selection_order limit 2`,
          [wilson],
        )
      ).rows.map((row) => row.id);
      const failure = await db
        .exec(
          `begin;
          update user_team_selections set selection_order = 1 where id = '${first!}';
          update user_team_selections set selection_order = 1 where id = '${second!}';
        commit;`,
        )
        .then(() => null)
        .catch((error: { code?: string; message: string }) => error);
      await db.exec('rollback').catch(() => undefined);
      expect(failure?.code).toBe('23505');
      expect(failure?.message).toContain('uq_user_order');
    });

    it('the same team twice on one board is rejected (23505, uq_user_team)', async () => {
      const failure = await db
        .query(
          `insert into user_team_selections (user_id, team_id, selection_order) values ($1, $2, 9)`,
          [wilson, wilsonTeam],
        )
        .catch((error: { code?: string; message: string }) => error);
      expect(failure).toMatchObject({ code: '23505' });
      expect((failure as { message: string }).message).toContain('uq_user_team');
    });

    it('a position outside 1–24 is rejected (23514)', async () => {
      expect(
        await errorCode(() =>
          db.query(
            `insert into user_team_selections (user_id, team_id, selection_order) values ($1, $2, 25)`,
            [wilson, freeTeam],
          ),
        ),
      ).toBe('23514');
    });

    it('a team on a board cannot be deleted (23001, on delete restrict)', async () => {
      // `restrict` reports restrict_violation (23001), not the 23503 a plain
      // foreign key would. No route deletes teams; this guards the data.
      expect(await errorCode(() => db.query(`delete from teams where id = $1`, [wilsonTeam]))).toBe(
        '23001',
      );
    });

    it('deleting a user deletes their board with it (on delete cascade)', async () => {
      const user = await one<{ id: string }>(
        db,
        `insert into app_users (display_name) values ('Cascade') returning id`,
      );
      await db.query(
        `insert into user_team_selections (user_id, team_id, selection_order) values ($1, $2, 1)`,
        [user.id, freeTeam],
      );
      await db.query(`delete from app_users where id = $1`, [user.id]);
      const { count } = await one<{ count: number }>(
        db,
        `select count(*)::int as count from user_team_selections where user_id = $1`,
        [user.id],
      );
      expect(count).toBe(0);
    });

    it('a blank display name is rejected (23514)', async () => {
      expect(
        await errorCode(() => db.query(`insert into app_users (display_name) values ('   ')`)),
      ).toBe('23514');
    });
  });
});
