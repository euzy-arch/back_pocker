/** Сырая сумма четырёх частей формулы рейтинга (до нормировки в 0–1000). */
export function rawRatingParts(W, L, F, Fmax, Tmax) {
    const T = W + L;
    const p1 = T > 0 ? 0.4 * (W / T) : 0;
    const p2 = 0.3 * (W / (L + 1));
    const p3 = Fmax > 0 ? 0.2 * (Math.min(F, Fmax) / Fmax) : 0;
    const p4 = Tmax > 0 ? 0.1 * (Math.min(T, Tmax) / Tmax) : 0;
    return p1 + p2 + p3 + p4;
}
/** R в диапазоне 0…1000 */
export function normalizedRatingR(W, L, F, Fmax, Tmax) {
    const raw = rawRatingParts(W, L, F, Fmax, Tmax);
    if (raw <= 0)
        return 0;
    return Math.min(1000, Math.round((1000 * raw) / (raw + 1)));
}
export function attachRatings(users) {
    const feat = (u) => u.totalChipsWon + (u.ratingPlacementPoints ?? 0);
    const Fmax = Math.max(0, ...users.map(feat));
    const Tmax = Math.max(0, ...users.map((u) => u.wins + u.losses));
    return users.map((u) => ({
        ...u,
        rating: normalizedRatingR(u.wins, u.losses, feat(u), Fmax, Tmax)
    }));
}
