import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type LatestViewsRow = { creator_id: string; views: number | null };
type DeliveryCountRow = { creator_id: string; n: number };

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT id, niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  // Sem raw_payload: só o que o score e a resposta usam.
  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const scored: CreatorMatch[] = [];
  const byId = new Map<string, CreatorMatch>();

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    const match: CreatorMatch = {
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: 0,
      deliveries_90d: 0,
    };
    scored.push(match);
    byId.set(match.id, match);
  }

  // O alcance entra na ordenação, então precisa de todos os compatíveis:
  // uma linha por conta deles, com a métrica mais recente (null se não houver).
  // O LIMIT 1 lê só a primeira entrada de idx_metrics_latest de cada conta.
  if (scored.length > 0) {
    const latest = await all<LatestViewsRow>(
      db,
      `SELECT a.creator_id AS creator_id,
              (SELECT m.views
                 FROM metrics m
                WHERE m.account_id = a.id
                ORDER BY m.captured_at DESC, m.id DESC
                LIMIT 1) AS views
         FROM social_accounts a
        WHERE a.creator_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(scored.map((match) => match.id)),
    );
    for (const row of latest) {
      const match = byId.get(row.creator_id);
      if (match && row.views !== null) match.latest_reach += row.views;
    }
  }

  scored.sort(compareCreators);
  const page = scored.slice(input.offset, input.offset + input.limit);

  // Entregas não entram na ordenação: conta só para quem está na página.
  if (page.length > 0) {
    const deliveries = await all<DeliveryCountRow>(
      db,
      `SELECT creator_id, COUNT(*) AS n
         FROM deliveries
        WHERE creator_id IN (SELECT value FROM json_each(?))
          AND delivered_at >= ?
        GROUP BY creator_id`,
      JSON.stringify(page.map((match) => match.id)),
      deliveriesSince(),
    );
    for (const row of deliveries) {
      const match = byId.get(row.creator_id);
      if (match) match.deliveries_90d = Number(row.n);
    }
  }

  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: page,
  };
}
