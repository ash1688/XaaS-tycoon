# AI playtest brief

You're playtesting **XaaS Tycoon**, a classroom business game. You run a company with one product (social network,
video platform or e-commerce shop) on one deployment model (on-prem, IaaS, PaaS or SaaS), and try to reach day 180
without going bankrupt. Play it as a player would: through the commands below only. Don't read the game's source
code or config. Everything a student can see is in the game's own output.

## How to play

Run every command from the `sim` folder. `<game>` is the path to your game file, for example `C:/tmp/ai/minmax-1.json`.

```bash
npm run -s play -- new <game> --product social --model paas --loan --seed 1 --player "AI 1" --playstyle min-maxer
npm run -s play -- look <game>
npm run -s play -- do <game> "hire support 3; price 6; next 7"
npm run -s play -- summary <game>
```

- `new` starts a game and shows the company and the commands. Leave out `--loan` to start without the bank loan.
- `look` shows the company and every command that works right now, with prices and allowed values.
- `do` runs game commands separated by `;`. Every game command goes inside `do`, including `preview` and `quote`:
  `npm run -s play -- do <game> "preview 8; quote iaas"`.
- `next [days]` (inside `do`) moves time on, 7 days by default, and **stops early** when something needs a
  decision: an event that hurts, an outage, a built feature, a server arriving, capacity running out, satisfaction
  falling, cash about to run out, the price lock ending, or paid API calls starting to be dropped. Any commands after a stop are skipped. Events that need
  nothing from you are shown but don't stop time.
- `preview <price>` and `quote <model>` show what a price change or migration would do without doing it.
- `summary` shows the final figures once the game is over.

Run `look` whenever you're unsure what you can do. Keep going until the game ends: day 180, or bankruptcy.

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
2. **Ending:** finished or bankrupt, on which day, final cash, paying and free users, satisfaction and uptime (from `summary`).
3. **Key moments:** first profit, price changes, migrations, events and how you handled them, any crisis.
4. **What you tried** and whether it worked.
5. **Anything that felt broken, unfair, confusing or exploitable**, with the day and the commands that caused it.
6. **One change you'd make** to the game.

Your game file and its log (`<game>.log.json`, in the same format as the classroom playtest log) stay on disk for analysis.
