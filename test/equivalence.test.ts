import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deliveriesSince } from "../src/clock.ts";
import { openDatabase } from "../src/db.ts";
import { listCreators } from "../src/list-creators.ts";
import { CAMPAIGN_ID, seed } from "../src/seed.ts";
import { referenceListCreators } from "./reference-list-creators.ts";

const LIMITS = [1, 7, 20, 50];

function offsetsFor(total: number): number[] {
  const candidates = [0, 1, 19, 20, total - 1, total, total + 50];
  return [...new Set(candidates.filter((offset) => offset >= 0))];
}

async function expectSamePages(db: DatabaseSync, campaignId: string): Promise<number> {
  const whole = await referenceListCreators(db, { campaignId, limit: 1, offset: 0 });
  const total = whole?.total ?? 0;
  let compared = 0;
  for (const limit of LIMITS) {
    for (const offset of offsetsFor(total)) {
      const input = { campaignId, limit, offset };
      const expected = JSON.stringify(await referenceListCreators(db, input));
      const actual = JSON.stringify(await listCreators(db, input));
      expect(actual, `limit=${limit} offset=${offset}`).toBe(expected);
      compared += 1;
    }
  }
  return compared;
}

function lcg(seedValue: number): () => number {
  let state = seedValue;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Dados feitos para empatar: poucos valores de views e de captured_at, ids
// inseridos fora de ordem, nichos repetidos, criadores sem conta, contas sem
// métrica e entregas em volta do limite de 90 dias.
function seedTies(db: DatabaseSync, creators: number, seedValue: number): void {
  const rand = lcg(seedValue);
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)] as T;
  const nicheSets = [
    ["beleza"],
    ["moda"],
    ["beleza", "moda"],
    ["beleza", "beleza"],
    ["games"],
    ["moda", "tech", "beleza"],
    [],
  ];
  const capturedAts = ["2026-05-30T00:00:00.000Z", "2026-05-29T00:00:00.000Z"];
  const views = [0, 10, 20];
  const since = Date.parse(deliveriesSince());
  const deliveredAts = [since - 1, since, since + 1, since + 86_400_000].map((ms) =>
    new Date(ms).toISOString(),
  );

  const insertCreator = db.prepare("INSERT INTO creators VALUES (?, ?, ?, '')");
  const insertAccount = db.prepare("INSERT INTO social_accounts VALUES (?, ?, 'instagram')");
  const insertMetric = db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, '')");
  const insertDelivery = db.prepare("INSERT INTO deliveries VALUES (?, ?, ?)");

  const order = Array.from({ length: creators }, (_, index) => index);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }

  db.exec("BEGIN");
  db.prepare("INSERT INTO campaigns VALUES ('cmp_ties', 'Empates', ?)").run(
    JSON.stringify(["beleza", "moda", "beleza"]),
  );
  for (const index of order) {
    const creatorId = `crt_${String(index).padStart(4, "0")}`;
    insertCreator.run(creatorId, `Criador ${index}`, JSON.stringify(pick(nicheSets)));

    const accountCount = Math.floor(rand() * 4);
    for (let accountIndex = 0; accountIndex < accountCount; accountIndex += 1) {
      const accountId = `acc_${creatorId}_${accountIndex}`;
      insertAccount.run(accountId, creatorId);
      const metricCount = Math.floor(rand() * 4);
      // Ids decrescentes: a ordem de inserção é o contrário do desempate.
      for (let metricIndex = metricCount - 1; metricIndex >= 0; metricIndex -= 1) {
        insertMetric.run(`met_${accountId}_${metricIndex}`, accountId, pick(views), pick(capturedAts));
      }
    }

    const deliveryCount = Math.floor(rand() * 4);
    for (let deliveryIndex = 0; deliveryIndex < deliveryCount; deliveryIndex += 1) {
      insertDelivery.run(`del_${creatorId}_${deliveryIndex}`, creatorId, pick(deliveredAts));
    }
  }
  db.exec("COMMIT");
}

describe("equivalência com a implementação original", () => {
  it.each([0, 1, 80, 600, 2000])("mesmo JSON no seed do desafio com %i criadores", async (creators) => {
    const db = openDatabase(":memory:");
    seed(db, { creators, seed: 7 });
    expect(await expectSamePages(db, CAMPAIGN_ID)).toBeGreaterThan(0);
  });

  it.each([1, 2, 3])("mesmo JSON com empates de métrica, de alcance e de id (semente %i)", async (seedValue) => {
    const db = openDatabase(":memory:");
    seedTies(db, 400, seedValue);
    expect(await expectSamePages(db, "cmp_ties")).toBeGreaterThan(0);
  });

  it("os dados de empate têm de fato os casos que o teste promete", () => {
    const db = openDatabase(":memory:");
    seedTies(db, 400, 1);
    const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    expect(
      count("SELECT COUNT(*) AS n FROM creators c WHERE NOT EXISTS (SELECT 1 FROM social_accounts a WHERE a.creator_id = c.id)"),
    ).toBeGreaterThan(0);
    expect(
      count("SELECT COUNT(*) AS n FROM social_accounts a WHERE NOT EXISTS (SELECT 1 FROM metrics m WHERE m.account_id = a.id)"),
    ).toBeGreaterThan(0);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM metrics
            GROUP BY account_id, captured_at
           HAVING COUNT(*) > 1 AND COUNT(DISTINCT views) > 1
              AND captured_at = (SELECT MAX(m.captured_at) FROM metrics m WHERE m.account_id = metrics.account_id))`,
      ),
    ).toBeGreaterThan(0);
  });

  it("campanha inexistente devolve null nas duas", async () => {
    const db = openDatabase(":memory:");
    seed(db, { creators: 5, seed: 7 });
    const input = { campaignId: "cmp_missing", limit: 20, offset: 0 };
    expect(await listCreators(db, input)).toBeNull();
    expect(await referenceListCreators(db, input)).toBeNull();
  });
});
