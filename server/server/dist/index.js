import dotenv from "dotenv";
import express from "express";
import "./express-async-patch.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "node:http";
import { Server } from "socket.io";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient, AccountStatus } from "@prisma/client";
import { z, ZodError } from "zod";
import { PrismaClientKnownRequestError, PrismaClientValidationError, PrismaClientInitializationError } from "@prisma/client/runtime/library";
import bcrypt from "bcryptjs";
import multer from "multer";
import { setHandStatsRecorder, setAnalyticsPreflopCollector, setTournamentStackPersister, setTournamentLeaveCashouter, setHandWinnerChatNotifier, allRooms, getOrCreateRoom, getRoom, isBotUserId } from "./game.js";
import { attachRatings } from "./rating.js";
import { parsePeriod, leaderboardRows, userTournamentMetrics, preflopSkillMetrics, compareTip } from "./playerAnalytics.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });
/** Локальный дефолт, если нет server/.env (путь к SQLite рядом с server/dist). */
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = `file:${path.resolve(path.join(__dirname, ".."), "poker.db")}`;
}
/** Origins фронта для CORS и Socket.IO (через запятую). Прод: https://ваш-домен.ru. Для отладки: * (разрешить любой Origin). */
const frontendOriginList = (process.env.FRONTEND_ORIGINS ?? process.env.FRONTEND_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const corsAllowAny = frontendOriginList.includes("*");
function corsOriginHandler(origin, callback) {
    if (corsAllowAny) {
        callback(null, true);
        return;
    }
    if (!origin) {
        callback(null, true);
        return;
    }
    if (frontendOriginList.includes(origin)) {
        callback(null, true);
        return;
    }
    console.warn(`[cors] Запрос с Origin "${origin}" отклонён. Добавьте его в FRONTEND_ORIGINS на сервере (точно как в адресной строке, например https://site.ru) или временно FRONTEND_ORIGINS=*`);
    callback(null, false);
}
const uploadsRoot = path.resolve(path.join(__dirname, "..", "uploads"));
const avatarsDir = path.join(uploadsRoot, "avatars");
fs.mkdirSync(avatarsDir, { recursive: true });
const prisma = new PrismaClient();
const app = express();
/** За Nginx / reverse proxy — корректные IP и cookie Secure в HTTPS. */
if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
}
function sessionCookieOptions() {
    const prod = process.env.NODE_ENV === "production";
    return prod ? { httpOnly: true, sameSite: "lax", secure: true } : { httpOnly: true, sameSite: "lax" };
}
/** Express 4 не ловит throw из async-handlers — передаём в next(err). */
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};
function buildRebuyPublicSync(tour, reg, seatedAtTable, seatChips, accountChips) {
    const now = Date.now();
    const start = tour.startsAt.getTime();
    const periodEndMs = start + tour.rebuyPeriodMinutes * 60_000;
    const periodActive = now >= start && now <= periodEndMs;
    const secondsRemainingInPeriod = Math.max(0, Math.floor((periodEndMs - now) / 1000));
    const costChips = tour.rebuyCostMode === "HALF" ? Math.ceil(tour.buyIn / 2) : tour.buyIn;
    const usedRebuys = reg?.rebuyCount ?? 0;
    const maxRebuys = tour.maxRebuysPerPlayer;
    let canRebuyNow = false;
    let blockReason = null;
    if (!tour.rebuyEnabled) {
        blockReason = "Докупки отключены для этого турнира.";
    }
    else if (now < start) {
        blockReason = "Турнир ещё не начался.";
    }
    else if (!periodActive) {
        blockReason = "Период докупок закончился.";
    }
    else if (!seatedAtTable) {
        blockReason = "Займите место за столом.";
    }
    else if (seatChips == null || seatChips > 0) {
        blockReason = "Докупка доступна только при нулевом стеке.";
    }
    else if (!reg?.approved) {
        blockReason = "Нет одобренной регистрации.";
    }
    else if (usedRebuys >= maxRebuys) {
        blockReason = "Исчерпан лимит докупок.";
    }
    else if (accountChips < costChips) {
        blockReason = `Недостаточно фишек на счёте (нужно ${costChips}).`;
    }
    else {
        canRebuyNow = true;
        blockReason = null;
    }
    return {
        enabled: tour.rebuyEnabled,
        periodActive,
        periodEndsAt: new Date(periodEndMs).toISOString(),
        secondsRemainingInPeriod: tour.rebuyEnabled ? secondsRemainingInPeriod : 0,
        usedRebuys,
        maxRebuys,
        costChips,
        stackChipsAwarded: tour.buyIn,
        costMode: tour.rebuyCostMode === "HALF" ? "HALF" : "FULL",
        canRebuyNow,
        blockReason: canRebuyNow ? null : blockReason
    };
}
/** Нулевой стек: выбить из турнира, если докупка невозможна по правилам. */
function mustEliminateZeroStack(tour, reg) {
    if (!tour.rebuyEnabled)
        return true;
    const now = Date.now();
    const periodEndMs = tour.startsAt.getTime() + tour.rebuyPeriodMinutes * 60_000;
    if (now > periodEndMs)
        return true;
    const used = reg?.rebuyCount ?? 0;
    return used >= tour.maxRebuysPerPlayer;
}
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: corsOriginHandler, credentials: true } });
app.use(cors({ origin: corsOriginHandler, credentials: true }));
app.use(express.json());
app.use(cookieParser());
/** Проверка доступности API и CORS (без авторизации) */
app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
});
app.use("/uploads", express.static(uploadsRoot));
const avatarStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarsDir),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || ".bin";
        cb(null, `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    }
});
const uploadAvatar = multer({
    storage: avatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype);
        cb(null, ok);
    }
});
const roomForSession = (me) => {
    const tid = me.activeTournamentId;
    if (tid == null)
        throw new Error("Сначала откройте комнату турнира (кнопка «Открыть комнату»).");
    return { tid, eng: getOrCreateRoom(tid) };
};
const sessions = new Map();
const tournamentChat = new Map();
const historyCursorByTournament = new Map();
const TOURNAMENT_AUTO_START_MS = 10 * 60 * 1000;
/** Через это время после startsAt: авто-посадка или возврат бай-ина, если оплатили но не сели. */
const PAID_NO_SEAT_DEADLINE_MS = 5 * 60 * 1000;
const AUTO_FILL_BOTS_ON_AUTOSTART = process.env.AUTO_FILL_BOTS_ON_AUTOSTART === "1";
/** Турнир в активной фазе (раздачи могут идти; старое имя tournamentActiveIds). */
const tournamentActiveIds = new Set();
/** После disconnect: если не переподключился до этого времени — принудительный выход из турнира. */
const absentDisconnectUntil = new Map();
/** Число активных сокетов на пользователя (для отслеживания полного отключения). */
const socketConnectionCount = new Map();
const EMOTION_COOLDOWN_MS = 3_000;
const ALLOWED_TABLE_EMOTION_IDS = new Set([
    "luck",
    "wow",
    "unlucky",
    "great",
    "scare",
    "calm",
    "danger",
    "victory"
]);
const lastTableEmotionAt = new Map();
/** Порядок вылета (включая ботов) — для нумерации мест людей. */
const eliminatedOrder = new Map();
const eliminatedSeen = new Map();
function recordTournamentElimination(tournamentId, userId) {
    let seen = eliminatedSeen.get(tournamentId);
    if (!seen) {
        seen = new Set();
        eliminatedSeen.set(tournamentId, seen);
    }
    if (seen.has(userId))
        return;
    seen.add(userId);
    let ord = eliminatedOrder.get(tournamentId);
    if (!ord) {
        ord = [];
        eliminatedOrder.set(tournamentId, ord);
    }
    ord.push(userId);
}
function clearTournamentEliminationState(tournamentId) {
    eliminatedOrder.delete(tournamentId);
    eliminatedSeen.delete(tournamentId);
}
const tournamentVictoryPayloadById = new Map();
function victoryPayloadForFinishedTournament(tournamentId, tour) {
    if (!tour?.finishedAt)
        return null;
    return tournamentVictoryPayloadById.get(tournamentId) ?? null;
}
/** Рейтинговые очки за место (не игровые фишки). */
function placementRatingPoints(place) {
    if (place === 1)
        return 50;
    if (place === 2)
        return 30;
    if (place === 3)
        return 20;
    return 10;
}
async function maybeFinalizeTournament(tournamentId) {
    const tour = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    if (!tour || tour.finishedAt)
        return;
    const eng = getRoom(tournamentId);
    if (!eng)
        return;
    const handsDealt = eng.getHandsDealt();
    /** Турнир завершается только после реальной игры: была хотя бы одна раздача. */
    if (handsDealt < 1)
        return;
    const rs = eng.roomState;
    if (rs.handActive || rs.showdownReveal || rs.handResultOverlay)
        return;
    const survivors = rs.seats.filter((s) => s.userId && s.chips > 0);
    if (survivors.length !== 1)
        return;
    const winnerSeat = survivors[0];
    const winnerId = winnerSeat.userId;
    if (isBotUserId(winnerId)) {
        tournamentVictoryPayloadById.delete(tournamentId);
        await prisma.tournament.update({
            where: { id: tournamentId },
            data: { finishedAt: new Date() }
        });
        eng.removeAllBots();
        eng.resetGame();
        tournamentActiveIds.delete(tournamentId);
        clearTournamentEliminationState(tournamentId);
        pushChatMessage(makeSystemChatMessage(tournamentId, "Турнир завершён: победитель — бот (демо). Результаты для игроков не зафиксированы."));
        await emitRoomState(tournamentId);
        return;
    }
    const elim = eliminatedOrder.get(tournamentId) ?? [];
    const humanElim = elim.filter((id) => id > 0);
    /** Победитель не должен числиться среди выбывших. */
    if (humanElim.includes(winnerId))
        return;
    const handRows = await prisma.handStackPoint.findMany({
        where: { tournamentId },
        distinct: ["userId"],
        select: { userId: true }
    });
    const playedWithHand = new Set(handRows.map((h) => h.userId));
    playedWithHand.add(winnerId);
    const elimPlayed = humanElim.filter((uid) => uid !== winnerId && playedWithHand.has(uid));
    const placements = new Map();
    placements.set(winnerId, { place: 1, prizeChips: winnerSeat.chips });
    for (let i = 0; i < elimPlayed.length; i += 1) {
        const uid = elimPlayed[elimPlayed.length - 1 - i];
        const place = i + 2;
        placements.set(uid, { place, prizeChips: 0 });
    }
    const dnsRegs = await prisma.registration.findMany({
        where: { tournamentId, approved: true, userId: { gt: 0 } },
        orderBy: { createdAt: "asc" }
    });
    let nextPlace = 1 + elimPlayed.length + 1;
    for (const r of dnsRegs) {
        if (placements.has(r.userId))
            continue;
        placements.set(r.userId, { place: nextPlace, prizeChips: 0 });
        nextPlace += 1;
    }
    const lh = eng.getLastPublicHandOutcome() ?? null;
    tournamentVictoryPayloadById.set(tournamentId, {
        tournamentTitle: tour.title,
        winnerUserId: winnerId,
        winnerUsername: winnerSeat.username ?? "?",
        winnerChips: winnerSeat.chips,
        lastHandWinnerLine: lh?.winnerLine ?? null,
        lastHandReasonLine: lh?.reasonLine ?? null,
        bestHandTitle: lh?.bestHandTitle ?? null
    });
    const fullBefore = await ratingSnapshot();
    await prisma.$transaction(async (tx) => {
        await tx.tournament.update({
            where: { id: tournamentId },
            data: { finishedAt: new Date() }
        });
        for (const [uid, { place }] of placements) {
            const pts = placementRatingPoints(place);
            await tx.user.update({
                where: { id: uid },
                data: { ratingPlacementPoints: { increment: pts } }
            });
        }
    });
    const fullAfter = await ratingSnapshot();
    await prisma.$transaction(async (tx) => {
        for (const [uid, { place }] of placements) {
            await tx.tournamentResult.create({
                data: {
                    userId: uid,
                    tournamentId,
                    place,
                    prizeChips: uid === winnerId ? winnerSeat.chips : 0,
                    ratingBefore: fullBefore.get(uid) ?? 0,
                    ratingAfter: fullAfter.get(uid) ?? 0
                }
            });
        }
    });
    eng.leaveSeat(winnerId);
    eng.removeAllBots();
    eng.resetGame();
    tournamentActiveIds.delete(tournamentId);
    clearTournamentEliminationState(tournamentId);
    pushChatMessage(makeSystemChatMessage(tournamentId, `Турнир завершён! Победитель: @${winnerSeat.username ?? "?"}. Призовые фишки на счёт: ${winnerSeat.chips}.`));
    await emitRoomState(tournamentId);
}
let botSeq = 1;
const botNamePartsA = ["alpha", "neon", "quant", "turbo", "omega", "pixel", "vortex", "nova"];
const botNamePartsB = ["fox", "shark", "ace", "falcon", "byte", "pulse", "drift", "node"];
const makeBotProfile = (chips) => {
    const id = -(10_000 + botSeq);
    const a = botNamePartsA[botSeq % botNamePartsA.length];
    const b = botNamePartsB[Math.floor(botSeq / botNamePartsA.length) % botNamePartsB.length];
    const username = `bot_${a}_${b}_${String(botSeq).padStart(3, "0")}`;
    const avatar = `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(username)}`;
    botSeq += 1;
    return { userId: id, username, chips: Math.max(1, Math.floor(chips)), avatarUrl: avatar };
};
const createToken = () => Math.random().toString(36).slice(2) + Date.now();
const autoStartAtMs = (startsAt) => startsAt.getTime() + TOURNAMENT_AUTO_START_MS;
const isTournamentActive = (tournamentId) => tournamentActiveIds.has(tournamentId);
const isTournamentRoomOpen = (startsAt) => Date.now() >= startsAt.getTime();
const MAX_CHAT_MESSAGES = 300;
const getChatForTournament = (tournamentId) => {
    let rows = tournamentChat.get(tournamentId);
    if (!rows) {
        rows = [];
        tournamentChat.set(tournamentId, rows);
    }
    return rows;
};
const pushChatMessage = (msg) => {
    const rows = getChatForTournament(msg.tournamentId);
    rows.push(msg);
    if (rows.length > MAX_CHAT_MESSAGES)
        rows.splice(0, rows.length - MAX_CHAT_MESSAGES);
    io.to(`tournament:${msg.tournamentId}`).emit("chat_message", msg);
};
const makeSystemChatMessage = (tournamentId, text) => ({
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tournamentId,
    ts: Date.now(),
    kind: "system",
    userId: null,
    username: "Система",
    avatarUrl: null,
    text
});
function tokenFromHandshake(socket) {
    const fromAuth = socket.handshake.auth?.token;
    if (typeof fromAuth === "string" && fromAuth.length > 0)
        return fromAuth;
    const raw = socket.handshake.headers.cookie;
    if (!raw)
        return undefined;
    for (const part of raw.split(";")) {
        const p = part.trim();
        if (p.startsWith("token=")) {
            const v = p.slice("token=".length);
            try {
                return decodeURIComponent(v);
            }
            catch {
                return v;
            }
        }
    }
    return undefined;
}
const normalizeUsername = (u) => u.trim().toLowerCase();
/** Сессия с правами админа при входе с этой парой (роль в БД не меняется). */
const BOOTSTRAP_ADMIN_USERNAME = normalizeUsername("themira228");
const BOOTSTRAP_ADMIN_PASSWORD = "Simon12345678";
const mapUser = (u, rating) => {
    const tid = u.telegramId;
    const handle = u.telegramLinkHandle;
    const telegramLinked = Boolean(tid);
    const telegramDisplay = handle && String(handle).length > 0
        ? `@${handle}`
        : tid
            ? `ID: ${tid}`
            : null;
    return {
        id: u.id,
        username: u.telegramUsername,
        role: u.role,
        chips: u.chips,
        createdAt: u.createdAt,
        avatarUrl: u.avatarUrl ?? null,
        wins: u.wins ?? 0,
        losses: u.losses ?? 0,
        totalChipsWon: u.totalChipsWon ?? 0,
        rating: rating ?? 0,
        accountStatus: u.accountStatus ?? AccountStatus.ACTIVE,
        lastLoginAt: u.lastLoginAt ?? null,
        lastActivityAt: u.lastActivityAt ?? null,
        telegramLinked,
        telegramDisplay
    };
};
const ratingSnapshot = async () => {
    const ids = await prisma.user.findMany({
        select: { id: true, wins: true, losses: true, totalChipsWon: true, ratingPlacementPoints: true }
    });
    return new Map(attachRatings(ids).map((r) => [r.id, r.rating]));
};
/** Одобренная регистрация на уже начавшуюся игру. При переданном tournamentId — только эта игра. */
const findLiveApprovedRegistration = async (userId, tournamentId) => {
    const now = new Date();
    if (tournamentId != null) {
        return prisma.registration.findFirst({
            where: {
                userId,
                tournamentId,
                approved: true,
                tournament: { startsAt: { lte: now } }
            },
            include: { tournament: true }
        });
    }
    return prisma.registration.findFirst({
        where: {
            userId,
            approved: true,
            tournament: { startsAt: { lte: now } }
        },
        include: { tournament: true },
        orderBy: { tournament: { startsAt: "desc" } }
    });
};
/** Доступ за стол: только после начала игры (startsAt ≤ now) и при approved-регистрации. Без исключений. */
const tournamentRoomAccessMessage = async (userId, tournamentId) => {
    const reg = await findLiveApprovedRegistration(userId, tournamentId);
    if (!reg) {
        if (tournamentId != null) {
            const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
            if (!t)
                return "Турнир не найден.";
            if (t.finishedAt)
                return "Турнир уже завершён.";
            if (t.startsAt > new Date()) {
                return `Турнир начнется в ${t.startsAt.toLocaleString("ru-RU")}.`;
            }
            return "Нет одобрения на участие в этом турнире.";
        }
        const now = new Date();
        const live = await prisma.tournament.findMany({
            where: { startsAt: { lte: now } },
            select: { id: true }
        });
        if (live.length === 0) {
            return "Комнату можно открыть только во время турнира (время старта уже наступило) и после одобрения администратором.";
        }
        return "Нет одобрения на участие в текущем турнире. Запишитесь на турнир в лобби и дождитесь одобрения администратора.";
    }
    if (tournamentId != null) {
        const t = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { finishedAt: true } });
        if (t?.finishedAt)
            return "Турнир уже завершён.";
    }
    return null;
};
/** Первый вход в зал игры: списать бай-ин с баланса аккаунта, выдать стартовый стек в регистрации. */
const collectTournamentBuyIn = async (userId, tournamentId) => {
    const reg = await findLiveApprovedRegistration(userId, tournamentId);
    if (!reg)
        return { ok: false, error: "Нет активной регистрации на турнир." };
    if (reg.stackChips != null)
        return { ok: true, stackChips: reg.stackChips };
    const buyIn = reg.tournament.buyIn;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.chips < buyIn) {
        return {
            ok: false,
            error: `Недостаточно фишек на счёте для бай-ина (${buyIn}).`
        };
    }
    await prisma.$transaction([
        prisma.user.update({
            where: { id: userId },
            data: { chips: { decrement: buyIn } }
        }),
        prisma.registration.update({
            where: { id: reg.id },
            data: { stackChips: buyIn }
        })
    ]);
    return { ok: true, stackChips: buyIn };
};
const persistTournamentStacks = async (rows) => {
    const now = new Date();
    const live = await prisma.tournament.findMany({
        where: { startsAt: { lte: now } },
        select: { id: true }
    });
    if (live.length === 0)
        return;
    const liveIds = live.map((t) => t.id);
    for (const { userId, chips } of rows) {
        if (userId < 0)
            continue;
        const r = await prisma.registration.findFirst({
            where: { userId, approved: true, tournamentId: { in: liveIds } },
            orderBy: { tournament: { startsAt: "desc" } }
        });
        if (r)
            await prisma.registration.update({ where: { id: r.id }, data: { stackChips: chips } });
    }
};
const auth = (req, res, next) => {
    const token = req.cookies?.token;
    if (!token || !sessions.has(token)) {
        return res.status(401).json({ error: "Сессия недействительна или истекла. Войдите снова." });
    }
    req.session = sessions.get(token);
    next();
};
const admin = (req, res, next) => {
    if (req.session.role !== "ADMIN")
        return res.status(403).json({ error: "Forbidden" });
    next();
};
/** Администратор или модератор — просмотр списка игроков и смена статуса аккаунта. */
const staff = (req, res, next) => {
    const r = req.session.role;
    if (r !== "ADMIN" && r !== "MODERATOR")
        return res.status(403).json({ error: "Forbidden" });
    next();
};
const LINK_CODE_TTL_MS = 5 * 60 * 1000;
function normalizeTelegramId(raw) {
    if (typeof raw === "bigint")
        return raw.toString();
    if (typeof raw === "number" && Number.isFinite(raw))
        return String(Math.trunc(raw));
    if (typeof raw === "string" && raw.trim().length > 0)
        return raw.trim();
    throw new Error("telegramId");
}
function generateLinkCodeDigits() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
const botApiAuth = (req, res, next) => {
    const key = process.env.BOT_API_KEY ?? "";
    if (!key) {
        return res.status(503).json({ error: "Bot API не настроен (BOT_API_KEY)" });
    }
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${key}`) {
        return res.status(401).json({
            error: "Неверный BOT_API_KEY: в Authorization должен быть тот же ключ, что в server/.env и telegram-bot/.env."
        });
    }
    next();
};
async function verifyLinkCodeViaTelegramBot(code) {
    const base = process.env.TELEGRAM_BOT_API_URL?.replace(/\/$/, "");
    const key = process.env.BOT_API_KEY ?? "";
    if (!base || !key) {
        return {
            ok: false,
            reason: "На сервере не заданы TELEGRAM_BOT_API_URL или BOT_API_KEY — используется только таблица кодов в БД сайта."
        };
    }
    const u = new URL(`${base}/verify`);
    u.searchParams.set("code", code);
    try {
        const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${key}` } });
        const raw = await r.text();
        if (r.status === 401) {
            console.error("[telegram/link] GET /verify → 401. Проверьте, что BOT_API_KEY в server/.env и telegram-bot/.env совпадают.");
            return {
                ok: false,
                reason: "401 от бота: неверный BOT_API_KEY."
            };
        }
        if (r.status === 400) {
            return { ok: false, reason: "Код в боте не найден или истёк (400)." };
        }
        if (!r.ok) {
            console.error("[telegram/link] GET /verify →", r.status, raw.slice(0, 300));
            return {
                ok: false,
                reason: `Бот ответил ${r.status}.`
            };
        }
        let j;
        try {
            j = JSON.parse(raw);
        }
        catch {
            return { ok: false, reason: "Некорректный JSON от бота." };
        }
        if (j.telegramId == null || String(j.telegramId).length === 0) {
            return { ok: false, reason: "В ответе бота нет telegramId." };
        }
        return {
            ok: true,
            telegramId: String(j.telegramId),
            telegramHandle: j.telegramHandle != null && j.telegramHandle !== "" ? String(j.telegramHandle) : null
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[telegram/link] fetch к боту не удался:", msg);
        return {
            ok: false,
            reason: `Нет связи с ${base}: ${msg}`
        };
    }
}
async function notifyTelegramBotAccountLinked(telegramId) {
    const base = process.env.TELEGRAM_BOT_API_URL?.replace(/\/$/, "");
    const key = process.env.BOT_API_KEY ?? "";
    if (!base || !key)
        return;
    try {
        await fetch(`${base}/internal/notify-linked`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ telegramId })
        });
    }
    catch (e) {
        console.error("[telegram] notify bot after link failed", e);
    }
}
async function tournamentStatsByUserId() {
    const rows = await prisma.$queryRaw `
    SELECT "userId",
      COUNT(*) AS played,
      SUM(CASE WHEN "place" = 1 THEN 1 ELSE 0 END) AS wins
    FROM "TournamentResult"
    GROUP BY "userId"
  `;
    const m = new Map();
    for (const r of rows) {
        m.set(r.userId, { played: Number(r.played), wins: Number(r.wins) });
    }
    return m;
}
async function lastTournamentResultDateByUser() {
    const rows = await prisma.tournamentResult.groupBy({
        by: ["userId"],
        _max: { createdAt: true }
    });
    const m = new Map();
    for (const row of rows) {
        const d = row._max.createdAt;
        if (d)
            m.set(row.userId, d);
    }
    return m;
}
async function leaderboardRankByUserId() {
    const users = await prisma.user.findMany({
        select: { id: true, wins: true, losses: true, totalChipsWon: true, ratingPlacementPoints: true }
    });
    const rated = attachRatings(users);
    rated.sort((a, b) => b.rating - a.rating);
    const m = new Map();
    rated.forEach((u, i) => m.set(u.id, i + 1));
    return m;
}
function effectiveLastActivity(lastActivityAt, lastLoginAt, lastTournamentAt) {
    const times = [lastActivityAt, lastLoginAt, lastTournamentAt]
        .filter((x) => x instanceof Date)
        .map((d) => d.getTime());
    if (times.length === 0)
        return null;
    return new Date(Math.max(...times));
}
const emitRoomState = async (tournamentId) => {
    const eng = getRoom(tournamentId);
    if (!eng)
        return;
    const tour = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    if (tour)
        eng.setTournamentBuyIn(tour.buyIn);
    const regs = tour != null ? await prisma.registration.findMany({ where: { tournamentId } }) : [];
    const regByUser = new Map(regs.map((r) => [r.userId, r]));
    const activeUserIds = [
        ...new Set([...sessions.values()]
            .filter((s) => s.activeTournamentId === tournamentId && s.userId > 0)
            .map((s) => s.userId))
    ];
    const users = activeUserIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: activeUserIds } },
            select: { id: true, chips: true }
        })
        : [];
    const chipsByUser = new Map(users.map((u) => [u.id, u.chips]));
    for (const session of sessions.values()) {
        if (session.activeTournamentId !== tournamentId)
            continue;
        const base = eng.visibleStateFor(session.userId);
        const seat = eng.roomState.seats.find((s) => s.userId === session.userId);
        const seatedAtTable = seat != null;
        const seatChips = seatedAtTable ? seat.chips : null;
        let rebuy = null;
        if (tour && session.userId > 0) {
            rebuy = buildRebuyPublicSync(tour, regByUser.get(session.userId) ?? null, seatedAtTable, seatChips, chipsByUser.get(session.userId) ?? 0);
        }
        io.to(`user:${session.userId}`).emit("room_state", {
            ...base,
            rebuy,
            tournamentStarted: isTournamentActive(tournamentId),
            tournamentAutoStartAt: tour ? new Date(autoStartAtMs(tour.startsAt)).toISOString() : null,
            tournamentFinished: Boolean(tour?.finishedAt),
            tournamentVictory: victoryPayloadForFinishedTournament(tournamentId, tour)
        });
    }
    const prevHistoryLen = historyCursorByTournament.get(tournamentId) ?? 0;
    const hist = eng.roomState.history ?? [];
    if (hist.length > prevHistoryLen) {
        for (const line of hist.slice(prevHistoryLen)) {
            pushChatMessage(makeSystemChatMessage(tournamentId, line));
        }
    }
    historyCursorByTournament.set(tournamentId, hist.length);
    io.emit("room_public", {
        tournamentId,
        players: eng.roomState.seats.filter((s) => s.userId).length,
        handActive: eng.roomState.handActive,
        tournamentStarted: isTournamentActive(tournamentId),
        tournamentFinished: Boolean(tour?.finishedAt)
    });
};
/** Автовыбивание с нулевым стеком, когда докупка по правилам невозможна. */
const eliminateBustedPlayersIfNeeded = async () => {
    for (const eng of allRooms()) {
        const tid = eng.tournamentId;
        const tour = await prisma.tournament.findUnique({ where: { id: tid } });
        if (!tour)
            continue;
        const busted = eng.roomState.seats.filter((s) => s.userId != null && s.userId > 0 && s.chips === 0);
        if (busted.length === 0)
            continue;
        const regs = await prisma.registration.findMany({ where: { tournamentId: tid } });
        const regByUser = new Map(regs.map((r) => [r.userId, r]));
        let changed = false;
        for (const s of busted) {
            const uid = s.userId;
            const reg = regByUser.get(uid);
            if (!mustEliminateZeroStack(tour, reg))
                continue;
            recordTournamentElimination(tid, uid);
            eng.leaveTable(uid);
            await prisma.registration.updateMany({
                where: { userId: uid, tournamentId: tid },
                data: { stackChips: null }
            });
            changed = true;
        }
        if (changed)
            await emitRoomState(tid);
    }
};
const autoSeatApprovedPlayers = async (tournamentId, eng) => {
    const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    if (!t)
        return { seated: 0, occupied: 0 };
    eng.setRoomMaxSeats(t.maxSeats);
    eng.setTournamentBuyIn(t.buyIn);
    const regs = await prisma.registration.findMany({
        where: { tournamentId, approved: true },
        include: { user: true }
    });
    let seated = 0;
    for (const reg of regs) {
        const uid = reg.userId;
        const already = eng.roomState.seats.some((s) => s.userId === uid);
        if (already)
            continue;
        const free = eng.roomState.seats.find((s) => !s.userId);
        if (!free)
            break;
        const paid = await collectTournamentBuyIn(uid, tournamentId);
        if (!paid.ok)
            continue;
        try {
            eng.joinSeat(free.seat, uid, reg.user.telegramUsername, paid.stackChips);
            seated += 1;
        }
        catch {
            // ignore race/occupied seat and continue
        }
    }
    let occupied = eng.roomState.seats.filter((s) => s.userId).length;
    if (AUTO_FILL_BOTS_ON_AUTOSTART && occupied === 1) {
        const free = eng.roomState.seats.find((s) => !s.userId);
        if (free) {
            const bot = makeBotProfile(Math.max(2 * t.buyIn, 500));
            eng.addBots([bot]);
            occupied = eng.roomState.seats.filter((s) => s.userId).length;
        }
    }
    return { seated, occupied };
};
/** Оплатили бай-ин, но не сели: после startsAt + 5 мин — авто-посадка или возврат бай-ина. */
const processPaidNoSeatDeadline = async () => {
    const nowMs = Date.now();
    const tournaments = await prisma.tournament.findMany({
        where: { finishedAt: null }
    });
    for (const t of tournaments) {
        const deadlineMs = t.startsAt.getTime() + PAID_NO_SEAT_DEADLINE_MS;
        if (nowMs < deadlineMs)
            continue;
        const eng = getOrCreateRoom(t.id);
        eng.setRoomMaxSeats(t.maxSeats);
        eng.setTournamentBuyIn(t.buyIn);
        const regs = await prisma.registration.findMany({
            where: { tournamentId: t.id, approved: true, stackChips: { not: null }, userId: { gt: 0 } },
            include: { user: true }
        });
        for (const reg of regs) {
            const uid = reg.userId;
            if (eng.roomState.seats.some((s) => s.userId === uid))
                continue;
            const free = eng.roomState.seats.find((s) => !s.userId);
            const stack = reg.stackChips ?? t.buyIn;
            if (free) {
                try {
                    eng.joinSeat(free.seat, uid, reg.user.telegramUsername, stack);
                    await emitRoomState(t.id);
                }
                catch {
                    /* ignore */
                }
            }
            else {
                await prisma.$transaction([
                    prisma.user.update({ where: { id: uid }, data: { chips: { increment: t.buyIn } } }),
                    prisma.registration.update({ where: { id: reg.id }, data: { stackChips: null } })
                ]);
                pushChatMessage(makeSystemChatMessage(t.id, `Игрок @${reg.user.telegramUsername} не занял место в срок — бай-ин возвращён на счёт.`));
            }
        }
    }
};
const processAbsentDisconnectKick = async () => {
    const now = Date.now();
    for (const [uid, until] of [...absentDisconnectUntil.entries()]) {
        if (now < until)
            continue;
        if ((socketConnectionCount.get(uid) ?? 0) > 0) {
            absentDisconnectUntil.delete(uid);
            continue;
        }
        const sessionEntry = [...sessions.entries()].find(([, s]) => s.userId === uid && s.activeTournamentId != null);
        if (!sessionEntry) {
            absentDisconnectUntil.delete(uid);
            continue;
        }
        const [, sess] = sessionEntry;
        const tid = sess.activeTournamentId;
        const eng = getRoom(tid);
        if (!eng) {
            sess.activeTournamentId = null;
            absentDisconnectUntil.delete(uid);
            continue;
        }
        const seat = eng.roomState.seats.find((s) => s.userId === uid);
        if (!seat) {
            sess.activeTournamentId = null;
            await prisma.registration
                .updateMany({ where: { userId: uid, tournamentId: tid }, data: { stackChips: null } })
                .catch(() => null);
            absentDisconnectUntil.delete(uid);
            continue;
        }
        const stackBefore = Math.max(0, seat.chips);
        if (uid > 0)
            recordTournamentElimination(tid, uid);
        eng.leaveTable(uid);
        const stillSeated = eng.roomState.seats.some((s) => s.userId === uid);
        sess.activeTournamentId = null;
        if (uid > 0 && !stillSeated && stackBefore === 0) {
            await prisma.registration.updateMany({
                where: { userId: uid, tournamentId: tid },
                data: { stackChips: null }
            });
        }
        await emitRoomState(tid);
        absentDisconnectUntil.delete(uid);
    }
};
const tryStartTournamentPlay = async (tournamentId, reason) => {
    if (isTournamentActive(tournamentId))
        return false;
    const eng = getOrCreateRoom(tournamentId);
    const tour = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    if (!tour || tour.finishedAt)
        return false;
    if (reason === "full" && Date.now() < tour.startsAt.getTime())
        return false;
    eng.setRoomMaxSeats(tour.maxSeats);
    eng.setTournamentBuyIn(tour.buyIn);
    const occupied = eng.roomState.seats.filter((s) => s.userId).length;
    if (reason === "full" && occupied < eng.roomState.seats.length)
        return false;
    tournamentActiveIds.add(tournamentId);
    if (occupied >= 2) {
        eng.startHand();
        pushChatMessage(makeSystemChatMessage(tournamentId, "Турнир начался! Удачи за столами."));
    }
    else {
        eng.roomState.history.push("Ожидание игроков...");
    }
    await emitRoomState(tournamentId);
    return true;
};
const tickTournamentAutoStart = async () => {
    const tournaments = await prisma.tournament.findMany({ orderBy: { id: "asc" } });
    const nowMs = Date.now();
    for (const t of tournaments) {
        if (t.finishedAt)
            continue;
        const eng = getOrCreateRoom(t.id);
        if (isTournamentActive(t.id))
            continue;
        if (!isTournamentRoomOpen(t.startsAt))
            continue;
        const occupied = eng.roomState.seats.filter((s) => s.userId).length;
        if (occupied >= eng.roomState.seats.length &&
            eng.roomState.seats.length > 0 &&
            nowMs >= t.startsAt.getTime()) {
            await tryStartTournamentPlay(t.id, "full");
            continue;
        }
        if (nowMs < autoStartAtMs(t.startsAt))
            continue;
        const { occupied: occ2 } = await autoSeatApprovedPlayers(t.id, eng);
        if (occ2 >= eng.roomState.seats.length && eng.roomState.seats.length > 0) {
            await tryStartTournamentPlay(t.id, "full");
        }
        else {
            await tryStartTournamentPlay(t.id, "timer");
        }
    }
};
app.post("/api/register", asyncHandler(async (req, res) => {
    const schema = z.object({
        username: z.string().min(3).max(64),
        password: z.string().min(6).max(64)
    });
    const body = schema.parse(req.body);
    const username = normalizeUsername(body.username);
    const existing = await prisma.user.findUnique({ where: { telegramUsername: username } });
    if (existing && existing.passwordHash) {
        return res.status(409).json({ error: "Username already registered" });
    }
    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = existing
        ? await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, role: "PLAYER" } })
        : await prisma.user.create({
            data: { telegramUsername: username, passwordHash, role: "PLAYER", chips: 0 }
        });
    const now = new Date();
    await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: now, lastActivityAt: now }
    });
    const token = createToken();
    const regRole = user.role === "ADMIN" ? "ADMIN" : user.role === "MODERATOR" ? "MODERATOR" : "PLAYER";
    sessions.set(token, { userId: user.id, username: user.telegramUsername, role: regRole, activeTournamentId: null });
    res.cookie("token", token, sessionCookieOptions());
    const rates = await ratingSnapshot();
    res.json({ ok: true, user: mapUser(user, rates.get(user.id)) });
}));
app.post("/api/login", asyncHandler(async (req, res) => {
    const schema = z.object({
        username: z.string().min(3).max(64),
        password: z.string().min(1).max(64)
    });
    const body = schema.parse(req.body);
    const username = normalizeUsername(body.username);
    const user = await prisma.user.findUnique({ where: { telegramUsername: username } });
    if (!user)
        return res.status(401).json({ error: "Invalid credentials" });
    if (user.accountStatus === AccountStatus.BLOCKED) {
        return res.status(403).json({ error: "Аккаунт заблокирован." });
    }
    const bootstrapAdminLogin = username === BOOTSTRAP_ADMIN_USERNAME && body.password === BOOTSTRAP_ADMIN_PASSWORD;
    let passwordOk = Boolean(user.passwordHash) && (await bcrypt.compare(body.password, user.passwordHash));
    if (!passwordOk && bootstrapAdminLogin) {
        passwordOk = true;
        await prisma.user.update({
            where: { id: user.id },
            data: { passwordHash: await bcrypt.hash(body.password, 10) }
        });
    }
    if (!passwordOk)
        return res.status(401).json({ error: "Invalid credentials" });
    const nowLogin = new Date();
    await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: nowLogin, lastActivityAt: nowLogin }
    });
    let sessionRole = "PLAYER";
    if (bootstrapAdminLogin)
        sessionRole = "ADMIN";
    else if (user.role === "ADMIN")
        sessionRole = "ADMIN";
    else if (user.role === "MODERATOR")
        sessionRole = "MODERATOR";
    const token = createToken();
    sessions.set(token, { userId: user.id, username: user.telegramUsername, role: sessionRole, activeTournamentId: null });
    res.cookie("token", token, sessionCookieOptions());
    const rates = await ratingSnapshot();
    res.json({ ok: true, user: mapUser(user, rates.get(user.id)) });
}));
app.get("/api/me", auth, asyncHandler(async (req, res) => {
    const me = req.session;
    const user = await prisma.user.findUnique({
        where: { id: me.userId },
        omit: { passwordHash: true },
        include: { registrations: { include: { tournament: true } } }
    });
    if (!user)
        return res.status(404).json({ error: "User not found" });
    const rates = await ratingSnapshot();
    const tournamentResults = await prisma.tournamentResult.findMany({
        where: { userId: me.userId },
        orderBy: { createdAt: "desc" },
        take: 30,
        include: { tournament: { select: { title: true, startsAt: true, buyIn: true } } }
    });
    const tournamentRegistrations = await Promise.all(user.registrations.map(async (r) => {
        const tid = r.tournamentId;
        const eng = getRoom(tid);
        const seatedAtTable = Boolean(eng?.roomState.seats.some((s) => s.userId === me.userId));
        const startsAtMs = r.tournament.startsAt.getTime();
        const nowMs = Date.now();
        const deadlineMs = startsAtMs + PAID_NO_SEAT_DEADLINE_MS;
        const paidNoSeatWarningDeadlineIso = r.approved &&
            r.stackChips != null &&
            !r.tournament.finishedAt &&
            !seatedAtTable &&
            nowMs >= startsAtMs &&
            nowMs < deadlineMs
            ? new Date(deadlineMs).toISOString()
            : null;
        return {
            tournamentId: r.tournamentId,
            title: r.tournament.title,
            approved: r.approved,
            startsAt: r.tournament.startsAt,
            stackChips: r.stackChips,
            rebuyCount: r.rebuyCount,
            seatedAtTable,
            paidNoSeatWarningDeadlineIso
        };
    }));
    res.json({
        user: mapUser(user, rates.get(user.id)),
        sessionRole: me.role,
        tournamentRegistrations,
        tournamentResults: tournamentResults.map((tr) => ({
            tournamentId: tr.tournamentId,
            title: tr.tournament.title,
            startsAt: tr.tournament.startsAt,
            buyIn: tr.tournament.buyIn,
            place: tr.place,
            prizeChips: tr.prizeChips,
            ratingBefore: tr.ratingBefore,
            ratingAfter: tr.ratingAfter,
            ratingDelta: tr.ratingAfter - tr.ratingBefore,
            createdAt: tr.createdAt
        }))
    });
}));
/** Публичные данные игрока для карточки за столом (аватар, рейтинг, турниры). */
app.get("/api/player/:id/table-public", auth, asyncHandler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const user = await prisma.user.findUnique({
        where: { id },
        select: { telegramUsername: true, avatarUrl: true }
    });
    if (!user)
        return res.status(404).json({ error: "Игрок не найден" });
    const [tournamentsPlayed, tournamentsWon] = await Promise.all([
        prisma.tournamentResult.count({ where: { userId: id } }),
        prisma.tournamentResult.count({ where: { userId: id, place: 1 } })
    ]);
    const rates = await ratingSnapshot();
    res.json({
        username: user.telegramUsername,
        avatarUrl: user.avatarUrl,
        rating: rates.get(id) ?? 0,
        tournamentsPlayed,
        tournamentsWon
    });
}));
app.get("/api/me/analytics/stack", auth, async (req, res) => {
    const me = req.session;
    const tid = Number(req.query.tournamentId);
    if (!Number.isInteger(tid))
        return res.status(400).json({ error: "Укажите tournamentId" });
    const participated = await prisma.tournamentResult.findFirst({
        where: { userId: me.userId, tournamentId: tid }
    });
    if (!participated)
        return res.status(403).json({ error: "Нет данных по этому турниру" });
    const points = await prisma.handStackPoint.findMany({
        where: { userId: me.userId, tournamentId: tid },
        orderBy: { handNumber: "asc" }
    });
    if (points.length === 0) {
        return res.json({ series: [], blindJumps: [], tournamentId: tid, message: "Нет пошаговых данных — статистика собирается с новых турниров." });
    }
    const avgRows = await prisma.$queryRaw `
    SELECT "handNumber", AVG("stackChips") as av FROM "HandStackPoint"
    WHERE "tournamentId" = ${tid}
    GROUP BY "handNumber" ORDER BY "handNumber" ASC
  `;
    const avgByHand = new Map(avgRows.map((r) => [r.handNumber, Number(r.av)]));
    const wonTournament = participated.place === 1;
    const series = points.map((p, idx) => {
        const bb = Math.max(1, p.bigBlind);
        const stackBB = p.stackChips / bb;
        let marker = null;
        if (p.stackChips === 0)
            marker = "bust";
        else if (idx === points.length - 1 && wonTournament)
            marker = "win";
        else if (p.startChips > 0 && p.deltaChips > 0.3 * p.startChips)
            marker = "big_win";
        else if (p.startChips > 0 && p.deltaChips < -0.5 * p.startChips)
            marker = "big_loss";
        const avgStack = avgByHand.get(p.handNumber);
        const avgBB = avgStack != null ? avgStack / bb : null;
        return {
            handNumber: p.handNumber,
            stackBB,
            startChips: p.startChips,
            endChips: p.stackChips,
            deltaChips: p.deltaChips,
            smallBlind: p.smallBlind,
            bigBlind: p.bigBlind,
            blindLevel: p.blindLevel,
            avgStackBB: avgBB,
            marker,
            label: marker === "big_win"
                ? "Крупный забор банка"
                : marker === "big_loss"
                    ? "Сильная просадка"
                    : marker === "bust"
                        ? "Вылет"
                        : marker === "win"
                            ? "Победа в турнире"
                            : ""
        };
    });
    const blindJumps = [];
    for (let i = 1; i < points.length; i++) {
        if (points[i].blindLevel !== points[i - 1].blindLevel) {
            blindJumps.push({
                handNumber: points[i].handNumber,
                label: `${points[i].smallBlind}/${points[i].bigBlind}`
            });
        }
    }
    res.json({ series, blindJumps, tournamentId: tid });
});
app.get("/api/me/analytics/heatmap", auth, async (req, res) => {
    const me = req.session;
    const period = parsePeriod(req.query);
    const stage = typeof req.query.stage === "string" ? req.query.stage : "all";
    const actions = await prisma.analyticsPreflopAction.findMany({
        where: {
            userId: me.userId,
            ...(period.from || period.to
                ? {
                    tournament: {
                        ...(period.from ? { startsAt: { gte: period.from } } : {}),
                        ...(period.to ? { startsAt: { lte: period.to } } : {})
                    }
                }
                : {})
        }
    });
    let filtered = actions;
    if (stage !== "all") {
        const maxByTournament = new Map();
        for (const a of actions) {
            const cur = maxByTournament.get(a.tournamentId) ?? 0;
            if (a.handNumber > cur)
                maxByTournament.set(a.tournamentId, a.handNumber);
        }
        filtered = actions.filter((a) => {
            const maxH = maxByTournament.get(a.tournamentId) ?? 1;
            const frac = a.handNumber / maxH;
            if (stage === "early")
                return frac <= 0.33;
            if (stage === "mid")
                return frac > 0.33 && frac <= 0.66;
            if (stage === "late")
                return frac > 0.66 && frac < 1;
            if (stage === "final")
                return frac >= 0.85;
            return true;
        });
    }
    const buckets = {};
    for (const a of filtered) {
        const key = `${a.positionBucket}|${a.facingBet ? "react" : "first"}`;
        if (!buckets[key])
            buckets[key] = {};
        const k = a.action;
        buckets[key][k] = (buckets[key][k] ?? 0) + 1;
    }
    res.json({ buckets, total: filtered.length, stage });
});
app.get("/api/me/analytics/compare", auth, async (req, res) => {
    const me = req.session;
    const period = parsePeriod(req.query);
    const group = typeof req.query.group === "string" ? req.query.group : "all";
    const refUserId = req.query.refUserId != null ? Number(req.query.refUserId) : null;
    const lb = await leaderboardRows(prisma);
    const meRow = lb.find((u) => u.id === me.userId);
    const meRating = meRow?.rating ?? 0;
    let refIds = lb.map((u) => u.id).filter((id) => id > 0);
    if (group === "top10")
        refIds = lb.slice(0, 10).map((u) => u.id);
    else if (group === "top50")
        refIds = lb.slice(0, 50).map((u) => u.id);
    else if (group === "similar") {
        refIds = lb.filter((u) => Math.abs(u.rating - meRating) <= 100).map((u) => u.id);
        if (refIds.length === 0)
            refIds = lb.map((u) => u.id);
    }
    else if (group === "user" && refUserId != null && Number.isInteger(refUserId)) {
        refIds = lb.some((u) => u.id === refUserId) ? [refUserId] : [];
    }
    if (refIds.length === 0)
        refIds = lb.map((u) => u.id);
    const userTour = await userTournamentMetrics(prisma, me.userId, period);
    const userPref = await preflopSkillMetrics(prisma, me.userId, period);
    const tourWhere = {
        ...(period.from || period.to
            ? {
                tournament: {
                    ...(period.from ? { startsAt: { gte: period.from } } : {}),
                    ...(period.to ? { startsAt: { lte: period.to } } : {})
                }
            }
            : {})
    };
    const refResults = await prisma.tournamentResult.findMany({
        where: {
            userId: { in: refIds.length > 0 ? refIds : [-1] },
            ...tourWhere
        }
    });
    const refN = refResults.length;
    const refWins = refN > 0 ? refResults.filter((r) => r.place === 1).length : 0;
    const refWinPct = refN > 0 ? Math.round((1000 * refWins) / refN) / 10 : null;
    const refAvgPlace = refN > 0 ? Math.round((100 * refResults.reduce((s, r) => s + r.place, 0)) / refN) / 100 : null;
    const refItm = refN > 0 ? refResults.filter((r) => r.place <= 3).length : 0;
    const refItmPct = refN > 0 ? Math.round((1000 * refItm) / refN) / 10 : null;
    const refActions = refIds.length > 0
        ? await prisma.analyticsPreflopAction.findMany({
            where: {
                userId: { in: refIds },
                ...(period.from || period.to
                    ? {
                        tournament: {
                            ...(period.from ? { startsAt: { gte: period.from } } : {}),
                            ...(period.to ? { startsAt: { lte: period.to } } : {})
                        }
                    }
                    : {})
            }
        })
        : [];
    const refFirstIn = refActions.filter((a) => !a.facingBet);
    const refFacing = refActions.filter((a) => a.facingBet);
    const refPfr = refFirstIn.length > 0
        ? Math.round((1000 * refFirstIn.filter((a) => a.action === "RAISE").length) / refFirstIn.length) / 10
        : null;
    const ref3b = refActions.length > 0
        ? Math.round((1000 * refActions.filter((a) => a.isThreeBet).length) / refActions.length) / 10
        : null;
    const refCall = refFacing.length > 0
        ? Math.round((1000 * refFacing.filter((a) => a.action === "CALL").length) / refFacing.length) / 10
        : null;
    const metrics = [
        {
            key: "tournamentWinPct",
            label: "% побед в турнирах",
            user: userTour.winPct,
            refAvg: refWinPct,
            refMin: null,
            refMax: null,
            tip: compareTip("tournamentWinPct", userTour.winPct, refWinPct)
        },
        {
            key: "avgPlace",
            label: "Среднее место (ниже — лучше)",
            user: userTour.avgPlace,
            refAvg: refAvgPlace,
            refMin: null,
            refMax: null,
            tip: compareTip("avgPlace", userTour.avgPlace, refAvgPlace)
        },
        {
            key: "itmPct",
            label: "% ITM (топ-3)",
            user: userTour.itmPct,
            refAvg: refItmPct,
            refMin: null,
            refMax: null,
            tip: compareTip("itmPct", userTour.itmPct, refItmPct)
        },
        {
            key: "pfrPct",
            label: "Частота рейза на префлопе (PFR)",
            user: userPref.pfrPct,
            refAvg: refPfr,
            refMin: null,
            refMax: null,
            tip: compareTip("pfrPct", userPref.pfrPct, refPfr)
        },
        {
            key: "threeBetPct",
            label: "Частота 3-бета (префлоп)",
            user: userPref.threeBetPct,
            refAvg: ref3b,
            refMin: null,
            refMax: null,
            tip: compareTip("threeBetPct", userPref.threeBetPct, ref3b)
        },
        {
            key: "callFacingPct",
            label: "Колл на префлопе под давлением",
            user: userPref.callFacingPct,
            refAvg: refCall,
            refMin: null,
            refMax: null,
            tip: null
        }
    ];
    res.json({
        group,
        refSampleSize: refIds.length,
        tournamentResultsCount: userTour.tournamentsPlayed,
        metrics
    });
});
app.post("/api/me/avatar", auth, uploadAvatar.single("avatar"), async (req, res) => {
    const me = req.session;
    const file = req.file;
    if (!file)
        return res.status(400).json({ error: "Файл не получен или недопустимый формат (JPEG, PNG, WebP, GIF)" });
    const ext0 = path.extname(file.originalname).toLowerCase();
    const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const ext = allowed.includes(ext0) ? ext0 : ".png";
    const finalName = `user-${me.userId}${ext}`;
    const finalPath = path.join(avatarsDir, finalName);
    const prev = await prisma.user.findUnique({ where: { id: me.userId }, select: { avatarUrl: true } });
    if (prev?.avatarUrl) {
        const rel = prev.avatarUrl.replace(/^\//, "");
        const prevPath = path.join(uploadsRoot, rel);
        const rootResolved = path.resolve(uploadsRoot);
        if (path.resolve(prevPath).startsWith(rootResolved) && fs.existsSync(prevPath) && prevPath !== finalPath) {
            try {
                fs.unlinkSync(prevPath);
            }
            catch {
                /* ignore */
            }
        }
    }
    try {
        fs.renameSync(file.path, finalPath);
    }
    catch {
        try {
            fs.unlinkSync(file.path);
        }
        catch {
            /* ignore */
        }
        return res.status(500).json({ error: "Не удалось сохранить файл" });
    }
    const url = `/uploads/avatars/${finalName}`;
    await prisma.user.update({ where: { id: me.userId }, data: { avatarUrl: url } });
    res.json({ ok: true, avatarUrl: url });
});
app.get("/api/leaderboard", async (_req, res) => {
    const users = await prisma.user.findMany({
        select: {
            id: true,
            telegramUsername: true,
            avatarUrl: true,
            wins: true,
            losses: true,
            totalChipsWon: true,
            ratingPlacementPoints: true
        }
    });
    const rows = users.map((u) => ({
        id: u.id,
        username: u.telegramUsername,
        avatarUrl: u.avatarUrl,
        wins: u.wins,
        losses: u.losses,
        totalChipsWon: u.totalChipsWon,
        ratingPlacementPoints: u.ratingPlacementPoints
    }));
    const rated = attachRatings(rows);
    rated.sort((a, b) => b.rating - a.rating);
    res.json({ players: rated });
});
app.get("/api/lobby", asyncHandler(async (_req, res) => {
    const nowIso = new Date().toISOString();
    const tournamentsRaw = await prisma.tournament.findMany({ orderBy: { startsAt: "asc" }, take: 10 });
    const tournaments = tournamentsRaw.map((t) => ({
        ...t,
        autoStartAt: new Date(autoStartAtMs(t.startsAt))
    }));
    const roomPlayersByTournament = {};
    const tournamentStartedByTournament = {};
    const tournamentRoomOpenByTournament = {};
    const tournamentFinishedByTournament = {};
    for (const t of tournamentsRaw) {
        const eng = getRoom(t.id);
        roomPlayersByTournament[String(t.id)] = eng ? eng.roomState.seats.filter((s) => s.userId).length : 0;
        tournamentStartedByTournament[String(t.id)] = isTournamentActive(t.id);
        tournamentRoomOpenByTournament[String(t.id)] = isTournamentRoomOpen(t.startsAt);
        tournamentFinishedByTournament[String(t.id)] = Boolean(t.finishedAt);
    }
    res.json({
        serverNow: nowIso,
        roomPlayersByTournament,
        tournamentRoomOpenByTournament,
        tournamentStartedByTournament,
        tournamentFinishedByTournament,
        tournaments
    });
}));
app.post("/api/admin/unlock", auth, (req, res) => {
    const schema = z.object({ adminPassword: z.string().min(1) });
    const { adminPassword } = schema.parse(req.body);
    if (adminPassword !== "pr26sa")
        return res.status(403).json({ error: "Forbidden" });
    const me = req.session;
    me.role = "ADMIN";
    res.json({ ok: true });
});
app.post("/api/room/enter", auth, async (req, res) => {
    const schema = z.object({ tournamentId: z.number().int() });
    const body = schema.parse(req.body ?? {});
    const me = req.session;
    const gate = await tournamentRoomAccessMessage(me.userId, body.tournamentId);
    if (gate)
        return res.status(403).json({ error: gate });
    const tour = await prisma.tournament.findUnique({ where: { id: body.tournamentId } });
    if (!tour)
        return res.status(400).json({ error: "Турнир не найден." });
    if (tour.finishedAt)
        return res.status(400).json({ error: "Турнир уже завершён." });
    const eng = getOrCreateRoom(body.tournamentId);
    try {
        eng.setRoomMaxSeats(tour.maxSeats);
    }
    catch (e) {
        return res.status(400).json({ error: e.message ?? "Нельзя перенастроить стол." });
    }
    eng.setTournamentBuyIn(tour.buyIn);
    const paid = await collectTournamentBuyIn(me.userId, body.tournamentId);
    if (!paid.ok)
        return res.status(400).json({ error: paid.error });
    me.activeTournamentId = body.tournamentId;
    await prisma.user
        .update({
        where: { id: me.userId },
        data: { lastActivityAt: new Date() }
    })
        .catch(() => null);
    res.json({ ok: true });
});
app.get("/api/room/state", auth, async (req, res) => {
    const me = req.session;
    try {
        const { eng, tid } = roomForSession(me);
        const tour = await prisma.tournament.findUnique({ where: { id: tid } });
        if (tour)
            eng.setTournamentBuyIn(tour.buyIn);
        const base = eng.visibleStateFor(me.userId);
        const reg = await prisma.registration.findUnique({
            where: { userId_tournamentId: { userId: me.userId, tournamentId: tid } }
        });
        const user = await prisma.user.findUnique({ where: { id: me.userId }, select: { chips: true } });
        const seat = eng.roomState.seats.find((s) => s.userId === me.userId);
        const rebuy = tour != null && me.userId > 0
            ? buildRebuyPublicSync(tour, reg, seat != null, seat != null ? seat.chips : null, user?.chips ?? 0)
            : null;
        res.json({
            ...base,
            rebuy,
            tournamentStarted: isTournamentActive(tid),
            tournamentAutoStartAt: tour ? new Date(autoStartAtMs(tour.startsAt)).toISOString() : null,
            tournamentFinished: Boolean(tour?.finishedAt),
            tournamentVictory: victoryPayloadForFinishedTournament(tid, tour)
        });
    }
    catch (e) {
        res.status(400).json({ error: e.message ?? "Нет активной комнаты" });
    }
});
app.post("/api/room/sit", auth, async (req, res) => {
    const me = req.session;
    const schema = z.object({
        seat: z.coerce.number().int().min(1),
        tournamentId: z.number().int().optional()
    });
    const { seat, tournamentId: tidBody } = schema.parse(req.body);
    const tournamentId = tidBody ?? me.activeTournamentId;
    if (tournamentId == null) {
        return res.status(400).json({ error: "Укажите tournamentId или откройте комнату." });
    }
    me.activeTournamentId = tournamentId;
    const eng = getOrCreateRoom(tournamentId);
    const maxSeat = eng.roomState.seats.length;
    if (seat > maxSeat)
        return res.status(400).json({ error: `Место от 1 до ${maxSeat}.` });
    const gate = await tournamentRoomAccessMessage(me.userId, tournamentId);
    if (gate)
        return res.status(403).json({ error: gate });
    const tourSit = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { buyIn: true, startsAt: true } });
    if (tourSit)
        eng.setTournamentBuyIn(tourSit.buyIn);
    const user = await prisma.user.findUnique({ where: { id: me.userId } });
    if (!user)
        return res.status(404).json({ error: "User not found" });
    const paid = await collectTournamentBuyIn(me.userId, tournamentId);
    if (!paid.ok)
        return res.status(400).json({ error: paid.error });
    try {
        eng.joinSeat(seat, user.id, user.telegramUsername, paid.stackChips);
        if (!isTournamentActive(tournamentId) &&
            tourSit != null &&
            isTournamentRoomOpen(new Date(tourSit.startsAt)) &&
            eng.roomState.seats.filter((s) => s.userId).length >= eng.roomState.seats.length) {
            await tryStartTournamentPlay(tournamentId, "full");
            return res.json({ ok: true, started: true });
        }
        await emitRoomState(tournamentId);
        res.json({ ok: true });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
});
app.post("/api/room/leave", auth, async (req, res) => {
    const me = req.session;
    try {
        const { tid, eng } = roomForSession(me);
        const seatBefore = eng.roomState.seats.find((s) => s.userId === me.userId);
        const stackBefore = seatBefore ? Math.max(0, seatBefore.chips) : 0;
        if (me.userId > 0 && seatBefore)
            recordTournamentElimination(tid, me.userId);
        eng.leaveTable(me.userId);
        const stillSeated = eng.roomState.seats.some((s) => s.userId === me.userId);
        /** Стек > 0 обрабатывает setTournamentLeaveCashout в движке; здесь только выход без фишек за столом. */
        if (me.userId > 0 && !stillSeated && stackBefore === 0) {
            await prisma.registration.updateMany({
                where: { userId: me.userId, tournamentId: tid },
                data: { stackChips: null }
            });
        }
        me.activeTournamentId = null;
        await emitRoomState(tid);
        res.json({ ok: true });
    }
    catch (e) {
        res.status(400).json({ error: e.message ?? "Нет активной комнаты" });
    }
});
app.post("/api/room/rebuy", auth, async (req, res) => {
    const me = req.session;
    try {
        const { tid, eng } = roomForSession(me);
        const tour = await prisma.tournament.findUnique({ where: { id: tid } });
        if (!tour)
            return res.status(400).json({ error: "Турнир не найден." });
        const reg = await prisma.registration.findUnique({
            where: { userId_tournamentId: { userId: me.userId, tournamentId: tid } }
        });
        const seat = eng.roomState.seats.find((s) => s.userId === me.userId);
        const user = await prisma.user.findUnique({ where: { id: me.userId }, select: { chips: true } });
        const rebuy = buildRebuyPublicSync(tour, reg, seat != null, seat != null ? seat.chips : null, user?.chips ?? 0);
        if (!rebuy.canRebuyNow) {
            return res.status(400).json({ error: rebuy.blockReason ?? "Докупка недоступна." });
        }
        if (reg == null)
            return res.status(400).json({ error: "Нет регистрации." });
        const cost = rebuy.costChips;
        const stackAdd = tour.buyIn;
        await prisma.$transaction([
            prisma.user.update({
                where: { id: me.userId },
                data: { chips: { decrement: cost } }
            }),
            prisma.registration.update({
                where: { id: reg.id },
                data: { rebuyCount: { increment: 1 }, stackChips: (reg.stackChips ?? 0) + stackAdd }
            })
        ]);
        eng.creditChipsToSeat(me.userId, stackAdd);
        await emitRoomState(tid);
        res.json({ ok: true, stackChips: (reg.stackChips ?? 0) + stackAdd });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
});
app.post("/api/room/action", auth, async (req, res) => {
    const schema = z.object({
        action: z.enum(["FOLD", "CHECK", "CALL", "RAISE", "ALL_IN"]),
        amount: z.number().int().min(0).optional()
    });
    const { action, amount } = schema.parse(req.body);
    const me = req.session;
    try {
        const { tid, eng } = roomForSession(me);
        eng.applyAction(me.userId, action, amount ?? 0);
        await emitRoomState(tid);
        res.json({ ok: true });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
});
app.post("/api/room/showdown", auth, async (req, res) => {
    const schema = z.object({ show: z.boolean() });
    const { show } = schema.parse(req.body);
    const me = req.session;
    try {
        const { tid, eng } = roomForSession(me);
        eng.setShowdownChoice(me.userId, show);
        eng.tickShowdownPhase();
        await emitRoomState(tid);
        res.json({ ok: true });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
});
app.post("/api/tournaments/register", auth, async (req, res) => {
    const schema = z.object({ tournamentId: z.number().int() });
    const { tournamentId } = schema.parse(req.body);
    const me = req.session;
    await prisma.registration.upsert({
        where: { userId_tournamentId: { userId: me.userId, tournamentId } },
        create: { userId: me.userId, tournamentId, approved: false },
        update: {}
    });
    res.json({ ok: true });
});
app.get("/api/admin/players/summary", auth, staff, async (_req, res) => {
    const allUsers = await prisma.user.findMany({
        select: { id: true, lastLoginAt: true, lastActivityAt: true }
    });
    const stats = await tournamentStatsByUserId();
    const lastTr = await lastTournamentResultDateByUser();
    const d30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let activeLast30Days = 0;
    let sumWins = 0;
    let sumPlayed = 0;
    for (const u of allUsers) {
        const s = stats.get(u.id);
        const played = s?.played ?? 0;
        const wins = s?.wins ?? 0;
        sumPlayed += played;
        sumWins += wins;
        const eff = effectiveLastActivity(u.lastActivityAt, u.lastLoginAt, lastTr.get(u.id));
        if (eff && eff.getTime() >= d30)
            activeLast30Days += 1;
    }
    const avgWinPercentPlatform = sumPlayed > 0 ? Math.round((1000 * sumWins) / sumPlayed) / 10 : null;
    res.json({
        totalRegistered: allUsers.length,
        activeLast30Days,
        avgWinPercentPlatform
    });
});
app.get("/api/admin/players", auth, staff, async (req, res) => {
    const qSchema = z.object({
        sort: z
            .enum(["createdAt", "username", "tournamentsPlayed", "tournamentsWon", "winPct", "lastActivity"])
            .optional(),
        dir: z.enum(["asc", "desc"]).optional(),
        q: z.string().optional(),
        status: z.enum(["ACTIVE", "BLOCKED", "RESTRICTED", "ALL"]).optional(),
        minPlayed: z.coerce.number().optional(),
        maxPlayed: z.coerce.number().optional(),
        minWinPct: z.coerce.number().optional(),
        maxWinPct: z.coerce.number().optional(),
        activityAfter: z.string().optional(),
        activityBefore: z.string().optional()
    });
    const qs = qSchema.parse(req.query ?? {});
    const users = await prisma.user.findMany({
        omit: { passwordHash: true },
        include: { registrations: { include: { tournament: true } } }
    });
    const rates = await ratingSnapshot();
    const stats = await tournamentStatsByUserId();
    const lastTr = await lastTournamentResultDateByUser();
    const activityAfterD = qs.activityAfter ? new Date(qs.activityAfter) : null;
    const activityBeforeD = qs.activityBefore ? new Date(qs.activityBefore) : null;
    let rows = users.map((u) => {
        const st = stats.get(u.id);
        const played = st?.played ?? 0;
        const wins = st?.wins ?? 0;
        const winPct = played > 0 ? Math.round((1000 * wins) / played) / 10 : null;
        const lastActivity = effectiveLastActivity(u.lastActivityAt, u.lastLoginAt, lastTr.get(u.id));
        return {
            id: u.id,
            orig: u,
            tournamentsPlayed: played,
            tournamentsWon: wins,
            winPercent: winPct,
            lastActivity,
            tournamentRegistrations: u.registrations.map((r) => ({
                tournamentId: r.tournamentId,
                title: r.tournament.title,
                approved: r.approved,
                startsAt: r.tournament.startsAt,
                stackChips: r.stackChips,
                rebuyCount: r.rebuyCount
            }))
        };
    });
    const qlow = (qs.q ?? "").trim().toLowerCase();
    if (qlow)
        rows = rows.filter((r) => r.orig.telegramUsername.toLowerCase().includes(qlow));
    const stFilter = qs.status ?? "ALL";
    if (stFilter !== "ALL")
        rows = rows.filter((r) => r.orig.accountStatus === stFilter);
    if (qs.minPlayed != null) {
        const minP = qs.minPlayed;
        rows = rows.filter((r) => r.tournamentsPlayed >= minP);
    }
    if (qs.maxPlayed != null) {
        const maxP = qs.maxPlayed;
        rows = rows.filter((r) => r.tournamentsPlayed <= maxP);
    }
    if (qs.minWinPct != null) {
        const minW = qs.minWinPct;
        rows = rows.filter((r) => r.winPercent != null && r.winPercent >= minW);
    }
    if (qs.maxWinPct != null) {
        const maxW = qs.maxWinPct;
        rows = rows.filter((r) => r.winPercent != null && r.winPercent <= maxW);
    }
    if (activityAfterD && !Number.isNaN(activityAfterD.getTime()))
        rows = rows.filter((r) => r.lastActivity && r.lastActivity >= activityAfterD);
    if (activityBeforeD && !Number.isNaN(activityBeforeD.getTime()))
        rows = rows.filter((r) => r.lastActivity && r.lastActivity <= activityBeforeD);
    const sort = qs.sort ?? "createdAt";
    const dir = qs.dir ?? "desc";
    const m = dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
        let cmp = 0;
        switch (sort) {
            case "username":
                cmp = a.orig.telegramUsername.localeCompare(b.orig.telegramUsername);
                break;
            case "tournamentsPlayed":
                cmp = a.tournamentsPlayed - b.tournamentsPlayed;
                break;
            case "tournamentsWon":
                cmp = a.tournamentsWon - b.tournamentsWon;
                break;
            case "winPct": {
                const av = a.winPercent ?? -1;
                const bv = b.winPercent ?? -1;
                cmp = av - bv;
                break;
            }
            case "lastActivity": {
                const at = a.lastActivity?.getTime() ?? 0;
                const bt = b.lastActivity?.getTime() ?? 0;
                cmp = at - bt;
                break;
            }
            case "createdAt":
            default:
                cmp = a.orig.createdAt.getTime() - b.orig.createdAt.getTime();
                break;
        }
        return cmp * m;
    });
    res.json({
        users: rows.map((r) => ({
            ...mapUser(r.orig, rates.get(r.id)),
            tournamentsPlayed: r.tournamentsPlayed,
            tournamentsWon: r.tournamentsWon,
            winPercent: r.winPercent,
            lastActivity: r.lastActivity ? r.lastActivity.toISOString() : null,
            tournamentRegistrations: r.tournamentRegistrations
        }))
    });
});
app.get("/api/admin/players/:id", auth, staff, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
        return res.status(400).json({ error: "Некорректный id" });
    const user = await prisma.user.findUnique({
        where: { id },
        omit: { passwordHash: true },
        include: { registrations: { include: { tournament: true } } }
    });
    if (!user)
        return res.status(404).json({ error: "Игрок не найден" });
    const rates = await ratingSnapshot();
    const rankMap = await leaderboardRankByUserId();
    const stats = await tournamentStatsByUserId();
    const st = stats.get(id) ?? { played: 0, wins: 0 };
    const lastTr = await lastTournamentResultDateByUser();
    const lastActivity = effectiveLastActivity(user.lastActivityAt, user.lastLoginAt, lastTr.get(id));
    const winPct = st.played > 0 ? Math.round((1000 * st.wins) / st.played) / 10 : null;
    const statusHistory = await prisma.accountStatusChange.findMany({
        where: { userId: id },
        orderBy: { changedAt: "desc" },
        take: 50
    });
    const recentTournaments = await prisma.tournamentResult.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 30,
        include: {
            tournament: {
                select: {
                    title: true,
                    startsAt: true,
                    maxSeats: true
                }
            }
        }
    });
    const tidList = [...new Set(recentTournaments.map((tr) => tr.tournamentId))];
    const participantRows = tidList.length > 0
        ? await prisma.tournamentResult.groupBy({
            by: ["tournamentId"],
            where: { tournamentId: { in: tidList } },
            _count: { _all: true }
        })
        : [];
    const participantsByTournament = new Map(participantRows.map((p) => [p.tournamentId, p._count._all]));
    res.json({
        user: {
            ...mapUser(user, rates.get(user.id)),
            tournamentsPlayed: st.played,
            tournamentsWon: st.wins,
            winPercent: winPct,
            lastActivity: lastActivity ? lastActivity.toISOString() : null,
            leaderboardRank: rankMap.get(user.id) ?? null,
            tournamentRegistrations: user.registrations.map((r) => ({
                tournamentId: r.tournamentId,
                title: r.tournament.title,
                approved: r.approved,
                startsAt: r.tournament.startsAt,
                stackChips: r.stackChips,
                rebuyCount: r.rebuyCount
            })),
            recentTournaments: recentTournaments.map((tr) => ({
                tournamentId: tr.tournamentId,
                title: tr.tournament.title,
                startsAt: tr.tournament.startsAt,
                place: tr.place,
                participants: participantsByTournament.get(tr.tournamentId) ?? 0,
                maxSeats: tr.tournament.maxSeats,
                prizeChips: tr.prizeChips,
                createdAt: tr.createdAt
            })),
            statusHistory: statusHistory.map((h) => ({
                fromStatus: h.fromStatus,
                toStatus: h.toStatus,
                changedAt: h.changedAt,
                changedById: h.changedById
            }))
        }
    });
});
app.patch("/api/admin/players/:id/status", auth, staff, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
        return res.status(400).json({ error: "Некорректный id" });
    const body = z.object({ status: z.nativeEnum(AccountStatus) }).parse(req.body);
    const me = req.session;
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target)
        return res.status(404).json({ error: "Игрок не найден" });
    if (target.role === "ADMIN" && me.role === "MODERATOR") {
        return res.status(403).json({ error: "Нельзя менять статус администратора" });
    }
    if (id === me.userId)
        return res.status(400).json({ error: "Нельзя изменить статус собственного аккаунта" });
    await prisma.$transaction([
        prisma.accountStatusChange.create({
            data: {
                userId: id,
                fromStatus: target.accountStatus,
                toStatus: body.status,
                changedById: me.userId
            }
        }),
        prisma.user.update({ where: { id }, data: { accountStatus: body.status } })
    ]);
    res.json({ ok: true });
});
app.get("/api/admin/tournaments-all", auth, admin, async (_req, res) => {
    const tournaments = await prisma.tournament.findMany({ orderBy: { startsAt: "asc" } });
    res.json({ tournaments });
});
app.post("/api/admin/registrations/approve", auth, admin, async (req, res) => {
    const schema = z.object({
        userId: z.number().int(),
        tournamentIds: z.array(z.number().int()).min(1)
    });
    const { userId, tournamentIds } = schema.parse(req.body);
    for (const tournamentId of tournamentIds) {
        await prisma.registration.upsert({
            where: { userId_tournamentId: { userId, tournamentId } },
            create: { userId, tournamentId, approved: true },
            update: { approved: true }
        });
    }
    res.json({ ok: true });
});
app.post("/api/admin/registrations/revoke", auth, admin, async (req, res) => {
    const schema = z.object({
        userId: z.number().int(),
        tournamentIds: z.array(z.number().int()).min(1)
    });
    const { userId, tournamentIds } = schema.parse(req.body);
    await prisma.registration.updateMany({
        where: { userId, tournamentId: { in: tournamentIds } },
        data: { approved: false }
    });
    res.json({ ok: true });
});
app.post("/api/admin/chips", auth, admin, async (req, res) => {
    const schema = z.object({ userId: z.number().int(), chips: z.number().int().min(0) });
    const { userId, chips } = schema.parse(req.body);
    await prisma.user.update({ where: { id: userId }, data: { chips } });
    res.json({ ok: true });
});
app.post("/api/admin/chips/take", auth, admin, async (req, res) => {
    const schema = z.object({ userId: z.number().int(), amount: z.number().int().min(1) });
    const { userId, amount } = schema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user)
        return res.status(404).json({ error: "Игрок не найден" });
    const next = Math.max(0, user.chips - amount);
    await prisma.user.update({ where: { id: userId }, data: { chips: next } });
    res.json({ ok: true, chips: next });
});
app.post("/api/admin/tournaments", auth, admin, async (req, res) => {
    const schema = z.object({
        title: z.string().trim().min(1, "Название турнира обязательно"),
        startsAt: z.string(),
        buyIn: z.number().int().min(1),
        maxSeats: z.number().int().min(2).max(9).optional(),
        rebuyEnabled: z.boolean().optional(),
        rebuyPeriodMinutes: z.number().int().min(1).max(1440).optional(),
        rebuyCostMode: z.enum(["FULL", "HALF"]).optional(),
        maxRebuysPerPlayer: z.number().int().min(0).max(99).optional()
    });
    const body = schema.parse(req.body);
    const t = await prisma.tournament.create({
        data: {
            title: body.title,
            startsAt: new Date(body.startsAt),
            buyIn: body.buyIn,
            maxSeats: body.maxSeats ?? 6,
            rebuyEnabled: body.rebuyEnabled ?? false,
            rebuyPeriodMinutes: body.rebuyPeriodMinutes ?? 60,
            rebuyCostMode: body.rebuyCostMode === "HALF" ? "HALF" : "FULL",
            maxRebuysPerPlayer: body.maxRebuysPerPlayer ?? 3
        }
    });
    res.json({ tournament: t });
});
app.patch("/api/admin/tournaments/:id", auth, admin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id))
        return res.status(400).json({ error: "Некорректный id." });
    const schema = z.object({
        rebuyEnabled: z.boolean().optional(),
        rebuyPeriodMinutes: z.number().int().min(1).max(1440).optional(),
        rebuyCostMode: z.enum(["FULL", "HALF"]).optional(),
        maxRebuysPerPlayer: z.number().int().min(0).max(99).optional()
    });
    const body = schema.parse(req.body);
    const data = {};
    if (body.rebuyEnabled !== undefined)
        data.rebuyEnabled = body.rebuyEnabled;
    if (body.rebuyPeriodMinutes !== undefined)
        data.rebuyPeriodMinutes = body.rebuyPeriodMinutes;
    if (body.rebuyCostMode !== undefined)
        data.rebuyCostMode = body.rebuyCostMode;
    if (body.maxRebuysPerPlayer !== undefined)
        data.maxRebuysPerPlayer = body.maxRebuysPerPlayer;
    if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "Нет полей для обновления." });
    }
    const t = await prisma.tournament.update({ where: { id }, data: data }).catch(() => null);
    if (!t)
        return res.status(404).json({ error: "Турнир не найден." });
    res.json({ tournament: t });
});
app.delete("/api/admin/tournaments/:id", auth, admin, async (req, res) => {
    const id = Number(req.params.id);
    await prisma.tournament.delete({ where: { id } }).catch(() => null);
    tournamentChat.delete(id);
    historyCursorByTournament.delete(id);
    tournamentActiveIds.delete(id);
    tournamentVictoryPayloadById.delete(id);
    clearTournamentEliminationState(id);
    res.json({ ok: true });
});
app.post("/api/admin/hand/start", auth, admin, async (req, res) => {
    const schema = z.object({ tournamentId: z.number().int() });
    const { tournamentId } = schema.parse(req.body);
    const eng = getOrCreateRoom(tournamentId);
    const tourHand = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { buyIn: true } });
    if (tourHand)
        eng.setTournamentBuyIn(tourHand.buyIn);
    tournamentActiveIds.add(tournamentId);
    eng.startHand();
    pushChatMessage(makeSystemChatMessage(tournamentId, "Турнир начался! Удачи за столами."));
    await emitRoomState(tournamentId);
    res.json({ ok: true });
});
app.post("/api/admin/hand/reset", auth, admin, async (req, res) => {
    const schema = z.object({ tournamentId: z.number().int() });
    const { tournamentId } = schema.parse(req.body);
    const eng = getOrCreateRoom(tournamentId);
    eng.resetGame();
    await emitRoomState(tournamentId);
    res.json({ ok: true });
});
app.post("/api/admin/kick", auth, admin, async (req, res) => {
    const schema = z.object({ userId: z.number().int(), tournamentId: z.number().int() });
    const { userId, tournamentId } = schema.parse(req.body);
    const eng = getOrCreateRoom(tournamentId);
    const seatBefore = eng.roomState.seats.find((s) => s.userId === userId);
    const stackBefore = seatBefore ? Math.max(0, seatBefore.chips) : 0;
    if (userId > 0)
        recordTournamentElimination(tournamentId, userId);
    eng.leaveTable(userId);
    const stillSeated = eng.roomState.seats.some((s) => s.userId === userId);
    if (userId > 0 && !stillSeated && stackBefore === 0) {
        await prisma.registration.updateMany({
            where: { userId, tournamentId },
            data: { stackChips: null }
        });
    }
    await emitRoomState(tournamentId);
    res.json({ ok: true });
});
app.post("/api/admin/room/bot/add", auth, admin, async (req, res) => {
    const schema = z.object({
        tournamentId: z.number().int(),
        count: z.coerce.number().int().min(1).optional(),
        chips: z.coerce.number().int().min(1).optional()
    });
    const body = schema.parse(req.body);
    const eng = getOrCreateRoom(body.tournamentId);
    const freeSeats = eng.roomState.seats.filter((s) => !s.userId).length;
    const count = Math.max(1, body.count ?? 1);
    const chips = body.chips ?? 2000;
    const want = Math.min(count, freeSeats);
    const bots = Array.from({ length: want }, () => makeBotProfile(chips));
    try {
        const added = eng.addBots(bots);
        const tourStart = await prisma.tournament.findUnique({ where: { id: body.tournamentId }, select: { startsAt: true } });
        if (!isTournamentActive(body.tournamentId) &&
            tourStart != null &&
            isTournamentRoomOpen(tourStart.startsAt) &&
            eng.roomState.seats.filter((s) => s.userId).length >= eng.roomState.seats.length) {
            await tryStartTournamentPlay(body.tournamentId, "full");
        }
        else {
            await emitRoomState(body.tournamentId);
        }
        res.json({
            ok: true,
            requested: count,
            added,
            freeSeatsAfter: Math.max(0, freeSeats - added),
            bots: bots.slice(0, added).map((b) => ({ userId: b.userId, username: b.username, avatarUrl: b.avatarUrl }))
        });
    }
    catch (e) {
        res.status(400).json({ error: e.message ?? "Не удалось добавить ботов." });
    }
});
app.post("/api/admin/room/bot/remove", auth, admin, async (req, res) => {
    const schema = z.object({ tournamentId: z.number().int() });
    const { tournamentId } = schema.parse(req.body);
    const eng = getOrCreateRoom(tournamentId);
    if (eng.roomState.handActive || eng.roomState.showdownReveal || eng.roomState.handResultOverlay) {
        return res.status(400).json({ error: "Сначала завершите раздачу и показ карт." });
    }
    const removed = eng.removeAllBots();
    await emitRoomState(tournamentId);
    res.json({ ok: true, removed });
});
io.on("connection", (socket) => {
    const token = tokenFromHandshake(socket);
    if (!token || !sessions.has(token))
        return;
    const session = sessions.get(token);
    const uid = session.userId;
    socketConnectionCount.set(uid, (socketConnectionCount.get(uid) ?? 0) + 1);
    absentDisconnectUntil.delete(uid);
    socket.on("disconnect", () => {
        const n = (socketConnectionCount.get(uid) ?? 1) - 1;
        if (n <= 0) {
            socketConnectionCount.delete(uid);
            const s = sessions.get(token);
            if (s && s.activeTournamentId != null && uid > 0) {
                absentDisconnectUntil.set(uid, Date.now() + 2 * 60 * 1000);
            }
        }
        else {
            socketConnectionCount.set(uid, n);
        }
    });
    void (async () => {
        socket.join(`user:${session.userId}`);
        if (session.activeTournamentId == null)
            return;
        const tid = session.activeTournamentId;
        socket.join(`tournament:${tid}`);
        const eng = getRoom(tid);
        if (!eng)
            return;
        const tour = await prisma.tournament.findUnique({ where: { id: tid } });
        if (tour)
            eng.setTournamentBuyIn(tour.buyIn);
        const base = eng.visibleStateFor(session.userId);
        const reg = await prisma.registration.findUnique({
            where: { userId_tournamentId: { userId: session.userId, tournamentId: tid } }
        });
        const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { chips: true } });
        const seat = eng.roomState.seats.find((s) => s.userId === session.userId);
        const rebuy = tour != null && session.userId > 0
            ? buildRebuyPublicSync(tour, reg, seat != null, seat != null ? seat.chips : null, user?.chips ?? 0)
            : null;
        socket.emit("room_state", {
            ...base,
            rebuy,
            tournamentStarted: isTournamentActive(tid),
            tournamentAutoStartAt: tour ? new Date(autoStartAtMs(tour.startsAt)).toISOString() : null,
            tournamentFinished: Boolean(tour?.finishedAt),
            tournamentVictory: victoryPayloadForFinishedTournament(tid, tour)
        });
        socket.emit("chat_history", { tournamentId: tid, messages: getChatForTournament(tid) });
    })();
    socket.on("chat_send", async (payload) => {
        const token = tokenFromHandshake(socket);
        if (!token || !sessions.has(token))
            return;
        const session = sessions.get(token);
        const schema = z.object({
            tournamentId: z.number().int(),
            text: z.string().trim().min(1).max(400)
        });
        let body;
        try {
            body = schema.parse(payload);
        }
        catch {
            return;
        }
        if (session.activeTournamentId == null || session.activeTournamentId !== body.tournamentId)
            return;
        const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { telegramUsername: true, avatarUrl: true }
        });
        if (!user)
            return;
        const msg = {
            id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            tournamentId: body.tournamentId,
            ts: Date.now(),
            kind: "user",
            userId: session.userId,
            username: user.telegramUsername,
            avatarUrl: user.avatarUrl ?? null,
            text: body.text
        };
        pushChatMessage(msg);
    });
    socket.on("emotion_send", (payload) => {
        const token = tokenFromHandshake(socket);
        if (!token || !sessions.has(token))
            return;
        const session = sessions.get(token);
        const schema = z.object({
            tournamentId: z.number().int(),
            emotionId: z.string().min(1).max(32)
        });
        let body;
        try {
            body = schema.parse(payload);
        }
        catch {
            return;
        }
        if (session.activeTournamentId == null || session.activeTournamentId !== body.tournamentId)
            return;
        if (session.userId <= 0)
            return;
        if (!ALLOWED_TABLE_EMOTION_IDS.has(body.emotionId))
            return;
        const now = Date.now();
        const prev = lastTableEmotionAt.get(session.userId) ?? 0;
        if (now - prev < EMOTION_COOLDOWN_MS) {
            socket.emit("emotion_rejected", { reason: "cooldown" });
            return;
        }
        lastTableEmotionAt.set(session.userId, now);
        io.to(`tournament:${body.tournamentId}`).emit("table_emotion", {
            userId: session.userId,
            emotionId: body.emotionId,
            ts: now
        });
    });
});
/** —— Telegram: привязка аккаунта и API для бота (Bearer BOT_API_KEY) —— */
app.post("/api/telegram/bot/link-code", botApiAuth, asyncHandler(async (req, res) => {
    const schema = z.object({
        telegramId: z.union([z.string(), z.number(), z.bigint()]),
        telegramHandle: z.string().min(1).max(64).optional()
    });
    const body = schema.parse(req.body);
    const telegramId = normalizeTelegramId(body.telegramId);
    const handle = body.telegramHandle?.replace(/^@/, "").trim() || null;
    await prisma.telegramLinkCode.deleteMany({
        where: { OR: [{ expiresAt: { lt: new Date() } }, { telegramId }] }
    });
    let code = generateLinkCodeDigits();
    for (let attempt = 0; attempt < 12; attempt++) {
        try {
            const row = await prisma.telegramLinkCode.create({
                data: {
                    code,
                    telegramId,
                    telegramHandle: handle,
                    expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS)
                }
            });
            res.json({ code: row.code, expiresAt: row.expiresAt.toISOString() });
            return;
        }
        catch (e) {
            if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
                code = generateLinkCodeDigits();
                continue;
            }
            throw e;
        }
    }
    res.status(500).json({ error: "Не удалось сгенерировать код" });
}));
app.post("/api/telegram/link", auth, asyncHandler(async (req, res) => {
    const me = req.session;
    const body = z
        .object({
        code: z.string().min(1).max(32),
        userId: z.number().int().optional()
    })
        .parse(req.body);
    if (body.userId != null && body.userId !== me.userId) {
        return res.status(403).json({ error: "userId не совпадает с текущей сессией" });
    }
    const digits = body.code.replace(/\D/g, "").slice(0, 6);
    if (digits.length !== 6) {
        return res.status(400).json({ success: false, message: "Нужен 6-значный код", error: "Нужен 6-значный код" });
    }
    let telegramId;
    let telegramHandle = null;
    let fromBot = false;
    const via = await verifyLinkCodeViaTelegramBot(digits);
    if (via.ok) {
        telegramId = via.telegramId;
        telegramHandle = via.telegramHandle;
        fromBot = true;
    }
    else {
        const row = await prisma.telegramLinkCode.findUnique({ where: { code: digits } });
        if (!row || row.expiresAt.getTime() < Date.now()) {
            const hint = [
                !process.env.TELEGRAM_BOT_API_URL
                    ? "В server/.env добавьте TELEGRAM_BOT_API_URL=http://127.0.0.1:8787 (или URL, где слушает HTTP бота) и перезапустите API."
                    : null,
                via.reason.includes("401") || via.reason.includes("BOT_API_KEY")
                    ? "BOT_API_KEY в server/.env и telegram-bot/.env должен быть одинаковым."
                    : null,
                via.reason.includes("Нет связи") || via.reason.includes("fetch") || via.reason.includes("ECONNREFUSED")
                    ? "Запустите бота: npm run dev -w telegram-bot (или npm run dev:stack). Порт HTTP бота по умолчанию 8787."
                    : null,
                "Код живёт 5 минут — в Telegram снова /link и введите новый код."
            ]
                .filter(Boolean)
                .join(" ");
            return res.status(400).json({
                success: false,
                message: "Неверный или просроченный код",
                error: "Неверный или просроченный код",
                detail: via.reason,
                hint: hint || undefined
            });
        }
        telegramId = row.telegramId;
        telegramHandle = row.telegramHandle;
    }
    const conflict = await prisma.user.findFirst({
        where: { telegramId, NOT: { id: me.userId } }
    });
    if (conflict) {
        return res.status(409).json({
            success: false,
            message: "Этот Telegram уже привязан к другому аккаунту",
            error: "Этот Telegram уже привязан к другому аккаунту"
        });
    }
    const self = await prisma.user.findUnique({ where: { id: me.userId }, select: { telegramId: true } });
    if (self?.telegramId) {
        return res.status(400).json({
            success: false,
            message: "Сначала отвяжите текущий Telegram",
            error: "Сначала отвяжите текущий Telegram"
        });
    }
    if (!fromBot) {
        await prisma.$transaction([
            prisma.telegramLinkCode.delete({ where: { code: digits } }),
            prisma.user.update({
                where: { id: me.userId },
                data: { telegramId, telegramLinkHandle: telegramHandle }
            })
        ]);
    }
    else {
        await prisma.user.update({
            where: { id: me.userId },
            data: { telegramId, telegramLinkHandle: telegramHandle }
        });
    }
    void notifyTelegramBotAccountLinked(telegramId);
    res.json({
        success: true,
        message: "Telegram успешно привязан к аккаунту"
    });
}));
app.post("/api/telegram/unlink-by-telegram", botApiAuth, asyncHandler(async (req, res) => {
    const { telegramId } = z
        .object({ telegramId: z.union([z.string(), z.number(), z.bigint()]) })
        .parse(req.body);
    const tid = normalizeTelegramId(telegramId);
    const r = await prisma.user.updateMany({
        where: { telegramId: tid },
        data: { telegramId: null, telegramLinkHandle: null }
    });
    res.json({ success: r.count > 0, message: r.count > 0 ? "Отвязано" : "Пользователь не найден" });
}));
app.post("/api/telegram/unlink", auth, asyncHandler(async (req, res) => {
    const me = req.session;
    await prisma.user.update({
        where: { id: me.userId },
        data: { telegramId: null, telegramLinkHandle: null }
    });
    res.json({ success: true });
}));
app.get("/api/bot/verify", botApiAuth, asyncHandler(async (req, res) => {
    const raw = String(req.query.code ?? "");
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    if (digits.length !== 6)
        return res.status(400).json({ error: "Invalid or expired code" });
    const row = await prisma.telegramLinkCode.findUnique({ where: { code: digits } });
    if (!row || row.expiresAt.getTime() < Date.now()) {
        return res.status(400).json({ error: "Invalid or expired code" });
    }
    await prisma.telegramLinkCode.delete({ where: { code: digits } });
    res.json({ telegramId: row.telegramId });
}));
app.get("/api/telegram/balance", botApiAuth, asyncHandler(async (req, res) => {
    let telegramId;
    try {
        telegramId = normalizeTelegramId(req.query.telegramId);
    }
    catch {
        return res.status(400).json({ error: "telegramId required" });
    }
    const user = await prisma.user.findUnique({
        where: { telegramId },
        select: { chips: true }
    });
    if (!user)
        return res.status(404).json({ error: "User not found" });
    res.json({ balance: user.chips, currency: "chips" });
}));
app.post("/api/telegram/deposit", botApiAuth, asyncHandler(async (req, res) => {
    const schema = z.object({
        telegramId: z.union([z.string(), z.number(), z.bigint()]),
        amountRub: z.number().int().min(0).optional(),
        amountChips: z.number().int().min(1)
    });
    const body = schema.parse(req.body);
    const telegramId = normalizeTelegramId(body.telegramId);
    const rub = body.amountRub ?? 0;
    const amountChips = body.amountChips;
    const desc = rub > 0 ? `Пополнение ${rub} руб → ${amountChips} фишек` : `Пополнение → ${amountChips} фишек`;
    const target = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
    if (!target)
        return res.status(404).json({ error: "User not found" });
    const newBalance = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
            where: { id: target.id },
            data: { chips: { increment: amountChips } },
            select: { chips: true }
        });
        await tx.transaction.create({
            data: {
                userId: target.id,
                type: "deposit",
                amount: amountChips,
                description: desc
            }
        });
        return updated.chips;
    });
    res.json({ success: true, newBalance });
}));
app.get("/api/telegram/tournaments", botApiAuth, asyncHandler(async (_req, res) => {
    const tours = await prisma.tournament.findMany({
        where: { finishedAt: null },
        orderBy: { startsAt: "asc" }
    });
    const tournaments = await Promise.all(tours.map(async (t) => {
        const participants = await prisma.registration.count({
            where: { tournamentId: t.id, approved: true }
        });
        return {
            id: t.id,
            name: t.title,
            startAt: t.startsAt.toISOString(),
            buyIn: t.buyIn,
            participants,
            maxPlayers: t.maxSeats
        };
    }));
    res.json({ tournaments });
}));
app.get("/api/telegram/history", botApiAuth, asyncHandler(async (req, res) => {
    let telegramId;
    try {
        telegramId = normalizeTelegramId(req.query.telegramId);
    }
    catch {
        return res.status(400).json({ error: "telegramId required" });
    }
    const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
    if (!user)
        return res.status(404).json({ error: "User not found" });
    const rows = await prisma.transaction.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 10
    });
    const history = rows.map((r) => ({
        date: r.createdAt.toISOString(),
        type: r.type,
        amount: r.amount,
        description: r.description
    }));
    res.json({ history });
}));
app.post("/api/telegram/register", botApiAuth, asyncHandler(async (req, res) => {
    const schema = z.object({
        telegramId: z.union([z.string(), z.number(), z.bigint()]),
        tournamentId: z.number().int()
    });
    const body = schema.parse(req.body);
    const telegramId = normalizeTelegramId(body.telegramId);
    const { tournamentId } = body;
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user)
        return res.status(404).json({ error: "User not found" });
    if (user.accountStatus !== AccountStatus.ACTIVE)
        return res.status(403).json({ error: "Account not active" });
    const tour = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    if (!tour || tour.finishedAt)
        return res.status(400).json({ error: "Tournament not available" });
    const participants = await prisma.registration.count({
        where: { tournamentId, approved: true }
    });
    if (participants >= tour.maxSeats)
        return res.status(400).json({ error: "Tournament is full" });
    const reg = await prisma.registration.findUnique({
        where: { userId_tournamentId: { userId: user.id, tournamentId } }
    });
    if (reg?.approved && reg.stackChips != null) {
        return res.json({ success: true, alreadyRegistered: true, newBalance: user.chips });
    }
    if (user.chips < tour.buyIn)
        return res.status(400).json({ error: "Insufficient chips" });
    const newBalance = await prisma.$transaction(async (tx) => {
        await tx.user.update({
            where: { id: user.id },
            data: { chips: { decrement: tour.buyIn } }
        });
        await tx.registration.upsert({
            where: { userId_tournamentId: { userId: user.id, tournamentId } },
            create: {
                userId: user.id,
                tournamentId,
                approved: true,
                stackChips: tour.buyIn
            },
            update: { approved: true, stackChips: tour.buyIn }
        });
        await tx.transaction.create({
            data: {
                userId: user.id,
                type: "registration",
                amount: -tour.buyIn,
                description: `Бай-ин: ${tour.title}`
            }
        });
        const u1 = await tx.user.findUnique({ where: { id: user.id }, select: { chips: true } });
        return u1.chips;
    });
    res.json({ success: true, newBalance });
}));
/** В production отдаём SPA из web/dist с того же origin, что и /api (если папка есть после сборки). */
const webDistPath = path.resolve(__dirname, "..", "..", "web", "dist");
const serveWebFromNode = (process.env.NODE_ENV === "production" || process.env.SERVE_WEB === "1") && fs.existsSync(webDistPath);
if (serveWebFromNode) {
    app.use(express.static(webDistPath));
    app.get("*", (req, res, next) => {
        if (req.method !== "GET")
            return next();
        if (req.path.startsWith("/api") || req.path.startsWith("/socket.io"))
            return next();
        res.sendFile(path.join(webDistPath, "index.html"), (err) => {
            if (err)
                next(err);
        });
    });
}
app.use((err, _req, res, _next) => {
    if (res.headersSent) {
        console.error("[HTTP] after headersSent", err);
        return;
    }
    console.error("[HTTP]", err);
    if (err instanceof ZodError) {
        return res.status(400).json({
            error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")
        });
    }
    if (err instanceof PrismaClientKnownRequestError) {
        if (err.code === "P2002") {
            return res.status(409).json({ error: "Такая запись уже существует" });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err instanceof PrismaClientValidationError) {
        return res.status(400).json({ error: "Некорректные данные для БД" });
    }
    if (err instanceof PrismaClientInitializationError) {
        return res.status(503).json({
            error: "База данных недоступна. Проверьте DATABASE_URL и что выполнены миграции: npx prisma migrate deploy"
        });
    }
    const msg = err instanceof Error ? err.message : "Internal error";
    const expose = process.env.NODE_ENV !== "production" || process.env.SERVER_DEBUG === "1" || process.env.SERVER_DEBUG === "true";
    const body = {
        error: expose ? msg : "Внутренняя ошибка сервера",
        ...(expose ? {} : { code: "INTERNAL" })
    };
    try {
        res.status(500).setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(body));
    }
    catch (sendErr) {
        console.error("[HTTP] не удалось отправить JSON ошибки", sendErr);
        res.status(500).type("text").send(expose ? msg : "Internal Server Error");
    }
});
const port = Number(process.env.PORT) || 3001;
void (async () => {
    try {
        await prisma.$connect();
        console.log("[prisma] База данных доступна");
    }
    catch (e) {
        console.error("[prisma] Не удалось подключиться к БД. Выполните из корня проекта: npx prisma migrate deploy\n", e);
        process.exit(1);
    }
    httpServer.listen(port, () => {
        console.log(`Server listening on port ${port}`);
        setInterval(() => {
            void (async () => {
                await tickTournamentAutoStart();
                await processPaidNoSeatDeadline();
                await processAbsentDisconnectKick();
                for (const eng of allRooms()) {
                    const tid = eng.tournamentId;
                    let progressed = false;
                    if (eng.tickBlindLevel(Date.now())) {
                        await emitRoomState(tid);
                        progressed = true;
                    }
                    while (eng.tickBotAction()) {
                        await emitRoomState(tid);
                        progressed = true;
                    }
                    if (eng.tickShowdownPhase()) {
                        await emitRoomState(tid);
                        progressed = true;
                    }
                    if (eng.tickHandResultPause()) {
                        await emitRoomState(tid);
                        progressed = true;
                    }
                    if (!progressed && eng.tickActionTimeout())
                        await emitRoomState(tid);
                }
                await eliminateBustedPlayersIfNeeded();
                for (const eng of allRooms()) {
                    await maybeFinalizeTournament(eng.tournamentId);
                }
            })();
        }, 500);
    });
})();
process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
});
setHandStatsRecorder(async (rows) => {
    try {
        for (const { userId, startChips, endChips, tournamentId, handNumber, smallBlind, bigBlind, blindLevel } of rows) {
            if (userId < 0)
                continue;
            const delta = endChips - startChips;
            const incW = delta > 0 ? 1 : 0;
            const incL = delta < 0 ? 1 : 0;
            const incF = Math.max(0, delta);
            const data = {};
            if (incW)
                data.wins = { increment: incW };
            if (incL)
                data.losses = { increment: incL };
            if (incF > 0)
                data.totalChipsWon = { increment: incF };
            if (Object.keys(data).length > 0)
                await prisma.user.update({ where: { id: userId }, data });
            await prisma.handStackPoint.upsert({
                where: {
                    tournamentId_userId_handNumber: { tournamentId, userId, handNumber }
                },
                create: {
                    tournamentId,
                    userId,
                    handNumber,
                    stackChips: endChips,
                    startChips,
                    deltaChips: delta,
                    smallBlind,
                    bigBlind,
                    blindLevel
                },
                update: {
                    stackChips: endChips,
                    startChips,
                    deltaChips: delta,
                    smallBlind,
                    bigBlind,
                    blindLevel
                }
            });
        }
    }
    catch (e) {
        console.error("hand stats", e);
    }
});
setAnalyticsPreflopCollector(async ({ tournamentId, handNumber, rows }) => {
    try {
        if (rows.length === 0)
            return;
        await prisma.analyticsPreflopAction.createMany({
            data: rows.map((r) => ({
                tournamentId,
                userId: r.userId,
                handNumber,
                seat: r.seat,
                dealerSeat: r.dealerSeat,
                seatCount: r.seatCount,
                positionBucket: r.positionBucket,
                action: r.action,
                facingBet: r.facingBet,
                isThreeBet: r.isThreeBet
            }))
        });
    }
    catch (e) {
        console.error("analytics preflop", e);
    }
});
setTournamentStackPersister(async (rows) => {
    try {
        await persistTournamentStacks(rows);
    }
    catch (e) {
        console.error("tournament stack persist", e);
    }
});
setHandWinnerChatNotifier((tournamentId, text) => {
    pushChatMessage(makeSystemChatMessage(tournamentId, text));
});
setTournamentLeaveCashouter(async (userId, tournamentId, stackChips) => {
    try {
        const tour = await prisma.tournament.findUnique({
            where: { id: tournamentId },
            select: { finishedAt: true }
        });
        if (tour?.finishedAt) {
            await prisma.registration.updateMany({
                where: { userId, tournamentId },
                data: { stackChips: null }
            });
            return;
        }
        await prisma.$transaction([
            prisma.user.update({
                where: { id: userId },
                data: { chips: { increment: stackChips } }
            }),
            prisma.registration.updateMany({
                where: { userId, tournamentId },
                data: { stackChips: null }
            })
        ]);
        console.log(`[tournament-cashout] userId=${userId} tournamentId=${tournamentId} chips=${stackChips} (stack returned to account balance)`);
    }
    catch (e) {
        console.error("tournament leave cashout", e);
    }
});
