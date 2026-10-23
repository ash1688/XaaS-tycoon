# AI playtest brief

You're playtesting **XaaS Tycoon**, a classroom business game. You run a company with one product (social network,
video platform or e-commerce shop) on one deployment model (on-prem, IaaS, PaaS or SaaS), and try to reach day 180
without going bankrupt. Play it as a player would: through the commands below only. Don't read the game's source
code or config. Everything a student can see is in the game's own output.

## How to play

Run every command from the `sim` folder. `<game>` is the path to your game file, for example `C:/tmp/ai/minmax-1.json`.

```bash
npm run -s play -- new <game> --product social --model paas --loan --shares 10000 --seed 1 --player "AI 1" --playstyle min-maxer
npm run -s play -- look <game>
npm run -s play -- do <game> "hire support junior 3; price 6; next 7"
npm run -s play -- summary <game>
```

- `new` starts a game and shows the company and the commands. Leave out `--loan` to start without the bank loan.
  `--shares` is how many shares your company has (10,000 to 100,000, 10,000 if left out): you own all of them.
  `--length` picks the game length: `180-days` (the default), `1-year` (ends on day 365) or `career` (47 years,
  ends on day 17,155). Play 180 days unless your brief says otherwise.
  `--difficulty` picks `easy`, `normal` (the default) or `hard`: Easy starts with more cash, has fewer random events
  and customers who put up with dearer prices; Hard the opposite. The status line shows it. Play Normal unless your
  brief says otherwise.
- `look` shows the company and every command that works right now, with prices and allowed values.
- `do` runs game commands separated by `;`. Every game command goes inside `do`, including `preview` and `quote`:
  `npm run -s play -- do <game> "preview 8; quote iaas"`.
- `next [days]` (inside `do`) moves time on, 7 days by default, and **stops early** when something needs a
  decision: an event that hurts, an outage, a new risk on the danger meter, a built feature, a server arriving,
  staff starting, capacity running out, satisfaction falling, cash about to run out, the price lock ending, or paid
  API calls starting to be dropped. Any commands after a stop are not run, and each says so ("not run: time
  stopped"). Events that need nothing from you are shown but don't stop time. Each advance ends with how the users
  changed, and each day shows paying users lost to a dear price, poor support or downtime.
- A refused command says why, and the rest of the batch still runs. A refused `letgo` or `move` also shows the
  grades that team has now.
- Staff come in junior, mid and senior grades, each with its own pay and work a day, and each takes days to start
  after hiring (shown under staff until they do). `hire <pool> [grade] [n]` and `letgo <pool> [grade] [n]` take a
  grade; without one it's mids. Time also stops when hires start.
- Random events come from an encounter system. The **danger meter** in `look` rises every day after launch and goes
  back to 0 when a random event fires. It creeps on a well-run day and climbs faster with risky play: servers going
  unpatched (fewer ops than your setup needs, on on-prem or IaaS), capacity overloaded, or unhappy customers. Which
  event comes next, and when, is hidden; your situation also changes which events are likely.
- `preview <price>` and `quote <model>` show what a price change or migration would do without doing it.
  A price rise's reaction is each customer type's reaction weighted by its share of users: the status shows your
  customer mix, each type's price threshold, and `!` where your price is over it.
- `valuation` shows what your company is worth, what's pushing it up or down, and who owns it. `funding` shows the
  friends and family and grant offers in full; `accept ff`, `accept grant`, `decline ff` and `decline grant` answer
  them, once each.
- `loan` takes a bank loan, repaid daily over a fixed term; `repayloan` pays it off early to save interest. One loan
  at a time: once it's repaid, `loan` is offered again.
- `summary` shows the final figures once the game is over.
- `end` (inside `do`) ends the game as the teacher would from the staff panel, scored as it stands. Only use it if
  your brief asks you to test it.

Run `look` whenever you're unsure what you can do. Keep going until the game ends: its final day (day 180 by default), or bankruptcy.

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

## What to hand back

When the game is over, reply with a **game summary** of no more than about 300 words:

1. **Setup:** playstyle, product, model, loan or not, seed.
2. **Ending:** finished or bankrupt, on which day, final cash, paying and free users, satisfaction and uptime (from `summary`),
   and your valuation and the share of the company you still own (from `valuation`).
3. **Key moments:** first profit, price changes, migrations, funding taken or declined, events and how you handled
   them (and what the danger meter was doing), any crisis.
4. **What you tried** and whether it worked.
5. **Anything that felt broken, unfair, confusing or exploitable**, with the day and the commands that caused it.
6. **One change you'd make** to the game.

Your game file and its log (`<game>.log.json`, in the same format as the classroom playtest log) stay on disk for analysis.
