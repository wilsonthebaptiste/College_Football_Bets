# College Football Team Board — Application Specification

## 1. Application Overview

The application is a private, mobile-friendly college football dashboard for a fixed group of users.

There are initially **9 individual users**. Each user has **6 selected college football teams**, creating up to **54 team selections** across all users.

The purpose of the application is to give the group a simple, centralized way to see:

- Which teams each user selected
- Each selected team's current record
- Each selected team's current ranking
- The team's previous opponent and result
- The team's next opponent, game date, and game time
- Live/current game information when a game is in progress
- The team's complete current-season schedule
- Available matchup win-probability/prediction information
- Current information that refreshes automatically

A team may be selected by more than one user.

The application should feel like a polished sports dashboard rather than an administrative database.

---

# 2. Primary Users

## 2.1 Regular Users

Regular users can:

- Sign in
- View the available users/boards
- Open a user's board
- View the six teams assigned to that board
- View current team information
- Open an individual team
- View the team's complete current-season schedule
- View available game prediction/win-probability information

Regular users cannot change another user's team selections.

## 2.2 Administrator

The administrator can manage the application-owned data associated with the boards.

The administrator can:

- Create/manage users
- Change a user's display name
- Add a team to a user's board
- Remove a team from a user's board
- Reorder a user's six team selections
- Search for valid college football teams
- Manage the team identities associated with board selections

Administrator permissions must be enforced server-side/database-side and not merely hidden in the frontend.

---

# 3. Core Data Concepts

The application contains three primary application-owned concepts:

## User

Represents one participant in the group.

A user has:

- Unique identifier
- Display name
- Authentication identity
- Created timestamp
- Updated timestamp

## Team

Represents a college football team selected by one or more users.

A team has:

- Internal application identifier
- Sports-data-provider identifier
- Provider name
- Team name
- Abbreviation
- Logo/image reference when available
- Conference when available

## User Team Selection

Represents the relationship between a user and a selected team.

A selection has:

- Unique identifier
- User identifier
- Team identifier
- Selection order
- Created timestamp

The same team may belong to multiple users.

The same team should not appear twice on the same user's board unless the application explicitly supports that behavior.

---

# 4. Sports Data

Sports data is external, dynamic information.

The application should treat the sports-data provider as the authoritative source for frequently changing sports information.

The sports-data layer may use ESPN initially where the required information is available.

Sports information can include:

- Current win/loss record
- Current ranking
- Team metadata
- Current-season schedule
- Completed game results
- Upcoming games
- Live game state
- Scores
- Game date/time
- Home/away status
- Game location when available
- Game status
- Available matchup prediction/win probability
- Opponent information

The application must not fabricate sports information.

If a particular field is unavailable from the provider, the application should display an appropriate unavailable state rather than estimating or inventing a value.

---

# 5. Sports Data Provider Abstraction

The application must separate provider-specific sports data from the rest of the application.

The frontend and core application logic should work with normalized application data rather than raw provider responses.

Conceptually, the application should support a sports-data provider interface capable of supplying:

- Team information
- Team record
- Team ranking
- Team schedule
- Previous game
- Next game
- Individual game information
- Prediction/win probability when available

The initial implementation may use an ESPN provider, but ESPN-specific response formats, endpoints, and parsing logic must remain isolated within the provider/data-service layer.

The application should therefore be capable of replacing ESPN with another data source later without requiring the frontend or application-wide data model to be rewritten.

---

# 6. Current Team Information

Every selected team should expose the following information when available:

- Team name
- Team logo
- Current ranking
- Current win/loss record
- Conference
- Previous opponent
- Previous game result
- Next opponent
- Next game date
- Next game time
- Home/away status
- Current game status
- Live score when applicable

Example:

**Alabama**  
**#4**  
**4–0**

Previous Game:  
LSU — W 31–24

Next Game:  
Tennessee — October 3, 4:30 PM

The exact content displayed may adjust based on game state and available provider data.

---

# 7. Ranking Behavior

The application should display the team's current ranking when ranking information is available.

Examples:

- `#1`
- `#8`
- `#25`

For an unranked team, display:

- `NR`
- or another clearly defined unranked indicator

The application must handle missing ranking data without breaking the page.

The application should not infer or calculate a ranking.

---

# 8. Team Record

The current team record should be displayed prominently.

For example:

- `4–0`
- `3–1`
- `2–2`

If ties or other record components are supplied by the sports provider, the application should preserve them accurately.

The record should always represent the current season being displayed.

---

# 9. Previous Game

Each selected team should show its most recent completed game when one exists.

Previous-game information can include:

- Opponent
- Date
- Final score
- Team score
- Opponent score
- Win/loss/tie
- Home/away
- Location when available

Example:

**Previous Game**  
LSU  
**W 31–24**

The previous game should not be confused with a currently live game.

---

# 10. Next Game

Each selected team should show its next scheduled game when one exists.

Next-game information can include:

- Opponent
- Date
- Time
- Home/away
- Location
- Game status
- Network/broadcast information if available

Example:

**Next Game**  
Tennessee  
**Oct. 3 · 4:30 PM**

If a team has no upcoming game, the application should display a meaningful state such as:

- `No upcoming game`
- `Season complete`

The application must also correctly represent bye weeks.

---

# 11. Live Game State

If a selected team's next/current game is in progress, the board should prioritize live information.

A live game can display:

- LIVE indicator
- Current score
- Opponent
- Quarter/period
- Time remaining
- Other live status information when available

Example:

**ALABAMA — LIVE**

Alabama 24  
Tennessee 21

3rd Quarter · 04:32

The application should update live information automatically.

Live information must never be presented as final until the provider reports that the game is complete.

---

# 12. Matchup Prediction / Win Probability

The individual team page should display available matchup prediction or win-probability information for the relevant upcoming game.

Example:

**Matchup Prediction**

Alabama — 67%  
Tennessee — 33%

The application must use an actual provider-supplied prediction/probability when available.

The application must not invent a percentage and label it as an ESPN or provider prediction.

When no prediction is available, display:

`Prediction unavailable`

The prediction source should be identifiable in the interface where appropriate.

---

# 13. User Board

A board represents one user's six selected teams.

The board should make the six teams easy to compare at a glance.

Each team should appear as a card or row containing, at minimum:

- Team logo
- Team name
- Current rank
- Current record
- Previous opponent
- Previous result
- Next opponent
- Next game date
- Next game time
- Current/live status when applicable

A board should clearly communicate:

- Which user is being viewed
- Which six teams are selected
- What each team is currently doing

The board should not require opening six separate pages to understand the current state of the teams.

---

# 14. Board Layout

The exact visual design is flexible, but the information hierarchy should remain consistent.

A board should conceptually resemble:

    USER NAME

    ┌───────────────────────────────┐
    │ Team logo  Alabama            │
    │           #4 · 4–0            │
    │                               │
    │ Previous: LSU                 │
    │ Result: W 31–24              │
    │                               │
    │ Next: Tennessee               │
    │ Oct. 3 · 4:30 PM             │
    └───────────────────────────────┘

    [Five additional team cards]

The layout can use a responsive grid on larger screens and a stacked layout on smaller screens.

---

# 15. Home / User Selection

The application should provide an obvious way to select a user's board.

The initial user population is nine people.

The home experience should allow a user to quickly identify and open the desired board.

The interface can present the users as:

- Cards
- Buttons
- A list
- Another clear selection UI

The user should not have to navigate through unnecessary menus to reach a board.

---

# 16. Team Detail Page

Clicking a team from a board opens the team's detail view.

The team detail page should prominently display:

- Team logo
- Team name
- Current rank
- Current record
- Conference when available
- Previous game
- Next game
- Matchup prediction/win probability when available
- Complete current-season schedule

The team detail page is the detailed view of the team.

---

# 17. Full Season Schedule

The individual team page should display the team's full schedule for the current season.

Each scheduled game can contain:

- Week
- Date
- Opponent
- Home/away
- Result or status
- Team score
- Opponent score
- Game time
- Location when available

Example:

| Week | Date | Opponent | H/A | Status | Score |
|------|------|----------|-----|--------|-------|
| 1 | Aug. 29 | Team A | Home | Final | W 34–17 |
| 2 | Sep. 5 | Team B | Away | Final | W 27–21 |
| 3 | Sep. 12 | Team C | Home | Final | L 20–24 |
| 4 | Sep. 19 | Team D | Away | Upcoming | — |

On mobile, the schedule may be represented as stacked game cards rather than a wide table.

---

# 18. Game Statuses

The application must support different game states.

At minimum:

- Scheduled / Upcoming
- Live / In Progress
- Final / Completed
- Postponed
- Canceled
- Delayed
- Bye
- Season Complete

The exact provider status codes should be normalized into application-level statuses.

---

# 19. Home/Away/Neutral Status

Games should indicate whether the selected team is:

- Home
- Away
- Neutral site

Do not assume the first listed team is always the home team.

Use the provider's actual designation.

---

# 20. Dates and Times

Sports timestamps should be stored as actual timestamps rather than arbitrary formatted strings.

The application should preserve sufficient information to correctly display:

- Date
- Local time
- Game status

Internally, timestamps should use a consistent timezone strategy, preferably UTC, with conversion performed for display.

The application should not hard-code strings such as `4:30 PM` into the underlying data model.

---

# 21. Current Season

The application should primarily display the current college-football season.

The season should not be permanently hard-coded to one year.

The application should have centralized season logic so that a new season can be displayed without restructuring the application.

The team record, ranking, schedule, previous game, upcoming game, and predictions should all correspond to the same selected/current season.

---

# 22. Offseason Behavior

When a season is complete:

- Completed games remain visible
- The record remains accurate
- The final schedule remains accessible
- The application must not break because there are no upcoming games
- The interface can indicate that the season is complete
- The application can transition to the next season according to its centralized season logic

No offseason behavior should result in undefined or broken UI.

---

# 23. Data Freshness

Sports information is dynamic and should be treated differently based on how often it can change.

Information such as team metadata can be cached longer.

Information about upcoming games can be refreshed more frequently.

Live game information should be refreshed significantly more frequently than completed-game information.

Completed games can be cached more aggressively.

The application should expose enough metadata to distinguish between:

- Fresh data
- Cached data
- Stale data
- Unavailable data

When appropriate, the interface should show a timestamp such as:

`Last updated: 3:42 PM`

The application should never imply that stale cached information is currently live.

---

# 24. Live Update Behavior

The application should automatically refresh dynamic sports information.

The preferred behavior is intelligent polling/caching rather than immediately requiring a persistent WebSocket system.

The application should:

- Refresh normally changing data at a moderate interval
- Refresh live games at a faster interval
- Avoid aggressive refreshes when no games are occurring
- Reduce unnecessary background work when the page is not visible
- Avoid duplicate requests

The exact refresh intervals should be centralized and configurable.

---

# 25. Caching

Caching should happen at the backend/data-service layer rather than independently from every browser.

The intended behavior is:

    Browser
       ↓
    Application API
       ↓
    Cache
       ↓
    External sports provider only when necessary

This reduces external requests and gives the application consistent data behavior.

The cache should distinguish between different categories of data, such as:

- Team metadata
- Rankings
- Upcoming games
- Live games
- Completed games
- Predictions
- Schedules

---

# 26. Frontend-to-Backend Relationship

The frontend should communicate with the application's API.

The frontend should not contain provider-specific ESPN endpoint logic.

The application API should return normalized data designed specifically for the website.

The frontend should not have to understand raw ESPN JSON structures.

---

# 27. Board Data Efficiency

Loading a user's board should be efficient.

The board should obtain the information needed to display all six teams without unnecessarily creating a long chain of independent browser requests.

The application should favor consolidated board-oriented responses where appropriate.

Detailed team schedule information can be loaded when the user opens a team.

---

# 28. Suggested Application API Concepts

The implementation may expose endpoints conceptually similar to:

- `GET /api/users`
- `GET /api/users/:userId`
- `GET /api/users/:userId/board`
- `GET /api/teams/:teamId`
- `GET /api/teams/:teamId/schedule`
- `GET /api/games/:gameId`
- `GET /api/health`

Administration functionality may include authenticated endpoints for:

- User management
- Team assignment
- Team removal
- Team ordering

The exact endpoint structure may differ as long as the same application behavior is supported.

---

# 29. Authentication

The application should support authenticated access.

Supabase Authentication is the intended authentication system.

Authentication should provide:

- Login
- Logout
- Persistent sessions
- Protected pages/operations
- Administrative authorization

Authentication identity and application profile/display information should remain conceptually separate.

---

# 30. Authorization

Regular users should have read access to the application data they are permitted to view.

Administrative write access must be protected.

Authorization must be enforced by the backend/database security model.

Frontend-only checks are insufficient.

A user should not be able to modify data merely by manually constructing a network request.

---

# 31. Database Security

The database should use Row Level Security or an equivalent server-enforced authorization mechanism.

The database should never depend on frontend assumptions such as:

- Hiding a button
- Removing an admin route
- Checking a JavaScript variable

Security rules must exist outside the UI.

---

# 32. Free Infrastructure Requirement

The application is intended to remain a completely free personal project.

The target architecture should avoid requiring paid infrastructure or paid subscriptions.

Intended categories of infrastructure include:

- React/Vite frontend
- Cloudflare Workers/serverless backend
- Supabase PostgreSQL/authentication
- GitHub source control
- No required paid sports-data subscription

A future paid/custom domain is optional and is not a requirement of the application.

The application should not rely on a paid service for a feature that can reasonably be implemented using the free architecture.

---

# 33. Proposed Technology Stack

The intended stack is:

### Frontend
- React
- Vite
- TypeScript
- CSS

### Backend
- Cloudflare Workers

### Database
- Supabase PostgreSQL

### Authentication
- Supabase Auth

### Source Control
- GitHub

### Sports Data
- ESPN initially, isolated behind a provider abstraction

The application should not add libraries merely because they are popular.

Additional dependencies should have a clear purpose.

---

# 34. Responsive Design

The application must work well on:

- Desktop
- Tablet
- Mobile phone

Mobile use is an important requirement.

The application should:

- Avoid accidental horizontal overflow
- Use touch-friendly controls
- Keep team cards readable
- Make navigation easy on narrow screens
- Adapt the schedule to small displays
- Maintain clear visual hierarchy

---

# 35. Visual Design

The interface should have a polished sports-dashboard appearance.

Desired characteristics:

- Clean
- Modern
- Easy to scan
- Strong visual hierarchy
- Moderate use of color
- Appropriate sports aesthetics
- Clear status indicators
- Consistent spacing
- Consistent card design
- Subtle borders and emphasis
- Minimal unnecessary animation

Team-specific colors may be used as subtle accents.

The interface should not become visually chaotic when six different teams have different branding.

---

# 36. Team Logos

Team logos should be displayed when reliable logo information is available.

Images should include accessible alternative text.

If a logo is missing or cannot be loaded, the team card should fall back gracefully to:

- Team initials
- Generic team icon
- Another neutral placeholder

A missing image must never break the team card.

---

# 37. Loading States

Network-dependent information needs clear loading states.

Examples:

- `Loading team data...`
- `Loading schedule...`
- `Refreshing game information...`

The interface should not render raw undefined/null fields while asynchronous data is loading.

---

# 38. Error States

Errors should be isolated and understandable.

Possible messages include:

- `Unable to load team information.`
- `Sports data temporarily unavailable.`
- `Schedule temporarily unavailable.`
- `Prediction unavailable.`

A single team's data failure should not prevent the other five teams on a board from loading.

The application should distinguish between:

- Temporary provider failure
- Missing data
- Invalid data
- Authorization failure
- Application error

---

# 39. Stale Data Behavior

When a sports-data request fails but valid cached data exists:

- Show the cached information
- Clearly indicate that it may be stale
- Preserve the last-updated timestamp when possible

When neither fresh nor cached information exists:

- Show an unavailable state

The application must never make stale data look unquestionably current.

---

# 40. External Data Validation

External sports-provider responses must be treated as untrusted external input.

The application should safely handle:

- Missing fields
- Null fields
- Unexpected values
- Changed provider structures
- Unknown game states
- Incomplete schedules
- Provider outages

External data should be transformed into the application's normalized domain model before being consumed by the rest of the application.

---

# 41. Type Safety

The application should use strict TypeScript.

Core sports concepts should have explicit types for:

- Team
- Record
- Ranking
- Game
- Schedule
- Prediction
- User
- User team selection
- Data freshness/status

The application should avoid `any` unless there is a specific unavoidable reason.

Provider responses should have provider-specific types separate from normalized application types.

---

# 42. Error Isolation

The application should be resilient when different parts of the external data are unavailable.

Examples:

If ranking data is missing:
- Record, schedule, and game information can still display.

If prediction data is missing:
- The team page still displays the schedule.

If a team's logo fails:
- The team card still displays.

If one team fails:
- Other selected teams still display.

If the sports provider is temporarily unavailable:
- Cached data can be displayed when appropriate.

---

# 43. Administrative Team Selection

Team selections should reference real team identities rather than free-form text.

When an administrator searches for or selects a team, the application should store the team's provider identifier and normalized identity.

The board should therefore remain tied to a real sports entity even if the provider's displayed name changes slightly.

---

# 44. User Board Ordering

Each user has six ordered team selections.

The selected order should be preserved.

The administrator can change the order so the board can have an intentional presentation sequence.

The application should not randomly reorder teams.

---

# 45. Data Ownership Boundaries

The application-owned database is responsible for:

- Users
- Authentication/profile association
- Team identities
- User/team selections
- Ordering
- Administrative configuration

The sports provider is responsible for dynamic:

- Records
- Rankings
- Game information
- Scores
- Schedules
- Predictions
- Live status

The application should not unnecessarily duplicate provider-owned data into persistent relational tables.

---

# 46. Sports Information Must Be Labeled Correctly

Provider-supplied information should be labeled accurately.

For example, if a percentage comes from a provider's game predictor, describe it as such.

Do not call an internally calculated percentage an ESPN prediction.

Do not present betting-market information as a provider prediction unless the source explicitly supports that characterization.

---

# 47. Navigation

The user should be able to move easily among:

- Home
- User board
- Team detail page
- Login
- Administrative pages where authorized

The application should preserve intuitive browser navigation and allow users to use the back button normally.

---

# 48. Accessibility

The application should use:

- Semantic HTML
- Proper heading hierarchy
- Keyboard-accessible controls
- Visible focus states
- Meaningful button/link labels
- Appropriate color contrast
- Alternative text for logos/images
- Accessible status indicators

Interactive team cards should be keyboard accessible and not depend solely on mouse hover.

---

# 49. Performance

The application should prioritize:

- Fast initial load
- Efficient API requests
- Appropriate caching
- Small dependency footprint
- Minimal duplicate requests
- Reasonable image sizes
- Lazy loading of detailed data where appropriate

Because the application is small, avoid premature performance complexity.

---

# 50. Reliability Expectations

The website should continue functioning even when:

- A provider request fails
- A provider returns incomplete data
- A prediction is missing
- A ranking is unavailable
- A team has no upcoming game
- A game is postponed
- A game is canceled
- A team has a bye
- A game is live
- A season is complete
- A logo is unavailable

The application should fail gracefully rather than crash.

---

# 51. Application Information Hierarchy

The most important information, in order, is:

1. User
2. Team
3. Current record/ranking
4. Current or previous game status
5. Next game
6. Prediction/win probability
7. Full schedule

The interface should emphasize what is happening now rather than burying current information underneath historical details.

---

# 52. Future Extensibility

The application is initially limited to the requested features, but the architecture should allow future additions without major restructuring.

Potential future capabilities include:

- More users
- More than six teams per user
- Multiple seasons
- Historical seasons
- Conference standings
- Team statistics
- Head-to-head comparisons
- Live score ticker
- Notifications
- Additional sports-data providers
- Additional team metrics

These are not required features of the initial application.

The initial application should not build them merely because the architecture allows them.

---

# 53. Explicit Non-Requirements

The following are not required for the initial application:

- Native mobile application
- Paid hosting
- Paid database
- Paid sports-data subscription
- Custom domain
- Betting functionality
- User messaging/chat
- Social networking
- Public comments
- Complex analytics
- Fantasy football scoring
- Automatic team selection
- AI-generated predictions
- Custom prediction models
- Advanced statistical modeling

---

# 54. Core Functional Summary

The application must support the following end-to-end behavior:

A user authenticates.

They can access the collection of user boards.

A user board contains six selected college football teams.

For each team, the board shows current sports information, including:

- Team name
- Ranking
- Record
- Previous game/result
- Next game/date/time
- Live information when applicable

The user can select a team.

The team detail page displays:

- Team identity
- Ranking
- Record
- Previous game
- Next game
- Available matchup prediction
- Full current-season schedule

Dynamic information updates automatically.

An administrator can manage which teams belong to each board.

The application remains usable when sports data is missing, stale, delayed, or temporarily unavailable.

The architecture isolates sports-provider-specific logic and is designed for a free deployment.

---

# 55. Design Principles

The application should consistently follow these principles:

### Accuracy over convenience
Never invent sports information.

### Current information over duplicated storage
Use the provider for dynamic sports data and use caching appropriately.

### Simplicity over unnecessary complexity
Use the smallest architecture that reliably satisfies the requirements.

### Separation of concerns
Keep authentication, database data, sports-provider data, backend logic, and frontend presentation distinct.

### Maintainability
Provider changes should be isolated.

### Security
Authorization must be enforced outside the UI.

### Graceful degradation
Missing or failed data should result in a clear state, not a broken application.

### Responsive design
The application should be equally usable on a phone and desktop.

### Free operation
The required application should be deployable without mandatory paid services.

---

# 56. Canonical Example

A representative board might appear conceptually as:

## Wilson

### Alabama
#4 · 4–0

Previous:  
LSU — W 31–24

Next:  
Tennessee — Oct. 3 · 4:30 PM

---

### Georgia
#7 · 3–1

Previous:  
Florida — W 28–17

Next:  
Auburn — Oct. 10 · 3:30 PM

---

### Texas
#3 · 4–0

Previous:  
Oklahoma — W 34–20

Next:  
Oklahoma State — Oct. 17 · 7:00 PM

---

### Michigan
NR · 3–1

Previous:  
Team A — W 27–14

Next:  
Team B — Oct. 10 · 12:00 PM

---

### USC
#15 · 3–1

Previous:  
Team C — L 21–24

Next:  
Team D — Oct. 3 · 8:00 PM

---

### LSU
#12 · 2–2

Previous:  
Team E — W 38–28

Next:  
Team F — Oct. 10 · 4:00 PM

Each team card is interactive and opens that team's detailed page.

---

# 57. Final Product Definition

This application is a private college football team-tracking dashboard for nine users.

Each user owns a six-team board.

The application combines:

- User/team selection data from the application's database
- Current college-football data from an external sports-data provider
- Automatic updates
- Team-level details
- Full schedules
- Rankings
- Records
- Game results
- Upcoming game information
- Available matchup predictions

The application should be visually simple, fast, responsive, reliable, secure, and free to operate under the intended free infrastructure.

The application must clearly distinguish between:

- Data the application owns
- Data supplied by the sports-data provider
- Fresh data
- Cached/stale data
- Actual provider predictions
- Missing/unavailable information

This specification defines the application's expected behavior and feature set. It is not a development plan and does not prescribe the order in which the application must be built.
