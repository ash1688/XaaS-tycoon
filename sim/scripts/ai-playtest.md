# AI playtest brief

You're playtesting **XaaS Tycoon**, a classroom business game. You run a company with one product (e-commerce shop,
social network, video platform, payments app, AI assistant or games network) on one deployment model (on-prem, IaaS, PaaS or SaaS), and try to reach day 180
without going into liquidation. Play it as a player would: through the commands below only. Don't read the game's source
code or config. Everything a student can see is in the game's own output.

## How to play

Run every command from the `sim` folder. `<game>` is the path to your game file, for example `C:/tmp/ai/minmax-1.json`.

```bash
npm run -s play -- new <game> --product social --model paas --loan --shares 10000 --seed 1 --player "AI 1" --playstyle min-maxer
npm run -s play -- look <game>
npm run -s play -- do <game> "hire support junior 3; price 6; next 7"
npm run -s play -- summary <game>
```

- `new` starts a game and shows the company and the commands. `--product` is `ecommerce`, `social`, `video`,
  `assistant` (AI assistant) or `games` (games network). Leave out `--loan` to start without the bank loan.
  `--shares` is how many shares your company has (10,000 to 100,000, 10,000 if left out): you own all of them.
  `--length` picks the game length: `180-days` (the default), `until-ipo` (no last day: it ends only when you float),
  `1-year` (ends on day 365) or `career` (47 years, ends on day 17,155). Play 180 days unless your brief says
  otherwise. The IPO ends every length. `--date 2026-11-01` starts the game on that date; left out, it starts on a
  random date this year.
  `--difficulty` picks `easy`, `normal` (the default) or `hard`: Easy starts with more cash, has fewer random events
  and customers who put up with dearer prices; Hard the opposite. The status line shows it. Play Normal unless your
  brief says otherwise.
- `look` shows the company and every command that works right now, with prices and allowed values.
- `do` runs game commands separated by `;`. Every game command goes inside `do`, including `preview` and `quote`:
  `npm run -s play -- do <game> "preview 8; quote iaas"`.
- `next [days]` (inside `do`) moves time on, 7 days by default, in ticks as the game page does: a tick is a day, or
  a week in a career. It **stops early**, on the day itself, when the game pauses for the student: an event that
  hurts or brings a wave of new users, or an outage, a holiday that hits your product (announced 14 days ahead, and on the day it starts), an
  alert (capacity over 100%, satisfaction falling below the poor mark, the grant withdrawn, paid API calls starting
  to be dropped), a new offer, cash about to run out, or something finished (the MVP ready to launch, a feature
  built, the launch over, servers ready, a migration step, the grant's condition met). The text interface also
  stops for a new risk on the danger meter, staff starting, satisfaction falling hard, reports going unhandled and the price lock
  ending.
  Any commands after a stop are not run, and each says so ("not run: time stopped"). Events that need nothing from
  you are shown but don't stop time. Each advance ends with how the users changed, and each day shows paying users
  lost to a dear price, poor support or downtime.
- A refused command says why, and the rest of the batch still runs. A refused `letgo` or `move` also shows the
  grades that team has now.
- Staff come in junior, mid and senior grades, each with its own pay and work a day, and each takes days to start
  after hiring (shown under staff until they do). `hire <pool> [grade] [n]` and `letgo <pool> [grade] [n]` take a
  grade; without one it's mids. Time also stops when hires start.
- Add `agency` before the grade for **agency staff** (`hire support agency 2`, `letgo support agency 2`): they start
  the next day, cost 1.25× and do half the work of permanent staff of the same grade, and go with no severance. They're
  listed apart from permanent staff. Letting go **permanent staff** pays their severance at once (shown per grade under
  staff, and on the `letgo` line); it's refused if you haven't the cash. `move` only moves permanent staff.
- Every game opens with an **MVP**: no users arrive, and nothing earns, until your developers have built it, while
  everyone is paid from day 1. The status shows its progress in developer-days and the day it'll be done. More
  developers finish it sooner (agency developers count at half), and on SaaS it's much shorter. Once it's done the
  company waits, **ready to launch**, until you type `launch`: go-live is the next day played, and your first users
  arrive at the end of it, over a 3-day launch ramp. Hosting bills start at go-live too, so servers rented while you
  wait cost nothing until then (on-prem kit is still paid for when you buy it). You can launch without an app server,
  database or ops: the status's launch line says what you'd be short of, and users who can't be served leave.
- Once the MVP is done, the **developer slider** splits developer time between features and **optimisation**:
  `optimise <0–100>` sets the % on optimisation. Optimisation builds up for good and cuts what each user needs (CU and
  DBU on on-prem and IaaS, instances on PaaS, the per-user fee on SaaS), quickly at first and then flattening out
  under a cap (higher on on-prem). The status shows the saving so far and the cap.
- Features sit in **tiers** 1–4. Tier 1 is open from the start; each later tier becomes available on a condition the
  status shows (users, then income and uptime, then an angel's money or IPO readiness), in order. Each feature and
  model benefit in an available tier then needs **research points (RP)** to unlock, in any order: `unlock <id>`
  (the status lists what you can unlock and its price), then you build or buy it as usual. Unlocks are kept for good,
  through migrations.
- **Researchers** and **marketers** are two more staff pools that open when your first angel investor approaches,
  whatever you do with the offer. Both are permanent hires only (no agency). Researchers earn RP every day, banked with
  no cap: `hire researchers [grade] [n]`. They're flagged idle once there's nothing left to unlock.
- **Campaigns** bring new users of one customer type directly, on top of normal growth:
  `campaign <type> <budget> <days>` (the `look` line shows what a user of each type costs today), and
  `stopcampaign <id>` stops one. Each needs a free marketer (`hire marketers [grade] [n]`), the most senior free one
  runs it, and their grade scales the users per pound. Campaigns bring fewer users as your market fills, when two aim
  at the same type, and more when started just before a holiday that boosts your product. A busy marketer can't be let
  go; marketers with no Campaign are flagged idle.
- On a social network or video platform, users post content and report some of it. **Moderators** are a fourth
  staff pool there (not on an e-commerce shop): `hire moderators [grade] [n]`. The status shows the reports a day,
  what your moderators handle and what's left unhandled. Unhandled reports pull satisfaction down and raise the odds
  of a lawsuit (shown as a multiplier).
- Random events come from an encounter system. The **danger meter** in `look` rises every day after launch and goes
  back to 0 when a random event fires. It creeps on a well-run day and climbs faster with risky play: servers going
  unpatched (fewer ops than your setup needs, on on-prem or IaaS), capacity overloaded, or unhappy customers. Which
  event comes next, and when, is hidden; your situation also changes which events are likely.
- The game runs on a **real calendar**: `look` shows today's date and year, any holiday on now and the next one
  coming. Holidays (January blues, Easter and summer holidays, Black Friday, Christmas) fall on their dates every
  year and hit each product its own way, multiplying load and growth on their days: a shop's Black Friday spike, more
  social and video use in the school holidays. They sit outside the danger meter, so you can plan capacity for them.
  `calendar` lists every holiday still to come in the game, with its dates and what it does to your product.
- `preview <price>` and `quote <model>` show what a price change or migration would do without doing it.
  A price rise's reaction is each customer type's reaction weighted by its share of users: the status shows your
  customer mix, each type's price threshold, and `!` where your price is over it.
- The mix shifts. `new users join as` shows the mix new users arrive in: the product's own, tilted by your features
  (each pulls a customer type, shown in `features` as `[pulls ...]`) and your price (above a type's threshold, fewer
  of that type join). A rise loses casual users first, and downtime drives businesses and professionals out. A
  pricier company ends up more professional, so its next rise hurts less.
- One or two **rivals** share your market. The status shows each company's market share, price and quality (0–100,
  from features and uptime). New users of each customer type go mostly to the best value for them: casual users chase
  price, businesses quality. Rivals answer a price change 14 days later, sometimes undercutting you, and staff you
  let go may join one and raise its quality. `market` shows it all in full, with who wins each customer type.
- The **payments app** (`--product payments`) earns two ways: a monthly fee from each paying business, and a
  transaction fee, a share of every payment they take. `price <fee> <rate%>` sets both in one change, with one lock
  (`price 12 2.5%`; the fee alone keeps today's rate), and `preview <fee> <rate%>` shows what they'd do. Customers judge
  them together, as what a usual month costs a business. The status shows both streams, the next payday and Black
  Friday (on the calendar), when payments (and load) rise. Outages hurt it most: no payments are taken, and no fee charged, for the hours you're down.
- `valuation` shows what your company is worth, what's pushing it up or down, and who owns it. `funding` shows the
  friends and family and grant offers in full; `accept ff`, `accept grant`, `decline ff` and `decline grant` answer
  them, once each. Either can be negotiated first: `counter ff amount 18000 share 18` asks friends and family for more
  cash and/or a smaller share (a percent), and `counter grant amount 11000 days 45` asks the grant for more cash and/or
  fewer days of its condition. A dice roll sets their next offer: a high roll moves most of the way to your counter, a
  middle one halfway, and a low one makes them dig in: their next offer is a little worse. You can counter twice; the third offer is final. The more you ask, the worse
  the odds, and a counter can ask at most 50% better terms in all. They never walk away: the latest offer stands until
  you accept or decline it. `odds ff ...` (same terms as `counter`) shows the odds and what each roll would bring.
  **Auto-negotiate**: `auto ff ...` (or `auto grant`, `auto angel`, `auto vc`, with the same terms as `counter`) makes
  that counter, then repeats it on each offer with the same rolls as by hand, and prints each round, ending on the
  final offer. On average it's no better and no worse than countering by hand. It never accepts: you still `accept` or
  `decline`.
- An **angel investor** may approach you (time stops when they do, and `look` shows them under `investors`). `angel`
  shows their offer in full: their cash for a share of the company, the valuation it puts on the company, their target
  (income, and users gained less users lost, both within a few weeks) and what happens if you miss it. `counter angel amount 30000 share 15` and `odds angel ...` negotiate it the same
  way as friends and family. `accept angel` takes it: the cash arrives, your valuation becomes theirs and moves with
  the company's performance from then on, and friends and family and the grant close for good. `decline angel` turns
  them down, and another angel approaches a few days later. An offer stands for a few days only (`look` shows when
  it lapses); left unanswered, it lapses and counts as declining it.
- **Venture capital**: after the angel, Series A, B, C and D each approach as your company grows (time stops, and
  `look` shows them under `vc`). Three VCs come for each round, each leaning towards the most cash, the fewest
  conditions or the least of the company taken. `vc` shows their offers in full and how every round stands. `pick 2`
  (or the start of a name) negotiates with one alone, which closes the other two; then `counter vc ...`, `odds vc ...`,
  `accept vc` and `decline vc` work as for the angel. `decline vc` before picking turns all three down. Turned down,
  failed or left to lapse, three new VCs approach for the same round a few days later. Accepting sets your valuation
  to the VC's figure, and they become your lead VC, back for the next round alongside two new VCs. The IPO needs no
  round's money, but Series A must have approached: it opens the last C-suite roles. A 180-day game has two rounds,
  not four: Series A (the size of A and B together) and Series B (C and D together). Each pays its cash in two
  tranches, the first on signing and the second once the company hits the VC's growth target (`vc` shows what's still
  to come).
- **Pay reviews**: a game counts as one year of four quarters, and before quarters 2, 3 and 4 your staff come to you
  about pay. Until IPO and a career have years of 365 days: reviews before quarters 2, 3 and 4 of the first year, then
  before every quarter after (`Y2Q1` is quarter 1 of year 2). Time stops, and `next` is refused until the review is settled. `pay` shows it: this review's inflation
  (2–6%), the least you may offer (inflation less a point) and the most staff ask (inflation plus four points), where
  they open. `offer 3.5` offers a 3.5% rise: staff accept an offer that reaches a hidden figure near a fair rise for
  how the company is doing, or counter, and a dice roll decides how far they come down (a low roll makes them ask for
  more). `payodds 3.5` shows what an offer would cost a day and a year, and the odds on their counter. `accept pay`
  agrees their counter at any time. Your third offer is final: if staff don't accept it, it goes to a **tribunal**,
  which charges a fee (about £2k) and picks your figure, staff's or the middle, favouring whichever is closest to the
  hidden fair rise, so lowballing backfires. `autopay 3.5` (schemes as with `offer`) auto-negotiates: it makes the
  offer, then the same again after each counter with the same rolls, and prints each one. If staff accept it's settled;
  if not, it stops on their last counter for you to `accept pay` or make the final offer yourself: it never goes to the
  tribunal by itself. On the final offer `payodds` shows the tribunal's odds. The rise raises every team's day rate from the next day, new hires and agency staff included,
  and each review's rise compounds on the last. A rise below inflation is a pay cut in real terms.
- **Staff schemes**: an offer can add schemes to a smaller cash rise: `offer 2.5 pension=2 health=1 death=on
  discount=on shares=1` (pension top-up, the health cash plan and share save go 0–3; death in service and the discount
  scheme are on or off). **Share save** (`shares=`) costs only a little admin, but each level added issues new shares
  worth 1% of the company to the staff share scheme on the cap table, diluting you; `payodds` shows your stake after. Staff weigh the offer's worth: the cash plus each level added × its worth to them × about 70% (they want cash).
  Only levels added this review count. Each scheme then costs every day for good, as staff spend, for every permanent
  member of staff: the pension and death in service a share of pay, the health plan and discount scheme £ per person,
  each with its own cost for what staff see in it. Levels only go up: lowering one is refused. Staff's counter
  keeps the schemes in your latest offer and asks the rest in cash, so accepting it starts them; a tribunal keeps your
  schemes whichever figure it picks. `pay` lists the schemes, levels and costs; `payodds 2.5 pension=2` shows the offer's worth and each
  scheme's cost.
- `payhistory` lists every pay review settled: its date, inflation, staff's opening ask, how it ended (your offer
  accepted, staff's counter accepted, or the tribunal's pick and fee), the cash rise against inflation, the schemes
  raised and share save's new shares, and the pay multiplier after; then the schemes held with their cost a day, the
  staff share scheme's stake and when the next review comes.
- **Drift** (until IPO and a career only): at the end of every 365-day year, running prices rise by a fresh random
  2–6% (servers, VMs, rent, provider and platform fees, power, model benefits) and time stops. Your own price never
  rises by itself, and pay only rises in pay reviews. Servers and VMs added after a year's end give 10% more units for
  the money each year (compounding); kit you already have keeps its units, so replacing old kit can pay. The `drift:`
  status line shows prices against the start and the next year's end; `drift` lists each year's end. A 180-day or
  1-year game never reaches a year's end, so it never drifts.
- **Server wear** (on-prem): a server wears its slider² a day (1 at 100%). Its life is about 5 years (1,825 days) in a
  1-year game or longer, and 250 in a 180-day game, so at 100% it lasts the game but at 150% it wears out in about 111
  days. At 90% worn, time stops with a warning (`NEARLY WORN OUT in ~Nd` beside the server); past its life it may
  crash on any day. Sell it and buy a new one, or turn its slider down.
- The first time cash runs out, a **vulture VC rescues** the company: it puts in cash for the losses plus about 30
  days, takes most of the company in new shares, and forces cost cuts (staff let go, hires cancelled). Time stops
  when it happens. `rescue` shows the terms in full; `buyback` buys all its shares back from company cash, at the
  price it sets (shown in `look`). Running out of cash a second time is **liquidation**, and the game ends.
- `csuite` lists the C-suite: every role, when it opens, who's hired, and each open role's shortlist of three
  candidates (id, strength, salary a day, equity ask now and what they'd do). `appoint <id>` (such as `appoint cfo-2`)
  hires one, for good: no letting go, and pay reviews leave their pay alone. Equity asks are new shares, and shrink as
  the C-suite's 10% cap fills. The heads open on day 1, the CFO on outside money or the first angel approach, the CTO
  and head of people at the first angel approach, and the COO, CIO, CMO, CISO and legal counsel at the Series A
  approach. Every role is needed to IPO: all 11 beyond you, the CEO. If cash falls below 7 days of running costs, the
  C-suite takes a **pay holiday**: none of them is paid (and it isn't owed later) until cash is back above 21 days.
- `ipo` shows the IPO readiness checklist: six conditions (a trading history; users and revenue, with a minimum
  paying customer base; an uptime record; predictable costs; a security audit; and the full C-suite, all 11 roles
  hired), each with where you stand and what's needed. Satisfaction and profit aren't conditions, but the market
  still weighs them: in the valuation, the cold-market chance and the first day of trading. The records need 30 days of trading since launch. Once every condition is met, `apply` applies to
  float: there's a small hidden chance of a cold market (postponed 30 days, satisfaction lost), less the more
  comfortably you're over every condition. Once approved, time holds (no `next`) until you ring the bell: `ipo`
  shows the offer and `ring <15-40>` floats that % of
  the company in new shares (diluting everyone) and rings the opening bell: the first day of trading is played and
  **the game ends**. A small float swings further on the day. Time stops when every condition is first met, and
  again if a ready company loses one.
- `loan` takes a bank loan, repaid daily over a fixed term; `repayloan` pays it off early to save interest. One loan
  at a time: once it's repaid, `loan` is offered again.
- `summary` shows the final figures once the game is over.
- `end` (inside `do`) ends the game as the teacher would from the staff panel, scored as it stands. Only use it if
  your brief asks you to test it.

Run `look` whenever you're unsure what you can do. Keep going until the game ends: its final day (day 180 by default), liquidation, or the IPO.

## Your playstyle

Play the whole game in character as your playstyle:

| Playstyle | How you play |
|---|---|
| `min-maxer` | Your only goal is the highest final cash. Hunt for exploits and **actually try them**: a preview is a hint, not a test. When something looks too good (a huge projected income, a cost that seems free), commit to it, play some days, and judge by real cash. Test the edges: extreme prices (up to the maximum), price cuts and rises in sequence, mass hiring and letting go, timing tricks around the price lock. If a trick works, repeat it. |
| `maxer` | Go for the biggest company: aggressive growth, take every risk that might pay off. |
| `average-joe` | Play like a typical student: skim the output, mostly advance time, react to problems late, follow the obvious prompts. Don't calculate. |
| `low-and-slow` | Cautious: avoid debt if you can, take few risks, grow steadily, keep a cash cushion. |
| `chaos-tester` | Try odd things just to see what happens: let everyone go, charge £1 or £1,000, migrate twice. |
| `spiffin-brit` | Find one ridiculous loophole and ride it as far as it goes, narrating how the system is "working as intended". |
| `reamu-keaves` | Breathtakingly wholesome: keep prices fair, never let anyone go, keep customers happy. Can doing right by everyone still win? |
| `hodd-toward` | "It just works!" Ship every feature as fast as you can, scale nothing until it breaks, overpromise. |

Whatever your playstyle, use the company's whole pipeline at least once, in character: how many developers build the
MVP, where the slider sits, what you research and when, and whether marketers and Campaigns earn their keep.

Every game has three **pay reviews** (before days 46, 91 and 136 in a 180-day game), and you must settle each one, so
negotiate them in character too. Before you offer, read `pay` and try `payodds` at a figure or two. Across the three
reviews, try at least two different approaches, and use at least one staff scheme in at least one review, for example:
- cash only, around inflation, taking a counter when it's reasonable
- a smaller cash rise topped up with schemes (share save included), and watch your stake and the daily scheme costs
- a lowball that runs to the tribunal, so you see its odds, its pick and its fee
- `autopay` from your opening figure, then decide on staff's last counter

Run `payhistory` at the end, and judge each approach by what it cost you in cash and ownership over the rest of the
game, not just on the day.

## What to hand back

When the game is over, reply with a **game summary** of no more than about 350 words:

1. **Setup:** playstyle, product, model, loan or not, seed.
2. **Ending:** finished, liquidated or floated (and whether you were rescued, and when), on which day, final cash, paying and free users, satisfaction and uptime (from `summary`),
   and your valuation and the share of the company you still own (from `valuation`). After an IPO: the float, cash
   raised, the close and market value, and your stake (from `ipo`).
3. **Key moments:** the MVP done and the launch day (when you pressed Launch), first profit, price changes, migrations, funding taken or
   declined, any rescue or buy-back, what you researched and unlocked, Campaigns you ran (spend, users, cost per user),
   where you kept the developer slider, events and how you handled them (and what the danger meter was doing), any
   crisis.
4. **Pay reviews** (from `payhistory`): for each review, inflation, what you offered (cash and schemes), how it ended
   (offer taken, counter taken, or the tribunal's pick and fee) and the rise against inflation; the schemes you hold and
   their cost a day, the staff share scheme's stake, and which approach you'd use again, and why.
5. **What you tried** and whether it worked.
6. **Anything that felt broken, unfair, confusing or exploitable**, with the day and the commands that caused it.
7. **One change you'd make** to the game.

Your game file and its log (`<game>.log.json`, in the same format as the classroom playtest log) stay on disk for analysis.
