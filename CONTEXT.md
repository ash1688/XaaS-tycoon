# XaaS Tycoon

A classroom business simulation in which students run a company and choose how to deploy its product (on-prem, IaaS, PaaS or SaaS), learning who manages each layer and what it costs.

## Language

### Games

**Game length**:
How long a game runs before it ends, if the company doesn't go bankrupt first: 180 days, until IPO, 1 year, or career.
_Avoid_: Mode, game mode, duration

**Debrief**:
The end-of-game step where the student sees the model comparison and answers three written prompts about their choices.
_Avoid_: Reflection, review, survey

**Model comparison**:
The student's own game recalculated for each other deployment model, shown at the end of every game.
_Avoid_: What-if, alternative costs

**Tutorial company**:
A permanent, scripted practice game every student has, which can be restarted at any time and never counts towards limits or scores.
_Avoid_: Tutorial mode, practice game

**Difficulty**:
Easy, Normal or Hard: a set of numbers the student picks from those the teacher allows. Never changes which systems exist.
_Avoid_: Mode, level

**Career**:
The longest game length: the student founds the company at 18 and runs it until they retire at 65.
_Avoid_: Lifetime mode, 65 years

**Tick**:
One step of the timed flow: a day, or a week in a career. A week is seven days simulated one by one.
_Avoid_: Turn, round

**Drift**:
The slow change in the world over a long game: inflation, cheaper hardware and server wear.
_Avoid_: Eras, ageing

**MVP**:
The first version of the product, which every game opens with the developers building, measured in developer-days. No users arrive until it's done: launch is the first day it's done and servers can serve them.
_Avoid_: Prototype, beta

**Go-live**:
The launch day: the first day users arrive. Hosting bills start from it.
_Avoid_: Release, ship date

### People

**C-suite**:
The company's senior leaders. The student is the CEO; the others (CFO, CTO and so on) are each hired once from a shortlist and kept for the rest of the game.
_Avoid_: Executives, leadership team, management

**Staff**:
The developers, ops, support and moderators hired and let go in bulk, as permanent or agency staff. Not the C-suite.
_Avoid_: Employees, workers

**Grade**:
Junior, mid or senior: sets a member of staff's pay, output and how long they take to arrive.
_Avoid_: Level, skill level, seniority

**Agency staff**:
Temporary staff who cost 1.25× and do half the work of permanent staff, arrive the next day, and can be let go with no severance.
_Avoid_: Contractors, temps (contract users are customers)

**Permanent staff**:
Staff employed directly, who are paid severance when let go.
_Avoid_: Employees, full-time staff

### Infrastructure

**Rack**:
A small, medium or large frame that holds on-prem servers, measured in rack units. Only on-prem companies have them.
_Avoid_: Cabinet, server room

**Rack unit (U)**:
One slot in a rack. Each server size takes a set number of them.
_Avoid_: SU, slot

**Tier**:
A level of benefits a company unlocks by meeting conditions. Each holds product features and model benefits.
_Avoid_: Level, plan (there are no pricing plans)

**Product feature**:
A benefit that belongs to the product, such as messaging or checkout. Survives a migration.
_Avoid_: Add-on (an add-on is a product feature bought from a SaaS provider)

**Model benefit**:
A benefit that belongs to the deployment model, such as on-prem optimisation or a PaaS CDN. Lost on migration.
_Avoid_: Upgrade, perk

### Customers

**Deal**:
A contract a company offers the student: a set number of users at a set price for a set time, under an SLA with daily penalties.
_Avoid_: Contract, offer (an offer is an investor's terms)

**Contract users**:
Users who came through a deal. They pay the contract price, ignore price rises, and are paid back the difference if the price is lowered below it.
_Avoid_: Business users, enterprise users

**Rival**:
A computer-run company in the same market, described only by its price, quality and market share. Competes for new users.
_Avoid_: Competitor, AI company, opponent

**Campaign**:
Marketing aimed at one customer type, with a budget and a length, that brings in extra new users of that type.
_Avoid_: Advert, marketing spend, ad

**Transaction fee**:
The payments app's percentage of every transaction its business customers process, charged on top of their monthly fee.
_Avoid_: Commission, cut, take rate

**Customer type**:
A group of users with its own price threshold: casual users, enthusiasts, professionals or businesses. Each product has its own mix.
_Avoid_: Segment, persona, tier

**Customer mix**:
Each customer type's share of a company's users. It starts as the product's mix and shifts as users come and go: features, the price and downtime change who joins and who leaves.
_Avoid_: Segmentation, demographics

**New-user mix**:
The customer mix new users arrive in: the product's mix, tilted by the features (each pulls in a customer type) and the price (fewer of a type join above its price threshold). Rivals and campaigns tilt it too.
_Avoid_: Acquisition mix, inflow

**Price threshold**:
The price at which a customer type starts to react badly.
_Avoid_: Pain point, willingness to pay

**Price reaction**:
How many users leave or go free after a price change: each customer type's reaction weighted by its share of users. Contract users are left out.
_Avoid_: Median reaction, backlash (backlash is the wave over the following days)

**API call**:
One use of the company's paid API by another business, earning about 1p.
_Avoid_: Request, hit

**APIU**:
API units: the capacity for API calls, from API servers or app servers converted from CU.
_Avoid_: API capacity units, API CU

**Content product**:
A product whose users post content: the social network, the video platform and the games network. Only these have reports and moderators.
_Avoid_: UGC product, community product

**Report**:
A user flagging another user's post on a content product, for a moderator to handle. Reports nobody handles pull satisfaction down and raise the odds of a lawsuit.
_Avoid_: Flag, complaint, ticket (tickets go to support)

### Events

**Encounter list**:
The rolled list of random events that could happen next, each with a threshold. Emptied and re-rolled whenever an event fires.
_Avoid_: Event queue, event pool

**Danger meter**:
A number that starts at 0 after each random event and rises daily, faster when the company is run riskily. An event fires when it reaches the next threshold on the encounter list.
_Avoid_: Encounter rate, risk score

**Calendar event**:
An event tied to a real date, such as Black Friday or the summer holidays. Outside the encounter system: it doesn't use or reset the danger meter.
_Avoid_: Scheduled event, seasonal event

### Money

**Valuation**:
What the company is worth: the formula's figure until the first investor after friends and family names one, then that figure moved in step with the formula.
_Avoid_: Company value, worth, market value (market value is only after the IPO)

**Seed money**:
The bank loan the student can take at the start. It's debt, not outside investment, so it doesn't unlock the CFO.
_Avoid_: Starting loan, startup loan

**Funding round**:
A sale of new shares to an investor or funder in exchange for cash.
_Avoid_: Investment, raise

**Shares in issue**:
How many shares the company has. The student picks 10,000–100,000 at the start; each funding round adds more.
_Avoid_: Share count, total shares

**Share price**:
Valuation divided by shares in issue.

**Funding ladder**:
The order of investment after friends and family: an angel, then Series A, B, C and D venture capital rounds.
_Avoid_: Stages, levels

**Angel investor**:
The first rung of the funding ladder: one investor who approaches a few days after the company first earns steady revenue. Accepting their offer sets the valuation to their figure and closes friends and family and grants; declining brings another angel a few days later.
_Avoid_: Angel round, seed investor

**Lead VC**:
The VC the student went with in the last round, who returns to offer in the next round alongside two new VCs.
_Avoid_: Main investor

**Tranche**:
One part of a VC round's cash. The first is paid on signing; the second only when the round's target is hit.
_Avoid_: Instalment, payment

**Rescue buyout**:
What happens the first time the company runs out of cash: a vulture VC puts in cash for a large share of the company and forces cost cuts.
_Avoid_: Bailout, rescue

**Vulture VC**:
The investor behind a rescue buyout. Separate from the funding ladder; the student can buy its shares back at a price it sets.

**Liquidation**:
The end of a game: the company runs out of cash after it has already had a rescue buyout.
_Avoid_: Bankruptcy, Chapter 7, insolvency

**Market value**:
What the company is worth on the stock market after the IPO: share price × shares in issue, including the cash the float raised.
_Avoid_: Market cap, valuation (valuation is before the IPO)

**Score**:
The student's share of the company × its valuation, or × its market value at the close of the first day if the game ended in an IPO.

**Ownership floor**:
The lowest share of the company a VC will let itself fall to before the IPO; dilution below it is borne by everyone else.
_Avoid_: Anti-dilution clause, protection

**Float**:
The new shares created and sold to the public at the IPO, up to 40% of all shares. It dilutes every shareholder.
_Avoid_: Listing, public offering

**Approach**:
An angel or VC contacting the student, a few days after the company hits a hidden target, to say they want to invest.
_Avoid_: Pitch (students don't pitch to angels or VCs)

**Offer**:
An investor's terms for a funding round: an amount of cash for a share of the company. A negotiation has at most three offers, and the third is final.
_Avoid_: Bid, deal (a deal is a customer contract)

**Counter**:
The student's reply to an offer, asking for different terms. A dice roll decides how far the next offer moves towards it.
_Avoid_: Counter-offer, haggle

### Testing

**AI playtester**:
An AI that plays the simulation through a compact text format instead of the web page, to test balance and find exploits.
_Avoid_: Bot (a bot is a scripted strategy in the balance harness), agent

**Playstyle**:
The way an AI playtester is told to play: min-maxer, maxer, average Joe, low and slow, chaos tester, Spiffin Brit, Reamu Keaves or Hodd Toward.
_Avoid_: Persona, strategy (a strategy is a scripted bot), personality

**Game summary**:
What an AI playtester hands back after a game: how it ended, the score, key moments, what it tried and anything that felt broken or exploitable.
_Avoid_: Report, results

## Flagged ambiguities

- **Bankrupt vs liquidation:** the alpha ends a game as "bankrupt" the moment cash runs out. In the beta that moment is a rescue buyout, and only the second time is **liquidation**. The alpha's "bankrupt" status means what the beta calls liquidation.
