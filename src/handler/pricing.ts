import {
  GetProductsCommand,
  PricingClient,
} from '@aws-sdk/client-pricing';
import type { ComputePrice, PriceTable } from './index';

/**
 * Builds a {@link PriceTable} from the AWS Price List (Pricing) API for Amazon
 * WorkSpaces, so the FinOps savings view reflects real list prices instead of
 * hard-coded estimates.
 *
 * Design notes:
 *  - The Pricing API is only served from a few Regions (us-east-1, ap-south-1,
 *    eu-central-1). Always create the client against one of those; the Region
 *    whose prices we want is passed as the `regionCode` filter, not the client
 *    Region.
 *  - WorkSpaces monthly price varies by OS, license, and storage within a
 *    single bundle group. We collapse that by taking the highest non-zero
 *    monthly price per (compute type, running mode) as a conservative
 *    "up to" estimate of the savings opportunity.
 *  - Anything we cannot map or price is simply omitted; the caller layers this
 *    over DEFAULT_PRICES, so missing entries fall back gracefully.
 */

/** Region that hosts the Pricing API endpoint we call. */
export const PRICING_API_REGION = 'us-east-1';

/** Maps Pricing API `bundleGroup` values to SDK `ComputeTypeName` keys. */
const BUNDLE_GROUP_TO_COMPUTE_TYPE: Record<string, string> = {
  VALUE: 'VALUE',
  STANDARD: 'STANDARD',
  PERFORMANCE: 'PERFORMANCE',
  POWER: 'POWER',
  POWERPRO: 'POWERPRO',
  GRAPHICS: 'GRAPHICS',
  GRAPHICSPRO: 'GRAPHICSPRO',
  'GRAPHICS.G4DN': 'GRAPHICS_G4DN',
  'GRAPHICSPRO.G4DN': 'GRAPHICSPRO_G4DN',
};

interface PricingProduct {
  product?: {
    attributes?: {
      bundleGroup?: string;
      runningMode?: string;
    };
  };
  terms?: {
    OnDemand?: Record<
      string,
      {
        priceDimensions?: Record<
          string,
          { unit?: string; pricePerUnit?: { USD?: string } }
        >;
      }
    >;
  };
}

/** Accumulator: compute type -> { alwaysOn?, autoStop? } highest monthly price. */
type Accumulator = Record<string, { alwaysOn?: number; autoStop?: number }>;

/**
 * Fetches WorkSpaces list prices for the given Region and returns a price table
 * keyed by `ComputeTypeName`. Throws on API failure so the caller can decide to
 * fall back to configured/default prices.
 */
export async function fetchPriceTable(
  client: PricingClient,
  regionCode: string,
): Promise<PriceTable> {
  const acc: Accumulator = {};
  let nextToken: string | undefined;

  do {
    const resp = await client.send(
      new GetProductsCommand({
        ServiceCode: 'AmazonWorkSpaces',
        Filters: [
          { Type: 'TERM_MATCH', Field: 'regionCode', Value: regionCode },
          { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'WorkSpaces Core' },
        ],
        NextToken: nextToken,
      }),
    );

    for (const raw of resp.PriceList ?? []) {
      accumulate(acc, raw as string);
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  return finalize(acc);
}

/** Parses a single price-list JSON string and folds it into the accumulator. */
function accumulate(acc: Accumulator, raw: string): void {
  let product: PricingProduct;
  try {
    product = JSON.parse(raw) as PricingProduct;
  } catch {
    return;
  }

  const attrs = product.product?.attributes;
  const groupKey = attrs?.bundleGroup?.toUpperCase();
  const computeType = groupKey ? BUNDLE_GROUP_TO_COMPUTE_TYPE[groupKey] : undefined;
  if (!computeType) return; // Standby/Storage/unknown groups are ignored.

  const monthly = monthlyPrice(product);
  if (monthly === undefined || monthly <= 0) return;

  const slot = (acc[computeType] ??= {});
  if (attrs?.runningMode === 'AutoStop') {
    slot.autoStop = Math.max(slot.autoStop ?? 0, monthly);
  } else {
    // Treat AlwaysOn (and anything else) as the flat monthly rate.
    slot.alwaysOn = Math.max(slot.alwaysOn ?? 0, monthly);
  }
}

/** Extracts the OnDemand monthly USD price from a product, if present. */
function monthlyPrice(product: PricingProduct): number | undefined {
  const onDemand = product.terms?.OnDemand;
  if (!onDemand) return undefined;

  let best: number | undefined;
  for (const term of Object.values(onDemand)) {
    for (const dim of Object.values(term.priceDimensions ?? {})) {
      if (dim.unit !== 'Month') continue;
      const usd = Number(dim.pricePerUnit?.USD);
      if (Number.isFinite(usd)) {
        best = best === undefined ? usd : Math.max(best, usd);
      }
    }
  }
  return best;
}

/** Converts the accumulator into a PriceTable, requiring at least one price. */
function finalize(acc: Accumulator): PriceTable {
  const table: PriceTable = {};
  for (const [computeType, slot] of Object.entries(acc)) {
    const alwaysOn = slot.alwaysOn ?? slot.autoStop;
    const autoStopBase = slot.autoStop ?? slot.alwaysOn;
    if (alwaysOn === undefined || autoStopBase === undefined) continue;
    const price: ComputePrice = { alwaysOn, autoStopBase };
    table[computeType] = price;
  }
  return table;
}
