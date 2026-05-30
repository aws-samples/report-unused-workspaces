import { GetProductsCommand, PricingClient } from '@aws-sdk/client-pricing';
import { mockClient } from 'aws-sdk-client-mock';
import { fetchPriceTable } from '../src/handler/pricing';

const pricingMock = mockClient(PricingClient);

/** Builds a Pricing API product JSON string with a monthly OnDemand price. */
function product(
  bundleGroup: string,
  runningMode: 'AlwaysOn' | 'AutoStop',
  monthlyUsd: number,
  sku = `${bundleGroup}-${runningMode}-${monthlyUsd}`,
): string {
  return JSON.stringify({
    product: {
      productFamily: 'WorkSpaces Core',
      attributes: { bundleGroup, runningMode },
      sku,
    },
    terms: {
      OnDemand: {
        [`${sku}.JRTCKXETXF`]: {
          priceDimensions: {
            [`${sku}.JRTCKXETXF.6YS6EN2CT7`]: {
              unit: 'Month',
              pricePerUnit: { USD: monthlyUsd.toFixed(10) },
            },
          },
        },
      },
    },
  });
}

beforeEach(() => pricingMock.reset());

describe('fetchPriceTable', () => {
  test('maps bundle groups and running modes to a price table', async () => {
    pricingMock.on(GetProductsCommand).resolves({
      PriceList: [
        product('Standard', 'AlwaysOn', 35),
        product('Standard', 'AutoStop', 9.75),
        product('Power', 'AlwaysOn', 78),
      ],
    });

    const table = await fetchPriceTable(new PricingClient({}), 'us-east-1');

    expect(table.STANDARD).toEqual({ alwaysOn: 35, autoStopBase: 9.75 });
    // Power has no AutoStop entry, so autoStopBase falls back to the AlwaysOn rate.
    expect(table.POWER).toEqual({ alwaysOn: 78, autoStopBase: 78 });
  });

  test('keeps the highest non-zero monthly price per compute type and mode', async () => {
    pricingMock.on(GetProductsCommand).resolves({
      PriceList: [
        product('Standard', 'AlwaysOn', 0), // $0 SKU ignored
        product('Standard', 'AlwaysOn', 29),
        product('Standard', 'AlwaysOn', 40), // highest wins
        product('Standard', 'AutoStop', 9.75),
      ],
    });

    const table = await fetchPriceTable(new PricingClient({}), 'us-east-1');
    expect(table.STANDARD).toEqual({ alwaysOn: 40, autoStopBase: 9.75 });
  });

  test('ignores standby/storage/unknown bundle groups', async () => {
    pricingMock.on(GetProductsCommand).resolves({
      PriceList: [
        product('Standard Standby', 'AlwaysOn', 5),
        product('Storage', 'AlwaysOn', 3),
        product('Standard', 'AlwaysOn', 35),
        product('Standard', 'AutoStop', 9),
      ],
    });

    const table = await fetchPriceTable(new PricingClient({}), 'us-east-1');
    expect(Object.keys(table)).toEqual(['STANDARD']);
  });

  test('follows pagination via NextToken', async () => {
    pricingMock
      .on(GetProductsCommand, { NextToken: undefined })
      .resolves({
        PriceList: [product('Standard', 'AlwaysOn', 35), product('Standard', 'AutoStop', 9.75)],
        NextToken: 'page2',
      })
      .on(GetProductsCommand, { NextToken: 'page2' })
      .resolves({
        PriceList: [product('Power', 'AlwaysOn', 78), product('Power', 'AutoStop', 19)],
      });

    const table = await fetchPriceTable(new PricingClient({}), 'us-east-1');
    expect(table.STANDARD).toEqual({ alwaysOn: 35, autoStopBase: 9.75 });
    expect(table.POWER).toEqual({ alwaysOn: 78, autoStopBase: 19 });
    expect(pricingMock.commandCalls(GetProductsCommand)).toHaveLength(2);
  });

  test('skips malformed price-list entries without throwing', async () => {
    pricingMock.on(GetProductsCommand).resolves({
      PriceList: ['{not valid json', product('Standard', 'AlwaysOn', 35), product('Standard', 'AutoStop', 9)],
    });

    const table = await fetchPriceTable(new PricingClient({}), 'us-east-1');
    expect(table.STANDARD).toEqual({ alwaysOn: 35, autoStopBase: 9 });
  });
});
