# XaaS Tycoon — Beta Design

The beta plan: ideas from the original notes, the alpha playtest on 2026-10-22, and later additions. The core game is described in [xaas-tycoon-design.md](xaas-tycoon-design.md).

## Server racks (on-prem)

Buildings and desks are **kept for later**; the beta stays a dashboard. On-prem kit instead lives in **server racks**:

Racks are measured in **rack units (U)**, the slots servers bolt into, and each server size takes a set number of them:

| Rack | Size (placeholder) |
|---|---|
| Small | 12U |
| Medium | 24U |
| Large | 42U |

| Server | Takes (placeholder) |
|---|---|
| Small | 1U |
| Medium | 2U |
| Large | 4U |
| Massive | 8U |

- A server can only be installed in a rack with enough free U, so a growing on-prem company has to buy racks as well as servers.
- **Cabling:** a fixed price is taken automatically every time new hardware is bought, on top of its price.
- Racks only exist on-prem. IaaS, PaaS and SaaS never buy racks, which is part of what moving to the cloud saves.

*Sizes and prices are placeholders.*

## Power and cooling

Every model pays a **fixed daily power and cooling cost**. On-prem pays the most, because you run the kit yourself; the cost falls through IaaS and PaaS to SaaS, which pays the least. *Amounts are placeholders.*

## Investors and funders

Each investor offers money with a target. **Missing a target never causes a game over on its own.**

| Investor | Money | Target | Consequence of missing |
|---|---|---|---|
| Friends and family | Small | Gentle (e.g. 500 users by day 30) | Stop funding you |
| Angel investor | Medium | Revenue figure | Lose extra equity |
| Venture capital | Large | Aggressive user growth | Forced cost cuts (staff removed) or forced decisions |
| Bank loan | Medium | None, fixed daily repayments over a fixed term | Repayments continue regardless; teaches debt vs equity |
| Grant / funder | Small | Condition, e.g. 99% uptime or sustainability | Funding withdrawn |

- **Escalation:** first miss is a warning, second costs equity or staff, third pulls remaining funding.
- **Lingering effects:** missed uptime damages reputation, which slows growth and makes the next target harder.
- **Tougher terms:** missing targets means future investors offer less money for more equity.

The only true game-over is **running out of cash** for the second time (liquidation). The first time triggers a **rescue buyout** (below).

From the alpha playtest:

- **Funding replaces the no-loan cliff.** In the alpha, 13 of 14 students who skipped the loan and kept normal prices went bankrupt before reaching break-even. Small funders such as friends and family should carry a careful student through the early weeks.
- **Offer funding when cash runs low.** When cash falls to about 5 days of costs, show the funders available at that moment alongside the low-cash warning.
- **Rescue buyout is the safety net, not just an alternative.** The first time the company runs out of cash, it's rescued instead of the game ending (below).

### Bank loans

The alpha's single loan is repaid by day 180, which doesn't work for a career or a game that runs until IPO. In beta:

- **Every loan has a fixed term** (e.g. 120 days for a loan at the start, shorter for a later one), whatever the game length.
- **One loan at a time.** Once a loan is repaid, the student can take another. This replaces the alpha's one loan per company.
- **Early repayment:** a student with spare cash can pay a loan off faster, which saves interest.
- A loan taken later still costs more interest, as in the alpha.

*Terms and rates are placeholders.*

### Rescue buyout

The first time the company runs out of cash, a **vulture VC** rescues it:

- **Cash:** enough to cover the losses plus about 30 days of breathing space.
- **Shares:** they take enough new shares that it stings (a placeholder of around 75% of the company). The student can later ask to **buy those shares back**, at a price the vulture VC sets.
- **Cost cutting:** they force savings straight away. This can include cutting staff and moving to a cheaper model, for example on-prem to IaaS. A forced move is a **fast-tracked migration**, quicker than the normal 14 days.
- **Tranches:** any unpaid VC tranche is cancelled; the VC has lost faith.
- **Once only.** Running out of cash a second time is **liquidation**, and the game ends.
- **Lead VC rescue.** If the student already has a lead VC, both the lead VC and the vulture VC offer a rescue, and the student picks one. Without a VC, only the vulture offers. The lead VC's terms still hurt but are gentler than the vulture's: a smaller share taken and softer cost cuts.

*Amounts are placeholders.*

## Share structure

When starting a company, the student chooses how many shares it has, from **10,000 to 100,000**. They own all of them at the start.

- **Share price** = valuation ÷ shares in issue.
- **Selling shares to investors.** A funding round creates new shares and sells them to the investor at the share price. The student's own shares stay the same in number but become a smaller share of the company. Raising early, while the valuation is low, costs far more of the company.
- **Offers.** Each investor makes an offer: a set amount of cash for a set share of the company. The student can accept, decline or negotiate. The offer shows its target, and what happens if it's missed, before the student accepts.
- **Where offers come from:**
  - **Friends and family and grants** are always on the Finance page from day 1, for the student to ask. Each can be taken once. Both disappear once the student accepts their first angel investor.
  - **Angels and venture capital** come to the student. When the company hits a hidden target, a few days later the student gets a notification in Finance: an angel or VC likes what they're doing and wants to invest. The student can decline or start negotiating.
- **Negotiation.** Up to three rounds:
  1. The investor opens with offer 1 (e.g. £50k for 20%).
  2. The student counters (e.g. £50k for 10%). A dice roll sets offer 2: a high roll moves most of the way to the student, a middle roll meets halfway, and a low roll makes them dig in: offer 2 is a little worse than offer 1, so a counter is never a free try.
  3. The student can counter once more; a new roll sets offer 3.
  4. **Offer 3 is final:** take it or leave it.
  - **Auto-negotiate.** Instead of countering round by round, the student enters their opening counter and presses Auto-negotiate. The game plays the remaining rounds with the same rolls and rules as by hand, repeating the student's counter each time, so on average it's no better and no worse than clicking through. It shows a short transcript of each round ("Offer 2: they met you halfway. Offer 3: they held."), then the final offer with **Accept** and **Decline**. It never accepts for the student.
  - The further a counter is from the investor's offer, the worse the odds on the roll.
  - A CFO adds a bonus to every negotiation roll.
  - Investors negotiate in good faith and never walk away: their latest offer always stands until the student accepts or declines.
- **The funding ladder.** An angel, then four rounds of venture capital, each approaching when the company hits that rung's hidden target:

  | Rung | Who approaches | Hidden target (placeholder) |
  |---|---|---|
  | Angel | One angel investor | First steady revenue, e.g. £500/day for 14 days |
  | Series A | Three VCs, each with a different offer | 45% of the product's IPO paying users |
  | Series B | The VC the student went with last round, plus two new VCs | Income at 45% of the IPO's revenue a day |
  | Series C | As Series B | 75% of the IPO's paying users and 99% uptime |
  | Series D | As Series B | 90% of the IPO's paying users and income at 70% of its revenue a day: the step before IPO |

  Each target counts only once the rung before has approached and at least 10 days have passed (#101). On sensible
  play Series A comes about two weeks after the angel and Series D by about day 95, before the IPO's trading history
  is met.

  **A 180-day game has two VC rounds, not four.** Series A and B merge into one round, and C and D into another,
  called Series A and Series B in that game. Each merged round approaches at the earlier round's target (A's, then
  C's). Its second tranche is paid when the later round's target is hit (B's, then D's), and its cash and share
  taken are the two rounds' added together, so a student who takes both ends up about where four rounds would leave
  them. The game summary says it was a two-round game. C-suite roles still open at the first round's approach. Until
  IPO, 1-year and career games keep all four rounds. (#233: the cash is split between the tranches in proportion to
  the two rounds' offers. Until tranches arrive for every round (#102), a merged round's second tranche has no
  deadline: it waits for the later target.)

  - Each VC's offer leans one way: **most cash**, **fewest conditions** or **least ownership taken**. Each VC's lean is random, so a round can have two "most cash" offers and one "least ownership".
  - The student picks **one** VC and negotiates with them alone. Picking one closes the other two.
  - **Declining all three**, or failing to reach a deal with the one they picked, means a few days later another three VCs approach for the same round. The same goes for the angel: declining brings a new angel a few days later.
  - Each round is bigger than the last, with a tougher target, and the chosen VC sets the valuation.
- **Tranches.** VC money arrives in two halves: 50% on signing and 50% when the round's target is hit, within a deadline set in the offer (e.g. 60 days). A "fewest conditions" VC may pay it all up front or set an easy target. Missing the deadline follows the escalation above: first a warning and a new deadline, then extra shares taken or forced cost cuts, then the second half is cancelled. Friends and family, grants and the angel pay everything up front.
- **Cap table.** The Finance page shows who owns what: the student, each investor, and any C-suite equity (below).
- **C-suite equity** is paid in new shares, diluting everyone.
- **Ownership floor (anti-dilution).** A VC's offer can include the lowest share of the company they'll let themselves fall to.
  - It's part of the offer and can be negotiated like the cash and the share. A "fewest conditions" VC may have none.
  - It covers later funding rounds and C-suite shares: dilution that would take the VC below its floor is shared among everyone else instead.
  - It doesn't cover the float. All floors end at the IPO, and everyone is diluted equally.
  - Floors together can't exceed a cap (e.g. 60% of the company); a VC whose floor would break the cap won't offer one. This stops the student being squeezed to nothing before the IPO.
- The share the student still owns feeds straight into the final score.

### Valuation

What the company is worth. It sets how many shares a funding round costs, the rescue buyout and the final score. The student sees it live on the Finance page, with what's pushing it up or down.

- **Formula valuation:** (annual revenue × a multiple) + (paying users × a value per user), never below a minimum of about £50k. The multiple rises with growth and falls with poor satisfaction or uptime. Counting paying users means price-gouging can't inflate the valuation.
- **A falling company can't gain value (#162).** While paying users or income are down on the week before, or satisfaction drops below the good line, the business (everything but cash) can't be worth more than it was the day before; once nothing is falling it catches up over about a week. Growth only counts above the company's best before, so winning back users lost in a crash isn't growth. Friends and family's price and the vulture VC's buy-back follow the same valuation.
- **Investor valuation:** the first investor after friends and family sets their own figure for what the company is worth. From then on the valuation starts from that figure and moves up or down with the formula's changes (if the formula valuation rises 10%, so does the company's).
- A student who never takes an investor beyond friends and family is valued by the formula throughout. Friends and family buy shares at the formula valuation.

*Multiples, value per user and the minimum are placeholders.*

## IPO (win condition)

To float, the company must pass a readiness check:

- **Trading history:** about four months (120 days, configurable) of trading since the launch, so even strong play can't float before about day 120
- **Users and revenue** above a threshold, including a **minimum paying customer base**, so a company with 300 payers at $1,000 each can't float
- **Uptime record**, e.g. 99% over the last 30 days
- **Predictable costs.** Big spending swings count against you (capex vs opex discussion). The record's single costliest day is set aside, so one fraud bill or severance payment doesn't fail it.
- **Security and compliance audit.** On IaaS you must have patched everything yourself; PaaS/SaaS providers cover more.
- **The full C-suite:** every role is hired (all 11 beyond the CEO). Because the last roles open at the Series A approach, Series A must have approached, but no later round has to.

That's six checks. Profitability, the satisfaction record and "all four Series rounds have approached" were cut to make the gate simpler: profitability overlaps revenue and predictable costs, satisfaction still moves the valuation and the first day's trading, and the Series approaches repeated the revenue check. The full C-suite replaced the three named executives (CFO, CISO, legal counsel): one rule that's easy to explain, and picking and timing 11 hires gives the late game decisions.

- **No VC money needed.** Series A must approach, but the student can decline it. Growing without investors and floating is harder but keeps far more of the company.
- **Visible checklist.** The Finance page shows each condition turning green. The student can apply once all are green.
- **Market mood.** Applying still carries a small hidden chance of a cold market: the IPO is postponed by about 30 days and some reputation is lost, but the student can try again. A company comfortably over every condition is less likely to hit one.
- In a 180-day game a float will be rare. A game that reaches its last day without floating is scored by its valuation (see Scoring).

**The float.** When the readiness check passes, the student chooses how many **new shares** to create and sell to the public, **up to 40% of all shares** (configurable). As in real life, the float dilutes everyone: the student, the investors and any C-suite shareholders. The cash raised goes to the company. Floating more raises more cash but leaves the student owning less.

- **Minimum float:** at least 15% (configurable). Floating less makes the IPO fail.
- **The cash counts:** the company's market value at the close includes the cash raised, so a bigger float is a smaller share of a bigger company, not simply a loss.
- **Float size and the first day:** a small float is more volatile, with scarce shares that can jump further or fall further. A large float is steadier.

**Ringing the opening bell.** The IPO has its own page where the student rings the opening bell and watches the first day of trading. The share price moves based on how ready the company was (growth, uptime, satisfaction, predictable costs, profitability), with a little randomness. The page ends with the result: cash raised, the company's market value and what the student's own shares are worth.

## Scoring

**Final score = company valuation × share of company the student still owns.** If the game ends without an IPO, the company is valued as it stands, so every student gets a score. If it ends in an IPO, the score is the student's share after the float × the **market value at the close of the first day of trading**.

- **Weight valuation by satisfaction and customer count, not just revenue**, so price-gouging can't top the class even after the alpha's pricing exploits are fixed.
- **Class leaderboard (optional):** the teacher can show scores for a login-code group on the staff dashboard.

## Debrief

Students justify their final infrastructure setup (possible assessment evidence). Suggested prompts: why did you choose your model; which layers were you responsible for, and what did that cost you; would you choose differently for a different product type, and why?

**Un-parked for beta.** "The game helped me understand cloud deployment models" scored 2.8/5 in the alpha survey, the lowest of any question. Part of that is timing: the alpha class hadn't been taught deployment models yet (that's next half term), so much of the game was unexplained. The debrief is still the most direct in-game fix.

- **When:** at the end of every game, before the summary screen, however it ended (IPO, liquidation, game length, or the teacher ending it).
- **Model comparison first:** "You ran on PaaS. Your 180 days cost £X in managed services. The same users on on-prem would have cost about £Y up front and £Z in ops staff." The figures come from the student's own game, recalculated for each other model. The comparison always shows, even with the debrief off.
- **Then the three prompts**, each with a text box. The student must write at least a sentence for each before seeing their score.
- **The teacher sees the answers** on the staff dashboard next to each company's summary, and can export them as assessment evidence.
- **The teacher can turn the prompts on or off** in the preset (on by default), so they can be used once the topic has been taught. It also adds an **end-of-game model comparison**, for example "on PaaS you paid X for managed services; on-prem would have cost Y".

## Events v2

The alpha gave every run the same events: four traffic-spike days in two pairs, one provider outage, one provider price rise, and OS patches on fixed days. Only the timing changed, so a second game was predictable.

### The encounter system

Random events work like random battles in the original Final Fantasy VII:

1. **Encounter list.** Each event type rolls its chances, and those that come up go into the encounter list, each with a **threshold**. Likelier events get lower thresholds. The company's situation decides what can go on the list and how likely it is: a breach only goes on, or goes on with much better odds, when patches are overdue.
2. **Danger meter.** Starts at 0 and rises every day. How much depends on what the student did that day and how the company is doing: unpatched servers, the slider above 100%, overloaded capacity and low satisfaction make it climb faster; a well-run day makes it creep.
3. **The check.** Each day the meter is compared with the next event on the list (the lowest threshold). Below it, nothing happens. At or above it, that event fires.
4. **Reset.** When an event fires, the list is emptied, a new list is rolled and the meter goes back to 0.

One exception to the surprise: a **traffic spike gives a tip-off** about a week ahead (when it's next on the list and a week of well-run days would reach its threshold), as nothing but spare capacity protects on-prem and new kit takes days to arrive. Risky days fill the meter faster, so it can come sooner.

There's no hard minimum gap between events. Because the meter climbs from 0 after each one, gaps come naturally, and thresholds are tuned so the next event rarely comes within about 14 days (students complained about spikes landing close together). The meter controls **when** something happens; the situation controls **what**.

### The calendar

Games use a **real calendar**. Each game starts on a random date, so students might open in the January blues or just before the summer holidays.

**Calendar events** fall on their dates and sit outside the encounter system: they don't need the meter and don't reset it, so they can be seen coming and planned for. Each product feels them differently. Examples:

| Date | Event | Hits |
|---|---|---|
| January | January blues: spending and sign-ups dip | E-commerce, payments |
| Easter holidays, summer holidays | Students and families online more | Social, video, games network |
| Black Friday (late November) | Huge shopping spike | E-commerce, payments |
| Christmas | Gifts, new devices and time off | Games network, video, e-commerce |
| Big game launch (e.g. 19 November for a GTA 6-sized release) | Download and multiplayer surge | Games network |
| Big film release (e.g. 18 December for a Doomsday-sized blockbuster) | Streaming and social buzz | Video, social |

In the game, launches and releases use made-up names, not real ones.

- **Holidays repeat every year** on their dates: January, Easter, summer, Black Friday, Christmas.
- **Big releases are rolled each year:** 1–3 big game launches and 1–2 blockbuster films, on random dates. Each is **announced in the game's news about 30 days ahead**, so the student can plan capacity.
- The calendar shows real years counting forward from the start date, so a career might run from 2026 to 2073.

### New events

- **New events**, each hitting the models differently:
  - **Security breach or ransomware:** worse if you haven't patched; ties into the IPO security audit.
  - **Viral growth:** a sudden wave of free users.
  - **Data-centre fire, flood or power cut:** hits on-prem hardest.
  - **Theft or fraud:** a one-off cash loss.
  - **Lawsuit:** a legal cost, for example after a breach.

## Staff v2

- **Grades:** each pool (developers, ops, support, moderators) has junior, mid and senior staff, each with its own pay and output. For example, a senior clears about twice the tickets of a junior for about 1.7× the pay: cheaper per unit of work, dearer up front.
- **Hiring lead time grows with grade:** juniors arrive in about 3 days, mids in 7 and seniors in 14. A crisis forces a choice between fast, cheap juniors and better seniors who arrive too late. *Placeholders.*
- **The head of each pool** (C-suite) improves that pool's output.
- **Moderators** are a fourth pool, only for products where users post content: social, video and the games network. They handle reports as support handles tickets; too few means falling satisfaction and a higher chance of a lawsuit.
- **Agency staff:** temporary staff who cost **1.25×** a permanent member of the same grade and do **half the work**. They arrive the next day, and can be let go and rehired freely with no severance. They're the expensive way to cover a short-term gap.
- **Permanent staff** get a **severance payout** when let go, so cutting them has a cost.
- **Staff you let go can join a rival.**
- **Hire and let go by number:** a number box next to each pool, so hiring 25 staff is one entry, not 25 clicks.
- **Researchers and marketers** are two more pools, which unlock when the **first angel approaches**, whether or not the student takes the money. They're **permanent hires only** (no agency staff), with the same grades, lead times and severance as other pools, and start at 0. Both are flagged as **idle** on the staff page when they have nothing to do: researchers once there's nothing left to unlock, marketers when not running a campaign.
  - **Researchers** earn **research points (RP)** each day (e.g. 2 RP per mid, scaled by grade), spent on unlocks (see Tiered features and add-ons). Research is an investment phase: once it's done, the student lets the team go.
  - **Marketers** carry out the student's marketing campaigns, one campaign each (see Competitors and marketing).
  - A **Research page** and a **Marketing page** appear at the same moment, so the company growing up shows in the navigation. *Pay and output are placeholders.*

## Developers: MVP and optimisation

**The MVP.** A company starts by building an MVP, measured in dev-days. **No users arrive until it's done**, while salaries are paid from day 1, so the opening is an early-game cash burn.

- The size comes from the product type (social bigger than e-commerce), then scales by how much of the stack the model owns: **on-prem 100%, IaaS 85%, PaaS 65%, SaaS 40%**. With the starting two developers that's at most about 10–15 days on-prem. On SaaS the MVP is setting up the storefront, linking payment gateways and so on.
- Hiring more developers (or agency developers) finishes it sooner, so the first hiring decision matters.
- **Launch is a button.** When the MVP is done the company waits as **Ready to launch** until the student presses **Launch**; launch users ramp in from then. Hosting bills still start at go-live, so kit rented while waiting is free until launch, but staff are paid every day, so waiting isn't free. On-prem kit can be ordered during the MVP so its delivery overlaps the build. See Phases and checklists.
- The features panel shows MVP progress (dev-days done of the total) and an estimated launch day.

**The developer slider.** After launch, a slider splits developer time between **features** and **optimisation**, on every model.

- **Optimisation** permanently cuts what the product needs per user: fewer CU and DBU on on-prem and IaaS, fewer instances on PaaS, a lower per-user platform fee on SaaS.
- **Diminishing returns:** the first optimisation work gives quick gains and later work less, up to a cap of about **50% on-prem** (hardware costs the most, so tuning pays most) and **about 35%** on the other models.
- **It's code**, so it survives a migration, capped at the new model's maximum.
- Early on, features drive growth; once the company is big, a few percent off a large server bill is worth more than another feature. *Sizes, shares and caps are placeholders.*

## Pay reviews

A 180-day game counts internally as one year, split into **four equal quarters** (game length ÷ 4). Staff first come to the student about pay **about 30 days into the Grow phase** (see Phases and checklists), so never before the company has launched and grown, then **every quarter** after that until the game ends: two or three reviews in a 180-day game, none if it never reaches Grow. A 1-year game works the same way. **Until IPO** and **Career** games have years of 365 days, so a review about every 91 days once they've started.

- **It stops the clock.** A notification appears and the student can't continue until the review is settled.
- **What the student sees:**
  - the review's **inflation figure** (rolled between 2% and 6%)
  - the **lowest offer allowed** (inflation − 1 point, never below 0) and the **most staff will ask for** (inflation + 4 points)
  - a live **cost preview** of their offer
- **The student offers first**, then staff respond. The rounds use the investor negotiation's roll with the sides reversed:
  1. The student offers a cash rise plus any scheme increases.
  2. Staff **accept** if the offer reaches their hidden walk-away point. If not, they **counter**, and a roll decides how far they come down.
  3. The student can accept a counter at any time.
  4. If there's still no deal after the student's **third offer**, it goes to a **tribunal**.
  - **Auto-negotiate:** the student sets their opening offer (cash rise and schemes) and presses Auto-negotiate. The game plays the remaining rounds with the same rolls, repeating the student's cash rise; schemes stay as set. It shows a transcript of each round. If staff accept, it's settled; if not, it ends on staff's last counter with **Accept** and **Tribunal** (showing the fee). It never goes to tribunal by itself.
- **The tribunal** picks the student's figure, the staff's figure or the middle. The roll is weighted towards whichever is closer to a hidden **fair rise** (inflation, plus more if the company is doing well), and the student pays a fee. There's no declining a review; the tribunal always settles it.
- **Staff schemes** cost money going forward but let the student offer a smaller cash rise:

  | Scheme | Control | Cost going forward | Value to staff |
  |---|---|---|---|
  | Share save | Slider 0–3 | New shares worth 1% of the company per level, to a "Staff share scheme" holder on the cap table (dilutes the student; outside the C-suite equity cap) | High |
  | Pension top-up | Slider 0–3 | An extra % on the wage bill | Medium |
  | Health cash plan (eye, dental, physio) | Slider 0–3 | £ per staff member per day | Medium |
  | Death in service | On/off | A small % on the wage bill | Low |
  | Discount scheme (like Blue Light Card) | On/off | A very small £ per staff member per day | Low |

  - **Schemes only go up.** A slider can be raised in a later review but never lowered or removed; a toggle once on stays on. Only the increase counts towards that review's offer.
  - If the tribunal picks the staff's figure, it's a cash rise only; if it picks the student's or the middle, the student's scheme increases apply.
- **The rise is pool-wide.** It lifts every staff pool's day rate, so existing staff get it and new hires join at the new rate. The C-suite is left out. Pay reviews replace wage inflation from drift.
- **Without a head of people** the student deals with staff directly: staff are stricter on the roll, want cash, and value schemes at only about 70%. **With a head of people** they're friendlier, value schemes fully or more, and the tribunal leans slightly the student's way.
- **A pay history** on the People page lists past reviews, how each ended, the rises given and the current schemes with their running costs.

The lessons: a rise below inflation is a pay cut, benefits are a permanent cost, and share schemes are paid for in ownership. *All figures are placeholders.*

## C-suite

A leadership team the student hires one role at a time. Each role gives a lasting bonus to one area of the business.

**Hiring.** Each role shows a shortlist of candidates (about 3), and the student picks one. Each candidate has their own stats and pay package: salary, and for senior roles an equity ask paid in **new shares**, which dilute every shareholder as funding rounds do. A strong candidate costs more; a cheap one may have a weakness.

- **When roles unlock:**

  | Stage | Roles |
  |---|---|
  | Day 1 | Head of development, head of ops, head of support |
  | On taking outside money (friends and family, a grant or any investor), which can be day 1, or at the first angel approach if that comes first. The bank loan doesn't count: it's the seed money. | CFO |
  | After the first angel approach | CTO, head of people |
  | After the Series A approach | COO, CIO, CMO, CISO, legal counsel |

  Like the angel, a round unlocks its roles when it **approaches**, whether the student accepts or declines.
- **Equity cap:** the whole C-suite together asks for no more than about 10% of the company. Candidates' equity asks shrink as the cap fills. The staff share scheme from pay reviews is a separate pot and doesn't count.
- **No pay reviews:** executives' pay is their own package, so pay review rises don't apply to them.
- **Hired for good (beta):** once hired, an executive can't be let go or replaced, and doesn't resign. Their salary is a permanent cost, so picking from the shortlist is a weighty decision. A rescue buyout's cost cuts don't touch the C-suite.

| Role | Effect (each candidate's stats vary it) |
|---|---|
| CEO | **The student**, as founder-CEO. Not hired. |
| CFO | Better rolls in investor and deal negotiations; cheaper loans. No part in pay reviews. |
| COO | About −8% everyday running costs (hosting, rent, provider fees; not staff pay) |
| CTO | Opens tier 2 straight away (as well as the market-share route); about +25% research points |
| CIO | Migrations about 30% cheaper and faster |
| Legal counsel | No gameplay effect: a compliance box to tick before floating. |
| CISO | Faster patching and a lower breach chance. |
| CMO | About +10% campaign effectiveness |
| Head of people | Pay reviews only: a better roll (in place of the penalty for dealing with staff directly), a softer walk-away point, schemes valued fully or more, and a slight tribunal lean |
| Head of ops | Ops staff cover more servers; better uptime |
| Head of support | Support staff clear more tickets; satisfaction recovers faster |
| Head of development | About +20% developer output on all developer work: the MVP, features and optimisation |

Some executives earn their keep and some are there because going public needs them: **the full C-suite is required to float**. *Stats, pay and the exact figures are placeholders for balancing.*

## More products

Three new product types join e-commerce, social and video, making six:

| Product type | Profile (placeholder) |
|---|---|
| AI assistant | Very heavy compute per user (GPU), costly to run; users willing to pay well |
| Games network (an online store and multiplayer service, like Steam, PSN or Xbox Live) | Huge spikes on big game launches and holidays; a subscription for online play |
| Payments app (like Stripe or Monzo) | Light, steady load with payday and Black Friday peaks; mostly business customers; outages and breaches hurt most, so uptime, security and compliance are the challenge |

Each product gets its own feature list and SaaS add-ons. The game shows generic names, not real brands.

**How the payments app earns** (like Klarna): its customers are mostly businesses, and it earns two ways:

- A **monthly fee** from each business using the service, like every other product's price.
- A **percentage of every transaction** those businesses process (e.g. 1.5%). Income follows transaction volume, so paydays and Black Friday are money spikes as well as load spikes.

The student sets both together as one price change: they share the 14-day lock and the reaction wave, and customer types react to the combined cost. *Rates are placeholders.*

## Pricing by customer type

In the alpha, willingness to pay and the free/paid split were set per product. In beta they're set by **customer type** instead, and each product has its own mix of customers. For example:

| Customer type | Willingness to pay | Goes free when the price rises |
|---|---|---|
| Casual users | Low | Readily |
| Enthusiasts | Medium | Sometimes |
| Professionals | High | Rarely |
| Businesses | Very high, on higher tiers | Rarely, but leave if uptime is poor |

- **One price for everyone**, as in the alpha. There are no separate plans.
- **Price thresholds:** each customer type has its own pain point for the price. When the price changes, each type's reaction is worked out, and the **weighted average** reaction (each type's reaction × its share of users) is applied to all users. For example, a social network of 70% casual users (30% leave), 20% enthusiasts (10%), 8% professionals (2%) and 2% businesses (1%) loses about 23%. As the mix shifts, the reaction moves smoothly with it.
- **Contract users** (from deals) are left out: they're locked in at their contract price and unaffected by a rise. If the student **lowers** the price below a contract's price, they pay the contract back the difference for the rest of the contract. For example, a contract for 1,000 users at £6 a month, with the price lowered to £5, costs £1,000 a month back, paid daily until the contract ends.

**What shifts the mix:**

- **New users** arrive in the product's base mix.
- **Features** each appeal to a customer type; a "pro" feature brings in more professionals.
- **Marketing** spend targets one customer type at a time.
- **Price** filters the mix: casual users leave first when it rises, so a pricier company ends up more professional and the next rise hurts less. This is how companies move upmarket.
- **Uptime:** businesses leave faster when it's poor.

The **Customers page** shows the mix as a bar, with each type's price threshold marked and contract users as a separate block. Pricing becomes reading the market rather than guessing.

A price change hits each customer type differently, so students learn to price for who their users are. Growing a different mix (for example through marketing or features aimed at professionals) changes what the company can charge. *Types and figures are placeholders.*

## Tiered features and add-ons

In the alpha every feature and add-on was available from day 1, and SaaS students bought every add-on on the first day. In beta, the benefits a company can buy are grouped into **tiers**, each with conditions to unlock:

| Tier | Example unlock conditions |
|---|---|
| 1 | Available from the start |
| 2 | A user count (35% of the product's market: 7,000 on the shop, 1,400 on the payments app), or a CTO hired |
| 3 | Revenue and uptime targets (e.g. £2k a day and 99% uptime over 30 days) |
| 4 | A funding round or IPO readiness |

- **A condition makes a tier available; research unlocks what's in it.** Once a tier's condition is met, each feature and model benefit in it has its own **research point (RP) price**, and the student unlocks them in any order with RP earned by researchers. Unlocking is separate from building (dev-days) or buying (cash).
- **Tier 1 needs no RP**, since researchers only arrive with the first angel.
- **Unused RP bank with no cap**, so the student can save up while waiting for the next tier's condition. *RP prices are placeholders.*
- This applies to **built features and SaaS add-ons alike**, so every model has something to work towards.
- **SaaS gets add-ons for every product**, including the new AI and games-network products.
- Higher tiers give bigger benefits but cost more, so each new tier is a decision, not an automatic purchase.

**Each deployment model has its own benefits**, matching what you control on that model:

| Model | Example benefits |
|---|---|
| On-prem | **Hardware efficiency:** better cooling and power efficiency. (Developers tuning the product to need fewer CU and DBU per user is now the developer slider, on every model.) |
| IaaS | **Reserved instances** (cheaper VMs if you commit for longer), **autoscaling** for traffic spikes |
| PaaS | **Managed autoscaling**, a **CDN** that takes load off the app, managed monitoring that warns before outages |
| SaaS | Provider add-ons such as integrations, analytics and a **premium support plan** that shortens provider outages |

The lesson: the more of the stack you own, the more you can optimise it yourself; the less you own, the more you buy ready-made from the provider.

**Tiers and migration:**

- Each tier holds both kinds of benefit: **product features** (e.g. messaging) and **model benefits** (e.g. a CDN on PaaS).
- Tiers and their **RP unlocks are per company**, so an unlocked item applies to whichever model the company is on now or moves to.
- **Product features survive a migration**; the code moves with the product.
- **Model benefits are lost on migration**, with no refund. Their RP unlocks are kept, so the new model's benefits can be bought straight away, up to the tier already unlocked. Losing them is part of what migrating costs.

**Hardware tuning (on-prem only).** Each on-prem server has a performance slider from **0 to 150%**.

- At 100% the server gives its normal capacity.
- Below 100% it gives less capacity but runs cooler and lasts longer.
- Above 100% it gives extra capacity but stresses the hardware. The higher the slider, the bigger the daily chance of **overheating** (capacity drops for a few days) or a **crash** (an outage until ops fix it).
- It's a short-term fix: pushing kit hard keeps the service up while new servers are on their ~10-day delivery, but leaving it high for weeks costs more in crashes than it saves.

This only exists on-prem because only on-prem gives you access to the physical hardware. *The risk curve and limits are placeholders for balancing.*

## Deals

From time to time a company approaches the student to use their service. Each deal offers:

- **A set number of users** who all arrive when the deal starts, so the student has to have capacity ready.
- **A set price per user**, fixed for the length of the deal (e.g. 90 days), whatever the student's normal price.
- **An SLA (service level agreement)** with conditions, for example 99.5% uptime, support tickets answered within a day, or satisfaction above 80%.
- **Daily penalties** for every day the SLA is broken. Breaking it too often lets the company end the deal early and take its users with it.

The student can accept, decline or **negotiate**, using the same three rounds as investors (the third offer is final), and the offer expires after a few days.

**When a deal ends:**

- **SLA kept on most days:** the company offers to renew, and the student can negotiate. A strong SLA record improves the negotiation rolls.
- **SLA broken often:** no renewal; the users leave.
- **Renewal declined:** the users become ordinary business customers, paying the normal price and reacting to price changes.
 Bigger deals come later and only to companies with a good uptime record. Deals teach students to check they can deliver before signing, and why providers sell SLAs. *Sizes, prices and penalties are placeholders.*

## APIs

Products that would have one in real life (AI assistant, payments app, e-commerce and the games network) can offer a **paid API** that other businesses build on.

- The API is a feature the student **unlocks through the tiers or buys**.
- Each API call earns a tiny amount, about **1p**.
- Calls start in the thousands a day and can grow into the hundreds of thousands, so it adds up the more the student can handle.
- **The price is fixed** at about 1p per call in beta; per-call pricing is kept for later.
- **What grows traffic:** paying users (developers build on popular platforms), uptime, and higher-tier features. An outage drops calls and slows API growth for a while, because developers don't trust a flaky API.
- **API calls need their own capacity, measured in APIU** (API units; e.g. 1 APIU handles 10,000 calls a day). Calls beyond APIU capacity are dropped, and their income with them, so the API rewards headroom and good infrastructure.
  - **API servers** join the server types (app, database, cache, load balancer), in the same four sizes, and give APIU.
  - **Converting:** an app server the student already has can be switched from giving CU to giving APIU, and back. This trades user capacity for API capacity.
  - On PaaS, API capacity is an instance count, as app capacity is.
- **API deals:** a company can sign a deal for a block of calls a day at a contract rate, with an SLA, negotiated like any deal.
- **On SaaS, the provider runs the API.** The student needs no capacity for it but pays the platform a per-call fee and keeps the margin.

## Competitors and marketing

- **One or two rivals** in the same market. Each rival is lightweight: a name, a price, a quality score and a market share.
  - **Quality** comes from their features and uptime, which change over time.
  - **New users** go to whichever company offers the best value for their customer type: a cheap rival pulls casual users, a high-quality one pulls professionals.
  - **Rivals react slowly** to the student's price (e.g. 14 days later), and sometimes undercut it.
  - **Staff the student lets go** can join a rival, nudging its quality up.
  - The **Customers page** shows market share as a pie.
  - Rivals never go bankrupt or IPO. They're market pressure, not opponents in a race.
- **Marketing campaigns** as a growth lever, so customer growth feels less random. The student picks a **customer type**, a **budget** and a **length** (e.g. professionals, £5k, 30 days), and the campaign brings extra new users of that type over its length.
  - **Marketers run them:** campaigns unlock with marketers at the first angel approach, and each marketer runs one campaign at a time. Headcount decides how many campaigns run and how good they are (marketer grade scales users per pound); budget decides how big each is.
  - **Users are added directly**, about (budget ÷ length) ÷ the customer type's cost per user each day (casual users £1, businesses £8, tuned in #200), on top of normal growth, so a campaign works even for a small company. Market saturation still slows it.
  - **Brand awareness (#200):** each user a campaign brings in grows the product's market size for good (5 each, up to +30% of its base market), so campaign users are extra rather than ones who'd have joined within weeks, and the bigger market keeps paying after the campaign ends. The Marketing page shows the growth so far against the cap, and what each campaign added.
  - **Diminishing returns:** running two campaigns for the same type at once brings fewer users per pound.
  - **A CMO** makes every campaign more effective.
  - **Results as it runs:** spend, users brought in and cost per user, teaching cost per acquisition.
  - **Calendar timing:** a campaign started just before a holiday works better.
  - Campaigns targeting a rival's customers are kept for later.

## Graphs

Live charts of cash, users and satisfaction over time on the Finance and Customers pages, not only on the end-of-game summary.

## Difficulty

Built-in **Easy, Normal and Hard** difficulties, working like game length:

- The config preset holds the list of **allowed difficulties**; the default allows only Normal.
- The student picks one of the allowed difficulties when starting a company.
- The class leaderboard is **split by difficulty**.
- Difficulty changes numbers only (starting cash, event odds, price thresholds, how fast the danger meter climbs), never which systems exist.

## Pacing

In the alpha, only about 6% of days needed any decision, most Continue clicks came less than half a second after the last, and a finished game took a median of 4 minutes.

- **Turn on the timed flow** that's already built in, pausing automatically on events, alerts and low cash (see Game length).
- **Show a day-progress bar.**

## Phases and checklists

From the playtest after the C-suite (2026-10-26): the opening was too many plates at once, and after a vulture rescue and Series A there was nothing left to do but add big infrastructure ahead of a spike. Students will do the same. So the game opens its jobs a phase at a time, and every phase has a checklist.

**Four phases**, each opened by a milestone. Jobs that aren't open yet are **hidden**, not just greyed out: a new player in Build sees developers and the MVP and little else.

| Phase | Opens | Ends | What opens |
|---|---|---|---|
| Build | Day 1 | The MVP is done | Deployment model, funding (loan, friends and family, grants), developers, servers or racks |
| Launch | The MVP is done (the student presses Launch) | The first angel approach | Price, ops, support |
| Grow | The first angel approach | The Series A approach | Moderators, researchers, marketers, features and tiers, deals, campaigns, the CFO, CTO and head of people |
| Scale | The Series A approach | The float, or the end of the game | The rest of the C-suite, the IPO |

The CFO keeps its early route (outside money opens it as soon as it's taken). Pay reviews start no sooner than about 30 days into Grow, rather than on a fixed quarter, so a student isn't settling pay before they've launched. *Exactly which jobs open where is a placeholder for the slice that builds it.*

**A checklist for each phase**, in two modes:

- **Below the phase's minimum:** it lists what's missing, each line saying why ("launch demand is about 9 CU; a small app server gives 6"), with **Get me ready**: one click buys or hires only the shortfall, showing the daily cost first. It never sells kit or lets anyone go. Hires are **permanent juniors**.
- **At or above the minimum:** it shows where the student's **own projection** says they'll need to be by the end of the phase (from their users, growth and model), next to the **baseline** for their product and model ("you're heading for 2 app servers; a typical social network on IaaS has 3 by now").

What each checklist covers:

- **Build:** developers, then the launch kit, shown once the MVP is 75% built so permanent hires and servers are ready by launch day. The kit is the minimum for launch-day demand on the student's model: on-prem and IaaS need app servers, a database, a load balancer once there's more than one app server, and the ops to run them; PaaS and SaaS need less, which is the lesson. Plus enough support for the first users' tickets.
- **Launch:** servers, ops and support for current demand.
- **Grow:** adds researchers, marketers and moderators sized to the company, and the C-suite roles as they open.
- **Scale:** the rest of the C-suite and the six float checks, so the late game always has a visible to-do list.

**Launching short.** The student can press Launch without the minimum, with a plain warning such as "No database: no users can be served". It's a teaching game, so they can get it wrong, but never without being told.

**Baselines.** One per product and model (6 × 4 = 24): what the balance harness's careful playstyle had at the end of each phase (users, servers by type, staff by pool, cash, the day the phase ended). They're stored in the config and rebuilt by a script whenever the balance changes, like the gameplay fingerprints. They're used:

- in Build and early Launch, before there's enough history to project from
- beside the projection, as the "typical company" column
- for balancing, since each phase's end day shows where a product or model is too slow or too harsh.

## Game length

A game ends on liquidation, on an IPO, or when its **game length** runs out. **The IPO ends every game**, whatever its length: ringing the opening bell is always the finale, and longer lengths just give more time to get there. (A public-company phase after the IPO is kept for later.) There are four lengths:

| Game length | Ends |
|---|---|
| 180 days (default) | On day 180 |
| Until IPO | Only when the company floats (no day limit) |
| 1 year | On day 365 |
| Career | After 47 years: the student founds the company at 18 and runs it until they retire at 65 |

**Only 180 days is available unless the teacher turns the others on from the staff panel.** The longer lengths could take hours, so they're for clubs, homework or extension work rather than a normal lesson.

- The config preset holds the list of **allowed game lengths**. The default allows only 180 days.
- The student picks one of the allowed lengths when starting a company.
- As with all preset settings, a change only affects new games.
- **Until IPO has no automatic cap.** A student who can't float can retire the company to free a slot, as now.
- **The teacher can end games** from the staff panel, for one company or a whole login code (for example at the end of a unit, or before showing the leaderboard). Each game ended this way is scored by its valuation as it stands. This works for every game length.

### How time moves

- **Timed flow** replaces clicking Continue for each day. Time passes on its own, with a pause button and speed settings.
- It **pauses itself** whenever something needs the student: an event, an alert, a deal offer, low cash or a finished build.
- **Each tick is a day**, except in a career, where each tick is a week. A career is about 2,450 weeks.
- The simulation still runs day by day underneath, so a career's week is seven ordinary days and there's only one set of numbers to balance. The pause triggers are checked after every day, so a crisis on the second day of a week still stops the clock.

### The world drifts over time

Long games change slowly rather than in eras (eras are kept for later):

- **Inflation:** at the end of each 365-day year, running prices (servers and VMs, rent, provider fees) rise by a fresh random 2–6%. The student's own price never rises by itself. Wages rise only through pay reviews, which roll their own 2–6% each time.
- **Cheaper hardware:** at each year's end, newly bought servers and VMs give about 10% more units for the money. Kit already owned keeps its units, so upgrading old kit is a real decision.
- **Server wear:** the hardware slider's wear, scaled to the game length. In a 180-day game a server at 100% never wears out, but pushing it hard wears it out within a few months. In longer games a server lasts about 5 years at 100%. Below 100% it lasts longer and above it wears faster, and the student is warned before a server is likely to fail.

180-day and 1-year games never reach a year's end, so prices and hardware don't drift in them. *Rates are placeholders.*

## Onboarding

A permanent **tutorial company** that every student has alongside their real ones:

- A short scripted game (e.g. 30 days) that walks the student through their first purchase, first price decision, first hire, and the systems that turn up later in a real game (an investor offer, a deal, a calendar event).
- It can be played and restarted at any time.
- It doesn't count towards the 3-active-companies limit, the leaderboard or the teacher's live dashboard.

*"I understood what I was supposed to do from the start" scored 3.3/5 in the alpha survey.*

## AI playtesting

A lightweight way for an AI to play the game, so balance and exploits can be tested before students see them. **Built for the alpha:** `npm run -s play` in the `sim` package, briefed by `sim/scripts/ai-playtest.md`. It was used to verify the alpha patch (#83), and it grows with each beta system. In the alpha, students found the price exploits within minutes; an AI that plays like a min-maxer should find them first.

**Not the web page.** The AI plays the simulation directly through a compact text format that's quicker and cheaper to read:

- Each turn the AI gets a **short state summary**: day and date, cash and runway, users by customer type, capacity by tier, satisfaction and uptime, plus anything waiting on it (alerts, investor offers, deals, events).
- With it comes the **list of actions it can take right now**, each with its allowed range (e.g. `setPrice 1–1000`, `hire support junior 1–50`).
- The AI replies with the actions it wants, then says how far to advance. Time pauses on the same triggers as the timed flow.
- Every game writes the **same log format as a real playtest**, so the same analysis runs on AI games and student games, and they can be compared.

**Playstyles.** Each AI game is given a playstyle that sets how it thinks and plays:

| Playstyle | How it plays |
|---|---|
| Min-maxer | Hunts for the most efficient route and any exploit; reads every number and tests the edges (extreme prices, mass hiring, timing tricks) |
| Maxer | Goes for the biggest company: aggressive growth, every investor, every deal, high risk |
| Average Joe | Plays like a typical student: skims, mostly lets time run, reacts to problems late, follows the obvious prompts |
| Low and slow | Cautious: no loan, few risks, steady growth, keeps a cash cushion |
| Chaos tester | Tries odd things just to see what happens, like the alpha student who let everyone go and charged £1 |
| Spiffin Brit | Plays like the exploit YouTuber: looks for one ridiculous loophole and rides it as far as it goes, narrating how the system is "working as intended" |
| Reamu Keaves | Breathtakingly wholesome: pays staff well, never lets anyone go, keeps prices fair and customers happy, and treats every investor with kindness. Tests whether doing right by everyone can still win |
| Hodd Toward | "It just works!" Ships every feature and tier as fast as possible, overpromises on deals and SLAs, and never tests capacity first. Tests what happens when you sell more than you can deliver |

- **Running it:** start a batch of AI playtesters, for example one per playstyle, each playing its own game in parallel. Each hands back a **game summary**: how the game ended, the score, key moments (first profit, investors taken, rescues, events), what it tried and anything that felt broken or exploitable. The summaries are then presented side by side, alongside the logs.
- Playstyles can be combined with any product, model, game length and difficulty, and run in batches with fixed random seeds so results can be repeated.
- **Average Joe matters most for balance:** if typical students can't break even, the game is too hard. With the MVP's early burn, the target is careful play breaking even around **day 60–75**, and no later than about **day 90** (it was day 45–65 in the alpha). **Min-maxer matters most for exploits:** anything it finds, students will too.

This sits alongside the existing scripted balance harness (`sim/scripts/harness.ts`), which plays thousands of rule-based games quickly. The scripted bots measure balance at volume; the AI playstyles bring judgement, and find what the scripts weren't written to look for.
