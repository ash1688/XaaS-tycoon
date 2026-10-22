# XaaS Tycoon — Game Design Notes

*An educational business sim for teaching IaaS, PaaS and SaaS to T Level students, loosely based on a cut-down version of the game Startup Company.*

> **XaaS** = "Anything as a Service". The X is a placeholder for any service model: IaaS, PaaS, SaaS, and extras like FaaS, DaaS and BaaS. Good starter question for students: *"What do you think the X stands for?"*

---

## Core design rule

If a mechanic doesn't change the answer to **"who manages this, and what does it cost me?"**, it goes.

## Audience

T Level students. The game exists to explain IaaS, PaaS and SaaS: the shared responsibility model, capex vs opex, and vendor lock-in.

---

## Concept

The student runs a company building **one product**. They choose how to deploy it using one of four models. The product type is locked for the whole game; the deployment model can be changed (see Migration).

**Key teaching line, shown on screen:**
*"Whatever you pick, your customers get your product as SaaS. You're the customer of the layer below."*

### Product types

Picked from a fixed list. Nothing beyond the choice of type: no crafting or component chains as in Startup Company. Each type has a light profile (2–3 numbers) so the same model plays out differently:

| Product type | Profile (placeholder) |
|---|---|
| E-commerce platform | Big seasonal traffic spikes |
| Social network | Steady viral growth |
| Video sharing platform | Heavy storage and bandwidth costs |

*More types can be added; figures are tuned after the alpha.*

### Deployment models

| Option | Upfront cost | Monthly cost | Ops staff needed | Control |
|---|---|---|---|---|
| Own servers (on-prem) | High | Low–medium | High | Full |
| Rent VMs (IaaS) | Low | Medium | Medium | High |
| Deploy to a platform (PaaS) | Low | Medium–high | Low | Medium |
| Build on a SaaS platform (SaaS) | Low | Per user, plus add-ons | None | Low |

**SaaS** means building your product inside someone else's SaaS platform (like a shop on Shopify). It has the cheapest, fastest start but the least control.

### Responsibility stack

An on-screen stack shows each layer coloured **You**, **Provider** or **Shared**, updating live as the model changes.

| Layer | On-prem | IaaS | PaaS | SaaS |
|---|---|---|---|---|
| Building, power, cooling | You | Provider | Provider | Provider |
| Hardware | You | Provider | Provider | Provider |
| OS and patching | You | You | Provider | Provider |
| Runtime and scaling | You | You | Provider | Provider |
| Application / features | You | You | You | Shared (add-ons) |
| Data and users | You | You | You | You |

Data is always yours.

---

## Staff

Two counters, each person costing a fixed amount per day:

- **Developers** build features
- **Ops / sysadmins** keep infrastructure running

The ops headcount needed drops as you move from on-prem → IaaS → PaaS → SaaS.

## Features

Each product type has a short fixed list of 3–5 features (e.g. an online shop gets checkout, reviews and recommendations).

- **On-prem, IaaS, PaaS:** features cost developer-days to build.
- **SaaS:** features are **paid add-ons** unlocked from the provider (like Salesforce). They unlock instantly but are billed per user per month. A small configuration team of developers is still needed.

SaaS swaps staff costs and build time for a monthly bill that grows with your user count.

## Capacity and outages

User growth follows each product type's profile. When load exceeds capacity there are outages, which hurt uptime and slow growth.

---

## Migration (changing deployment model)

Allowed at any time. The product stays the same.

- **Duration:** 2 weeks for every direction, made up of 5 days planning, 2 days testing and 7 days moving infrastructure.
- **Overruns:** possible, adding extra days on top.
- **Staff:** the migration runs in the background; staff are not tied up. Staff may be reallocated between the developer and ops pools as the new model needs.
- **Paying for both setups:** the new provider is billed in full from the first day of the migration *(assumed; to confirm)*. The old provider is charged **pro rata** up to the day you leave. Example: paying 280 a month in February and leaving on the 14th means you're charged 140.
- **Exit penalty:** may apply on top when leaving a provider.
- **Leaving SaaS:** add-on features don't carry over and must be rebuilt in developer-days. This is the vendor lock-in lesson.

All timings and costs live in config, to be tuned after the alpha.

---

## Scripted events (alpha)

Each event hits each model differently:

- **Traffic spike:** on-prem kit melts; PaaS scales, but you pay for it.
- **OS security patch:** your job on IaaS/on-prem; nothing to do on PaaS/SaaS.
- **Provider price rise or outage:** teaches vendor lock-in.
- **Feature the SaaS platform can't provide:** teaches the cost of giving up control.

---

## Time

- **Alpha:** a manual **Continue** button advances **1 day** per click.
- A timed flow system (for example a day every ~15 seconds, with pause) is built into the game but **switched off**, so different time systems can be tested after the alpha.
- The clock is a single "advance N days" function, so the timed system just calls it on a timer.

## Game end

- **Alpha:** the game ends at **day 180**, or immediately on bankruptcy.
- **Later:** the game ends when you go public (IPO) or go bankrupt.

### Alpha summary screen

Shown at the end of the game (and visible on the staff dashboard):

- Final cash, users and uptime percentage
- Total spent, split into staff, infrastructure and add-ons
- Migrations made
- Cost-over-time chart

---

## Accounts and access

- **Login codes:** random 8-digit codes created by the teacher on the staff dashboard. A code takes the student to their companies.
- **Companies per code:** up to **3 active** companies at once (configurable). Only games still being played count towards the limit: finished and bankrupt games move to history automatically, and a student can retire an active one to make room. Retired companies move to history rather than being deleted *(assumed; to confirm)*, and stay viewable with their summary, but can't be played.
- **Company name:** entered in a text box when starting a new game, with a profanity filter. Names don't need to be unique; the code identifies the game.

## Staff dashboard

- Signed in with one teacher password (environment variable).
- Creates login codes.
- **Live dashboard** of recent games (last N hours by default): each company's model, cash, users and uptime, grouped by code.
- Old games can be archived or deleted.

---

## Technical

| Part | Choice |
|---|---|
| Language | TypeScript (Node.js) |
| Front end | Vue + Vite |
| Server | Fastify |
| Database | Postgres with Drizzle ORM |
| Testing | Vitest (simulation logic), Playwright (end-to-end smoke tests) |
| Hosting | VPS, deployed with **Dokploy** (Docker) |
| CI | None to begin with; development runs locally at home |

### Structure

One repository with three parts:

- **`sim`**: the simulation as a pure TypeScript module, heavily tested with Vitest. All balance numbers are in a config file.
- **`server`**: Fastify + Drizzle/Postgres. **The server runs the simulation** and stores the full game state, so students can resume across lessons and on any machine, and can't edit values in the browser.
- **`web`**: the Vue + Vite client.

Docker is used both locally (docker compose for Postgres and the app) and on the VPS through Dokploy. The VPS is reachable from the college network.

---

## Alpha scope

**In:** model choice and migration, staff counters, features and SaaS add-ons, users vs capacity with outages, cash and bankruptcy, the four scripted events, the responsibility stack, login codes, the live staff dashboard, and the day-180 summary screen.

**Deferred to beta:** buildings, investors, the IPO, scoring and the debrief questions (below).

---

## Beta and later (from the original notes)

### Buildings and progression

Players unlock bigger premises as they grow. **Rack space only matters for kit you own.** IaaS, PaaS and SaaS use no floor space, so moving to the cloud lets a student stay in a smaller building longer. Staff still need desks either way.

| Building | Rack space | Desks | Notes |
|---|---|---|---|
| Garage | 1 small rack | 2 | Cheap, cramped, power trips if overloaded |
| Small office | 2 racks | 6 | First real step up |
| Medium office | 4 racks | 12 | Needs a server room, so cooling costs appear |
| Large office | 8 racks | 25 | Rent starts to hurt |
| Warehouse + office | Lots | Lots | Effectively your own data centre, with big fixed costs |

*Figures are placeholders for balancing.* Power and cooling costs scale with the number of racks, reinforcing why companies move off-prem.

**Desks cap headcount.** You can't hire more staff than you have desks. In the alpha playtest one student hired 275 support staff and another clicked hire more than 250 times; a desk limit makes headcount a real decision.

### Investors and funders

Each investor offers money with a target. **Missing a target never causes a game over on its own.**

| Investor | Money | Target | Consequence of missing |
|---|---|---|---|
| Friends and family | Small | Gentle (e.g. 500 users by day 30) | Stop funding you |
| Angel investor | Medium | Revenue figure | Lose extra equity |
| Venture capital | Large | Aggressive user growth | Forced cost cuts (staff removed) or forced decisions |
| Bank loan | Medium | None, fixed daily repayments | Repayments continue regardless; teaches debt vs equity |
| Grant / funder | Small | Condition, e.g. 99% uptime or sustainability | Funding withdrawn |

- **Escalation:** first miss is a warning, second costs equity or staff, third pulls remaining funding.
- **Lingering effects:** missed uptime damages reputation, which slows growth and makes the next target harder.
- **Tougher terms:** missing targets means future investors offer less money for more equity.

The only true game-over is **running out of cash** (bankruptcy). *Alternative:* a **rescue buyout**, where you're bailed out but lose most of your equity.

From the alpha playtest:

- **Funding replaces the no-loan cliff.** In the alpha, 13 of 14 students who skipped the loan and kept normal prices went bankrupt before reaching break-even. Small funders such as friends and family should carry a careful student through the early weeks.
- **Offer funding when cash runs low.** When cash falls to about 5 days of costs, show the funders available at that moment alongside the low-cash warning.
- **Rescue buyout is the safety net, not just an alternative.** Running out of cash offers a buyout that costs most of your equity, so bankruptcy stops being an instant game over.

### Share structure

The company has a fixed number of shares from day 1, and the student owns all of them at the start.

- **Selling shares to investors.** When an investor or funder offers money for equity, the student enters how much to raise, from **£10k to £100k**. The number of shares they give up depends on the company's valuation at that moment, so raising early, while the company is worth little, costs far more of the company.
- **Cap table.** The Finance page shows who owns what: the student, each investor, and any C-suite equity (below).
- The share the student still owns feeds straight into the final score.

### IPO (win condition)

To float, the company must pass a readiness check:

- **Users and revenue** above a threshold
- **Uptime record**, e.g. 99% over the last 30 days
- **Predictable costs.** Big spending swings count against you (capex vs opex discussion).
- **Security and compliance audit.** On IaaS you must have patched everything yourself; PaaS/SaaS providers cover more.
- **Profitability**, or a clear path to it
- **Customer satisfaction record**, e.g. above 70% over the last 30 days. In the alpha, satisfaction at 0% had no consequence: one student sat there for 143 days and still finished.
- **A minimum paying customer base**, so a company with 300 payers at $1,000 each can't float.

Applying before you're ready causes a failed float: you lose time and some reputation, but can try again.

**The float.** When the readiness check passes, the student chooses how many shares to offer to the public, **up to 40% of all shares** (configurable). Floating more raises more cash but leaves the student owning less.

**Ringing the opening bell.** The IPO has its own page where the student rings the opening bell and watches the first day of trading. The share price moves based on how ready the company was (growth, uptime, satisfaction, predictable costs, profitability), with a little randomness. The page ends with the result: cash raised, the company's market value and what the student's own shares are worth.

### Scoring

**Final score = company valuation × share of company the student still owns.** Valuation is based on users, revenue, uptime and growth. If the session ends before an IPO, the company is valued as it stands, so every student gets a score.

- **Weight valuation by satisfaction and customer count, not just revenue**, so price-gouging can't top the class even after the alpha's pricing exploits are fixed.
- **Class leaderboard (optional):** the teacher can show scores for a login-code group on the staff dashboard.

### Debrief

Students justify their final infrastructure setup (possible assessment evidence). Suggested prompts: why did you choose your model; which layers were you responsible for, and what did that cost you; would you choose differently for a different product type, and why?

**Un-parked for beta.** "The game helped me understand cloud deployment models" scored 2.8/5 in the alpha survey, the lowest of any question. The debrief is the most direct fix. It also adds an **end-of-game model comparison**, for example "on PaaS you paid X for managed services; on-prem would have cost Y".

### Events v2

The alpha gave every run the same events: four traffic-spike days in two pairs, one provider outage, one provider price rise, and OS patches on fixed days. Only the timing changed, so a second game was predictable.

- **Randomise how many events a game gets**, and keep events at least about 14 days apart (students complained about spikes landing close together).
- **New events**, each hitting the models differently:
  - **Security breach or ransomware:** worse if you haven't patched; ties into the IPO security audit.
  - **Viral growth:** a sudden wave of free users.
  - **Data-centre fire, flood or power cut:** hits on-prem hardest.
  - **Theft or fraud:** a one-off cash loss.
  - **Lawsuit:** a legal cost, for example after a breach.

### Staff v2

- **Hiring lead time:** new staff take a few days to arrive.
- **Skill levels:** staff of different skill and pay, so a few good staff can do the work of more average ones.
- **Moderators** for the social product, which needs them as it grows.
- **Staff you let go can join a competitor.**

### C-suite

A leadership team the student hires one role at a time. Each role gives a lasting bonus to one area of the business.

**Hiring.** Each role shows a shortlist of candidates (about 3), and the student picks one. Each candidate has their own stats and pay package: salary, and for senior roles an equity ask that comes out of the student's shares. A strong candidate costs more; a cheap one may have a weakness.

| Role | Helps with |
|---|---|
| CEO | Better investor terms; a small boost to every other role |
| CFO | Cheaper loans and funding, cost forecasts, the IPO's predictable-costs check |
| COO | Everyday running costs and staff productivity |
| CTO | Faster feature builds; unlocks higher feature tiers |
| CIO | Cheaper, faster migrations and better infrastructure decisions |
| Legal counsel | Lawsuits and the IPO compliance audit |
| CISO | Patching and security breaches |
| CMO | Gets more out of marketing spend |
| Head of people | Shorter hiring lead times, fewer staff leaving, desk planning |
| Head of ops | Ops staff cover more servers; better uptime |
| Head of support | Support staff clear more tickets; satisfaction recovers faster |
| Head of development | Developers build faster |

CISO, CMO and head of people were added to fit the new events, marketing spend and hiring lead time. *Stats, pay and effects are placeholders for balancing.*

### More products

Two new product types join e-commerce, social and video:

| Product type | Profile (placeholder) |
|---|---|
| AI assistant | Very heavy compute per user (GPU), costly to run; users willing to pay well |
| Games network (an online store and multiplayer service, like Steam, PSN or Xbox Live) | Huge spikes on big game launches and holidays; a subscription for online play |

Each product gets its own feature list and SaaS add-ons. The game shows generic names, not real brands.

### Pricing by customer type

In the alpha, willingness to pay and the free/paid split were set per product. In beta they're set by **customer type** instead, and each product has its own mix of customers. For example:

| Customer type | Willingness to pay | Goes free when the price rises |
|---|---|---|
| Casual users | Low | Readily |
| Enthusiasts | Medium | Sometimes |
| Professionals | High | Rarely |
| Businesses | Very high, on higher tiers | Rarely, but leave if uptime is poor |

A price change hits each customer type differently, so students learn to price for who their users are. Growing a different mix (for example through marketing or features aimed at professionals) changes what the company can charge. *Types and figures are placeholders.*

### Tiered features and add-ons

In the alpha every feature and add-on was available from day 1, and SaaS students bought every add-on on the first day. In beta, the benefits a company can buy are grouped into **tiers**, each with conditions to unlock:

| Tier | Example unlock conditions |
|---|---|
| 1 | Available from the start |
| 2 | A user count (e.g. 5,000 users), or a CTO hired |
| 3 | Revenue and uptime targets (e.g. £2k a day and 99% uptime over 30 days) |
| 4 | A bigger building, a funding round or IPO readiness |

- This applies to **built features and SaaS add-ons alike**, so every model has something to work towards.
- **SaaS gets add-ons for every product**, including the new AI and games-network products.
- Higher tiers give bigger benefits but cost more, so each new tier is a decision, not an automatic purchase.

**Each deployment model has its own benefits**, matching what you control on that model:

| Model | Example benefits |
|---|---|
| On-prem | **Optimisation:** developers tune the product to need fewer CU and DBU per user, so the same kit serves more users. Also better cooling and power efficiency. |
| IaaS | **Reserved instances** (cheaper VMs if you commit for longer), **autoscaling** for traffic spikes |
| PaaS | **Managed autoscaling**, a **CDN** that takes load off the app, managed monitoring that warns before outages |
| SaaS | Provider add-ons such as integrations, analytics and a **premium support plan** that shortens provider outages |

The lesson: the more of the stack you own, the more you can optimise it yourself; the less you own, the more you buy ready-made from the provider.

**Hardware tuning (on-prem only).** Each on-prem server has a performance slider from **0 to 150%**.

- At 100% the server gives its normal capacity.
- Below 100% it gives less capacity but runs cooler, uses less power and lasts longer.
- Above 100% it gives extra capacity but stresses the hardware. The higher the slider, the bigger the daily chance of **overheating** (capacity drops for a few days) or a **crash** (an outage until ops fix it).
- It's a short-term fix: pushing kit hard keeps the service up while new servers are on their ~10-day delivery, but leaving it high for weeks costs more in crashes than it saves.

This only exists on-prem because only on-prem gives you access to the physical hardware. *The risk curve and limits are placeholders for balancing.*

### Competitors and marketing

- **One or two AI competitor companies** in the same market, competing for users and reacting to your price.
- **Marketing spend** as a growth lever, so customer growth feels less random.

### Graphs

Live charts of cash, users and satisfaction over time on the Finance and Customers pages, not only on the end-of-game summary.

### Difficulty

Built-in **Easy, Normal and Hard** presets, using the config preset system the teacher already has.

### Pacing

In the alpha, only about 6% of days needed any decision, most Continue clicks came less than half a second after the last, and a finished game took a median of 4 minutes.

- **Turn on the timed flow** that's already built in, pausing automatically on events, alerts and low cash.
- **Show a day-progress bar.**
- **Make the IPO the end of the game** instead of day 180, so a game can run longer.

### Onboarding

A guided first few days that walks students through their first purchase, the first price decision and the first support hire.

---

## Name

**XaaS Tycoon**

Alternatives considered: Rack to Riches, Cloud Nine to Five, Scale Up, Uptime, Stackd, Who Manages What?
