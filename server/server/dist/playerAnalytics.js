import { attachRatings } from "./rating.js";
export function parsePeriod(q) {
    const fromS = typeof q.from === "string" ? q.from : null;
    const toS = typeof q.to === "string" ? q.to : null;
    const from = fromS ? new Date(fromS) : null;
    const to = toS ? new Date(toS) : null;
    if (from && Number.isNaN(from.getTime()))
        return { from: null, to: null };
    if (to && Number.isNaN(to.getTime()))
        return { from: null, to: null };
    return { from, to };
}
export async function tournamentResultsInPeriod(prisma, userId, period) {
    return prisma.tournamentResult.findMany({
        where: {
            userId,
            ...(period.from || period.to
                ? {
                    tournament: {
                        startsAt: {
                            ...(period.from ? { gte: period.from } : {}),
                            ...(period.to ? { lte: period.to } : {})
                        }
                    }
                }
                : {})
        },
        include: { tournament: true }
    });
}
export async function leaderboardRows(prisma) {
    const users = await prisma.user.findMany({
        select: {
            id: true,
            telegramUsername: true,
            wins: true,
            losses: true,
            totalChipsWon: true,
            ratingPlacementPoints: true
        }
    });
    const rated = attachRatings(users);
    rated.sort((a, b) => b.rating - a.rating);
    return rated;
}
export async function userTournamentMetrics(prisma, userId, period) {
    const results = await tournamentResultsInPeriod(prisma, userId, period);
    const n = results.length;
    if (n === 0) {
        return {
            tournamentsPlayed: 0,
            tournamentsWon: 0,
            winPct: null,
            avgPlace: null,
            itmPct: null
        };
    }
    const wins = results.filter((r) => r.place === 1).length;
    const sumPlace = results.reduce((s, r) => s + r.place, 0);
    const itm = results.filter((r) => r.place <= 3).length;
    return {
        tournamentsPlayed: n,
        tournamentsWon: wins,
        winPct: Math.round((1000 * wins) / n) / 10,
        avgPlace: Math.round((100 * sumPlace) / n) / 100,
        itmPct: Math.round((1000 * itm) / n) / 10
    };
}
export async function preflopSkillMetrics(prisma, userId, period) {
    const actions = await prisma.analyticsPreflopAction.findMany({
        where: {
            userId,
            ...(period.from || period.to
                ? {
                    tournament: {
                        startsAt: {
                            ...(period.from ? { gte: period.from } : {}),
                            ...(period.to ? { lte: period.to } : {})
                        }
                    }
                }
                : {})
        }
    });
    if (actions.length === 0) {
        return {
            pfrPct: null,
            threeBetPct: null,
            callFacingPct: null,
            sampleSize: 0
        };
    }
    const firstIn = actions.filter((a) => !a.facingBet);
    const facing = actions.filter((a) => a.facingBet);
    const raisesFirstIn = firstIn.filter((a) => a.action === "RAISE").length;
    const threeBetCount = actions.filter((a) => a.isThreeBet).length;
    const callsFacing = facing.filter((a) => a.action === "CALL").length;
    const pfrPct = firstIn.length > 0 ? Math.round((1000 * raisesFirstIn) / firstIn.length) / 10 : null;
    const threeBetPct = actions.length > 0 ? Math.round((1000 * threeBetCount) / actions.length) / 10 : null;
    const callFacingPct = facing.length > 0 ? Math.round((1000 * callsFacing) / facing.length) / 10 : null;
    return { pfrPct, threeBetPct, callFacingPct, sampleSize: actions.length };
}
export function compareTip(key, userVal, refAvg) {
    if (userVal == null || refAvg == null)
        return null;
    const diff = userVal - refAvg;
    if (key === "avgPlace") {
        if (userVal > refAvg + 0.35) {
            return "Среднее место хуже, чем у группы. Уделите внимание выживанию на ранних уровнях и финальному столу.";
        }
        return null;
    }
    if (key === "pfrPct" && diff < -8) {
        return "Игроки с высоким рейтингом чаще открывают префлоп-рейзом. Попробуйте добавить открытия с поздних позиций.";
    }
    if (key === "tournamentWinPct" && diff < -5 && userVal < 15) {
        return "Процент побед в турнирах ниже среднего по выбранной группе — поработайте над ICM и финальными столами.";
    }
    if (key === "itmPct" && diff < -8) {
        return "Реже попадаете в призы. Проверьте дисциплину на ранних уровнях и выбор рук.";
    }
    if (key === "threeBetPct" && diff > 10) {
        return "Частый трёхбет без результата может стоить дорого. Сужайте диапазон 3-бета.";
    }
    return null;
}
