# Arbiter

If you play Path of Exile 2 for the economy, you know the routine. Twelve trade tabs open. A price
site in another window. A spreadsheet where you guess what your stash is worth. Half an hour of
tabbing around before you make a single trade. I got sick of it and built the thing I wanted: one
window that trades, watches the market, and runs the numbers for me.

![Arbiter, the Board](docs/screenshots/board-vault.png)

## It makes you currency

Tell Arbiter what's in your bank. It finds loops on the currency exchange, and through vendor
recipes, that end with more of what you started with. It sizes every loop to what you actually
hold, charges the real gold fees, works out how long each step takes to fill from real hourly
volume, and ranks them by how fast they earn per gold you burn. Gold cheap for you right now? The
gold-hungry loops float up. Gold precious? The gold-free ones win. One slider.

I run this every session and it pays for itself. It's not a get-rich button, it's the boring edge
you'd never find by eye, found for you, every hour.

## It tells you what to hold

Profits melt. The league inflates, the currency you stacked last week buys less this week, and by
the time you notice it's gone. The Hold page scores every currency as a store of value and tells
you which ones are holding up against inflation and which are about to move. Park your wealth
somewhere that keeps it.

## It watches the market so you don't have to

Every currency, priced off the market that actually trades it, with the hourly history behind it.
Price, trend, change, a line that ends on today's number. Click a card and you get the zoomed
history and every market that thing trades in. This is the price site, except it's yours, it's
local, and it's already open.

## It kills your tab problem

The Trading tab is the real trade site, inside the app, logged in, with folders. Save a search,
drop it in a folder (mapping, crafting, flipping, whatever), and open it with one click. Copy an
item in game and it shows up in an ExiledExchange2 history folder with a search ready to run.
Every search is Instant Buyout, so travel-to-hideout just works.

Set a search live and Arbiter listens. When a listing pings, hit `Ctrl+G`. It pulls up the newest
hit and travels you to the seller. You never leave the game.

## It writes your stash searches

Rolling waystones, sorting tablets? Pick the tier, the revives, the mods you want, the mods you
don't, and it writes the regex for the stash search box. It knows the 250-character limit and has a
switch for when you're over. The same selection goes straight to the trade site as a search.

## What sold

Sales, when, for how much, next to what you're holding. So you know if the plan is working.

## Six looks, one layout

| Vault (default) | Arbiter of Ash | Arbiter of Divinity |
|---|---|---|
| ![Vault](docs/screenshots/board-vault.png) | ![Ash](docs/screenshots/board-ash.png) | ![Divinity](docs/screenshots/board-divinity.png) |

| Trial of the Sekhemas | Vaal | Azmeri |
|---|---|---|
| ![Sekhemas](docs/screenshots/board-sekhemas.png) | ![Vaal](docs/screenshots/board-vaal.png) | ![Azmeri](docs/screenshots/board-azmeri.png) |

## The pages

| | |
|---|---|
| ![Arbitrage](docs/screenshots/strategy-arbitrage.png) | ![Hold](docs/screenshots/strategy-hold.png) |
| Arbitrage. Loops sized to your bank, ranked by how fast they earn. | Hold. Where wealth keeps. |
| ![Economy](docs/screenshots/economy.png) | ![Regex](docs/screenshots/trading-regex.png) |
| Economy. The league's inflation and its hub currencies. | Regex. The stash search, written for you. |

## Get it

Latest release: [Windows installer and Mac dmg](https://github.com/Shazambom/shazam-poe2-dashboard/releases/latest).
Install it, log in once from the top bar (the normal pathofexile.com login, Steam works), and
you're trading. It updates itself.

Everything stays on your PC. No account of mine, no server of mine, nothing phoning home. It talks
to GitHub for updates and to pathofexile.com on your own login, and that's it.

The trading side grew out of what I liked in Better Trading. The rest is what I wished existed.
