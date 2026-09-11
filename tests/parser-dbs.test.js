const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const context = { console };
vm.createContext(context);
for (const file of ['BalanceCheck.gs', 'ParserDbs.gs']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
}

const parse = text => vm.runInContext('ParserDbs.parse(__text)', Object.assign(context, { __text: text }));

const valid = `
DBS Bank Account Statement
Account No: 1234567890
01-Jun-2026 to 30-Jun-2026
Currency: SGD
Balance Brought Forward 1,832.00
05-Jun-26 200.00
05-Jun-26 LOAN REPAYMENT 1,632.00
30-Jun-26 190.00
30-Jun-26 BANK CHARGE 10.00
Balance Carried Forward
`;

const ok = parse(valid);
assert.strictEqual(ok.transactions.length, 2);
assert.strictEqual(ok.transactions[0].outgoing, 1632);
assert.strictEqual(ok.transactions[0].printedAmount, 1632);
assert.strictEqual(ok.balanceCheck.passed, true, ok.balanceCheck.reason);

const duplicatedBalance = valid.replace('05-Jun-26 200.00', '05-Jun-26 1,832.00');
const zero = parse(duplicatedBalance);
assert.strictEqual(zero.transactions[0].outgoing, 0);
assert.match(zero.transactions[0].parseWarning, /zero-value/i);
assert.strictEqual(zero.balanceCheck.passed, false);
assert.match(zero.balanceCheck.reason, /zero-value/i);

const misalignedBalance = valid.replace('05-Jun-26 200.00', '05-Jun-26 300.00');
const mismatch = parse(misalignedBalance);
assert.match(mismatch.transactions[0].parseWarning, /does not match/i);
assert.strictEqual(mismatch.balanceCheck.passed, false);

console.log('DBS parser regression tests passed');
