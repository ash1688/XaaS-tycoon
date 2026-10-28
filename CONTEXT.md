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
Easy, Normal or Hard: a set of numbers the student picks from those the teacher allows. Never changes which systems exist. On Hard, tier 4 also opens on a revenue milestone, so a company can float without outside investors, and a dangerous cancel can go ahead once confirmed (see **Cancelling**).
_Avoid_: Mode, level

**Cancelling**:
Taking a ready server out of service: cancelling a rented VM, or selling back bought kit. With a replacement of the same kind on order it waits for it, still serving and billed, and goes at the end of the day the replacement is ready. Otherwise, if what's left wouldn't carry today's load, Easy and Normal refuse it and Hard asks the student to confirm (`cancel N now`), and the outage is theirs. A server still being set up can always be cancelled at once.
_Avoid_: Decommission, retire (in the student's words)

**Bootstrapped float**:
A float with no outside investors' money along the way: no friends and family, angel, VC or vulture. The grant and the bank loan aren't shares, so they don't count. The end screen flags it: "Floated without outside investors".
_Avoid_: Solo IPO, self-funded

**Career**:
The longest game length: the student founds the company at 18 and runs it until they retire at 65.
_Avoid_: Lifetime mode, 65 years

**Phase**:
One of the four stages a game's jobs open in: Build (to the MVP), Launch (to the first angel approach), Grow (to the Series A approach) and Scale (to the end). Jobs not yet open are hidden, and a phase lists only the jobs that apply to the company's product and model.
_Avoid_: Stage, era, act

**Checklist**:
The list on each phase of what the company needs: the shortfall below the phase's minimum, or, at or above it, the student's projection for the end of the phase beside the baseline.
_Avoid_: To-do list, objectives

**Get me ready**:
The checklist's one click that buys or hires only the shortfall, hiring permanent juniors. It never sells or lets anyone go.
_Avoid_: Auto-buy, quick setup

**Baseline**:
What careful play has at the end of each phase for one product on one model, made by the balance harness and stored in the config.
_Avoid_: Benchmark, par

**Tick**:
One step of the timed flow: a day, or a week in a career. A week is seven days simulated one by one.
_Avoid_: Turn, round

**Drift**:
The slow change in the world over a long game (until IPO or a career). At each **year's end** (every 365 days), running prices rise by a fresh random 2–6% and servers and VMs added from then give about 10% more units for the money; kit already owned keeps its units. The student's own price and pay never drift: pay rises only in pay reviews, and the student's price changes only when they change it (the **fair price** moves by a quarter of each pay review's inflation instead). Servers age through the hardware slider's wear, whose lifespan scales with the game length. A 180-day or 1-year game never reaches a year's end.
_Avoid_: Eras, ageing

**Year's end**:
The last day of each 365-day year of a long game, after which drift raises prices and improves new kit. A game's last day is never one.
_Avoid_: New year, anniversary

**MVP**:
The first version of the product, which every game opens with the developers building, measured in developer-days. No users arrive until it's done and the student presses Launch.
_Avoid_: Prototype, beta

**Developer slider**:
After the MVP, the split of developer time between building features and optimisation, from 0% to 100% optimisation.
_Avoid_: Dev split, focus

**Optimisation**:
Developer work that makes the product cheaper to run: fewer CU and DBU per user (so fewer servers and ops, or fewer instances on PaaS), or a lower per-user platform fee on SaaS. The saving flattens out under a cap, highest on-prem. It's permanent and kept through a migration, capped at the new model's maximum.
_Avoid_: Tuning, performance work, refactoring

**Go-live**:
The launch day: the day the student presses Launch, once the MVP is done, and the first day users arrive. Hosting bills start from it.
_Avoid_: Release, ship date

### People

**C-suite**:
The company's senior leaders. The student is the CEO; the others (CFO, CTO and so on) are each hired once from a shortlist and kept for the rest of the game. Roles open as the company grows (the heads from day 1, the CFO on outside money or the first angel approach, the CTO and head of people at the first angel approach, the rest at the Series A approach). Each candidate has a salary, fixed for good (pay reviews leave the C-suite out), and an equity ask in new shares that shrinks as the C-suite's cap (about 10%) fills. The full C-suite is needed to IPO.
_Avoid_: Executives, leadership team, management

**Pay holiday**:
When cash falls below about 7 days of running costs, the whole C-suite forgoes its pay until cash is back above about 21 days. Pay missed isn't owed later. It keeps a small company that has hired the full C-suite from running out of cash.
_Avoid_: Pay freeze, deferred pay (nothing is paid back)

**Staff**:
The developers, ops, support, moderators, researchers and marketers hired and let go in bulk, as permanent or agency staff (researchers and marketers permanent only). Not the C-suite.
_Avoid_: Employees, workers

**Ops shortfall**:
Too few ops staff for the servers running. Every tier's capacity is cut in step with the share of ops work missing, down to 40% with no ops at all, so one short in a big team cuts less than one short in a small one. Servers on order need no ops until they're ready. Shown as "ops: 1 of 2 needed, capacity cut to 70%", and time stops the day it starts.
_Avoid_: Understaffed, unpatched (that's the danger meter's risk)

**Grade**:
Junior, mid or senior: sets a member of staff's pay, output and how long they take to arrive.
_Avoid_: Level, skill level, seniority

**Agency staff**:
Temporary staff who cost 1.25× and do half the work of permanent staff, arrive the next day, and can be let go with no severance.
_Avoid_: Contractors, temps (contract users are customers)

**Retraining**:
Moving a permanent member of staff into another team (`move`). They leave their old team at once and join the new one after their grade's lead time, the same wait as a hire, keeping their grade. They're paid the new team's rate while they retrain, with no severance and no recruitment cost: cheaper than letting someone go and hiring, but not instant.
_Avoid_: Transfer, reassign, redeploy

**Permanent staff**:
Staff employed directly, who are paid severance when let go.
_Avoid_: Employees, full-time staff

**Researcher**:
A member of staff who earns research points. Researchers can be hired only once the first angel investor approaches, whether or not the student takes the money, and only as permanent staff.
_Avoid_: Scientist, R&D staff

**Marketer**:
A member of staff who runs one campaign at a time, for its whole length. A new campaign gets the most senior free marketer, whose grade scales how many users each pound brings. A marketer running a campaign can't be let go or moved until it ends or is stopped; one let go in a rescue's cuts stops their campaign. Marketers not running a campaign are idle. Like researchers, they can be hired only once the first angel investor approaches, and only as permanent staff.
_Avoid_: Marketing team, agency (agencies supply other staff, not marketers)

**Research points (RP)**:
What researchers earn each day, more for higher grades. They bank with no cap, to be spent unlocking items in a tier.
_Avoid_: Science, research credits, XP

**Pay review**:
Staff coming to the student about pay before quarters 2, 3 and 4 of a game (a game counts as one year of four equal quarters). Until IPO and a career have 365-day years instead: quarters 2, 3 and 4 in the first, then every quarter. The clock holds until it's settled. Each review rolls its own inflation, from 2% to 6%; the student offers a rise from inflation less a point, and staff, who open at inflation plus four points, accept an offer near a fair rise for how the company is doing or counter with a roll. The agreed rise lifts every staff pool's day rate, new hires and agency staff included, and compounds with each review. The C-suite is left out.
_Avoid_: Pay rise round, wage negotiation, salary review

**People-lead modifier**:
What a head of people (a C-suite role) changes in a pay review, read in one place: the roll bonus on staff's counters, a softer walk-away figure, how much of a staff scheme's worth staff count, and a tribunal lean the student's way. Without a head of people the student deals with staff directly: staff take a point off the roll and count schemes at about 70%, with no softening and no lean. Each head of people candidate's strength sets how far they move it.
_Avoid_: HR modifier, people lead bonus

**Staff scheme**:
A benefit the student can offer in a pay review alongside or instead of some of a cash rise: a pension top-up, a health cash plan, share save (levels 0–3), death in service or a discount scheme (on or off). Staff count only the levels added in that review, at about 70% of their worth without a head of people. Each is paid every day afterwards for every permanent member of staff, and its level only goes up: once given, it can't be lowered or taken away.
_Avoid_: Benefit (that's a model benefit), perk, package

**Share save**:
The staff scheme paid for in ownership rather than cash: each level added issues new shares worth 1% of the company at the time to the **Staff share scheme**, diluting the student and every other holder as a funding round does. It costs only a little admin a day per person, and is worth the most of any scheme to staff.
_Avoid_: Share options, ESOP, equity (for this scheme)

**Staff share scheme**:
The shareholder on the cap table that holds share save's shares for the staff. Each later share save level adds to it. It's a pot of its own, outside the student's stake and any C-suite equity cap.
_Avoid_: Employee trust, staff shares

**Tribunal**:
What settles a pay review with no deal after the student's third offer: it picks the student's figure, staff's or the middle, favouring whichever is closer to a fair rise (the middle when they're about as close), and charges a fee. It always settles the review: there's no declining it.
_Avoid_: Arbitration, court

**Pay history**:
The record of every pay review settled, on the People page and in text play: each one's inflation, how it ended (the student's offer accepted, staff's counter accepted, or the tribunal's pick and fee), the cash rise, the staff schemes it raised and share save's new shares. With it, the **pay multiplier**: every rise so far compounded, pay as a multiple of the day rates.

### Infrastructure

**Autoscaling (PaaS)**:
On for every PaaS company. Each night the platform sets the app instances to a **baseline** of 1.25× yesterday's CU demand (**basic autoscaling**), or 1.5× with the Managed autoscaling benefit (**managed autoscaling**), never below the instances the student set by hand (their **minimum**, never reset). During a day **burst instances** cover a spike over the baseline at about twice an instance's price, up to a **maximum** the student sets (about 3× today's instances until they do); demand over it is an outage, and time stops the first time. The **autoscaler failure** event stops bursts for a day, more often on spike days, which is what the minimum insures against.
_Avoid_: Auto-scaling, elastic scaling

**Rack**:
A small, medium or large frame that holds on-prem servers, measured in rack units. Only on-prem companies have them.
_Avoid_: Cabinet, server room

**Hardware slider**:
On-prem only: each server runs at 0–150% of its normal capacity. Below 100% it costs less to run and wears slower; above, it risks overheating or a crash and wears faster. Wear is the game's one ageing system: a server lasts about 5 years at 100% in a 1-year game or longer, and in a 180-day game lasts the game at 100% but wears out in a few months pushed hard. The student is warned before it's worn out.
_Avoid_: Overclocking, performance slider (the developer slider is something else)

**Rack unit (U)**:
One slot in a rack. Each server size takes a set number of them.
_Avoid_: SU, slot

**Tier**:
A level of benefits, 1 to 4. Tier 1 is open from the start; each later tier becomes available once its condition is met, in order, and stays available. Each holds product features and model benefits, each with a stable id. Tier 1's items are unlocked from the start, and its features can be built from Launch, taking longer than their developer-days alone; above tier 1, each item in an available tier is unlocked with its own RP price, in any order, once research opens in Grow.
_Avoid_: Level, plan (there are no pricing plans)

**Unlock**:
Spending research points on one item in an available tier so it can be built or bought, which still costs its own developer-days or cash. Unlocks belong to the company and survive a migration, for any model's benefits.
_Avoid_: Research (that's what researchers do), buy (that's paying cash)

**Product feature**:
A benefit that belongs to the product, such as messaging or checkout. Survives a migration.
_Avoid_: Add-on (an add-on is a product feature bought from a SaaS provider)

**Model benefit**:
A benefit that belongs to the deployment model, such as on-prem hardware efficiency or a PaaS CDN, bought with a set-up fee and billed monthly. Lost on migration, though its unlock stays.
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
Marketing aimed at one customer type, with a budget and a length, that brings in extra new users of that type. Its budget is spent evenly over its days, and each pound brings fewer users as the market fills up and when another campaign targets the same type at once; one started just before a holiday brings more. Each user it brings in also grows the product's market for good (brand awareness), up to a cap, so its users are extra rather than ones who'd have joined anyway. Each needs a free marketer to run it, so headcount decides how many run at once and the marketer's grade how well each does. Campaigns open once the first angel investor approaches, and never before launch.
_Avoid_: Advert, marketing spend, ad

**Campaign quote**:
What a campaign would bring over its whole run, shown before it starts: a range of users and of cost per user ("£5.20–£7.10 a user"). It plays the run forward day by day, as the market fills with the campaign's users, everyone else's growth and the type's other campaigns; the low end assumes slow growth and the high end fast. With the market almost full it says so, with an estimate of the users, instead of a price. The quote stays with the campaign, and its end message compares the result with it.
_Avoid_: Estimate, forecast, £ a user now

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

**Fair price**:
The monthly price users think the product is worth, which each customer type's price threshold is a multiple of. It starts at the product's own and rises by a quarter of each pay review's inflation, compounding. The student's price never moves by itself.
_Avoid_: Market price, list price

**Opening price**:
The price set as Launch is pressed (the fair price if none is given). Launch users react to it, and it holds until the usual price lock after go-live.
_Avoid_: Launch price, starting price

**Price bands**:
How each customer type splits over a price. A rise splits paying users into accept, grumble online, contact support, drop to free and leave; a cut splits the new users it could bring, and the opening price the launch users, into join paying, join free and don't join. The bands slide with the size of the change against the type's price threshold.
_Avoid_: Segments, buckets

**Grumbling online**:
Paying users who stay through a rise but complain about it publicly. While the backlash lasts, they send a share of new users to the rival that's the best value for each customer type.
_Avoid_: Bad reviews, word of mouth (word of mouth is a cut's wave)

**Expected price**:
The price customers expect: the latest that has held for 30 days. A cut is measured from it, so a cut back from a rise that hasn't held is no bargain. A rise is still measured from the lowest price customers remember over 60 days.
_Avoid_: Reference price, anchor

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
The order of investment after friends and family: an angel, then Series A, B, C and D venture capital rounds. A 180-day game merges them into two rounds, Series A (A and B) and Series B (C and D).
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

**Daily costs**:
Every daily outgoing at today's numbers: staff and executive pay, staff schemes, hosting, rent and power, add-ons and platform fees, Campaign spend and loan repayments. One figure for the costs line, runway, the IPO's predictable costs and the shortfall limit.
_Avoid_: Burn, running costs, overheads

**One-offs**:
Outgoings that aren't daily costs: kit bought, severance, a tribunal fee, an event's bill, a grant paid back. Shown apart as "one-offs this week".
_Avoid_: Capital costs, extras

**Shortfall**:
How far cash went below £0 on a day. It goes onto the bank loan being repaid (same repayment a day, a longer term), or onto an emergency loan with none, until what shortfalls owe would pass 7 days of daily costs: then the company has run out of cash.
_Avoid_: Overdraft, deficit

**Emergency loan**:
The loan the bank opens for a shortfall when no loan is being repaid: at the rate a loan taken that day would have, over a short term (30 days). Shown as "loan (emergency)".
_Avoid_: Overdraft, payday loan

**Run out of cash**:
Going further below £0 than the shortfall limit allows. The first time is a rescue buyout; after one, liquidation.
_Avoid_: Going bust, bankrupt

**Rescue buyout**:
What happens the first time the company runs out of cash: a vulture VC puts in cash for a large share of the company and forces cost cuts.
_Avoid_: Bailout, rescue

**Vulture VC**:
The investor behind a rescue buyout. Separate from the funding ladder; the student can buy its shares back at a price it sets, which follows its stake as later rounds dilute it.

**Liquidation**:
The end of a game: the company runs out of cash after it has already had a rescue buyout.
_Avoid_: Bankruptcy, Chapter 7, insolvency

**Market value**:
What the company is worth on the stock market after the IPO: share price × shares in issue, including the cash the float raised.
_Avoid_: Market cap, valuation (valuation is before the IPO)

**Score**:
What the student's own shares are worth at the end: their share of the company × its valuation, or × its market value at the close of the first day if the game ended in an IPO, less any debt still owed. There's no bonus for floating, and a liquidated company scores £0. The end screen shows it under the headline "raised £X, now worth £Y" and the shareholder breakdown.

**Shareholder breakdown**:
The end screen's table of everyone who owns the company: the founder (with their seed money, the starting cash), friends and family, the angel, each VC, the vulture, the C-suite, the staff share scheme and the public float. Each row gives what they put in, their stake, its worth and their multiple; the stakes add up to 100%, and the founder row's worth is the score.
_Avoid_: Cap table (in the student's words)

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

**Auto-negotiate**:
Playing out the rest of an investor negotiation or pay review in one click from the student's opening figure, with the same rolls as by hand. It ends on Accept or Decline for an investor, and Accept or Tribunal for a pay review.
_Avoid_: Auto-accept, quick deal

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
