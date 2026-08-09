const fs = require('fs');
const path = require('path');

function readTree(dir) {
    const out = {};
    const walk = (current, prefix) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            const rel = prefix ? path.join(prefix, entry.name) : entry.name;
            if (entry.isDirectory()) walk(full, rel);
            else {
                try { out[rel] = fs.readFileSync(full, 'utf8'); }
                catch { out[rel] = null; }
            }
        }
    };
    if (fs.existsSync(dir)) walk(dir, '');
    return out;
}

function anyFile(tree, predicate) {
    return Object.entries(tree).some(([name, content]) =>
        content !== null && predicate(content, name));
}

const pass = detail => ({ passed: true, detail });
const fail = detail => ({ passed: false, detail });

const TASKS = [
    {
        id: 'G01', category: 'organisation',
        prompt: 'Sort every file in {{dir}} into subfolders named after its file extension',
        fixtures: [
            { path: 'a.txt', content: 'one' }, { path: 'b.txt', content: 'two' },
            { path: 'c.csv', content: 'x,y' }, { path: 'd.json', content: '{}' }
        ],
        check(dir) {
            const tree = readTree(dir);
            const names = Object.keys(tree);
            const txtGrouped = names.filter(n => n.includes('/') && n.endsWith('.txt')).length >= 2;
            const csvGrouped = names.some(n => n.includes('/') && n.endsWith('.csv'));
            return txtGrouped && csvGrouped
                ? pass('files moved into extension subfolders')
                : fail(`expected extension subfolders, saw: ${names.join(', ')}`);
        }
    },
    {
        id: 'G02', category: 'organisation',
        prompt: 'Rename every .txt file in {{dir}} so it has a .md extension instead',
        fixtures: [{ path: 'notes.txt', content: 'hello' }, { path: 'todo.txt', content: 'world' }],
        check(dir) {
            const names = Object.keys(readTree(dir));
            const md = names.filter(n => n.endsWith('.md')).length;
            const txt = names.filter(n => n.endsWith('.txt')).length;
            return md >= 2 && txt === 0
                ? pass('both files renamed to .md')
                : fail(`expected 2 .md and 0 .txt, saw ${md} .md and ${txt} .txt`);
        }
    },
    {
        id: 'G03', category: 'organisation',
        prompt: 'List every file in {{dir}} bigger than 100 bytes and write the list to {{dir}}/big.txt',
        fixtures: [
            { path: 'small.txt', content: 'tiny' },
            { path: 'large.txt', content: 'x'.repeat(500) },
            { path: 'huge.txt', content: 'y'.repeat(900) }
        ],
        check(dir) {
            const report = path.join(dir, 'big.txt');
            if (!fs.existsSync(report)) return fail('big.txt was not created');
            const body = fs.readFileSync(report, 'utf8');
            return body.includes('large') && body.includes('huge') && !body.includes('small')
                ? pass('report lists exactly the large files')
                : fail(`report contents wrong: ${body.slice(0, 90)}`);
        }
    },
    {
        id: 'G04', category: 'organisation',
        prompt: 'Move every file from the nested subfolders of {{dir}} up into {{dir}} itself',
        fixtures: [
            { path: 'one/a.txt', content: 'a' },
            { path: 'two/deep/b.txt', content: 'b' },
            { path: 'top.txt', content: 'c' }
        ],
        check(dir) {
            const names = Object.keys(readTree(dir));
            const atRoot = names.filter(n => !n.includes('/'));
            return atRoot.includes('a.txt') && atRoot.includes('b.txt')
                ? pass('nested files flattened to the top level')
                : fail(`expected a.txt and b.txt at root, saw: ${names.join(', ')}`);
        }
    },
    {
        id: 'G05', category: 'organisation',
        prompt: 'Find files with identical contents in {{dir}} and write the duplicate groups to {{dir}}/dupes.txt',
        fixtures: [
            { path: 'x1.txt', content: 'same content' },
            { path: 'x2.txt', content: 'same content' },
            { path: 'unique.txt', content: 'different' }
        ],
        check(dir) {
            const report = path.join(dir, 'dupes.txt');
            if (!fs.existsSync(report)) return fail('dupes.txt was not created');
            const body = fs.readFileSync(report, 'utf8');
            return body.includes('x1') && body.includes('x2')
                ? pass('duplicate pair identified')
                : fail(`duplicates not reported: ${body.slice(0, 90)}`);
        }
    },

    {
        id: 'G06', category: 'extraction',
        prompt: 'Extract every email address from the text files in {{dir}} and save them to {{dir}}/emails.csv',
        fixtures: [
            { path: 'a.txt', content: 'contact alice@example.com for details' },
            { path: 'b.txt', content: 'bob@test.org and carol@test.org replied' }
        ],
        check(dir) {
            const out = path.join(dir, 'emails.csv');
            if (!fs.existsSync(out)) return fail('emails.csv was not created');
            const body = fs.readFileSync(out, 'utf8');
            const found = ['alice@example.com', 'bob@test.org', 'carol@test.org'].filter(e => body.includes(e));
            return found.length === 3
                ? pass('all three addresses extracted')
                : fail(`only found ${found.length}/3: ${body.slice(0, 90)}`);
        }
    },
    {
        id: 'G07', category: 'extraction',
        prompt: 'Pull every http and https URL out of the files in {{dir}} into {{dir}}/urls.txt',
        fixtures: [
            { path: 'page.txt', content: 'see https://example.com/docs and http://test.org' },
            { path: 'more.txt', content: 'also https://third.net/path?q=1' }
        ],
        check(dir) {
            const out = path.join(dir, 'urls.txt');
            if (!fs.existsSync(out)) return fail('urls.txt was not created');
            const body = fs.readFileSync(out, 'utf8');
            const found = ['example.com', 'test.org', 'third.net'].filter(u => body.includes(u));
            return found.length === 3
                ? pass('all three URLs extracted')
                : fail(`only found ${found.length}/3: ${body.slice(0, 90)}`);
        }
    },
    {
        id: 'G08', category: 'extraction',
        prompt: 'Count the lines in each file in {{dir}} and write a summary to {{dir}}/lines.csv',
        fixtures: [
            { path: 'three.txt', content: 'a\nb\nc' },
            { path: 'one.txt', content: 'only' }
        ],
        check(dir) {
            const out = path.join(dir, 'lines.csv');
            if (!fs.existsSync(out)) return fail('lines.csv was not created');
            const body = fs.readFileSync(out, 'utf8');
            return /three[^\n]*3/.test(body) && /one[^\n]*1/.test(body)
                ? pass('line counts correct')
                : fail(`counts wrong: ${body.slice(0, 90)}`);
        }
    },
    {
        id: 'G09', category: 'extraction',
        prompt: 'Find which files in {{dir}} contain the word "urgent" and list them in {{dir}}/matches.txt',
        fixtures: [
            { path: 'memo.txt', content: 'this is urgent, act now' },
            { path: 'note.txt', content: 'nothing pressing here' },
            { path: 'alert.txt', content: 'URGENT: read me' }
        ],
        check(dir) {
            const out = path.join(dir, 'matches.txt');
            if (!fs.existsSync(out)) return fail('matches.txt was not created');
            const body = fs.readFileSync(out, 'utf8');
            return body.includes('memo') && !body.includes('note.txt')
                ? pass('matching files identified')
                : fail(`matches wrong: ${body.slice(0, 90)}`);
        }
    },
    {
        id: 'G10', category: 'extraction',
        prompt: 'Take the first heading line from each markdown file in {{dir}} and build an index at {{dir}}/index.md',
        fixtures: [
            { path: 'intro.md', content: '# Introduction\n\nbody text' },
            { path: 'setup.md', content: '# Getting Started\n\nmore text' }
        ],
        check(dir) {
            const out = path.join(dir, 'index.md');
            if (!fs.existsSync(out)) return fail('index.md was not created');
            const body = fs.readFileSync(out, 'utf8');
            return body.includes('Introduction') && body.includes('Getting Started')
                ? pass('both headings indexed')
                : fail(`headings missing: ${body.slice(0, 90)}`);
        }
    },

    {
        id: 'G11', category: 'transformation',
        prompt: 'Convert {{dir}}/data.csv into a JSON file at {{dir}}/data.json',
        fixtures: [{ path: 'data.csv', content: 'name,age\nalice,30\nbob,25\n' }],
        check(dir) {
            const out = path.join(dir, 'data.json');
            if (!fs.existsSync(out)) return fail('data.json was not created');
            try {
                const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
                const text = JSON.stringify(parsed);
                return text.includes('alice') && text.includes('bob')
                    ? pass('CSV converted to valid JSON')
                    : fail(`rows missing: ${text.slice(0, 90)}`);
            } catch (err) {
                return fail(`not valid JSON: ${err.message}`);
            }
        }
    },
    {
        id: 'G12', category: 'transformation',
        prompt: 'Turn {{dir}}/records.json into a CSV file at {{dir}}/records.csv',
        fixtures: [{
            path: 'records.json',
            content: '[{"city":"London","pop":9},{"city":"Paris","pop":2}]'
        }],
        check(dir) {
            const out = path.join(dir, 'records.csv');
            if (!fs.existsSync(out)) return fail('records.csv was not created');
            const body = fs.readFileSync(out, 'utf8');
            return body.includes('London') && body.includes('Paris') && body.includes('city')
                ? pass('JSON converted to CSV with headers')
                : fail(`CSV wrong: ${body.slice(0, 90)}`);
        }
    },
    {
        id: 'G13', category: 'transformation',
        prompt: 'Merge all the CSV files in {{dir}} into a single {{dir}}/combined.csv keeping one header row',
        fixtures: [
            { path: 'jan.csv', content: 'item,qty\napple,3\n' },
            { path: 'feb.csv', content: 'item,qty\npear,5\n' }
        ],
        check(dir) {
            const out = path.join(dir, 'combined.csv');
            if (!fs.existsSync(out)) return fail('combined.csv was not created');
            const body = fs.readFileSync(out, 'utf8');
            const headers = (body.match(/item,qty/g) || []).length;
            return body.includes('apple') && body.includes('pear') && headers === 1
                ? pass('merged with a single header')
                : fail(`merge wrong (headers=${headers}): ${body.slice(0, 90)}`);
        }
    },
    {
        id: 'G14', category: 'transformation',
        prompt: 'Split {{dir}}/sales.csv into one file per value in its region column, saved into {{dir}}',
        fixtures: [{
            path: 'sales.csv',
            content: 'region,amount\nnorth,10\nsouth,20\nnorth,15\n'
        }],
        check(dir) {
            const tree = readTree(dir);
            const names = Object.keys(tree);
            const north = names.find(n => /north/i.test(n) && n !== 'sales.csv');
            const south = names.find(n => /south/i.test(n) && n !== 'sales.csv');
            return north && south
                ? pass('split into per-region files')
                : fail(`expected north/south files, saw: ${names.join(', ')}`);
        }
    },
    {
        id: 'G15', category: 'transformation',
        prompt: 'Strip trailing whitespace from the end of every line in the text files in {{dir}}',
        fixtures: [
            { path: 'messy.txt', content: 'line one   \nline two\t\n' },
            { path: 'clean.txt', content: 'already fine\n' }
        ],
        check(dir) {
            const tree = readTree(dir);
            const messy = tree['messy.txt'];
            if (messy === undefined) return fail('messy.txt disappeared');
            return !/[ \t]+\n/.test(messy) && messy.includes('line one')
                ? pass('trailing whitespace removed, content intact')
                : fail(`whitespace remains: ${JSON.stringify(messy.slice(0, 40))}`);
        }
    },

    {
        id: 'G16', category: 'aggregation',
        prompt: 'Add up the amount column in {{dir}}/expenses.csv and write the total to {{dir}}/total.txt',
        fixtures: [{ path: 'expenses.csv', content: 'item,amount\nrent,1200\nfood,300\ntravel,150\n' }],
        check(dir) {
            const out = path.join(dir, 'total.txt');
            if (!fs.existsSync(out)) return fail('total.txt was not created');
            const body = fs.readFileSync(out, 'utf8');
            return /1650/.test(body.replace(/[,\s]/g, ''))
                ? pass('total is 1650')
                : fail(`expected 1650, got: ${body.slice(0, 60)}`);
        }
    },
    {
        id: 'G17', category: 'aggregation',
        prompt: 'Work out the most common words across the text files in {{dir}} and write the top 3 to {{dir}}/top.txt',
        fixtures: [
            { path: 'a.txt', content: 'apple apple apple banana banana cherry' },
            { path: 'b.txt', content: 'apple banana date' }
        ],
        check(dir) {
            const out = path.join(dir, 'top.txt');
            if (!fs.existsSync(out)) return fail('top.txt was not created');
            const body = fs.readFileSync(out, 'utf8').toLowerCase();
            return body.includes('apple') && body.includes('banana')
                ? pass('top words identified')
                : fail(`top words wrong: ${body.slice(0, 90)}`);
        }
    },
    {
        id: 'G18', category: 'aggregation',
        prompt: 'Group the rows of {{dir}}/orders.csv by their status column and write the counts to {{dir}}/counts.csv',
        fixtures: [{
            path: 'orders.csv',
            content: 'id,status\n1,open\n2,closed\n3,open\n4,open\n'
        }],
        check(dir) {
            const out = path.join(dir, 'counts.csv');
            if (!fs.existsSync(out)) return fail('counts.csv was not created');
            const body = fs.readFileSync(out, 'utf8');
            return /open[^\n]*3/.test(body) && /closed[^\n]*1/.test(body)
                ? pass('group counts correct (open=3, closed=1)')
                : fail(`counts wrong: ${body.slice(0, 90)}`);
        }
    },
    {
        id: 'G19', category: 'aggregation',
        prompt: 'Work out the total size of files per extension in {{dir}} and save a summary to {{dir}}/sizes.csv',
        fixtures: [
            { path: 'a.txt', content: 'x'.repeat(100) },
            { path: 'b.txt', content: 'y'.repeat(200) },
            { path: 'c.log', content: 'z'.repeat(50) }
        ],
        check(dir) {
            const out = path.join(dir, 'sizes.csv');
            if (!fs.existsSync(out)) return fail('sizes.csv was not created');
            const body = fs.readFileSync(out, 'utf8');
            return /300/.test(body.replace(/[,\s]/g, '')) && /txt/i.test(body)
                ? pass('txt total of 300 bytes reported')
                : fail(`sizes wrong: ${body.slice(0, 90)}`);
        }
    },
    {
        id: 'G20', category: 'aggregation',
        prompt: 'Produce a summary report of {{dir}} at {{dir}}/report.txt with the file count and total size',
        fixtures: [
            { path: 'a.txt', content: 'x'.repeat(10) },
            { path: 'b.csv', content: 'y'.repeat(20) },
            { path: 'c.md', content: 'z'.repeat(30) }
        ],
        check(dir) {
            const out = path.join(dir, 'report.txt');
            if (!fs.existsSync(out)) return fail('report.txt was not created');
            const body = fs.readFileSync(out, 'utf8');
            const digits = body.replace(/[,\s]/g, '');
            return /3/.test(digits) && /60/.test(digits)
                ? pass('report includes count and total size')
                : fail(`report incomplete: ${body.slice(0, 90)}`);
        }
    }
];

module.exports = { TASKS, readTree };
