-- ─────────────────────────────────────────────────────────────────────────────
-- Seed — nine boards, fifty teams, fifty-four selections.
--
-- Every provider_team_id below is a REAL ESPN team id, verified against the
-- captured team list (apps/api/test/fixtures/espn/team-list.json, 762 teams).
-- Seeding with real ids is what lets Phases 2–4 be developed and tested against
-- live sports data long before an admin UI exists (plan §1.3).
--
-- NO auth identities are created here. Viewers never sign in (plan §11.1), and
-- the single `admins` row is inserted by hand once the administrator's account
-- exists — see docs/supabase-setup.md, step 5.
--
-- Idempotent: safe to run more than once. Users are matched by display name,
-- teams by (provider, provider_team_id), selections by (user_id, team_id).
--
-- ── Renaming the nine participants ───────────────────────────────────────────
-- The names below are PLACEHOLDERS apart from "Wilson". Change them before or
-- after seeding; nothing references them but the home screen. Either edit the
-- list in section 1 before running this file, or afterwards:
--
--     update public.app_users set display_name = 'Real Name' where display_name = 'Avery';
--
-- Renaming does not disturb boards — selections key on the user's uuid.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Board participants ────────────────────────────────────────────────────
insert into public.app_users (display_name)
select v.display_name
from (values
  ('Wilson'),
  ('Avery'),
  ('Blake'),
  ('Casey'),
  ('Devin'),
  ('Emerson'),
  ('Finley'),
  ('Harper'),
  ('Jordan')
) as v(display_name)
where not exists (
  select 1 from public.app_users u where u.display_name = v.display_name
);

-- ── 2. Team identities ───────────────────────────────────────────────────────
-- `name` is ESPN's displayName ("Alabama Crimson Tide"); `display_name` is its
-- shortDisplayName ("Alabama"), which is what a card shows (§56).
-- Colours are hex WITHOUT a leading '#', as ESPN supplies them.
-- Logos follow ESPN's stable pattern: /i/teamlogos/ncaa/500/{provider_team_id}.png
--
-- `conference` is seeded from the 2026 alignment. It is cached identity, not
-- live data — Phase 2 refreshes it from the provider (docs/espn-notes.md §7).
insert into public.teams
  (provider, provider_team_id, name, display_name, abbreviation, conference, primary_color, alt_color, logo_url)
select
  'espn', v.pid, v.name, v.short, v.abbr, v.conf, v.color, v.alt,
  'https://a.espncdn.com/i/teamlogos/ncaa/500/' || v.pid || '.png'
from (values
  ('333',  'Alabama Crimson Tide',        'Alabama',        'ALA',  'SEC',            '9e1b32', 'ffffff'),
  ('61',   'Georgia Bulldogs',            'Georgia',        'UGA',  'SEC',            'ba0c2f', '2c2a29'),
  ('251',  'Texas Longhorns',             'Texas',          'TEX',  'SEC',            'af5c37', 'ffffff'),
  ('130',  'Michigan Wolverines',         'Michigan',       'MICH', 'Big Ten',        '00274c', 'ffcb05'),
  ('30',   'USC Trojans',                 'USC',            'USC',  'Big Ten',        '9d2235', 'ffc72c'),
  ('99',   'LSU Tigers',                  'LSU',            'LSU',  'SEC',            '461d76', 'fdd023'),
  ('194',  'Ohio State Buckeyes',         'Ohio State',     'OSU',  'Big Ten',        'ba0c2f', 'a8adb4'),
  ('2483', 'Oregon Ducks',                'Oregon',         'ORE',  'Big Ten',        '00934b', 'fff41b'),
  ('87',   'Notre Dame Fighting Irish',   'Notre Dame',     'ND',   'FBS Independents','062340','c99700'),
  ('213',  'Penn State Nittany Lions',    'Penn State',     'PSU',  'Big Ten',        '061440', 'ffffff'),
  ('2633', 'Tennessee Volunteers',        'Tennessee',      'TENN', 'SEC',            'ff8200', 'ffffff'),
  ('201',  'Oklahoma Sooners',            'Oklahoma',       'OU',   'SEC',            '990000', 'ffffff'),
  ('228',  'Clemson Tigers',              'Clemson',        'CLEM', 'ACC',            'f56600', 'ffffff'),
  ('52',   'Florida State Seminoles',     'Florida St',     'FSU',  'ACC',            '782f40', 'ceb888'),
  ('2390', 'Miami Hurricanes',            'Miami',          'MIA',  'ACC',            'f47423', '035131'),
  ('2',    'Auburn Tigers',               'Auburn',         'AUB',  'SEC',            '002b5c', 'f26522'),
  ('245',  'Texas A&M Aggies',            'Texas A&M',      'TA&M', 'SEC',            '500000', 'ffffff'),
  ('145',  'Ole Miss Rebels',             'Ole Miss',       'MISS', 'SEC',            '13294b', 'cf142b'),
  ('275',  'Wisconsin Badgers',           'Wisconsin',      'WIS',  'Big Ten',        'a00000', 'ffffff'),
  ('2294', 'Iowa Hawkeyes',               'Iowa',           'IOWA', 'Big Ten',        '231f20', 'fcd116'),
  ('254',  'Utah Utes',                   'Utah',           'UTAH', 'Big 12',         'be0000', 'ffffff'),
  ('264',  'Washington Huskies',          'Washington',     'WASH', 'Big Ten',        '33006f', 'e8d3a2'),
  ('57',   'Florida Gators',              'Florida',        'FLA',  'SEC',            '0021a5', 'fa4616'),
  ('158',  'Nebraska Cornhuskers',        'Nebraska',       'NEB',  'Big Ten',        'e31937', 'ffffff'),
  ('2306', 'Kansas State Wildcats',       'Kansas St',      'KSU',  'Big 12',         '330a57', 'e2e3e4'),
  ('142',  'Missouri Tigers',             'Missouri',       'MIZ',  'SEC',            'f1b82d', '000000'),
  ('97',   'Louisville Cardinals',        'Louisville',     'LOU',  'ACC',            'c9001f', 'ffffff'),
  ('9',    'Arizona State Sun Devils',    'Arizona St',     'ASU',  'Big 12',         'ffc627', '8c1d40'),
  ('252',  'BYU Cougars',                 'BYU',            'BYU',  'Big 12',         '0047ba', '002e5d'),
  ('2567', 'SMU Mustangs',                'SMU',            'SMU',  'ACC',            'a80000', '0033a1'),
  ('68',   'Boise State Broncos',         'Boise St',       'BOIS', 'Mountain West',  '0033a0', 'd64309'),
  ('221',  'Pittsburgh Panthers',         'Pitt',           'PITT', 'ACC',            '003594', 'ffb81c'),
  ('153',  'North Carolina Tar Heels',    'North Carolina', 'UNC',  'ACC',            '7bafd4', '13294b'),
  ('127',  'Michigan State Spartans',     'Michigan St',    'MSU',  'Big Ten',        '173f35', 'ffffff'),
  ('2572', 'Southern Miss Golden Eagles', 'Southern Miss',  'USM',  'Sun Belt',       'ffc72c', '231f20'),
  ('38',   'Colorado Buffaloes',          'Colorado',       'COLO', 'Big 12',         'cfb87c', '000000'),
  ('8',    'Arkansas Razorbacks',         'Arkansas',       'ARK',  'SEC',            'a32136', 'ffffff'),
  ('96',   'Kentucky Wildcats',           'Kentucky',       'UK',   'SEC',            '0033a0', 'ffffff'),
  ('259',  'Virginia Tech Hokies',        'Virginia Tech',  'VT',   'ACC',            '6a2c3e', 'cf4520'),
  ('2641', 'Texas Tech Red Raiders',      'Texas Tech',     'TTU',  'Big 12',         'da291c', '000000'),
  ('239',  'Baylor Bears',                'Baylor',         'BAY',  'Big 12',         '154734', 'ffb81c'),
  ('2628', 'TCU Horned Frogs',            'TCU',            'TCU',  'Big 12',         '4d1979', 'ffffff'),
  ('356',  'Illinois Fighting Illini',    'Illinois',       'ILL',  'Big Ten',        'ff5f05', '13294b'),
  ('84',   'Indiana Hoosiers',            'Indiana',        'IU',   'Big Ten',        '970310', 'ffffff'),
  ('150',  'Duke Blue Devils',            'Duke',           'DUKE', 'ACC',            '00539b', 'ffffff'),
  ('152',  'NC State Wolfpack',           'NC State',       'NCSU', 'ACC',            'cc0000', 'ffffff'),
  ('135',  'Minnesota Golden Gophers',    'Minnesota',      'MINN', 'Big Ten',        '5e0a2f', 'fab41c'),
  ('2426', 'Navy Midshipmen',             'Navy',           'NAVY', 'American',       '00225b', 'b5a67c'),
  ('235',  'Memphis Tigers',              'Memphis',        'MEM',  'American',       '004991', '8e908f'),
  ('2655', 'Tulane Green Wave',           'Tulane',         'TULN', 'American',       '006747', '418fde')
) as v(pid, name, short, abbr, conf, color, alt)
on conflict (provider, provider_team_id) do update set
  name          = excluded.name,
  display_name  = excluded.display_name,
  abbreviation  = excluded.abbreviation,
  conference    = excluded.conference,
  primary_color = excluded.primary_color,
  alt_color     = excluded.alt_color,
  logo_url      = excluded.logo_url;

-- ── 3. Selections ────────────────────────────────────────────────────────────
-- Wilson's board is the canonical example from §56, so the first screen of the
-- app matches the specification exactly.
--
-- Jordan's board deliberately re-uses four teams that appear on other boards
-- (Alabama, Texas, Ohio State, Notre Dame). §1 allows it, and it exercises the
-- shared-team cache-dedupe path the board fan-out depends on (§27).
--
-- Southern Miss is on Emerson's board on purpose: it is the longest display name
-- in the seed, and Phase 3 is supposed to prove the card grid survives it.
insert into public.user_team_selections (user_id, team_id, selection_order)
select u.id, t.id, v.ord
from (values
  ('Wilson',  '333',  1), ('Wilson',  '61',   2), ('Wilson',  '251',  3),
  ('Wilson',  '130',  4), ('Wilson',  '30',   5), ('Wilson',  '99',   6),

  ('Avery',   '194',  1), ('Avery',   '2483', 2), ('Avery',   '87',   3),
  ('Avery',   '213',  4), ('Avery',   '2633', 5), ('Avery',   '201',  6),

  ('Blake',   '228',  1), ('Blake',   '52',   2), ('Blake',   '2390', 3),
  ('Blake',   '2',    4), ('Blake',   '245',  5), ('Blake',   '145',  6),

  ('Casey',   '275',  1), ('Casey',   '2294', 2), ('Casey',   '254',  3),
  ('Casey',   '264',  4), ('Casey',   '57',   5), ('Casey',   '158',  6),

  ('Devin',   '2306', 1), ('Devin',   '142',  2), ('Devin',   '97',   3),
  ('Devin',   '9',    4), ('Devin',   '252',  5), ('Devin',   '2567', 6),

  ('Emerson', '68',   1), ('Emerson', '221',  2), ('Emerson', '153',  3),
  ('Emerson', '127',  4), ('Emerson', '2572', 5), ('Emerson', '38',   6),

  ('Finley',  '8',    1), ('Finley',  '96',   2), ('Finley',  '259',  3),
  ('Finley',  '2641', 4), ('Finley',  '239',  5), ('Finley',  '2628', 6),

  ('Harper',  '356',  1), ('Harper',  '84',   2), ('Harper',  '150',  3),
  ('Harper',  '152',  4), ('Harper',  '135',  5), ('Harper',  '2426', 6),

  ('Jordan',  '333',  1), ('Jordan',  '251',  2), ('Jordan',  '194',  3),
  ('Jordan',  '87',   4), ('Jordan',  '235',  5), ('Jordan',  '2655', 6)
) as v(display_name, pid, ord)
join public.app_users u on u.display_name = v.display_name
join public.teams     t on t.provider = 'espn' and t.provider_team_id = v.pid
on conflict (user_id, team_id) do nothing;

commit;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect: 9 users, 50 teams, 54 selections, and every board holding exactly 6.
select
  (select count(*) from public.app_users)            as users,
  (select count(*) from public.teams)                as teams,
  (select count(*) from public.user_team_selections) as selections;

select u.display_name, count(s.id) as team_count
from public.app_users u
left join public.user_team_selections s on s.user_id = u.id
group by u.display_name
order by u.display_name;
