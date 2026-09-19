/**
 * The mock provider's teams: the fifty seeded in `supabase/seed.sql`, under the
 * same provider ids, so every seeded board resolves in mock mode. Opponents are
 * drawn from this list as well, so an opponent name is always a real team.
 *
 * Identity only. Everything the mock says about games, scores, records, and
 * rankings is generated and labelled `provider: 'mock'`.
 *
 * No logo URLs: those are ESPN's CDN, and nothing outside `providers/espn/`
 * references ESPN (§5). Board cards take logos from Postgres anyway, and a
 * `null` opponent logo exercises the UI's initials fallback (§36).
 */
export interface RosterTeam {
  id: string;
  name: string;
  short: string;
  abbr: string;
  conference: string;
  color: string;
  alt: string;
}

type Row = readonly [
  id: string,
  name: string,
  short: string,
  abbr: string,
  conference: string,
  color: string,
  alt: string,
];

const ROWS: readonly Row[] = [
  ['333', 'Alabama Crimson Tide', 'Alabama', 'ALA', 'SEC', '9e1b32', 'ffffff'],
  ['61', 'Georgia Bulldogs', 'Georgia', 'UGA', 'SEC', 'ba0c2f', '2c2a29'],
  ['251', 'Texas Longhorns', 'Texas', 'TEX', 'SEC', 'af5c37', 'ffffff'],
  ['130', 'Michigan Wolverines', 'Michigan', 'MICH', 'Big Ten', '00274c', 'ffcb05'],
  ['30', 'USC Trojans', 'USC', 'USC', 'Big Ten', '9d2235', 'ffc72c'],
  ['99', 'LSU Tigers', 'LSU', 'LSU', 'SEC', '461d76', 'fdd023'],
  ['194', 'Ohio State Buckeyes', 'Ohio State', 'OSU', 'Big Ten', 'ba0c2f', 'a8adb4'],
  ['2483', 'Oregon Ducks', 'Oregon', 'ORE', 'Big Ten', '00934b', 'fff41b'],
  ['87', 'Notre Dame Fighting Irish', 'Notre Dame', 'ND', 'FBS Independents', '062340', 'c99700'],
  ['213', 'Penn State Nittany Lions', 'Penn State', 'PSU', 'Big Ten', '061440', 'ffffff'],
  ['2633', 'Tennessee Volunteers', 'Tennessee', 'TENN', 'SEC', 'ff8200', 'ffffff'],
  ['201', 'Oklahoma Sooners', 'Oklahoma', 'OU', 'SEC', '990000', 'ffffff'],
  ['228', 'Clemson Tigers', 'Clemson', 'CLEM', 'ACC', 'f56600', 'ffffff'],
  ['52', 'Florida State Seminoles', 'Florida St', 'FSU', 'ACC', '782f40', 'ceb888'],
  ['2390', 'Miami Hurricanes', 'Miami', 'MIA', 'ACC', 'f47423', '035131'],
  ['2', 'Auburn Tigers', 'Auburn', 'AUB', 'SEC', '002b5c', 'f26522'],
  ['245', 'Texas A&M Aggies', 'Texas A&M', 'TA&M', 'SEC', '500000', 'ffffff'],
  ['145', 'Ole Miss Rebels', 'Ole Miss', 'MISS', 'SEC', '13294b', 'cf142b'],
  ['275', 'Wisconsin Badgers', 'Wisconsin', 'WIS', 'Big Ten', 'a00000', 'ffffff'],
  ['2294', 'Iowa Hawkeyes', 'Iowa', 'IOWA', 'Big Ten', '231f20', 'fcd116'],
  ['254', 'Utah Utes', 'Utah', 'UTAH', 'Big 12', 'be0000', 'ffffff'],
  ['264', 'Washington Huskies', 'Washington', 'WASH', 'Big Ten', '33006f', 'e8d3a2'],
  ['57', 'Florida Gators', 'Florida', 'FLA', 'SEC', '0021a5', 'fa4616'],
  ['158', 'Nebraska Cornhuskers', 'Nebraska', 'NEB', 'Big Ten', 'e31937', 'ffffff'],
  ['2306', 'Kansas State Wildcats', 'Kansas St', 'KSU', 'Big 12', '330a57', 'e2e3e4'],
  ['142', 'Missouri Tigers', 'Missouri', 'MIZ', 'SEC', 'f1b82d', '000000'],
  ['97', 'Louisville Cardinals', 'Louisville', 'LOU', 'ACC', 'c9001f', 'ffffff'],
  ['9', 'Arizona State Sun Devils', 'Arizona St', 'ASU', 'Big 12', 'ffc627', '8c1d40'],
  ['252', 'BYU Cougars', 'BYU', 'BYU', 'Big 12', '0047ba', '002e5d'],
  ['2567', 'SMU Mustangs', 'SMU', 'SMU', 'ACC', 'a80000', '0033a1'],
  ['68', 'Boise State Broncos', 'Boise St', 'BOIS', 'Mountain West', '0033a0', 'd64309'],
  ['221', 'Pittsburgh Panthers', 'Pitt', 'PITT', 'ACC', '003594', 'ffb81c'],
  ['153', 'North Carolina Tar Heels', 'North Carolina', 'UNC', 'ACC', '7bafd4', '13294b'],
  ['127', 'Michigan State Spartans', 'Michigan St', 'MSU', 'Big Ten', '173f35', 'ffffff'],
  ['2572', 'Southern Miss Golden Eagles', 'Southern Miss', 'USM', 'Sun Belt', 'ffc72c', '231f20'],
  ['38', 'Colorado Buffaloes', 'Colorado', 'COLO', 'Big 12', 'cfb87c', '000000'],
  ['8', 'Arkansas Razorbacks', 'Arkansas', 'ARK', 'SEC', 'a32136', 'ffffff'],
  ['96', 'Kentucky Wildcats', 'Kentucky', 'UK', 'SEC', '0033a0', 'ffffff'],
  ['259', 'Virginia Tech Hokies', 'Virginia Tech', 'VT', 'ACC', '6a2c3e', 'cf4520'],
  ['2641', 'Texas Tech Red Raiders', 'Texas Tech', 'TTU', 'Big 12', 'da291c', '000000'],
  ['239', 'Baylor Bears', 'Baylor', 'BAY', 'Big 12', '154734', 'ffb81c'],
  ['2628', 'TCU Horned Frogs', 'TCU', 'TCU', 'Big 12', '4d1979', 'ffffff'],
  ['356', 'Illinois Fighting Illini', 'Illinois', 'ILL', 'Big Ten', 'ff5f05', '13294b'],
  ['84', 'Indiana Hoosiers', 'Indiana', 'IU', 'Big Ten', '970310', 'ffffff'],
  ['150', 'Duke Blue Devils', 'Duke', 'DUKE', 'ACC', '00539b', 'ffffff'],
  ['152', 'NC State Wolfpack', 'NC State', 'NCSU', 'ACC', 'cc0000', 'ffffff'],
  ['135', 'Minnesota Golden Gophers', 'Minnesota', 'MINN', 'Big Ten', '5e0a2f', 'fab41c'],
  ['2426', 'Navy Midshipmen', 'Navy', 'NAVY', 'American', '00225b', 'b5a67c'],
  ['235', 'Memphis Tigers', 'Memphis', 'MEM', 'American', '004991', '8e908f'],
  ['2655', 'Tulane Green Wave', 'Tulane', 'TULN', 'American', '006747', '418fde'],
];

export const ROSTER: readonly RosterTeam[] = ROWS.map(
  ([id, name, short, abbr, conference, color, alt]) => ({
    id,
    name,
    short,
    abbr,
    conference,
    color,
    alt,
  }),
);
