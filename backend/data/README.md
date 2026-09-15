# backend/data — seed files

Bundled seed data loaded at startup (offline fallbacks; the live sources override them):

- `currency_map.json` — a small **fallback** metadata→trade override map + a few currency
  records. The **authoritative** metadata→trade mapping is the poe2scout bridge (`meta_bridge`
  in `kv_ops`, built by the crawl); see `app/currencies.py`. Only add an entry here for something
  poe2scout can't provide, and keep it correct (semantically-distinct currencies must map to
  distinct trade ids — e.g. Orb of Alchemy `CurrencyUpgradeToRare→alch` vs Regal
  `CurrencyUpgradeMagicToRare→regal`).
- `recipes.json` — vendor/recipe edges for the exchange graph.

## ⚠️ Before touching the database, schema, kv routing, or the market snapshot

**Read [`../../docs/db-maintenance.md`](../../docs/db-maintenance.md) first.** It is the rulebook:
user data is migrated forward (never dropped); market data ships in the snapshot (bump
`snapshot_version`). Publishing a new snapshot forces **every client to re-seed** — don't do it
casually. New operational kv keys ride `kv_ops` automatically; user kv keys must be added to
`_USER_KV` in `db.py`.
