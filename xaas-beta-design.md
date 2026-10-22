# XaaS Tycoon — Beta Design

The beta plan: ideas from the original notes, the alpha playtest on 2026-10-22, and later additions. The core game is described in [xaas-tycoon-design.md](xaas-tycoon-design.md).

## Buildings and progression

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

## Investors and funders

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

## Share structure

The company has a fixed number of shares from day 1, and the student owns all of them at the start.

- **Selling shares to investors.** When an investor or funder offers money for equity, the student enters how much to raise, from **£10k to £100k**. The number of shares they give up depends on the company's valuation at that moment, so raising early, while the company is worth little, costs far more of the company.
- **Cap table.** The Finance page shows who owns what: the student, each investor, and any C-suite equity (below).
- The share the student still owns feeds straight into the final score.

## IPO (win condition)

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

## Scoring

**Final score = company valuation × share of company the student still owns.** Valuation is based on users, revenue, uptime and growth. If the session ends before an IPO, the company is valued as it stands, so every student gets a score.

- **Weight valuation by satisfaction and customer count, not just revenue**, so price-gouging can't top the class even after the alpha's pricing exploits are fixed.
- **Class leaderboard (optional):** the teacher can show scores for a login-code group on the staff dashboard.

## Debrief

Students justify their final infrastructure setup (possible assessment evidence). Suggested prompts: why did you choose your model; which layers were you responsible for, and what did that cost you; would you choose differently for a different product type, and why?

**Un-parked for beta.** "The game helped me understand cloud deployment models" scored 2.8/5 in the alpha survey, the lowest of any question. The debrief is the most direct fix. It also adds an **end-of-game model comparison**, for example "on PaaS you paid X for managed services; on-prem would have cost Y".

## Events v2

The alpha gave every run the same events: four traffic-spike days in two pairs, one provider outage, one provider price rise, and OS patches on fixed days. Only the timing changed, so a second game was predictable.

- **Randomise how many events a game gets**, and keep events at least about 14 days apart (students complained about spikes landing close together).
- **New events**, each hitting the models differently:
  - **Security breach or ransomware:** worse if you haven't patched; ties into the IPO security audit.
  - **Viral growth:** a sudden wave of free users.
  - **Data-centre fire, flood or power cut:** hits on-prem hardest.
  - **Theft or fraud:** a one-off cash loss.
  - **Lawsuit:** a legal cost, for example after a breach.

## Staff v2

- **Hiring lead time:** new staff take a few days to arrive.
- **Skill levels:** staff of different skill and pay, so a few good staff can do the work of more average ones.
- **Moderators** for the social product, which needs them as it grows.
- **Staff you let go can join a competitor.**

## C-suite

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

## More products

Three new product types join e-commerce, social and video, making six:

| Product type | Profile (placeholder) |
|---|---|
| AI assistant | Very heavy compute per user (GPU), costly to run; users willing to pay well |
| Games network (an online store and multiplayer service, like Steam, PSN or Xbox Live) | Huge spikes on big game launches and holidays; a subscription for online play |
| Payments app (like Stripe or Monzo) | Light, steady load with payday and Black Friday peaks; mostly business customers; outages and breaches hurt most, so uptime, security and compliance are the challenge |

Each product gets its own feature list and SaaS add-ons. The game shows generic names, not real brands.

## Pricing by customer type

In the alpha, willingness to pay and the free/paid split were set per product. In beta they're set by **customer type** instead, and each product has its own mix of customers. For example:

| Customer type | Willingness to pay | Goes free when the price rises |
|---|---|---|
| Casual users | Low | Readily |
| Enthusiasts | Medium | Sometimes |
| Professionals | High | Rarely |
| Businesses | Very high, on higher tiers | Rarely, but leave if uptime is poor |

A price change hits each customer type differently, so students learn to price for who their users are. Growing a different mix (for example through marketing or features aimed at professionals) changes what the company can charge. *Types and figures are placeholders.*

## Tiered features and add-ons

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

## Deals

From time to time a company approaches the student to use their service. Each deal offers:

- **A set number of users** who all arrive when the deal starts, so the student has to have capacity ready.
- **A set price per user**, fixed for the length of the deal (e.g. 90 days), whatever the student's normal price.
- **An SLA (service level agreement)** with conditions, for example 99.5% uptime, support tickets answered within a day, or satisfaction above 80%.
- **Daily penalties** for every day the SLA is broken. Breaking it too often lets the company end the deal early and take its users with it.

The student can accept or decline, and the offer expires after a few days. Bigger deals come later and only to companies with a good uptime record. Deals teach students to check they can deliver before signing, and why providers sell SLAs. *Sizes, prices and penalties are placeholders.*

## APIs

Products that would have one in real life (AI assistant, payments app, e-commerce and the games network) can offer a **paid API** that other businesses build on.

- The API is a feature the student **unlocks through the tiers or buys**.
- Each API call earns a tiny amount, about **1p**.
- Calls start in the thousands a day and can grow into the hundreds of thousands, so it adds up the more the student can handle.
- **API calls use capacity like users do.** Running out of capacity drops calls and loses the income, so the API rewards headroom and good infrastructure.
- API customers can also come through deals, with their own SLA.

## Competitors and marketing

- **One or two AI competitor companies** in the same market, competing for users and reacting to your price.
- **Marketing spend** as a growth lever, so customer growth feels less random.

## Graphs

Live charts of cash, users and satisfaction over time on the Finance and Customers pages, not only on the end-of-game summary.

## Difficulty

Built-in **Easy, Normal and Hard** presets, using the config preset system the teacher already has.

## Pacing

In the alpha, only about 6% of days needed any decision, most Continue clicks came less than half a second after the last, and a finished game took a median of 4 minutes.

- **Turn on the timed flow** that's already built in, pausing automatically on events, alerts and low cash.
- **Show a day-progress bar.**
- **Make the IPO the end of the game** instead of day 180, so a game can run longer.

## Onboarding

A guided first few days that walks students through their first purchase, the first price decision and the first support hire.
