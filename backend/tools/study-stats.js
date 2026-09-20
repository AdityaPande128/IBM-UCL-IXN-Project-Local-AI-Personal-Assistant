// Statistics for the model study, in plain JavaScript so the analysis has no
// dependency the report cannot name: Wilson intervals, exact McNemar, Holm,
// Friedman with tie correction, and cluster-robust standard errors.

function lgamma(x) {
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1;
    let a = c[0];
    const t = x + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logChoose(n, k) {
    return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

function binomCdf(k, n, p = 0.5) {
    let total = 0;
    for (let i = 0; i <= k; i++) {
        total += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
    }
    return Math.min(1, total);
}

function wilson(k, n, z = 1.96) {
    if (!n) return { p: null, lo: null, hi: null };
    const p = k / n;
    const denom = 1 + z * z / n;
    const centre = (p + z * z / (2 * n)) / denom;
    const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
    return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// Exact two-sided McNemar on the discordant counts (b: A right, B wrong;
// c: A wrong, B right).
function mcnemarExact(b, c) {
    const n = b + c;
    if (!n) return { p: 1, b, c, n };
    const k = Math.min(b, c);
    return { p: Math.min(1, 2 * binomCdf(k, n)), b, c, n };
}

function holm(pvalues) {
    const order = pvalues.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
    const m = pvalues.length;
    const adjusted = new Array(m);
    let running = 0;
    order.forEach(([p, i], rank) => {
        running = Math.max(running, Math.min(1, (m - rank) * p));
        adjusted[i] = running;
    });
    return adjusted;
}

// Regularised upper incomplete gamma Q(a, x), for the chi-square survival
// function. Series below a + 1, Lentz continued fraction above.
function gammaQ(a, x) {
    if (x <= 0) return 1;
    if (x < a + 1) {
        let sum = 1 / a, term = 1 / a;
        for (let n = 1; n < 500; n++) {
            term *= x / (a + n);
            sum += term;
            if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
        }
        return 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
    }
    let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
    for (let i = 1; i < 500; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
        c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
        d = 1 / d;
        const delta = d * c;
        h *= delta;
        if (Math.abs(delta - 1) < 1e-14) break;
    }
    return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

function chisqSf(x, df) {
    return gammaQ(df / 2, x / 2);
}

function ranksWithTies(row) {
    const order = row.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(row.length);
    let tieCorrection = 0;
    for (let i = 0; i < order.length;) {
        let j = i;
        while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
        const avg = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) ranks[order[k][1]] = avg;
        const t = j - i + 1;
        tieCorrection += t * t * t - t;
        i = j + 1;
    }
    return { ranks, tieCorrection };
}

// Friedman test: rows are blocks (a task, a seed, a prompt), columns are the
// arms; higher is better. Tie-corrected chi-square approximation.
function friedman(matrix) {
    const n = matrix.length;
    const k = n ? matrix[0].length : 0;
    if (n < 2 || k < 2) return { chi2: null, df: k - 1, p: null, meanRanks: [], n, k };
    const sums = new Array(k).fill(0);
    let ties = 0;
    for (const row of matrix) {
        const { ranks, tieCorrection } = ranksWithTies(row);
        ranks.forEach((r, j) => { sums[j] += r; });
        ties += tieCorrection;
    }
    const meanRanks = sums.map(s => s / n);
    let chi2 = (12 / (n * k * (k + 1))) * sums.reduce((acc, s) => acc + s * s, 0) - 3 * n * (k + 1);
    const denom = 1 - ties / (n * k * (k * k - 1));
    if (denom > 0) chi2 /= denom;
    const df = k - 1;
    return { chi2, df, p: denom > 0 ? chisqSf(chi2, df) : 1, meanRanks, n, k };
}

// Mean of 0/1 values with a cluster-robust standard error: items sharing a
// family (paraphrases, perturbations of one request) are not independent.
function clusteredMean(values, clusters) {
    const n = values.length;
    if (!n) return { mean: null, se: null, clusters: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const byCluster = new Map();
    values.forEach((v, i) => {
        const key = clusters[i];
        byCluster.set(key, (byCluster.get(key) || 0) + (v - mean));
    });
    const G = byCluster.size;
    let sum = 0;
    for (const s of byCluster.values()) sum += s * s;
    const se = G > 1 ? Math.sqrt((G / (G - 1)) * sum) / n : null;
    return { mean, se, clusters: G };
}

function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    if (!s.length) return null;
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(xs, q) {
    const s = [...xs].sort((a, b) => a - b);
    if (!s.length) return null;
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

module.exports = { wilson, mcnemarExact, holm, friedman, chisqSf, clusteredMean, median, quantile, binomCdf, lgamma };
