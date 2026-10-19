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
- **Companies per code:** up to **3 active** companies at once. Only active companies count towards the limit. Retired companies move to history rather than being deleted *(assumed; to confirm)*.
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

### IPO (win condition)

To float, the company must pass a readiness check:

- **Users and revenue** above a threshold
- **Uptime record**, e.g. 99% over the last 30 days
- **Predictable costs.** Big spending swings count against you (capex vs opex discussion).
- **Security and compliance audit.** On IaaS you must have patched everything yourself; PaaS/SaaS providers cover more.
- **Profitability**, or a clear path to it

Applying before you're ready causes a failed float: you lose time and some reputation, but can try again.

### Scoring

**Final score = company valuation × share of company the student still owns.** Valuation is based on users, revenue, uptime and growth. If the session ends before an IPO, the company is valued as it stands, so every student gets a score.

### Debrief (parked)

Students justify their final infrastructure setup (possible assessment evidence). Suggested prompts: why did you choose your model; which layers were you responsible for, and what did that cost you; would you choose differently for a different product type, and why?

---

## Name

**XaaS Tycoon**

Alternatives considered: Rack to Riches, Cloud Nine to Five, Scale Up, Uptime, Stackd, Who Manages What?
