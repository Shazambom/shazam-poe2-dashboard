// Copied by sync-ee2.mjs into <ee2 cache>/renderer/specs/arbiter/goldens.test.ts and run under
// EE2's OWN vitest setup at the pinned tag. For every fixture item × prefs variant it runs EE2's
// real parseClipboard → createPresets → apiToSatisfySearch → createTradeRequest (exactly the
// port's seam, roadmap §4.4) and writes { prefs, q | error, name } goldens. The port's golden
// test then compares byte-for-byte. Env: ARBITER_FIXTURES (…/test/fixtures/ee2), ARBITER_GOLDENS.
import { describe, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { init, TRADE_ITEM_BY_REF } from "@/assets/data";
import { setupTests } from "@specs/vitest.setup";
import { parseClipboard } from "@/parser/Parser";
import { ItemRarity } from "@/parser";
import { createPresets } from "@/web/price-check/filters/create-presets";
import { createTradeRequest } from "@/web/price-check/trade/pathofexile-trade";
import { apiToSatisfySearch } from "@/web/price-check/trade/common";

const FIX = process.env.ARBITER_FIXTURES!;
const OUT = process.env.ARBITER_GOLDENS!;
const TRADE = process.env.ARBITER_TRADE_DATA!; // the same GGG snapshot the port bundles

// Serve the port's trade-data snapshot (not specs/data) so both sides see identical data.
vi.mock("@/web/background/IPC", () => ({
  Host: {
    proxy: vi.fn(async (url: string) => {
      const kind = url.endsWith("/stats") ? "stats" : "items";
      const data = fs.readFileSync(path.join(process.env.ARBITER_TRADE_DATA!, `${kind}.json`), "utf8");
      return { ok: true, status: 200, json: async () => JSON.parse(data), text: async () => data };
    }),
    onEvent: vi.fn(() => new AbortController()), sendEvent: vi.fn(), getConfig: vi.fn(async () => null),
    importFile: vi.fn(async (f: File) => f.name), logs: { value: "" }, version: { value: "0" }, updateInfo: { value: { state: "initial" } }, isElectron: true,
  },
}));

const PREFS_VARIANTS = JSON.parse(fs.readFileSync(path.join(FIX, "prefs-variants.json"), "utf8")) as Array<Record<string, any>>;
const DEFAULTS = { leagueId: "Standard", language: "en", realm: "pc-ggg", preferredTradeSite: "default", searchStatRange: 10, defaultAllSelected: false, activateStockFilter: false, collapseListings: "api", apiLatencySeconds: 2, savedAugments: {} };

function widgetFor(p: any) {
  return { wmId: 2, wmType: "price-check", wmTitle: "", wmWants: "hide", wmZorder: "exclusive", wmFlags: ["hide-on-blur", "menu::skip"],
    searchStatRange: p.searchStatRange, defaultAllSelected: p.defaultAllSelected, activateStockFilter: p.activateStockFilter, collapseListings: p.collapseListings,
    apiLatencySeconds: p.apiLatencySeconds, savedAugments: p.savedAugments, coreCurrency: "exalted", rememberCurrency: false, rememberListingType: false } as any;
}

function displayName(item: any) {
  const base = item.info?.name || "";
  const name = item.rarity === ItemRarity.Unique ? (base || item.name || item.info?.refName || "")
    : (item.name && item.name !== base ? `${item.name} ${base}`.trim() : (item.name || base));
  return String(name).slice(0, 60);
}

function build(raw: string, p: any) {
  if (p.language !== "en") return { error: { stage: "lang" } };
  const parsed = parseClipboard(raw);
  if (!parsed.isOk()) return { error: { stage: "parse", message: String(parsed.error) } };
  const item = parsed.value;
  let presets;
  try {
    presets = createPresets(item, { league: p.leagueId, currency: undefined, listingType: undefined, collapseListings: p.collapseListings, activateStockFilter: p.activateStockFilter,
      searchStatRange: p.searchStatRange, useEn: (p.language === "cmn-Hant" && p.realm === "pc-ggg") || p.preferredTradeSite === "www", defaultAllSelected: p.defaultAllSelected });
  } catch (e: any) { return { error: { stage: "presets", message: String(e?.message || e) } }; }
  const active = presets.presets.find((x) => x.id === presets.active) || presets.presets[0];
  if (!active) return { error: { stage: "presets", message: "no preset" } };
  if (apiToSatisfySearch(item, active.stats, active.filters) === "bulk") return { error: { stage: "currency" } };
  try { return { q: JSON.stringify(createTradeRequest(active.filters, active.stats, item)), name: displayName(item) }; }
  catch (e: any) { return { error: { stage: "request", message: String(e?.message || e) } }; }
}

describe("arbiter goldens", () => {
  const files = fs.readdirSync(path.join(FIX, "items")).filter((f) => f.endsWith(".txt")).sort();
  for (const variant of PREFS_VARIANTS) {
    const p = { ...DEFAULTS, ...variant };
    it(`variant ${variant.id}`, async () => {
      setupTests({ language: p.language as any, realm: p.realm as any, preferredTradeSite: p.preferredTradeSite as any, leagueId: p.leagueId, widgets: [widgetFor(p)] } as any);
      await init("en");
      if (!TRADE_ITEM_BY_REF) throw new Error("trade data not loaded");
      fs.mkdirSync(OUT, { recursive: true });
      for (const f of files) {
        const raw = fs.readFileSync(path.join(FIX, "items", f), "utf8");
        const { id, ...prefs } = variant;
        const r = build(raw, p);
        fs.writeFileSync(path.join(OUT, `${f.replace(/\.txt$/, "")}__${variant.id}.json`), JSON.stringify({ fixture: f, prefs, ...r }, null, 1) + "\n");
      }
    }, 60_000);
  }
});
