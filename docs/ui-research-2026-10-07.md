# Learnable, pleasant, habit-forming: what the evidence says

For the product owner. Each principle ends with a check you can run on one screen. **[lore]** marks practitioner opinion.

## (a) Principles, ranked for Arbiter

**1. Users act before they read, so the first click has to pay off.** New users skip instructions and start doing tasks straight away (Carroll & Rosson 1987, "Paradox of the Active User", https://www.nngroup.com/articles/paradox-of-the-active-user/). Users read 20–28% of a page's words, and 100 extra words buy only 4.4 more seconds of attention (Nielsen 2008, https://www.nngroup.com/articles/how-little-do-users-read/). *Check:* every tab opens on a useful, ready view, and a new user's first click on it does something worthwhile.

**2. Defaults are the design.** Most users never customize; the few who do mostly react to a forced change (Mackay 1991, CHI, https://doi.org/10.1145/108844.108867). The default largely decides the outcome (Johnson & Goldstein 2003, Science, https://doi.org/10.1126/science.1091721). *Check:* with settings untouched, the Board shows what most players want.

**3. Recognition beats recall, and an icon alone is recall.** Options visible on screen need fewer memory cues than ones users must remember (Budiu 2024, https://www.nngroup.com/articles/recognition-and-recall/; Nielsen heuristic #6). Few icons are understood everywhere, so put a visible text label beside each one; hover labels fail (Harley 2014, https://www.nngroup.com/articles/icon-usability/). A one-word label under each icon tab is the brief, specific label the owner accepts. *Check:* users who can't name a tab from its icon alone mean that tab needs a label.

**4. Overview first, details on demand, two levels at most.** Overview, then zoom and filter, then details on demand (Shneiderman 1996, https://doi.org/10.1109/VL.1996.545307). Users get lost past two disclosure levels (Nielsen 2006, https://www.nngroup.com/articles/progressive-disclosure/). *Check:* base cards show value and unit, depth lives in the expanded row or `CardDetail`, and no fact sits more than two clicks deep.

**5. Structure for scanning.** People scan unformatted text in an F-shape. Clear grouping and leading with the key fact replace that pattern (Pernice 2006/2017, https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/). *Check:* a user can find a named currency's price within 5 seconds, using groups taken from the game's own categories.

**6. Show status, within the time limits.** Under 0.1 s feels instant, 1 s breaks the user's flow, and past 10 s they lose attention unless they see progress (Nielsen, after Miller 1968 and Card 1991, https://www.nngroup.com/articles/response-times-3-important-limits/). *Check:* time every action. Flag any action over 1 s with no feedback.

**7. Build the path from novice to expert. ⌘K is for experts.** Users plateau on slow methods and switch only when the faster method is visible and pays off right away (Scarr et al. 2011, CHI, https://doi.org/10.1145/1978942.1979348; Cockburn et al. 2014, https://doi.org/10.1145/2659796). Listing hotkeys in menus did little. Naming the shortcut each time the user took the slow path raised adoption (Grossman et al. 2007, CHI, https://doi.org/10.1145/1240624.1240865). I found no peer-reviewed study of command-palette discoverability, so "palettes aid discovery" is **[lore]**. *Check:* every palette command is also reachable by clicking, and reaching one by clicking briefly shows its shortcut.

**8. Guidance that helps novices slows experts.** This is the expertise-reversal effect: help that guides novices becomes redundant for experts and degrades their performance (Kalyuga et al. 2003, https://doi.org/10.1207/S15326985EP3801_4; cognitive load theory, Sweller 1988, https://doi.org/10.1207/s15516709cog1202_4). PoE2 traders already know the economy. *Check:* no explanatory copy, and labels use the game's own terms (heuristic #2).

**9. Fewer choices, big targets for frequent actions.** Decision time grows with the log of the number of options (Hick 1952, https://doi.org/10.1080/17470215208416600). Pointing time grows with distance and shrinks with target size (Fitts 1954, https://doi.org/10.1037/h0055392). *Check:* remove controls that telemetry shows nobody touches, rather than shrinking them.

**10. Polish raises perceived usability, but real usability wins after use.** Attractive interfaces are rated easier to use (Kurosu & Kashimura 1995; Tractinsky et al. 2000, https://doi.org/10.1016/S0953-5438(00)00031-X; Moran 2024, https://www.nngroup.com/articles/aesthetic-usability-effect/). After real use, poor usability lowered aesthetic ratings (Tuch et al. 2012, https://doi.org/10.1016/j.chb.2012.03.024). Beauty tracks hedonic quality, which Hassenzahl separates from pragmatic quality (2004, https://doi.org/10.1207/s15327051hci1904_2). *Check:* delight comes from consistent type, alignment, motion that confirms actions, and nothing in the way, not from decoration. Test on the real build, because polish hides problems at first sight.

**11. People return when the tool makes them feel competent and in control.** In games, satisfying the needs for competence and autonomy predicted enjoyment and continued play, and intuitive controls fed competence (Ryan, Rigby & Przybylski 2006, https://doi.org/10.1007/s11031-006-9051-8). Habits form through repetition in a stable context (Wood & Neal 2007, https://doi.org/10.1037/0033-295X.114.4.843). Behavior happens when motivation, ability and a prompt come together (Fogg, https://behaviormodel.org/). *Check:* prompts carry real value (a fired signal in the inbox), layout stays stable across releases, and outcomes such as realized profit stay visible.

**12. The worst moment and the last moment shape memory.** People remember an experience by its peak and its end (Kahneman et al. 1993, Psychological Science; Kane 2018, https://www.nngroup.com/articles/peak-end-rule/). *Check:* fix the three worst moments in telemetry (errors, stale prices, rate-limit stalls) before adding any delight.

## (b) What does NOT work

- **Onboarding tours and tutorials.** NN/g found deck-of-cards tutorials didn't improve task performance and made apps look more complicated. Use them only for genuinely new interactions, kept brief and optional (Kendrick 2020, https://www.nngroup.com/articles/mobile-app-onboarding/). For experts, expertise reversal predicts they do harm.
- **Tooltips as a crutch.** Hover-only meaning turns recognition into recall (Harley 2014).
- **Listing a shortcut and hoping users pick it up** (Grossman 2007).
- **Anything that looks like an ad.** Users skip ad-like placement or animation, then avoid that whole area afterwards (https://www.nngroup.com/articles/banner-blindness-old-and-new-findings/).
- **Engagement-hook design** (Eyal, *Hooked*, 2014) **[lore]**, untested on tools. The evidence points to competence, not variable rewards.
- Empty states: state the status in one line and link to the next action (Kaplan 2021, NN/g) **[lore]**.

## (c) Judging first-contact friction

- **Nielsen's 10 heuristics** (Nielsen & Molich 1990, revised 1994, https://www.nngroup.com/articles/ten-usability-heuristics/): a cheap expert review. It misses many problems, so pair it with real users.
- **First-click test:** users whose first click was correct succeeded 87% of the time, against 46% after a wrong first click (Bailey, cited in Sauro 2011, https://measuringu.com/first-click/). Give five players one task per tab and record where they click first.
- **5-second test** **[lore, Perfetti/UIE]:** show a screen for 5 seconds, then ask what it's for. It measures clarity of purpose only, not usability.
- **Learnability:** time to first success, and how performance improves across trials (Grossman et al. 2009, CHI, https://doi.org/10.1145/1518701.1518803). If session 5 is no faster than session 1, users have plateaued.
- **Rank findings by severity**, meaning frequency × impact × persistence, never by how many there are.
