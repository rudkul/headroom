# headroom

A compact band above the Claude Code prompt that shows where you stand on your 5-hour and weekly usage limits.

- A thin progress bar per limit, with the orange (50%) and red (80%) zones marked in advance
- Percent used, and an estimate of tokens used, total and left (like `229k / 1.3M  ~1.0M left`)
- Tokens this chat has used, shown when you hover over the band
- Pace: whether the limit will last until it resets at your current rate
- Time until each limit resets, refreshed every minute
- Alerts at 50%, 80% and 95%, and when a limit is on pace to run out

Claude reports limits as a percentage only, so the token figures are estimates: headroom compares the tokens you use with how the percentage moves, and shows "calibrating…" until it has a reading. Other sessions running at the same time make the estimate read low.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install headroom --marketplace rudkul/headroom
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

Or from a shell:

```bash
claude plugin marketplace add rudkul/headroom
claude plugin install headroom@headroom --scope user
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `rudkul/headroom`, then Add plugin.
