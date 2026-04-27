import { randomInt } from "node:crypto";

export type HandStatDelta = {
  tournamentId: number;
  handNumber: number;
  smallBlind: number;
  bigBlind: number;
  blindLevel: number;
  userId: number;
  startChips: number;
  endChips: number;
};

export type AnalyticsPreflopRow = {
  userId: number;
  seat: number;
  dealerSeat: number;
  seatCount: number;
  positionBucket: string;
  action: ActionType;
  facingBet: boolean;
  isThreeBet: boolean;
};

let handStatsRecorder: ((rows: HandStatDelta[]) => void | Promise<void>) | null = null;
let analyticsPreflopCollector:
  | ((payload: { tournamentId: number; handNumber: number; rows: AnalyticsPreflopRow[] }) => void | Promise<void>)
  | null = null;
let tournamentStackPersist: ((rows: { userId: number; chips: number }[]) => void | Promise<void>) | null =
  null;

/** Возврат турнирного стека на баланс аккаунта при снятии игрока (leave / kick / конец олл-ин leave). */
let tournamentLeaveCashout:
  | ((userId: number, tournamentId: number, stackChips: number) => void | Promise<void>)
  | null = null;

export const setHandStatsRecorder = (fn: (rows: HandStatDelta[]) => void | Promise<void>) => {
  handStatsRecorder = fn;
};

export const setAnalyticsPreflopCollector = (
  fn: ((payload: { tournamentId: number; handNumber: number; rows: AnalyticsPreflopRow[] }) => void | Promise<void>) | null
) => {
  analyticsPreflopCollector = fn;
};

export const setTournamentStackPersister = (
  fn: ((rows: { userId: number; chips: number }[]) => void | Promise<void>) | null
) => {
  tournamentStackPersist = fn;
};

export const setTournamentLeaveCashouter = (
  fn: ((userId: number, tournamentId: number, stackChips: number) => void | Promise<void>) | null
) => {
  tournamentLeaveCashout = fn;
};

let handWinnerChatNotifier: ((tournamentId: number, text: string) => void | Promise<void>) | null = null;

export const setHandWinnerChatNotifier = (
  fn: ((tournamentId: number, text: string) => void | Promise<void>) | null
) => {
  handWinnerChatNotifier = fn;
};

export type Street = "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN";
export type ActionType = "FOLD" | "CHECK" | "CALL" | "RAISE" | "ALL_IN";
type ActionBadgeType = "fold" | "check" | "call" | "raise" | "allin";

export interface SeatState {
  seat: number;
  userId: number | null;
  username: string | null;
  chips: number;
  hand: string[];
  folded: boolean;
  allIn: boolean;
  bet: number;
  committedThisHand: number;
}

export interface SidePot {
  amount: number;
  eligibleSeats: number[];
}

export type ShowdownReveal = {
  board: string[];
  deadlineAt: number;
  winnerChoice: Record<number, "pending" | "show" | "muck">;
  handLabels: Record<number, string>;
  handTitles: Record<number, string>;
  winnerLine: string;
  reasonLine: string;
  winnerIds: number[];
  loserIds: number[];
};

export interface RoomState {
  open: boolean;
  password: string;
  seats: SeatState[];
  board: string[];
  pot: number;
  sidePots: SidePot[];
  dealerSeat: number;
  turnSeat: number | null;
  street: Street;
  currentBet: number;
  minRaiseIncrement: number;
  smallBlind: number;
  bigBlind: number;
  handActive: boolean;
  history: string[];
  turnDeadlineAt: number | null;
  showdownReveal: ShowdownReveal | null;
  /** Пауза после победы без шоудауна; не отдаётся клиенту напрямую (см. handResultBanner). */
  handResultOverlay: { winnerLine: string; reasonLine: string; dismissAt: number; winnerUserIds?: number[] } | null;
}

const DEFAULT_SEATS = 6;
const MIN_SEATS = 2;
const MAX_SEATS_CAP = 9;
const ACTION_MS = 30_000;
const ACTION_BADGE_MS = 1_900;
/** Карты всех дошедших до вскрытия и борд остаются на столе минимум это время (мс). */
const SHOWDOWN_PHASE_MS = 5_000;
/** Удвоение блайндов каждые 20 минут (от первой раздачи с заданным бай-ином). */
const BLIND_LEVEL_MS = 20 * 60 * 1000;

/** Тестовый бот в комнате; отрицательные id не пишутся в БД. */
export const BOT_SA_USER_ID = -1000;
export const isBotUserId = (id: number) => id < 0;

function positionBucket(seat: number, dealerSeat: number, n: number): string {
  if (n < 2) return "EP";
  const o = (seat - dealerSeat + n) % n;
  if (o === 0) return "BTN";
  if (o === 1) return "SB";
  if (o === 2) return "BB";
  if (n <= 4) return o === 3 ? "EP" : "CO";
  if (o === 3 || o === 4) return "EP";
  if (o === 5) return "CO";
  return "MP";
}

export function createRoomEngine(tournamentId: number) {
  let handStartStacks = new Map<number, number>();
  let handsDealt = 0;
  /** Последняя завершённая раздача (для экрана победы турнира); не сбрасывается до resetGame. */
  let lastPublicHandOutcome: { winnerLine: string; reasonLine: string; bestHandTitle: string | null } | null = null;
  let analyticsPreflopBuffer: AnalyticsPreflopRow[] = [];
  let preflopRaiseCount = 0;

const seatCount = () => roomState.seats.length;

const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const suits = ["c", "d", "h", "s"];

const makeDeck = () => suits.flatMap((s) => ranks.map((r) => `${r}${s}`));

const secureShuffle = <T>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Игрок в олл-ине запросил выход: снимаем с места после завершения раздачи. */
let pendingLeaveAfterHand = new Set<number>();
let pendingJoinAfterHand = new Map<number, { seat: number; userId: number; username: string; chips: number }>();
let lastActionByUser = new Map<number, { kind: ActionBadgeType; label: string; at: number }>();

/** Бай-ин турнира (фишки): SB = 0.5%, BB = 1%; null — дефолтные блайнды стола. */
let tournamentBuyIn: number | null = null;
/** Момент старта «турнирных часов» блайндов (первая раздача после настройки бай-ина). */
let blindClockStartedAt: number | null = null;
let lastAppliedBlindLevel = 0;

const baseBlindsFromBuyIn = (buyIn: number): { sb: number; bb: number } => {
  const bi = Math.max(1, Math.floor(buyIn));
  const sb = Math.max(1, Math.round(bi * 0.005));
  const bbPct = Math.round(bi * 0.01);
  const bb = Math.max(sb * 2, Math.max(2, bbPct));
  return { sb, bb };
};

const blindsForBuyInAndLevel = (buyIn: number, level: number): { sb: number; bb: number } => {
  const { sb, bb } = baseBlindsFromBuyIn(buyIn);
  const m = 2 ** Math.max(0, level);
  return { sb: Math.max(1, sb * m), bb: Math.max(2, bb * m) };
};

const getCurrentBlindLevel = (now: number): number => {
  if (tournamentBuyIn == null || blindClockStartedAt == null) return 0;
  return Math.max(0, Math.floor((now - blindClockStartedAt) / BLIND_LEVEL_MS));
};

const applyBlindsForLevel = (level: number) => {
  if (tournamentBuyIn == null) return;
  const { sb, bb } = blindsForBuyInAndLevel(tournamentBuyIn, level);
  roomState.smallBlind = sb;
  roomState.bigBlind = bb;
  lastAppliedBlindLevel = level;
  if (!roomState.handActive) roomState.minRaiseIncrement = bb;
};

let roomState: RoomState = {
  open: false,
  password: "",
  seats: Array.from({ length: DEFAULT_SEATS }, (_, i) => ({
    seat: i + 1,
    userId: null,
    username: null,
    chips: 0,
    hand: [],
    folded: false,
    allIn: false,
    bet: 0,
    committedThisHand: 0
  })),
  board: [],
  pot: 0,
  sidePots: [],
  dealerSeat: 1,
  turnSeat: null,
  street: "PREFLOP",
  currentBet: 0,
  minRaiseIncrement: 20,
  smallBlind: 10,
  bigBlind: 20,
  handActive: false,
  history: [],
  turnDeadlineAt: null,
  showdownReveal: null,
  handResultOverlay: null
};

const emitHandWinnerChatLine = (text: string) => {
  if (!handWinnerChatNotifier || !text) return;
  void Promise.resolve(handWinnerChatNotifier(tournamentId, text)).catch(() => {});
};

const buildShowdownWinnerChat = (sr: ShowdownReveal): string => {
  const ids = sr.winnerIds;
  if (ids.length === 1) {
    const uid = ids[0];
    const nick = roomState.seats.find((x) => x.userId === uid)?.username?.replace(/^@/, "") ?? "?";
    const combo = comboShortRuFromTitle(sr.handTitles[uid] ?? "");
    return `🏆 ${nick} выиграл раздачу с комбинацией ${combo}`;
  }
  const parts = ids.map((uid) => {
    const nick = roomState.seats.find((x) => x.userId === uid)?.username?.replace(/^@/, "") ?? "?";
    const combo = comboShortRuFromTitle(sr.handTitles[uid] ?? "");
    return `${nick} (${combo})`;
  });
  return `🏆 Ничья: ${parts.join(", ")}`;
};

const actedThisStreet = new Set<number>();

const syncPot = () => {
  const inBets = roomState.seats.reduce((s, x) => s + x.bet, 0);
  const inPots = roomState.sidePots.reduce((s, p) => s + p.amount, 0);
  roomState.pot = inBets + inPots;
};

const nextSeatNum = (fromSeat: number) => (fromSeat % seatCount()) + 1;

const nextOccupiedFrom = (fromSeat: number): number | null => {
  const n = seatCount();
  let s = nextSeatNum(fromSeat);
  for (let k = 0; k < n; k += 1) {
    if (roomState.seats[s - 1].userId) return s;
    s = nextSeatNum(s);
  }
  return null;
};

const firstFreeSeat = (): number | null => {
  const free = roomState.seats.find((s) => !s.userId);
  return free ? free.seat : null;
};

const occupiedSeatsOrdered = () =>
  roomState.seats.filter((s) => s.userId && s.chips > 0).sort((a, b) => a.seat - b.seat);

const nonFoldedWithCards = () => roomState.seats.filter((s) => s.userId && !s.folded);

const canVoluntarilyAct = (s: SeatState) => Boolean(s.userId && s.chips > 0 && !s.folded && !s.allIn);

const nextToActFrom = (fromSeat: number): number | null => {
  const n = seatCount();
  let s = nextSeatNum(fromSeat);
  for (let k = 0; k < n; k += 1) {
    const st = roomState.seats[s - 1];
    if (canVoluntarilyAct(st)) return s;
    s = nextSeatNum(s);
  }
  return null;
};

const getSmallBlindSeat = (): number | null => {
  const o = occupiedSeatsOrdered();
  if (o.length < 2) return null;
  if (o.length === 2) return roomState.dealerSeat;
  const d = roomState.dealerSeat;
  return nextOccupiedFrom(d);
};

const getBigBlindSeat = (): number | null => {
  const sb = getSmallBlindSeat();
  if (sb == null) return null;
  return nextOccupiedFrom(sb);
};

const getFirstToActPreflop = (): number | null => {
  const o = occupiedSeatsOrdered();
  if (o.length < 2) return null;
  if (o.length === 2) return roomState.dealerSeat;
  const bb = getBigBlindSeat();
  if (bb == null) return null;
  return nextOccupiedFrom(bb);
};

const getFirstToActPostFlop = (): number | null => nextToActFrom(roomState.dealerSeat);

const getRecentAction = (uid: number) => {
  const rec = lastActionByUser.get(uid);
  if (!rec) return null;
  if (Date.now() - rec.at > ACTION_BADGE_MS) return null;
  return rec;
};

const setDeadline = () => {
  if (roomState.handActive && roomState.turnSeat) roomState.turnDeadlineAt = Date.now() + ACTION_MS;
  else roomState.turnDeadlineAt = null;
};

const tickActionTimeout = (): boolean => {
  if (roomState.showdownReveal) return false;
  if (!roomState.handActive || !roomState.turnSeat || !roomState.turnDeadlineAt) return false;
  if (Date.now() < roomState.turnDeadlineAt) return false;
  const st = roomState.seats.find((s) => s.seat === roomState.turnSeat);
  if (!st?.userId) return false;
  try {
    applyActionInternal(st.userId, "FOLD");
    return true;
  } catch {
    return false;
  }
};

const visibleStateFor = (userId: number | null) => {
  const sr = roomState.showdownReveal;
  const boardOut = sr ? sr.board : roomState.board;

  let handWinnerBadge: { userIds: number[]; comboByUserId: Record<number, string> } | null = null;
  if (sr) {
    const comboByUserId: Record<number, string> = {};
    for (const uid of sr.winnerIds) {
      comboByUserId[uid] = comboShortRuFromTitle(sr.handTitles[uid] ?? "");
    }
    handWinnerBadge = { userIds: [...sr.winnerIds], comboByUserId };
  } else if (roomState.handResultOverlay?.winnerUserIds?.length) {
    const comboByUserId: Record<number, string> = {};
    for (const uid of roomState.handResultOverlay.winnerUserIds) {
      comboByUserId[uid] = "Победа без вскрытия";
    }
    handWinnerBadge = {
      userIds: [...roomState.handResultOverlay.winnerUserIds],
      comboByUserId
    };
  }

  const seatView = (s: SeatState) => {
    const uid = s.userId;
    if (!uid) {
      return {
        ...s,
        hand: [] as string[],
        handLabel: null as string | null,
        showdownChoice: undefined as undefined,
        isBot: false as const
      };
    }

    if (sr) {
      const isWinner = sr.winnerIds.includes(uid);
      const label = sr.handLabels[uid] ?? null;
      const handTitle = sr.handTitles[uid] ?? null;
      const ra = getRecentAction(uid);
      return {
        ...s,
        hand: s.hand,
        handLabel: label,
        handTitle,
        recentAction: ra?.label ?? null,
        recentActionKind: ra?.kind ?? null,
        isShowdownWinner: isWinner,
        showdownChoice: undefined,
        isBot: isBotUserId(uid)
      };
    }

    const showAll = !roomState.handActive && roomState.street === "SHOWDOWN" && boardOut.length === 5;
    const ra = getRecentAction(uid);
    return {
      ...s,
      hand:
        showAll && s.hand.length === 2
          ? s.hand
          : s.userId === userId
            ? s.hand
            : s.hand.length
              ? ["XX", "XX"]
              : [],
      handLabel: null as string | null,
      handTitle: null as string | null,
      recentAction: ra?.label ?? null,
      recentActionKind: ra?.kind ?? null,
      isShowdownWinner: false as const,
      showdownChoice: undefined as undefined,
      isBot: isBotUserId(uid)
    };
  };

  const { handResultOverlay: _hr, ...publicState } = roomState;
  void _hr;

  return {
    ...publicState,
    handResultBanner: null,
    handWinnerBadge,
    board: boardOut,
    seats: roomState.seats.map(seatView)
  };
};

const straightHighCard = (ranksDesc: number[]) => {
  const uniq = Array.from(new Set(ranksDesc)).sort((a, b) => b - a);
  if (uniq[0] === 14) uniq.push(1);
  for (let i = 0; i <= uniq.length - 5; i += 1) {
    const w = uniq.slice(i, i + 5);
    let ok = true;
    for (let j = 0; j < 4; j += 1) {
      if (w[j] - 1 !== w[j + 1]) {
        ok = false;
        break;
      }
    }
    if (ok) return w[0] === 1 ? 5 : w[0];
  }
  return 0;
};

const rankValue = (card: string) => {
  const r = card[0];
  if (r >= "2" && r <= "9") return Number(r);
  if (r === "T") return 10;
  if (r === "J") return 11;
  if (r === "Q") return 12;
  if (r === "K") return 13;
  return 14;
};

const evaluate7 = (cards: string[]) => {
  const bySuit = new Map<string, number[]>();
  const counts = new Map<number, number>();
  const ranksDesc = cards.map(rankValue).sort((a, b) => b - a);

  cards.forEach((c) => {
    const suit = c[1];
    const rv = rankValue(c);
    bySuit.set(suit, [...(bySuit.get(suit) ?? []), rv]);
    counts.set(rv, (counts.get(rv) ?? 0) + 1);
  });

  const flushSuit = Array.from(bySuit.entries()).find(([, rs]) => rs.length >= 5)?.[0];
  const flushRanks = flushSuit ? (bySuit.get(flushSuit) ?? []).sort((a, b) => b - a) : [];
  const sfHigh = flushRanks.length ? straightHighCard(flushRanks) : 0;
  if (sfHigh) {
    if (sfHigh === 14) return [9, 14];
    return [8, sfHigh];
  }

  const groups = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });
  const fours = groups.filter((g) => g[1] === 4).map((g) => g[0]);
  const threes = groups.filter((g) => g[1] === 3).map((g) => g[0]);
  const pairs = groups.filter((g) => g[1] === 2).map((g) => g[0]);

  if (fours.length) {
    const kicker = ranksDesc.find((r) => r !== fours[0]) ?? 0;
    return [7, fours[0], kicker];
  }
  if (threes.length && (threes.length > 1 || pairs.length)) {
    const top3 = threes[0];
    const top2 = threes.length > 1 ? threes[1] : pairs[0];
    return [6, top3, top2];
  }
  if (flushRanks.length) return [5, ...Array.from(new Set(flushRanks)).slice(0, 5)];

  const straightHigh = straightHighCard(ranksDesc);
  if (straightHigh) return [4, straightHigh];

  if (threes.length) {
    const kickers = ranksDesc.filter((r) => r !== threes[0]).slice(0, 2);
    return [3, threes[0], ...kickers];
  }
  if (pairs.length >= 2) {
    const top = pairs[0];
    const second = pairs[1];
    const kicker = ranksDesc.find((r) => r !== top && r !== second) ?? 0;
    return [2, top, second, kicker];
  }
  if (pairs.length) {
    const p = pairs[0];
    const kickers = ranksDesc.filter((r) => r !== p).slice(0, 3);
    return [1, p, ...kickers];
  }
  return [0, ...ranksDesc.slice(0, 5)];
};

const compareScore = (a: number[], b: number[]) => {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
};

const rankWordHigh = (r: number): string => {
  switch (r) {
    case 14:
      return "туз";
    case 13:
      return "король";
    case 12:
      return "дама";
    case 11:
      return "валет";
    case 10:
      return "десятка";
    case 9:
      return "девятка";
    case 8:
      return "восьмёрка";
    case 7:
      return "семёрка";
    case 6:
      return "шестёрка";
    case 5:
      return "пятёрка";
    case 4:
      return "четвёрка";
    case 3:
      return "тройка";
    default:
      return "двойка";
  }
};

const rankWordPairPhrase = (r: number): string => {
  switch (r) {
    case 14:
      return "тузы";
    case 13:
      return "короли";
    case 12:
      return "дамы";
    case 11:
      return "валеты";
    case 10:
      return "десятки";
    case 9:
      return "девятки";
    case 8:
      return "восьмёрки";
    case 7:
      return "семёрки";
    case 6:
      return "шестёрки";
    case 5:
      return "пятёрки";
    case 4:
      return "четвёрки";
    case 3:
      return "тройки";
    default:
      return "двойки";
  }
};

const pairGrammar = (r: number): string => {
  switch (r) {
    case 14:
      return "пара тузов";
    case 13:
      return "пара королей";
    case 12:
      return "пара дам";
    case 11:
      return "пара валетов";
    case 10:
      return "пара десяток";
    default:
      return `пара ${rankWordPairPhrase(r)}`;
  }
};

const comboTitleRuEn = (score: number[]): string => {
  const cat = score[0] ?? 0;
  if (cat === 9) return "Роял-флэш / Royal Flush";
  if (cat === 8) return "Стрит-флэш / Straight Flush";
  if (cat === 7) return "Каре / Four of a Kind";
  if (cat === 6) return "Фулл-хаус / Full House";
  if (cat === 5) return "Флэш / Flush";
  if (cat === 4) return "Стрит / Straight";
  if (cat === 3) return "Сет / Three of a Kind";
  if (cat === 2) return "Две пары / Two Pair";
  if (cat === 1) return "Пара / One Pair";
  return "Старшая карта / High Card";
};

/** Короткое русское название комбинации из строки вида «Флэш / Flush». */
const comboShortRuFromTitle = (fullTitle: string): string => {
  const i = fullTitle.indexOf(" / ");
  if (i === -1) return fullTitle.trim();
  return fullTitle.slice(0, i).trim();
};

const formatComboDetail = (score: number[]): string => {
  const cat = score[0] ?? 0;
  if (cat === 9) return "Роял-флэш";
  if (cat === 8) return `Стрит-флэш, старшая карта — ${rankWordHigh(score[1] ?? 0)}`;
  if (cat === 7) {
    const q = score[1] ?? 0;
    const k = score[2] ?? 0;
    return `Каре ${rankWordPairPhrase(q)}, кикер — ${rankWordHigh(k)}`;
  }
  if (cat === 6) {
    const trips = score[1] ?? 0;
    const pr = score[2] ?? 0;
    return `Фулл-хаус — тройка ${rankWordPairPhrase(trips)}, ${pairGrammar(pr)}`;
  }
  if (cat === 5) {
    const rs = score.slice(1, 6).filter((x) => x > 0);
    const tail = rs.map((x) => rankWordHigh(x)).join(", ");
    return `Флэш — ${tail}`;
  }
  if (cat === 4) {
    const hi = score[1] ?? 0;
    if (hi === 5) return "Стрит от туза до пятёрки (колесо)";
    return `Стрит, старшая — ${rankWordHigh(hi)}`;
  }
  if (cat === 3) {
    const t = score[1] ?? 0;
    const k1 = score[2] ?? 0;
    const k2 = score[3] ?? 0;
    return `Сет ${rankWordPairPhrase(t)}, кикеры — ${rankWordHigh(k1)}, ${rankWordHigh(k2)}`;
  }
  if (cat === 2) {
    const hi = score[1] ?? 0;
    const lo = score[2] ?? 0;
    const k = score[3] ?? 0;
    return `Две пары — ${pairGrammar(hi)} и ${pairGrammar(lo)}, кикер — ${rankWordHigh(k)}`;
  }
  if (cat === 1) {
    const p = score[1] ?? 0;
    const k1 = score[2] ?? 0;
    const k2 = score[3] ?? 0;
    const k3 = score[4] ?? 0;
    return `${pairGrammar(p)}, кикеры — ${rankWordHigh(k1)}, ${rankWordHigh(k2)}, ${rankWordHigh(k3)}`;
  }
  const hi = score[1] ?? 0;
  const k1 = score[2] ?? 0;
  const k2 = score[3] ?? 0;
  const k3 = score[4] ?? 0;
  const k4 = score[5] ?? 0;
  return `Старшая карта — ${rankWordHigh(hi)}, кикеры — ${rankWordHigh(k1)}, ${rankWordHigh(k2)}, ${rankWordHigh(k3)}, ${rankWordHigh(k4)}`;
};

const buildWinnerAnnouncementLines = (
  winnerIds: number[],
  boardCards: string[]
): { winnerLine: string; reasonLine: string } => {
  const tag = (uid: number) => {
    const s = roomState.seats.find((x) => x.userId === uid);
    return `@${s?.username ?? "?"}`;
  };
  const tags = winnerIds.map(tag);
  let winnerLine: string;
  if (winnerIds.length === 1) winnerLine = `Игрок ${tags[0]} выиграл`;
  else if (winnerIds.length === 2) winnerLine = `Игроки ${tags[0]} и ${tags[1]} выиграли (делёж банка)`;
  else winnerLine = `Победители делят банк: ${tags.join(", ")}`;

  const parts = winnerIds.map((uid) => {
    const s = roomState.seats.find((x) => x.userId === uid)!;
    return { username: s.username ?? "?", score: evaluate7([...s.hand, ...boardCards]) };
  });
  let reasonLine: string;
  if (parts.length === 1) {
    reasonLine = formatComboDetail(parts[0].score);
  } else {
    const first = parts[0].score;
    const same = parts.every((p) => compareScore(p.score, first) === 0);
    if (same) reasonLine = `${formatComboDetail(first)} — делёж банка`;
    else reasonLine = parts.map((p) => `@${p.username}: ${formatComboDetail(p.score)}`).join("; ");
  }
  return { winnerLine, reasonLine };
};

const collectStreetToSidePots = () => {
  const rows = roomState.seats
    .filter((s) => s.userId && s.bet > 0)
    .map((s) => ({ seat: s.seat, bet: s.bet, folded: s.folded }));
  const levels = [...new Set(rows.map((r) => r.bet))].sort((a, b) => a - b);
  let prev = 0;
  for (const level of levels) {
    const delta = level - prev;
    if (delta <= 0) continue;
    const inLevel = rows.filter((r) => r.bet >= level);
    const amount = delta * inLevel.length;
    const eligibleSeats = inLevel.filter((r) => !r.folded).map((r) => r.seat);
    if (amount > 0 && eligibleSeats.length > 0) roomState.sidePots.push({ amount, eligibleSeats });
    prev = level;
  }
  roomState.seats.forEach((s) => {
    s.bet = 0;
  });
  roomState.currentBet = 0;
  syncPot();
};

const advanceDealerButton = () => {
  const next = nextOccupiedFrom(roomState.dealerSeat);
  if (next != null) roomState.dealerSeat = next;
};

const bettingRoundComplete = (): boolean => {
  const alive = nonFoldedWithCards();
  if (alive.length <= 1) return true;
  const allMatched = alive.every((s) => s.bet === roomState.currentBet || s.allIn);
  const needSpeech = alive.filter(canVoluntarilyAct);
  const allSpoke = needSpeech.every((s) => actedThisStreet.has(s.seat));
  return allMatched && allSpoke;
};

let deck: string[] = [];
const drawCard = () => {
  const c = deck.pop();
  if (!c) throw new Error("Колода пуста");
  return c;
};

/** Списать до targetToPay фишек в текущую улицу */
const addToBet = (seat: SeatState, targetToPay: number) => {
  const payAmt = Math.min(targetToPay, seat.chips);
  seat.chips -= payAmt;
  seat.bet += payAmt;
  seat.committedThisHand += payAmt;
  if (seat.chips === 0) seat.allIn = true;
  syncPot();
  return payAmt;
};

const pushTurn = (fromSeat: number) => {
  const alive = nonFoldedWithCards();
  if (alive.length <= 1) return;
  if (bettingRoundComplete()) {
    advanceBoardOrShowdown();
    return;
  }
  const n = nextToActFrom(fromSeat);
  roomState.turnSeat = n;
  setDeadline();
};

const allInShowdownRunout = () => {
  if (roomState.board.length >= 5) return false;
  const alive = nonFoldedWithCards();
  if (alive.length <= 1) return false;
  if (!alive.every((s) => s.allIn)) return false;
  while (roomState.board.length < 5) {
    if (roomState.board.length === 0) {
      roomState.street = "FLOP";
      roomState.board.push(drawCard(), drawCard(), drawCard());
      roomState.history.push("Флоп (runout)");
    } else if (roomState.board.length === 3) {
      roomState.street = "TURN";
      roomState.board.push(drawCard());
      roomState.history.push("Терн (runout)");
    } else if (roomState.board.length === 4) {
      roomState.street = "RIVER";
      roomState.board.push(drawCard());
      roomState.history.push("Ривер (runout)");
    }
  }
  return true;
};

const advanceBoardOrShowdown = () => {
  if (!bettingRoundComplete()) return;
  collectStreetToSidePots();
  actedThisStreet.clear();
  roomState.minRaiseIncrement = roomState.bigBlind;

  const alive = nonFoldedWithCards();
  if (alive.length <= 1) {
    finishHand();
    return;
  }

  if (allInShowdownRunout()) {
    finishHand();
    return;
  }

  if (roomState.street === "PREFLOP") {
    roomState.street = "FLOP";
    roomState.board.push(drawCard(), drawCard(), drawCard());
    roomState.history.push("Флоп: 3 общие карты");
  } else if (roomState.street === "FLOP") {
    roomState.street = "TURN";
    roomState.board.push(drawCard());
    roomState.history.push("Терн");
  } else if (roomState.street === "TURN") {
    roomState.street = "RIVER";
    roomState.board.push(drawCard());
    roomState.history.push("Ривер");
  } else if (roomState.street === "RIVER") {
    finishHand();
    return;
  }

  roomState.turnSeat = getFirstToActPostFlop();
  setDeadline();
};

const maybeAutoStartNextHand = () => {
  if (roomState.showdownReveal) return;
  if (roomState.handResultOverlay) return;
  const seated = roomState.seats.filter((s) => s.userId && s.chips > 0);
  if (seated.length >= 2) startHand();
};

const flushPendingSeatJoins = () => {
  if (pendingJoinAfterHand.size === 0) return;
  for (const item of [...pendingJoinAfterHand.values()]) {
    const target = roomState.seats[item.seat - 1];
    const already = roomState.seats.find((s) => s.userId === item.userId);
    if (!target || target.userId || already) continue;
    target.userId = item.userId;
    target.username = item.username;
    target.chips = Math.max(0, Math.floor(item.chips));
    target.hand = [];
    target.folded = false;
    target.allIn = false;
    target.bet = 0;
    target.committedThisHand = 0;
  }
  pendingJoinAfterHand.clear();
};

const endShowdownAndCleanup = () => {
  roomState.showdownReveal = null;
  roomState.board = [];
  roomState.street = "PREFLOP";
  roomState.seats.forEach((s) => {
    if (s.userId) s.hand = [];
  });
  flushPendingSeatJoins();
  advanceDealerButton();
  maybeAutoStartNextHand();
};

const finishHand = () => {
  collectStreetToSidePots();

  const alive = nonFoldedWithCards();
  const hadShowdownBoard = alive.length > 1 && roomState.board.length === 5;
  const boardSnapshot = hadShowdownBoard ? [...roomState.board] : [];

  if (alive.length === 1) {
    const w = alive[0];
    const winAmt = roomState.sidePots.reduce((s, p) => s + p.amount, 0);
    w.chips += winAmt;
    roomState.history.push(`Победил ${w.username} | банк ${winAmt}`);
  } else if (alive.length > 1 && roomState.board.length === 5) {
    const bySeatScore = alive.map((p) => ({
      player: p,
      score: evaluate7([...p.hand, ...roomState.board])
    }));

    for (const pot of roomState.sidePots) {
      if (pot.amount === 0) continue;
      const contenders = bySeatScore.filter((x) => pot.eligibleSeats.includes(x.player.seat));
      if (contenders.length === 0) continue;
      contenders.sort((a, b) => compareScore(b.score, a.score));
      const best = contenders[0].score;
      const winners = contenders.filter((c) => compareScore(c.score, best) === 0).map((c) => c.player);

      const base = Math.floor(pot.amount / winners.length);
      let rem = pot.amount % winners.length;
      const m = seatCount();
      const orderFromDealer = [...winners].sort((a, b) => {
        const da = (a.seat - roomState.dealerSeat + m) % m;
        const db = (b.seat - roomState.dealerSeat + m) % m;
        return da - db;
      });
      orderFromDealer.forEach((w, i) => {
        w.chips += base + (i < rem ? 1 : 0);
      });
    }

    roomState.history.push(`Шоудаун | банк ${roomState.sidePots.reduce((s, p) => s + p.amount, 0)}`);
  }

  const statRows: HandStatDelta[] = [];
  const lvl = lastAppliedBlindLevel;
  for (const [uid, startChips] of handStartStacks) {
    const seat = roomState.seats.find((s) => s.userId === uid);
    const endChips = seat != null ? seat.chips : startChips;
    statRows.push({
      tournamentId,
      handNumber: handsDealt,
      smallBlind: roomState.smallBlind,
      bigBlind: roomState.bigBlind,
      blindLevel: lvl,
      userId: uid,
      startChips,
      endChips
    });
  }
  handStartStacks.clear();
  void analyticsPreflopCollector?.({ tournamentId, handNumber: handsDealt, rows: [...analyticsPreflopBuffer] });
  analyticsPreflopBuffer = [];
  void handStatsRecorder?.(statRows);

  const stacks = roomState.seats
    .filter((s) => s.userId)
    .map((s) => ({ userId: s.userId!, chips: s.chips }));
  void tournamentStackPersist?.(stacks);

  const winnerIds = statRows.filter((r) => r.endChips > r.startChips).map((r) => r.userId);
  const loserIds = statRows.filter((r) => r.endChips < r.startChips).map((r) => r.userId);

  roomState.pot = 0;
  roomState.sidePots = [];
  roomState.handActive = false;
  roomState.street = "SHOWDOWN";
  roomState.turnSeat = null;
  roomState.turnDeadlineAt = null;
  actedThisStreet.clear();
  roomState.seats.forEach((s) => {
    s.bet = 0;
    s.committedThisHand = 0;
    if (!s.userId) s.hand = [];
  });

  if (hadShowdownBoard) {
    const { winnerLine, reasonLine } = buildWinnerAnnouncementLines(winnerIds, boardSnapshot);
    const handLabels: Record<number, string> = {};
    const handTitles: Record<number, string> = {};
    const winnerChoice: Record<number, "pending" | "show" | "muck"> = {};
    for (const p of alive) {
      const uid = p.userId!;
      const sc = evaluate7([...p.hand, ...boardSnapshot]);
      handLabels[uid] = formatComboDetail(sc);
      handTitles[uid] = comboTitleRuEn(sc);
    }
    for (const w of winnerIds) {
      winnerChoice[w] = "show";
    }
    roomState.board = [];
    roomState.handResultOverlay = null;
    roomState.showdownReveal = {
      board: boardSnapshot,
      deadlineAt: Date.now() + SHOWDOWN_PHASE_MS,
      winnerChoice,
      handLabels,
      handTitles,
      winnerLine,
      reasonLine,
      winnerIds,
      loserIds
    };
    const w0 = winnerIds[0];
    lastPublicHandOutcome = {
      winnerLine,
      reasonLine,
      bestHandTitle: w0 != null ? handTitles[w0] ?? null : null
    };
    applyPendingLeavesToShowdown(roomState.showdownReveal);
    if (roomState.showdownReveal?.winnerIds.length)
      emitHandWinnerChatLine(buildShowdownWinnerChat(roomState.showdownReveal));
    return;
  }

  roomState.board = [];
  roomState.showdownReveal = null;
  if (alive.length === 1) {
    const w = alive[0];
    const wl = `Игрок @${w.username ?? "?"} выиграл`;
    const rl = "Все соперники сбросили карты";
    const wid = w.userId;
    roomState.handResultOverlay = {
      winnerLine: wl,
      reasonLine: rl,
      dismissAt: Date.now() + SHOWDOWN_PHASE_MS,
      winnerUserIds: wid != null ? [wid] : []
    };
    const foldNick = w.username?.replace(/^@/, "") ?? "?";
    emitHandWinnerChatLine(`🏆 ${foldNick} выиграл раздачу (все соперники сбросили карты)`);
    lastPublicHandOutcome = { winnerLine: wl, reasonLine: rl, bestHandTitle: null };
  } else {
    roomState.handResultOverlay = null;
    flushPendingSeatJoins();
    advanceDealerButton();
    maybeAutoStartNextHand();
  }
  flushPendingLeavesAfterHand();
};

const setShowdownChoice = (userId: number, show: boolean) => {
  const sr = roomState.showdownReveal;
  if (!sr || !sr.winnerIds.includes(userId)) throw new Error("Нет выбора показа для этого игрока");
  if (sr.winnerChoice[userId] !== "pending") throw new Error("Решение уже принято");
  sr.winnerChoice[userId] = show ? "show" : "muck";
};

const tickShowdownPhase = (): boolean => {
  const sr = roomState.showdownReveal;
  if (!sr) return false;
  if (Date.now() < sr.deadlineAt) return false;
  const pending = sr.winnerIds.filter((uid) => sr.winnerChoice[uid] === "pending");
  for (const uid of pending) {
    sr.winnerChoice[uid] = "muck";
  }
  endShowdownAndCleanup();
  return true;
};

const tickHandResultPause = (): boolean => {
  if (roomState.showdownReveal) return false;
  const o = roomState.handResultOverlay;
  if (!o || Date.now() < o.dismissAt) return false;
  roomState.handResultOverlay = null;
  advanceDealerButton();
  maybeAutoStartNextHand();
  return true;
};

function applyActionInternal(userId: number, action: ActionType, amount = 0) {
  if (roomState.showdownReveal) throw new Error("Дождитесь окончания показа карт.");
  if (!roomState.handActive) throw new Error("Раздача не начата");
  const seat = roomState.seats.find((s) => s.userId === userId);
  if (!seat) throw new Error("Игрок не за столом");
  if (roomState.turnSeat !== seat.seat) throw new Error("Сейчас не ваш ход");

  const streetBefore = roomState.street;
  const toCall = Math.max(roomState.currentBet - seat.bet, 0);
  const toCallBefore = toCall;
  const tableBetBefore = roomState.currentBet;

  if (action === "FOLD") {
    seat.folded = true;
  } else if (action === "CHECK") {
    if (toCall > 0) throw new Error("Нельзя чекать");
  } else if (action === "CALL") {
    addToBet(seat, toCall);
  } else if (action === "ALL_IN") {
    addToBet(seat, 1_000_000_000);
    const newBet = seat.bet;
    if (newBet > tableBetBefore) {
      const increment = newBet - tableBetBefore;
      const shortAllIn = seat.allIn && increment < roomState.minRaiseIncrement;
      roomState.currentBet = newBet;
      if (!shortAllIn) roomState.minRaiseIncrement = Math.max(roomState.minRaiseIncrement, increment);
      actedThisStreet.clear();
    }
  } else if (action === "RAISE") {
    if (amount <= toCall) throw new Error("Сумма должна быть больше колла");
    addToBet(seat, Math.min(amount, seat.chips));
    const newBet = seat.bet;
    const increment = newBet - tableBetBefore;
    const shortAllIn = seat.allIn && newBet < tableBetBefore + roomState.minRaiseIncrement;
    if (!shortAllIn && increment < roomState.minRaiseIncrement) throw new Error("Минимальный рейз не соблюдён");
    if (newBet <= tableBetBefore) throw new Error("Рейз должен поднять ставку");
    roomState.currentBet = newBet;
    roomState.minRaiseIncrement = Math.max(roomState.minRaiseIncrement, increment);
    actedThisStreet.clear();
  }

  if (streetBefore === "PREFLOP" && userId > 0 && !isBotUserId(userId)) {
    const bucket = positionBucket(seat.seat, roomState.dealerSeat, seatCount());
    const facing = toCallBefore > 0;
    let is3bet = false;
    if (action === "RAISE") {
      is3bet = preflopRaiseCount >= 1;
      preflopRaiseCount += 1;
    }
    analyticsPreflopBuffer.push({
      userId,
      seat: seat.seat,
      dealerSeat: roomState.dealerSeat,
      seatCount: seatCount(),
      positionBucket: bucket,
      action,
      facingBet: facing,
      isThreeBet: is3bet
    });
  }

  actedThisStreet.add(seat.seat);
  roomState.history.push(`${seat.username}: ${action}${action === "RAISE" ? ` ${amount}` : ""}`);
  const actionBadge = (() => {
    if (action === "FOLD") return { kind: "fold" as const, label: "FOLD" };
    if (action === "CHECK") return { kind: "check" as const, label: "CHECK" };
    if (action === "CALL") return { kind: "call" as const, label: "CALL" };
    if (action === "ALL_IN") return { kind: "allin" as const, label: "ALL-IN" };
    return { kind: "raise" as const, label: `RAISE ${seat.bet}` };
  })();
  lastActionByUser.set(userId, { ...actionBadge, at: Date.now() });

  const alive = nonFoldedWithCards();
  if (alive.length <= 1) {
    finishHand();
    return;
  }

  if (bettingRoundComplete()) {
    advanceBoardOrShowdown();
    return;
  }

  pushTurn(seat.seat);
}

const applyAction = (userId: number, action: ActionType, amount = 0) => {
  applyActionInternal(userId, action, amount);
};

/** Один ход бота с упрощённой вероятностной логикой. */
const tickBotAction = (): boolean => {
  if (roomState.showdownReveal) return false;
  if (!roomState.handActive || roomState.turnSeat == null) return false;
  const seat = roomState.seats.find((s) => s.seat === roomState.turnSeat);
  if (!seat?.userId || !isBotUserId(seat.userId)) return false;
  const toCall = Math.max(roomState.currentBet - seat.bet, 0);
  const canRaise = seat.chips > toCall;
  const minRaisePay = Math.min(seat.chips, toCall + roomState.minRaiseIncrement);
  const randomRaisePay = Math.min(
    seat.chips,
    Math.max(minRaisePay, toCall + randomInt(1, Math.max(roomState.bigBlind, 2) + 1))
  );
  const r = Math.random();
  try {
    if (toCall === 0) {
      if (!canRaise || r < 0.72) applyActionInternal(seat.userId, "CHECK");
      else if (r < 0.95) applyActionInternal(seat.userId, "RAISE", randomRaisePay);
      else applyActionInternal(seat.userId, "ALL_IN");
    } else if (toCall >= seat.chips) {
      if (r < 0.78) applyActionInternal(seat.userId, "ALL_IN");
      else applyActionInternal(seat.userId, "FOLD");
    } else if (r < 0.28) {
      applyActionInternal(seat.userId, "FOLD");
    } else if (r < 0.78 || !canRaise) {
      applyActionInternal(seat.userId, "CALL");
    } else if (r < 0.94) {
      applyActionInternal(seat.userId, "RAISE", randomRaisePay);
    } else {
      applyActionInternal(seat.userId, "ALL_IN");
    }
    return true;
  } catch {
    try {
      applyActionInternal(seat.userId, "FOLD");
      return true;
    } catch {
      return false;
    }
  }
};

const startHand = () => {
  roomState.showdownReveal = null;
  roomState.handResultOverlay = null;
  pendingLeaveAfterHand.clear();
  handStartStacks.clear();
  lastActionByUser.clear();
  analyticsPreflopBuffer = [];
  preflopRaiseCount = 0;
  const seated = roomState.seats.filter((s) => s.userId && s.chips > 0);
  if (seated.length < 2) {
    roomState.history.push("Нужно минимум 2 игрока");
    return;
  }
  handsDealt += 1;
  if (tournamentBuyIn != null) {
    if (blindClockStartedAt == null) blindClockStartedAt = Date.now();
    applyBlindsForLevel(getCurrentBlindLevel(Date.now()));
  }
  deck = secureShuffle(makeDeck());
  roomState.board = [];
  roomState.sidePots = [];
  roomState.pot = 0;
  roomState.street = "PREFLOP";
  roomState.handActive = true;
  roomState.minRaiseIncrement = roomState.bigBlind;
  actedThisStreet.clear();

  roomState.seats.forEach((s) => {
    s.folded = false;
    s.allIn = false;
    s.bet = 0;
    s.committedThisHand = 0;
    s.hand = s.userId ? [drawCard(), drawCard()] : [];
  });

  const sbSeat = getSmallBlindSeat();
  const bbSeat = getBigBlindSeat();
  if (sbSeat == null || bbSeat == null) return;

  const sb = roomState.seats[sbSeat - 1];
  const bb = roomState.seats[bbSeat - 1];
  addToBet(sb, roomState.smallBlind);
  addToBet(bb, roomState.bigBlind);
  roomState.currentBet = Math.max(sb.bet, bb.bet);

  roomState.minRaiseIncrement = roomState.bigBlind;
  roomState.turnSeat = getFirstToActPreflop();
  setDeadline();
  syncPot();
  for (const s of roomState.seats) {
    if (s.userId) handStartStacks.set(s.userId, s.chips);
  }
  roomState.history.push("Раздача: префлоп, Fisher–Yates + crypto RNG");
};

const resetGame = () => {
  roomState.showdownReveal = null;
  roomState.handResultOverlay = null;
  pendingLeaveAfterHand.clear();
  handStartStacks.clear();
  handsDealt = 0;
  lastPublicHandOutcome = null;
  blindClockStartedAt = null;
  lastAppliedBlindLevel = 0;
  roomState.board = [];
  roomState.pot = 0;
  roomState.sidePots = [];
  roomState.street = "PREFLOP";
  roomState.currentBet = 0;
  roomState.handActive = false;
  roomState.turnSeat = null;
  roomState.turnDeadlineAt = null;

  roomState.seats.forEach((s) => {
    s.folded = false;
    s.allIn = false;
    s.bet = 0;
    s.hand = [];
    s.committedThisHand = 0;
  });

  actedThisStreet.clear();
  lastActionByUser.clear();
  roomState.history.push("Игра сброшена администратором");
};

const emptySeat = (seatNum: number): SeatState => ({
  seat: seatNum,
  userId: null,
  username: null,
  chips: 0,
  hand: [],
  folded: false,
  allIn: false,
  bet: 0,
  committedThisHand: 0
});

/** Задать число мест за столом (2–9). Нельзя во время раздачи или если заняты удаляемые места. */
const setRoomMaxSeats = (n: number): void => {
  if (!Number.isInteger(n) || n < MIN_SEATS || n > MAX_SEATS_CAP) {
    throw new Error(`Количество мест должно быть от ${MIN_SEATS} до ${MAX_SEATS_CAP}.`);
  }
  const cur = roomState.seats.length;
  if (n === cur) return;
  if (roomState.handActive) {
    throw new Error("Нельзя менять число мест во время раздачи.");
  }
  if (n > cur) {
    for (let i = cur + 1; i <= n; i += 1) {
      roomState.seats.push(emptySeat(i));
    }
    return;
  }
  for (let idx = n; idx < cur; idx += 1) {
    if (roomState.seats[idx].userId) {
      throw new Error("Сначала освободите места с большим номером.");
    }
  }
  roomState.seats = roomState.seats.slice(0, n);
  if (roomState.dealerSeat > n) {
    const o = occupiedSeatsOrdered();
    roomState.dealerSeat = o[0]?.seat ?? 1;
  }
};

const persistOccupiedStacks = () => {
  const stacks = roomState.seats.filter((s) => s.userId).map((s) => ({ userId: s.userId!, chips: s.chips }));
  if (stacks.length) void tournamentStackPersist?.(stacks);
};

/** Запись статистики раздачи для ушедшего до шоудауна (исключает двойной подсчёт в finishHand). */
const recordEarlyLeaveHandStats = (userId: number) => {
  if (isBotUserId(userId)) {
    handStartStacks.delete(userId);
    return;
  }
  const start = handStartStacks.get(userId);
  if (start == null) return;
  const seat = roomState.seats.find((s) => s.userId === userId);
  const endChips = seat != null ? seat.chips : start;
  handStartStacks.delete(userId);
  void handStatsRecorder?.([
    {
      tournamentId,
      handNumber: handsDealt,
      smallBlind: roomState.smallBlind,
      bigBlind: roomState.bigBlind,
      blindLevel: lastAppliedBlindLevel,
      userId,
      startChips: start,
      endChips
    }
  ]);
};

const resolveShowdownForLeaver = (sr: ShowdownReveal, userId: number) => {
  if (sr.winnerIds.includes(userId) && sr.winnerChoice[userId] === "pending") {
    sr.winnerChoice[userId] = "muck";
  }
  delete sr.handLabels[userId];
};

const flushPendingLeavesAfterHand = () => {
  if (pendingLeaveAfterHand.size === 0) return;
  for (const uid of [...pendingLeaveAfterHand]) {
    if (roomState.seats.some((s) => s.userId === uid)) clearOccupantFromSeat(uid, "forfeit");
  }
  pendingLeaveAfterHand.clear();
};

const applyPendingLeavesToShowdown = (sr: ShowdownReveal) => {
  if (pendingLeaveAfterHand.size === 0) return;
  for (const uid of [...pendingLeaveAfterHand]) {
    resolveShowdownForLeaver(sr, uid);
    clearOccupantFromSeat(uid, "forfeit");
  }
  pendingLeaveAfterHand.clear();
};

/** Снять со стола в любой фазе: при активной раздаче — фолд и проигрыш текущей руки (кроме олл-ина: выход после её завершения). */
const leaveTable = (userId: number) => {
  if (roomState.showdownReveal) {
    const sr = roomState.showdownReveal;
    resolveShowdownForLeaver(sr, userId);
    clearOccupantFromSeat(userId, "forfeit");
    tickShowdownPhase();
    return;
  }

  if (roomState.handActive) {
    const seat = roomState.seats.find((s) => s.userId === userId);
    if (!seat) {
      clearOccupantFromSeat(userId, "forfeit");
      return;
    }

    if (seat.allIn) {
      pendingLeaveAfterHand.add(userId);
      roomState.history.push(`${seat.username ?? "?"} покинет стол после раздачи (олл-ин)`);
      return;
    }

    const foldedJust = !seat.folded;
    if (foldedJust) {
      seat.folded = true;
      actedThisStreet.add(seat.seat);
      roomState.history.push(`${seat.username ?? "?"}: FOLD (покинул стол)`);
    }

    const wasTheirTurn = roomState.turnSeat === seat.seat;
    const alive = nonFoldedWithCards();

    if (alive.length <= 1) {
      finishHand();
      clearOccupantFromSeat(userId, "forfeit");
      return;
    }

    if (bettingRoundComplete()) {
      advanceBoardOrShowdown();
      if (roomState.seats.some((s) => s.userId === userId)) {
        if (handStartStacks.has(userId)) recordEarlyLeaveHandStats(userId);
        clearOccupantFromSeat(userId, "forfeit");
        persistOccupiedStacks();
      }
      return;
    }

    if (wasTheirTurn && foldedJust) pushTurn(seat.seat);

    recordEarlyLeaveHandStats(userId);
    clearOccupantFromSeat(userId, "forfeit");
    persistOccupiedStacks();
    return;
  }

  clearOccupantFromSeat(userId, "forfeit");
};

/** Снять игрока с места: forfeit — выход (стек > 0 уходит в cashout-колбэк); persist — только записать стек в регистрацию (смена места). */
const clearOccupantFromSeat = (userId: number, mode: "forfeit" | "persist") => {
  const seat = roomState.seats.find((s) => s.userId === userId);
  if (!seat) return;
  const uid = seat.userId!;
  const stack = Math.max(0, seat.chips);
  if (mode === "forfeit" && stack > 0 && !isBotUserId(uid)) {
    void Promise.resolve(tournamentLeaveCashout?.(uid, tournamentId, stack)).catch((e) =>
      console.error("tournamentLeaveCashout", e)
    );
  }
  seat.userId = null;
  seat.username = null;
  seat.hand = [];
  seat.folded = false;
  seat.allIn = false;
  seat.bet = 0;
  seat.chips = 0;
  seat.committedThisHand = 0;
  if (isBotUserId(uid)) return;
  if (mode === "persist") void tournamentStackPersist?.([{ userId: uid, chips: stack }]);
  /* forfeit: стек снимается без зачисления на счёт (турнирный формат). */
};

/** Зачислить фишки на место (докупка); во время раздачи стек доступен со следующих улиц. */
const creditChipsToSeat = (userId: number, amount: number) => {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Сумма докупки должна быть положительной");
  const seat = roomState.seats.find((s) => s.userId === userId);
  if (!seat) throw new Error("Игрок не за столом");
  seat.chips += Math.floor(amount);
  syncPot();
};

const joinSeat = (seat: number, userId: number, username: string, chips: number) => {
  if (seat < 1 || seat > roomState.seats.length) throw new Error("Неверное место");
  if (roomState.handActive) {
    pendingJoinAfterHand.set(userId, { seat, userId, username, chips });
    return;
  }
  const prev = roomState.seats.find((s) => s.userId === userId);
  const carryChips = prev ? prev.chips : chips;
  if (prev) clearOccupantFromSeat(userId, "persist");
  const target = roomState.seats[seat - 1];
  if (!target || target.userId) throw new Error("Место занято");
  target.userId = userId;
  target.username = username;
  target.chips = carryChips;
  target.committedThisHand = 0;
};

const addBots = (bots: Array<{ userId: number; username: string; chips: number }>): number => {
  if (bots.length === 0) return 0;
  let added = 0;
  for (const bot of bots) {
    const seat = firstFreeSeat();
    if (seat == null) break;
    joinSeat(seat, bot.userId, bot.username, bot.chips);
    added += 1;
  }
  return added;
};

const removeAllBots = (): number => {
  const botIds = roomState.seats.filter((s) => s.userId && isBotUserId(s.userId)).map((s) => s.userId!);
  for (const uid of botIds) clearOccupantFromSeat(uid, "forfeit");
  return botIds.length;
};

const leaveSeat = (userId: number) => {
  clearOccupantFromSeat(userId, "forfeit");
};

const setTournamentBuyIn = (buyIn: number) => {
  if (!Number.isFinite(buyIn) || buyIn < 1) return;
  tournamentBuyIn = Math.floor(buyIn);
  const idle = !roomState.handActive && !roomState.showdownReveal && !roomState.handResultOverlay;
  if (idle) {
    const lvl = blindClockStartedAt == null ? 0 : getCurrentBlindLevel(Date.now());
    applyBlindsForLevel(lvl);
  }
};

/** Между раздачами: поднять блайнды при смене уровня по таймеру. Вернёт true, если состояние изменилось. */
const tickBlindLevel = (now: number): boolean => {
  if (tournamentBuyIn == null || blindClockStartedAt == null) return false;
  if (roomState.handActive || roomState.showdownReveal || roomState.handResultOverlay) return false;
  const level = getCurrentBlindLevel(now);
  if (level <= lastAppliedBlindLevel) return false;
  applyBlindsForLevel(level);
  roomState.history.push(`Блайнды: ${roomState.smallBlind}/${roomState.bigBlind}`);
  return true;
};

  return {
    tournamentId,
    get roomState() {
      return roomState;
    },
    tickActionTimeout,
    visibleStateFor,
    applyAction,
    tickBotAction,
    startHand,
    resetGame,
    setRoomMaxSeats,
    joinSeat,
    addBots,
    removeAllBots,
    creditChipsToSeat,
    leaveSeat,
    leaveTable,
    setShowdownChoice,
    tickShowdownPhase,
    tickHandResultPause,
    setTournamentBuyIn,
    tickBlindLevel,
    getHandsDealt: () => handsDealt,
    getLastPublicHandOutcome: () => lastPublicHandOutcome,
    /** Раздача идёт (включая шоудаун и паузу результата). */
    isHandInProgress: () =>
      roomState.handActive || roomState.showdownReveal || Boolean(roomState.handResultOverlay)
  };
}

export type RoomEngine = ReturnType<typeof createRoomEngine>;
