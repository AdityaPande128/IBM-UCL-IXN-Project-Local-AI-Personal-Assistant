import fs from 'fs-extra';

const LABELS = ['execute_existing', 'generate_new_skill', 'refuse'];


function percentile(sorted, p) {
    const idx = (p / 100) * (sorted.length - 1);
    const lo  = Math.floor(idx);
    const hi  = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stddev(values, mean) {
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}


function buildConfusionMatrix(records) {
    const matrix = {};
    for (const a of LABELS) {
        matrix[a] = {};
        for (const p of LABELS) matrix[a][p] = 0;
    }
    for (const r of records) {
        const act  = r.expected_intent;
        const pred = LABELS.includes(r.actual_intent) ? r.actual_intent : '__other__';
        if (matrix[act] && matrix[act][pred] !== undefined) {
            matrix[act][pred]++;
        }
    }
    return matrix;
}

function perClassMetrics(matrix) {
    const metrics = {};
    for (const label of LABELS) {
        let tp = matrix[label][label];
        let fp = 0, fn = 0;
        for (const other of LABELS) {
            if (other !== label) {
                fp += matrix[other][label];
                fn += matrix[label][other];
            }
        }
        const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
        const recall    = tp + fn > 0 ? tp / (tp + fn) : 0;
        const f1        = precision + recall > 0
            ? 2 * precision * recall / (precision + recall) : 0;
        metrics[label] = {
            tp, fp, fn,
            precision: parseFloat(precision.toFixed(4)),
            recall:    parseFloat(recall.toFixed(4)),
            f1:        parseFloat(f1.toFixed(4)),
            support:   tp + fn
        };
    }
    return metrics;
}

function macroF1(classMetrics) {
    const f1s = LABELS.map(l => classMetrics[l].f1);
    return parseFloat((f1s.reduce((a, b) => a + b, 0) / f1s.length).toFixed(4));
}

function weightedF1(classMetrics) {
    let num = 0, den = 0;
    for (const l of LABELS) {
        num += classMetrics[l].f1 * classMetrics[l].support;
        den += classMetrics[l].support;
    }
    return den > 0 ? parseFloat((num / den).toFixed(4)) : 0;
}

function cohensKappa(matrix, total) {
    let po = 0;
    for (const l of LABELS) po += matrix[l][l];
    po /= total;

    let pe = 0;
    for (const l of LABELS) {
        let rowSum = 0, colSum = 0;
        for (const o of LABELS) {
            rowSum += matrix[l][o];
            colSum += matrix[o][l];
        }
        pe += (rowSum / total) * (colSum / total);
    }

    return pe < 1 ? parseFloat(((po - pe) / (1 - pe)).toFixed(4)) : 1;
}


function printSeparator(char = '═', width = 74) {
    console.log(char.repeat(width));
}

function printHeader(title) {
    console.log();
    printSeparator();
    console.log(`  ${title}`);
    printSeparator();
}

function analyseModel(alias, records) {
    const N = records.length;
    printHeader(`MODEL: ${alias}   (n = ${N})`);

    const cm = buildConfusionMatrix(records);
    console.log('\n  ┌─ CONFUSION MATRIX ───────────────────────────────────────────┐');
    console.log('  │ Predicted →       exec_existing   gen_new_skill      refuse │');
    console.log('  │ Actual ↓          ─────────────   ─────────────   ───────── │');
    for (const actual of LABELS) {
        const shortActual = actual === 'execute_existing' ? 'exec_existing'
                          : actual === 'generate_new_skill' ? 'gen_new_skill'
                          : 'refuse       ';
        const cells = LABELS.map(pred => String(cm[actual][pred]).padStart(6));
        console.log(`  │ ${shortActual.padEnd(18)} ${cells.join('          ')}    │`);
    }
    console.log('  └──────────────────────────────────────────────────────────────┘');

    const cls = perClassMetrics(cm);
    console.log('\n  Per-Class Metrics:');
    console.log('  ┌───────────────────────┬───────────┬────────┬────────┬─────────┐');
    console.log('  │ Class                 │ Precision │ Recall │   F1   │ Support │');
    console.log('  ├───────────────────────┼───────────┼────────┼────────┼─────────┤');
    for (const l of LABELS) {
        const m = cls[l];
        console.log(`  │ ${l.padEnd(21)} │   ${(m.precision*100).toFixed(1).padStart(5)}%  │ ${(m.recall*100).toFixed(1).padStart(5)}% │ ${(m.f1*100).toFixed(1).padStart(5)}% │   ${String(m.support).padStart(3)}   │`);
    }
    console.log('  └───────────────────────┴───────────┴────────┴────────┴─────────┘');

    const correct  = records.filter(r => r.intent_correct).length;
    const accuracy = correct / N;
    const mF1      = macroF1(cls);
    const wF1      = weightedF1(cls);
    const kappa    = cohensKappa(cm, N);

    console.log('\n  Aggregate Metrics:');
    console.log(`    Overall Accuracy ........... ${(accuracy * 100).toFixed(1)}%  (${correct}/${N})`);
    console.log(`    Macro-F1 ................... ${(mF1 * 100).toFixed(1)}%`);
    console.log(`    Weighted-F1 ................ ${(wF1 * 100).toFixed(1)}%`);
    console.log(`    Cohen's Kappa (κ) .......... ${kappa.toFixed(4)}`);

    const schemaOk = records.filter(r => r.schema_valid).length;
    console.log(`    Schema Compliance .......... ${(schemaOk/N*100).toFixed(1)}%  (${schemaOk}/${N})`);

    const latencies = records.map(r => r.latency_sec).sort((a, b) => a - b);
    const meanLat   = latencies.reduce((a, b) => a + b, 0) / N;
    const sdLat     = stddev(latencies, meanLat);
    console.log('\n  Latency Distribution:');
    console.log(`    p50 ........................ ${percentile(latencies, 50).toFixed(3)}s`);
    console.log(`    p75 ........................ ${percentile(latencies, 75).toFixed(3)}s`);
    console.log(`    p90 ........................ ${percentile(latencies, 90).toFixed(3)}s`);
    console.log(`    p95 ........................ ${percentile(latencies, 95).toFixed(3)}s`);
    console.log(`    p99 ........................ ${percentile(latencies, 99).toFixed(3)}s`);
    console.log(`    Mean ± σ ................... ${meanLat.toFixed(3)}s ± ${sdLat.toFixed(3)}s`);

    const tracks = {};
    for (const r of records) {
        if (!tracks[r.track]) tracks[r.track] = { total: 0, correct: 0 };
        tracks[r.track].total++;
        if (r.intent_correct) tracks[r.track].correct++;
    }
    console.log('\n  Per-Track Accuracy:');
    for (const [track, v] of Object.entries(tracks)) {
        const pct = ((v.correct / v.total) * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(v.correct / v.total * 20)).padEnd(20, '░');
        console.log(`    ${track.padEnd(16)} ${bar} ${pct}%  (${v.correct}/${v.total})`);
    }

    const diffs = {};
    for (const r of records) {
        if (!diffs[r.difficulty]) diffs[r.difficulty] = { total: 0, correct: 0 };
        diffs[r.difficulty].total++;
        if (r.intent_correct) diffs[r.difficulty].correct++;
    }
    console.log('\n  Per-Difficulty Accuracy:');
    for (const level of ['easy', 'medium', 'hard']) {
        if (!diffs[level]) continue;
        const v   = diffs[level];
        const pct = ((v.correct / v.total) * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(v.correct / v.total * 20)).padEnd(20, '░');
        console.log(`    ${level.padEnd(16)} ${bar} ${pct}%  (${v.correct}/${v.total})`);
    }

    const failures = records.filter(r => !r.intent_correct);
    if (failures.length > 0) {
        console.log(`\n  Failure Analysis (${failures.length} failures):`);
        console.log('  ┌────────┬──────────────┬───────────────────────┬───────────────────────┬──────────────────────────────────────────────┐');
        console.log('  │   ID   │ Track        │ Expected              │ Actual                │ Prompt (truncated)                           │');
        console.log('  ├────────┼──────────────┼───────────────────────┼───────────────────────┼──────────────────────────────────────────────┤');
        for (const f of failures) {
            const promptShort = f.prompt.length > 42 ? f.prompt.slice(0, 39) + '...' : f.prompt;
            console.log(`  │ ${f.id.padEnd(6)} │ ${f.track.padEnd(12)} │ ${f.expected_intent.padEnd(21)} │ ${f.actual_intent.padEnd(21)} │ ${promptShort.padEnd(44)} │`);
        }
        console.log('  └────────┴──────────────┴───────────────────────┴───────────────────────┴──────────────────────────────────────────────┘');
    } else {
        console.log('\n  Failure Analysis: NONE — all test cases passed.');
    }

    return { alias, accuracy, mF1, wF1, kappa, schemaOk: schemaOk / N, meanLat, sdLat, perTrack: tracks, perDiff: diffs, perClass: cls };
}


function printComparison(summaries) {
    printHeader('HEAD-TO-HEAD COMPARISON');
    console.log();
    console.log('  ┌──────────────────────────┬──────────────────────────┬──────────────────────────┐');
    console.log(`  │ ${'Metric'.padEnd(24)} │ ${summaries[0].alias.padEnd(24)} │ ${summaries[1].alias.padEnd(24)} │`);
    console.log('  ├──────────────────────────┼──────────────────────────┼──────────────────────────┤');

    const rows = [
        ['Overall Accuracy',    s => `${(s.accuracy*100).toFixed(1)}%`],
        ['Macro-F1',            s => `${(s.mF1*100).toFixed(1)}%`],
        ['Weighted-F1',         s => `${(s.wF1*100).toFixed(1)}%`],
        ['Cohen\'s Kappa',      s => s.kappa.toFixed(4)],
        ['Schema Compliance',   s => `${(s.schemaOk*100).toFixed(1)}%`],
        ['Mean Latency',        s => `${s.meanLat.toFixed(3)}s ± ${s.sdLat.toFixed(3)}s`],
    ];

    for (const l of LABELS) {
        const shortName = l === 'execute_existing' ? 'F1: exec_existing'
                        : l === 'generate_new_skill' ? 'F1: gen_new_skill'
                        : 'F1: refuse';
        rows.push([shortName, s => `${(s.perClass[l].f1*100).toFixed(1)}%`]);
    }

    for (const [label, fn] of rows) {
        const v0 = fn(summaries[0]);
        const v1 = fn(summaries[1]);
        console.log(`  │ ${label.padEnd(24)} │ ${v0.padEnd(24)} │ ${v1.padEnd(24)} │`);
    }

    console.log('  └──────────────────────────┴──────────────────────────┴──────────────────────────┘');

    console.log('\n  Per-Track Accuracy Comparison:');
    const allTracks = [...new Set([...Object.keys(summaries[0].perTrack), ...Object.keys(summaries[1].perTrack)])];
    console.log('  ┌──────────────────────────┬──────────────────────────┬──────────────────────────┐');
    console.log(`  │ ${'Track'.padEnd(24)} │ ${summaries[0].alias.padEnd(24)} │ ${summaries[1].alias.padEnd(24)} │`);
    console.log('  ├──────────────────────────┼──────────────────────────┼──────────────────────────┤');
    for (const track of allTracks) {
        const v0 = summaries[0].perTrack[track];
        const v1 = summaries[1].perTrack[track];
        const s0 = v0 ? `${((v0.correct/v0.total)*100).toFixed(1)}% (${v0.correct}/${v0.total})` : 'N/A';
        const s1 = v1 ? `${((v1.correct/v1.total)*100).toFixed(1)}% (${v1.correct}/${v1.total})` : 'N/A';
        console.log(`  │ ${track.padEnd(24)} │ ${s0.padEnd(24)} │ ${s1.padEnd(24)} │`);
    }
    console.log('  └──────────────────────────┴──────────────────────────┴──────────────────────────┘');
    console.log();
}


async function main() {
    console.log('\n');
    printSeparator('═', 74);
    console.log('           OPENCLAW COGNITIVE ROUTER — EVALUATION REPORT');
    console.log(`           Generated: ${new Date().toISOString()}`);
    printSeparator('═', 74);

    const models = [
        { alias: 'Granite 4.1 8B (q4)',     src: './benchmark_8b.json'  },
        { alias: 'Granite 4.1 30B (mxfp4)', src: './benchmark_30b.json' }
    ];

    const summaries = [];

    for (const m of models) {
        if (!fs.existsSync(m.src)) {
            console.log(`\n  ⚠  ${m.src} not found — skipping ${m.alias}.`);
            continue;
        }
        const records = await fs.readJson(m.src);
        const summary = analyseModel(m.alias, records);
        summaries.push(summary);
    }

    if (summaries.length === 2) {
        printComparison(summaries);
    }

    printSeparator('═', 74);
    console.log('  END OF REPORT');
    printSeparator('═', 74);
    console.log();
}

main();
